import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction, type AuthorizeResult } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  /** Exact text form (microseconds) — a JS Date would truncate it. This attempt's lease token: finalize/release only match the holder's own reservation. */
  reserved_at: string;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
  reserved_at: Date | null;
  transaction_status: string | null;
  captured_attempt: boolean;
}

/**
 * Expiry is judged on the server's clock only. `submittedAt` comes from the
 * (unauthenticated, public) client, so honouring it let anyone pay an
 * expired link by sending an old timestamp. Accepted for compatibility,
 * ignored.
 */
export function expiryReferenceTime(_submittedAt?: string): Date {
  return new Date();
}

/**
 * True when an earlier pay attempt's authorization of this link (found by its
 * `paylink:<link id>:<key>:authorize` idempotency key) has been captured. An
 * attempt whose capture met an acquirer error reopens the link but keeps its
 * authorization, and the merchant can capture that authorization by hand:
 * the link is then paid even though its row says 'active'. `exceptKeyParam`
 * names the SQL parameter holding the caller's own Idempotency-Key, whose
 * attempt a same-key retry may still finalize.
 */
function capturedAttemptExists(link: string, exceptKeyParam?: string): string {
  const exceptOwn = exceptKeyParam ? ` AND k.key <> 'paylink:' || ${link}.id || ':' || ${exceptKeyParam} || ':authorize'` : "";
  return `EXISTS (
    SELECT 1 FROM idempotency_keys k JOIN transactions t ON t.id = k.resource_id
     WHERE k.merchant_id = ${link}.merchant_id
       AND k.endpoint = 'transactions.authorize'
       AND k.key LIKE 'paylink:' || ${link}.id || ':%:authorize'
       AND t.captured_fils > 0${exceptOwn})`;
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize with no lock held on payment_links at all, then finalize with
 * a second atomic conditional UPDATE keyed on this attempt's own lease, and
 * only then capture. Only the request that wins the finalize moves money,
 * so a lease that times out mid-flight can never produce a second charge.
 * A short, configurable reservation timeout self-heals a link stuck
 * 'reserved' by a crash between claim and finalize, with no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number; cardFingerprintKey: Buffer },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime(input.submittedAt);

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now()
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval)
            )
        AND expires_at > $3
        AND NOT ${capturedAttemptExists("payment_links", "$4")}
      RETURNING id, merchant_id, amount_fils, reference, reserved_at::text AS reserved_at`,
    [input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime, input.idempotencyKey],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
  };
  const leaseToken = claimedRow.reserved_at;

  // Step 2 — authorize.
  // am: keys include link.id so two links can never collide on idempotency. good
  const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  let authResult: AuthorizeResult;
  try {
    authResult = await authorizeTransaction(pool, acquirer, {
      merchantId: link.merchantId,
      amountFils: link.amountFils,
      card: input.card,
      reference: link.reference ?? undefined,
      idempotencyKey: authorizeKey,
      // No merchant session/API key initiated this — a customer did, via
      // the public link.
      actor: { type: "system" },
      cardFingerprintKey: config.cardFingerprintKey,
    });
  } catch (err) {
    // authorize threw (an acquirer timeout or socket error, an idempotency
    // conflict, a DB fault). Hand the link back now instead of leaving it
    // 'reserved', and unpayable, for the whole lease. Nothing was captured:
    // money only moves after the finalize below, which this attempt never
    // reached. The acquirer may still have authorized. A same-key retry
    // resends the same acquirer key (acquirerIdempotencyKey) and gets that
    // authorization back. Any other payer still has to win the finalize to
    // capture, so such an authorization is never captured; it is the same
    // leftover as when the lease runs out.
    await releaseReservation(pool, link.id, leaseToken).catch(() => undefined);
    throw err;
  }

  if (authResult.statusCode !== 201) {
    await releaseReservation(pool, link.id, leaseToken);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 3 — finalize, on this attempt's own lease and BEFORE any money moves.
  // The link goes reserved -> paid exactly once, so only the request that
  // wins this UPDATE ever captures. It used to run after capture: when
  // capture outlived the reservation timeout, a second payer re-claimed the
  // link, charged its card and finalized first, and this request still
  // captured and answered 200 — two customers charged for one link
  // (incident 2026-05-14). Checking the lease before capture is not enough:
  // capture itself can outlive it.
  const finalizeResult = await pool.query<{ paid_at: Date }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $3::timestamptz
      RETURNING paid_at`,
    [link.id, txnId, leaseToken],
  );
  const finalized = finalizeResult.rows[0];
  if (!finalized) {
    return loseFinalizeRace(pool, link, txnId);
  }

  // Step 4 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  // If capture throws, the link deliberately stays 'paid' against this
  // authorized transaction. The throw may come AFTER the acquirer approved
  // the capture (a DB failure while journalling), so the acquirer outcome is
  // unknown. Reopening the link on a throw let a second payer claim it after
  // the reservation timeout and be captured too: two acquirer captures for
  // one link. The public read and the claim-failure path report such a link
  // as 'processing' until the merchant captures or voids the authorization.
  // When the acquirer call itself threw, capture.ts records the attempt as
  // unresolved (0123): a void is then refused and the merchant's capture
  // resends the same acquirer key.
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (captureResult.statusCode !== 200) {
    // Nothing was captured: hand the link back so the customer can retry.
    // Unless the merchant captured this authorization by hand in the
    // meantime (the capture then answers not_capturable): the link is paid.
    await pool.query(
      `UPDATE payment_links SET status = 'active', paid_at = NULL, transaction_id = NULL
        WHERE id = $1 AND status = 'paid' AND transaction_id = $2
          AND NOT EXISTS (SELECT 1 FROM transactions WHERE id = $2 AND captured_fils > 0)`,
      [link.id, txnId],
    );
    // A declined capture leaves an authorization nobody will ever capture:
    // release its hold. An acquirer error (502) stays retryable with the
    // same Idempotency-Key, so its authorization is kept for that retry.
    if (captureResult.statusCode !== 502) {
      await voidTransaction(pool, { transactionId: txnId, merchantId: link.merchantId, actor: { type: "system", id: link.id } });
    }
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // An earlier attempt whose capture met an acquirer error kept its
  // authorization for a same-key retry. The link is paid now, so that
  // retry can never capture it: release it rather than leave the first
  // customer's funds on hold, capturable as a second charge for one link.
  // Best effort: the payment itself has already succeeded.
  await voidOtherLinkAuthorizations(pool, link, txnId).catch(() => undefined);

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: finalized.paid_at.toISOString(),
    },
  };
}

/**
 * The finalize UPDATE matched 0 rows: while this request was authorizing, its
 * lease timed out and another payer took the link over (or the merchant
 * canceled it). Nothing has been captured yet, so void this request's own
 * authorization and report the link's state — unless the link was finalized
 * with this very transaction (a retry carrying the same Idempotency-Key
 * replayed this authorization), in which case that request owns the capture.
 */
async function loseFinalizeRace(
  pool: Pool,
  link: { id: string; merchantId: string },
  txnId: string,
): Promise<PayPaymentLinkResult> {
  const current = await pool.query<{ status: string; transaction_id: string | null }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [link.id],
  );
  const row = current.rows[0];
  if (row?.transaction_id === txnId) {
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  await voidTransaction(pool, { transactionId: txnId, merchantId: link.merchantId, actor: { type: "system", id: link.id } });
  if (row?.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row?.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  return { statusCode: 409, body: { error: "payment_link_processing" } };
}

/**
 * Voids every authorization a pay attempt on this link created, except
 * `keepTxnId` (null: all of them). Attempts are found through their
 * authorize idempotency keys (`paylink:<link id>:<key>:authorize`).
 * voidTransaction leaves anything that is no longer 'authorized' alone.
 */
export async function voidOtherLinkAuthorizations(
  pool: Pool,
  link: { id: string; merchantId: string },
  keepTxnId: string | null,
): Promise<void> {
  const result = await pool.query<{ resource_id: string }>(
    `SELECT resource_id FROM idempotency_keys
      WHERE merchant_id = $1 AND endpoint = 'transactions.authorize' AND key LIKE $2
        AND resource_id IS NOT NULL AND resource_id IS DISTINCT FROM $3::uuid`,
    [link.merchantId, `paylink:${link.id}:%:authorize`, keepTxnId],
  );
  for (const row of result.rows) {
    await voidTransaction(pool, {
      transactionId: row.resource_id,
      merchantId: link.merchantId,
      actor: { type: "system", id: link.id },
    });
  }
}

/**
 * Used when authorize declines or throws, above. Guarded by the lease token
 * for the same reason as the finalize UPDATE: this request only ever
 * releases the reservation it itself holds.
 */
async function releaseReservation(pool: Pool, linkId: string, leaseToken: string): Promise<void> {
  await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL
      WHERE id = $1 AND status = 'reserved' AND reserved_at = $2`,
    [linkId, leaseToken],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
// FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT
// ... FOR UPDATE here. TODO
// am: its only for the error message. ignore
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  reservationTimeoutSeconds: number,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(
    `SELECT pl.status, pl.expires_at, pl.reserved_at, t.status AS transaction_status,
            ${capturedAttemptExists("pl")} AS captured_attempt
       FROM payment_links pl
       LEFT JOIN transactions t ON t.id = pl.transaction_id
      WHERE pl.token = $1`,
    [token],
  );
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.captured_attempt && (row.status === "active" || row.status === "reserved")) {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "paid" && row.transaction_status === "authorized") {
    // Finalized but not yet captured (capture running, or its outcome is
    // unknown): no money has moved, so "already paid" would be false.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (
    row.status === "reserved" &&
    row.expires_at.getTime() <= expiryCheckTime.getTime() &&
    !(row.reserved_at && row.reserved_at.getTime() > expiryCheckTime.getTime() - reservationTimeoutSeconds * 1000)
  ) {
    // An abandoned reservation on a link that has since expired: nobody is
    // paying it and nobody can. Answering 'processing' here kept the
    // customer retrying forever while the public read said 'active'.
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. It's still within the timeout (if it
    // weren't, our claim UPDATE would have matched it) — reachable only in
    // a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
