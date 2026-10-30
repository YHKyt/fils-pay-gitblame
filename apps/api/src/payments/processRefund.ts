import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  hashRequest,
  type IdempotencyClaim,
  type IdempotencyKeyRow,
} from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest, type RefundValidation } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

/**
 * An attempt still 'in_progress' this long after it was claimed is taken to
 * be dead (takeOverStaleAttempt). Far longer than an acquirer call; and an
 * attempt that was only slow cannot record anything once taken over.
 */
const STALE_ATTEMPT_SECONDS = 5 * 60;

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/**
 * Stored on a failed key when the acquirer call threw: the outcome is unknown
 * and the reservation is still held. Also stored, with `claimedAt`, on the
 * in_progress key of every attempt about to call the acquirer
 * (recordAttemptInFlight), so a key left behind by a dead process says what
 * it sent.
 */
interface UnknownOutcomeMarker {
  error: "acquirer_unavailable";
  acquirerOutcome: "unknown";
  acquirerIdempotencyKey: string;
  reservedFils: number;
  claimedAt?: string;
}

function unknownOutcomeMarker(body: unknown): UnknownOutcomeMarker | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Partial<UnknownOutcomeMarker>;
  if (b.acquirerOutcome !== "unknown" || typeof b.acquirerIdempotencyKey !== "string") return null;
  if (typeof b.reservedFils !== "number" || !Number.isSafeInteger(b.reservedFils) || b.reservedFils <= 0) return null;
  return b as UnknownOutcomeMarker;
}

const REFUND_ERROR_MESSAGES = {
  transaction_not_refundable: "this transaction cannot be refunded in its current status",
  refund_amount_invalid: "the refund amount must be a positive number of fils",
  refund_exceeds_refundable: "the refund amount is more than the transaction has left to refund",
} as const;

/**
 * The HTTP body for a refused refund: the API's uniform `{ error, message }`
 * shape (lib/errors.ts), plus the detail field the refusal carries. The
 * validation result itself (`{ ok, code }`) was sent before, so a client or
 * the dashboard reading `body.error` got nothing.
 */
function refundErrorBody(validation: Exclude<RefundValidation, { ok: true }>): Record<string, unknown> {
  const { ok: _ok, code, ...details } = validation;
  return { error: code, message: REFUND_ERROR_MESSAGES[code], ...details };
}

/** Refund business logic: validate, call the acquirer, then journal the reversal. */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  // 1 validate
  const prepared = await withTransaction(pool, async (client) => {
    let claim: IdempotencyClaim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      // Another attempt holds the key: in flight (409, retry later), or
      // stale because its process died after step 1 committed.
      const takenOver = await takeOverStaleAttempt(client, claim.row);
      if (!takenOver) {
        throw new ConflictError("request_in_progress");
      }
      claim = { outcome: "retry_after_failure", row: takenOver };
    }
    if (claim.outcome === "replay") {
      return {
        kind: "settled" as const,
        result: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody },
      };
    }

    // A retry after an acquirer call that threw (outcome unknown), or of a
    // stale attempt taken over above: the step-1 reservation is still held
    // and the acquirer may already have refunded. Resend the SAME acquirer idempotency key for the reserved
    // amount, so the acquirer answers with its first result instead of
    // refunding the cardholder a second time.
    const pending = unknownOutcomeMarker(claim.outcome === "retry_after_failure" ? claim.row.responseBody : null);
    if (pending) {
      const pendingTxn = await client.query<{ id: string; merchant_id: string; acquirer_reference: string }>(
        `SELECT id, merchant_id, acquirer_reference FROM transactions WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
        [input.transactionId, input.merchantId],
      );
      const row = pendingTxn.rows[0];
      if (row) {
        await recordAttemptInFlight(client, claim.row.id, pending.acquirerIdempotencyKey, pending.reservedFils);
        return {
          kind: "proceed" as const,
          claimId: claim.row.id,
          attemptCount: claim.row.attemptCount,
          acquirerIdempotencyKey: pending.acquirerIdempotencyKey,
          transactionId: row.id,
          merchantId: row.merchant_id,
          acquirerReference: row.acquirer_reference,
          requestedAmount: toFils(pending.reservedFils),
        };
      }
    }

    // Scoped to the caller's merchant (another merchant's id is just "not
    // found"), and row-locked so two concurrent refunds with different
    // idempotency keys validate one after the other, never against the same
    // refunded_fils.
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
          FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { kind: "settled" as const, result: { statusCode: 404, body } };
    }

    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    // Only money that was actually captured can go back — never the
    // uncaptured authorization headroom.
    const refundableFils = subtractFils(capturedFils, refundedFils);

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      const body = refundErrorBody(validation);
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body });
      return { kind: "settled" as const, result: { statusCode, body } };
    }

    // Reserve the amount before the lock is released and the acquirer is
    // called: a concurrent refund now sees it as already refunded. Released
    // again in step 3 if the acquirer declines or errors. A crash in between
    // leaves the key in_progress with the reservation held; once the attempt
    // is stale, a same-key retry takes it over and resends the same acquirer
    // key, so the refund is neither lost nor sent twice.
    await client.query(`UPDATE transactions SET refunded_fils = refunded_fils + $2 WHERE id = $1`, [
      txn.id,
      validation.amountFils,
    ]);

    const acquirerIdempotencyKey = `${claim.row.id}:${claim.row.attemptCount}`;
    await recordAttemptInFlight(client, claim.row.id, acquirerIdempotencyKey, validation.amountFils);
    return {
      kind: "proceed" as const,
      claimId: claim.row.id,
      attemptCount: claim.row.attemptCount,
      acquirerIdempotencyKey,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      acquirerReference: txn.acquirer_reference,
      requestedAmount: validation.amountFils,
    };
  });

  if (prepared.kind === "settled") {
    return prepared.result;
  }

  // 2 acquirer
  let acquirerResult;
  try {
    acquirerResult = await acquirer.refund({
      acquirerReference: prepared.acquirerReference,
      amountFils: prepared.requestedAmount,
      idempotencyKey: prepared.acquirerIdempotencyKey,
    });
  } catch {
    // The acquirer call threw (e.g. a timeout or socket error) rather than
    // returning an outcome, so whether the cardholder was refunded is
    // UNKNOWN: a timeout can arrive after the acquirer processed it. Keep the
    // step-1 reservation (refunded_fils stays reserved, so no other refund
    // can spend the same money) and mark the key failed with the acquirer
    // key and the reserved amount: a retry with the same Idempotency-Key
    // then resends that same acquirer key, and the acquirer deduplicates.
    // Releasing the reservation here and retrying under a new acquirer key
    // refunded the cardholder twice.
    const marker: UnknownOutcomeMarker = {
      error: "acquirer_unavailable",
      acquirerOutcome: "unknown",
      acquirerIdempotencyKey: prepared.acquirerIdempotencyKey,
      reservedFils: prepared.requestedAmount,
    };
    await withTransaction(pool, async (client) => {
      if (await ownsAttempt(client, prepared.claimId, prepared.attemptCount)) {
        await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body: marker });
      }
    });
    return { statusCode: 502, body: { error: "acquirer_unavailable" } };
  }

  // 3 journal
  return withTransaction(pool, async (client) => {
    if (!(await ownsAttempt(client, prepared.claimId, prepared.attemptCount))) {
      // This attempt went stale and a same-key retry took it over. That retry
      // resent the same acquirer key and records the outcome (and releases
      // the reservation) itself; doing it here too would do it twice.
      throw new ConflictError("request_in_progress");
    }
    if (acquirerResult.outcome !== "approved") {
      // Release the step-1 reservation.
      await client.query(`UPDATE transactions SET refunded_fils = refunded_fils - $2 WHERE id = $1`, [
        prepared.transactionId,
        prepared.requestedAmount,
      ]);
    }
    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    // Re-read under the row lock. captured_fils and amount_fils are read
    // fresh here, not carried from step 1: a capture that landed between the
    // step-1 reservation and now would otherwise leave the fee reversal and
    // the derived status computed against a stale captured amount.
    const locked = await client.query<{ captured_fils: string; amount_fils: string }>(
      `SELECT captured_fils, amount_fils FROM transactions WHERE id = $1 FOR UPDATE`,
      [prepared.transactionId],
    );
    const capturedFils = toFils(Number(locked.rows[0]!.captured_fils));
    const amountAuthorized = toFils(Number(locked.rows[0]!.amount_fils));

    // The fee this transaction was actually charged, read from the ledger
    // rather than recomputed from the current mdr_bps: MDR credits net of
    // capture-time debits (the negotiated discount adjustment), excluding
    // earlier refund reversals. The reversal is the pro-rata share of the
    // cumulative refunded amount minus what earlier refunds already
    // reversed, so partial refunds sum to exactly the fee, with no rounding
    // drift across them.
    const feeResult = await client.query<{ fee_fils: string; reversed_fils: string; prior_refunded_fils: string }>(
      `SELECT
         (SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
            FROM ledger_entries
           WHERE transaction_id = $1
             AND account_id = 'platform_fee_revenue'
             AND description NOT LIKE 'refund:%')::text AS fee_fils,
         (SELECT COALESCE(SUM(fee_reversed_fils), 0) FROM refunds
           WHERE transaction_id = $1 AND status = 'succeeded')::text AS reversed_fils,
         (SELECT COALESCE(SUM(amount_fils), 0) FROM refunds
           WHERE transaction_id = $1 AND status = 'succeeded')::text AS prior_refunded_fils`,
      [prepared.transactionId],
    );
    const feeRow = feeResult.rows[0]!;
    const netFeeFils = toFils(Math.max(0, Number(feeRow.fee_fils)));

    // The settled refunded total: refunds that have actually succeeded plus
    // this one. This is NOT read from transactions.refunded_fils, which also
    // carries the reservations of other refunds still in flight — one of
    // which may yet be released on a decline/error. Deriving the total (and
    // hence the status and the event type) from the reservation column is
    // what let a concurrent refund that later declined push a transaction to
    // "refunded" with half its captured amount still refundable.
    const newRefundedTotal = addFils(toFils(Number(feeRow.prior_refunded_fils)), prepared.requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });

    const cumulativeShare = calculateRefundFee(capturedFils, netFeeFils, newRefundedTotal);
    const owed = subtractFils(cumulativeShare, toFils(Number(feeRow.reversed_fils)));
    const feeReversedFils = compareFils(owed, ZERO_FILS) > 0 ? owed : ZERO_FILS;

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        prepared.transactionId,
        prepared.merchantId,
        prepared.requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        // 0070 made reason NOT NULL (CHECK) with DEFAULT 'unspecified', but a
        // DEFAULT only applies when the column is omitted — passing an
        // explicit NULL here failed chk_refunds_reason_not_null for every
        // refund created without a reason.
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    // refunded_fils was already moved by the reservation; only the derived
    // status changes here. Writing an absolute total computed from a stale
    // read is what used to let two concurrent refunds overwrite each other.
    await client.query(`UPDATE transactions SET status = $2 WHERE id = $1`, [prepared.transactionId, newStatus]);

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, prepared.merchantId, prepared.transactionId, prepared.requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, prepared.merchantId, prepared.transactionId, feeReversedFils],
      );
    }
    // merchant_balances caches merchant_payable (ADR-0004): same move as the legs above.
    await client.query(
      `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (merchant_id) DO UPDATE
         SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils, updated_at = now()`,
      [prepared.merchantId, subtractFils(feeReversedFils, prepared.requestedAmount)],
    );

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column ends up
    // saying: everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: prepared.transactionId,
      eventType,
      amountFils: toFils(-prepared.requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: prepared.transactionId,
      payload: {
        merchantId: prepared.merchantId,
        refundId: refund.id,
        amountFils: prepared.requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: prepared.transactionId,
      merchantId: prepared.merchantId,
      amountFils: prepared.requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, prepared.claimId, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}

/**
 * Writes this attempt's acquirer key and reserved amount onto its claim row,
 * in the step-1 transaction that holds the reservation, so they commit
 * together. A process that dies before recording the outcome then leaves an
 * in_progress key that says exactly what to resend.
 */
async function recordAttemptInFlight(
  client: PoolClient,
  claimId: string,
  acquirerIdempotencyKey: string,
  reservedFils: number,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET response_body = jsonb_build_object(
              'error', 'acquirer_unavailable', 'acquirerOutcome', 'unknown',
              'acquirerIdempotencyKey', $2::text, 'reservedFils', $3::bigint, 'claimedAt', now())
      WHERE id = $1`,
    [claimId, acquirerIdempotencyKey, reservedFils],
  );
}

/**
 * Recovers a key left 'in_progress' by an attempt whose process died between
 * step 1 and recording the outcome. Such a key answered 409
 * request_in_progress forever (no sweeper exists). Once the attempt is older
 * than STALE_ATTEMPT_SECONDS, this request takes it over and continues as a
 * retry after an unknown outcome: the SAME acquirer key for the SAME reserved
 * amount, so the acquirer replays the dead attempt's refund (or makes it, if
 * it never arrived) instead of refunding twice, and nothing is reserved
 * again. Bumping attempt_count fences the old attempt off (ownsAttempt), in
 * case it was only slow, and lets only one of two concurrent retries win.
 * Only keys carrying the in-flight marker qualify; an older in_progress key
 * stays 409 for a person to resolve.
 */
async function takeOverStaleAttempt(client: PoolClient, row: IdempotencyKeyRow): Promise<IdempotencyKeyRow | null> {
  const result = await client.query<{ attempt_count: number; response_body: unknown }>(
    `UPDATE idempotency_keys SET attempt_count = attempt_count + 1
      WHERE id = $1 AND status = 'in_progress' AND attempt_count = $2
        AND response_body->>'acquirerOutcome' = 'unknown'
        AND (response_body->>'claimedAt')::timestamptz < now() - make_interval(secs => $3)
      RETURNING attempt_count, response_body`,
    [row.id, row.attemptCount, STALE_ATTEMPT_SECONDS],
  );
  const updated = result.rows[0];
  return updated ? { ...row, attemptCount: updated.attempt_count, responseBody: updated.response_body } : null;
}

/**
 * Locks this attempt's claim row. False once a later request took the
 * attempt over (takeOverStaleAttempt).
 */
async function ownsAttempt(client: PoolClient, claimId: string, attemptCount: number): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM idempotency_keys WHERE id = $1 AND status = 'in_progress' AND attempt_count = $2 FOR UPDATE`,
    [claimId, attemptCount],
  );
  return result.rows.length > 0;
}
