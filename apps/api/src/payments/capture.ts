import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, applyRateFils, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerCaptureResult, AcquirerSimulator } from "../acquirer/types.js";
import {
  acquirerIdempotencyKey,
  activeCaptureReservationFils,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  hashRequest,
  markAcquirerAttempt,
  ownsAcquirerAttempt,
  takeOverAcquirerAttempt,
  type IdempotencyKeyRow,
} from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { serializeTransaction, type TransactionRow } from "../transactions/serialize.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";
import { getEffectiveMdrBps } from "../fees/feeSchedule.js";
import { getVolumeTierBonusBps } from "../fees/platformVolumeTier.js";
import { nextStatusAfterRefund } from "./refundState.js";

async function recordCaptureMetric(
  client: import("pg").PoolClient,
  merchantId: string,
  amountFils: Fils,
  capturedAt: Date,
): Promise<void> {
  const dateStr = capturedAt.toISOString().slice(0, 10);
  const existing = await client.query(
    `SELECT merchant_id FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = $2`,
    [merchantId, dateStr],
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE merchant_daily_volume
          SET captured_count = captured_count + 1, captured_gross_fils = captured_gross_fils + $3
        WHERE merchant_id = $1 AND volume_date = $2`,
      [merchantId, dateStr, amountFils],
    );
  } else {
    await client.query(
      `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count)
       VALUES ($1, $2, 1, $3, 0)
       ON CONFLICT (merchant_id, volume_date)
       DO UPDATE SET captured_count = merchant_daily_volume.captured_count + 1,
                     captured_gross_fils = merchant_daily_volume.captured_gross_fils + $3`,
      [merchantId, dateStr, amountFils],
    );
  }
}

const ENDPOINT = "transactions.capture";

export interface CaptureInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils; // omitted => capture the full remaining amount
  idempotencyKey: string;
  /** Includes 'system' (matching AuthorizeInput.actor and
   *  RecordTransactionEventInput.actor.type) so the payment-link checkout
   *  handler — which has no merchant session or API key of its own — can
   *  call captureTransaction() directly. routes/transactions.ts's capture
   *  route always supplies a real session/API-key actor. */
  actor: { type: "merchant_session" | "merchant_api_key" | "system"; id: string };
}

export interface CaptureResult {
  statusCode: number;
  body: unknown;
}

interface LockedTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

interface UnresolvedCaptureRow {
  idempotency_key_id: string;
  amount_fils: string | number;
  acquirer_idempotency_key: string;
}

/** The step-1 transaction either settles the request outright (replay, a
 *  validation rejection) or hands step 2 everything it needs to call the
 *  acquirer with no pool connection held. */
interface CapturePrepared {
  claim: IdempotencyKeyRow;
  attemptId: string;
  acquirerReference: string;
  requestedAmount: Fils;
  /** The acquirer idempotency key to send: this claim's derived key, or the
   *  stored key of an earlier thrown attempt we are resolving. */
  acquirerKey: string;
  /** When resolving an earlier thrown attempt recorded under a different
   *  key, the original claim to also settle so its retry replays. */
  unresolvedKeyId: string | null;
}

type PreparedResult = { settled: CaptureResult } | CapturePrepared;

/**
 * `POST /v1/transactions/:id/capture` business logic. Integer math,
 * double-entry journaling, row-locked, idempotent.
 *
 * Three steps, so that no pool connection is held while the acquirer runs
 * (perfload): (1) one short transaction claims the key, row-locks the
 * transaction, validates it and reserves the amount on the claim; (2) the
 * acquirer call, with no connection checked out; (3) a second transaction
 * re-locks the row and journals the result from its current values.
 *
 * The row lock used to be held across the acquirer call, so that nothing
 * (not a second capture, not a void) could act on what step 1 validated.
 * The reservation gives the same guarantee without the connection: while
 * this capture is at the acquirer, its amount counts as captured for any
 * other capture (activeCaptureReservationFils), and a void is refused.
 *
 * When the acquirer call throws (a timeout: the acquirer may already have
 * captured) the outcome is unknown and stays unknown after the reservation
 * lapses. Step 2 records it in capture_attempts_unresolved (0123) instead
 * of silently dropping the reservation: a void and a differing-amount
 * capture are then refused (capture_outcome_unknown), and a same-amount
 * capture — under any key — resends the stored acquirer key so the acquirer
 * replays its one answer rather than capturing a second time.
 */
export async function captureTransaction(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: CaptureInput,
): Promise<CaptureResult> {
  // The transaction id is part of the request: the idempotency scope is
  // (merchant, endpoint, key), so without it a key reused on another
  // transaction would replay the first transaction's response.
  const requestHash = hashRequest({ transactionId: input.transactionId, amountFils: input.amountFils ?? null });

  const prepared = await withTransaction<PreparedResult>(pool, async (client) => {
    let claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      // Another attempt with this key is at the acquirer (409, retry later),
      // or its process died: then this request takes it over and resends
      // the same acquirer key.
      const takenOver = await takeOverAcquirerAttempt(client, claim.row);
      if (!takenOver) {
        throw new ConflictError("request_in_progress");
      }
      claim = { outcome: "retry_after_failure", row: takenOver };
    }
    if (claim.outcome === "replay") {
      // No row lock is ever taken on this call.
      return { settled: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody } };
    }
    // 'fresh' / 'retry_after_failure' — continue.

    // Acquire the row lock FIRST, before any validation. Ownership is
    // enforced by input.merchantId, which the caller derives only from
    // request.merchantAuth — never from a merchantId in the request body —
    // so ownership can never be satisfied by a value the caller controls
    // independently of how they authenticated.
    const lockResult = await client.query<LockedTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = lockResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { settled: { statusCode: 404, body } };
    }

    // Validate current state, still holding the lock, before calling the
    // acquirer.
    if (txn.status !== "authorized" && txn.status !== "partially_captured") {
      const body = { error: "not_capturable", status: txn.status };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 409, body });
      return { settled: { statusCode: 409, body } };
    }

    // The authorization lapses when its hold does: authorize.ts sets
    // holds.expires_at (now() + 7 days, the scheme's CNP window) and
    // expire_holds.ts flips it to 'expired' after that. A transaction with
    // no hold row (deleted by the old FP-219 janitor) falls back to the
    // same window from its own created_at.
    const expiryResult = await client.query<{ expired: boolean }>(
      `SELECT CASE
                WHEN EXISTS (SELECT 1 FROM holds WHERE transaction_id = $1)
                  THEN EXISTS (SELECT 1 FROM holds
                                WHERE transaction_id = $1
                                  AND (status = 'expired' OR expires_at <= now()))
                ELSE (SELECT created_at + interval '7 days' <= now() FROM transactions WHERE id = $1)
              END AS expired`,
      [txn.id],
    );
    if (expiryResult.rows[0]?.expired) {
      const body = { error: "authorization_expired" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 409, body });
      return { settled: { statusCode: 409, body } };
    }

    // — YA: authorised vs captured. finance says "amount" and means both.
    // Captures still at the acquirer count as captured here.
    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedSoFar = toFils(Number(txn.captured_fils));
    const inFlight = toFils(await activeCaptureReservationFils(client, txn.id, claim.row.id));
    const remaining = subtractFils(subtractFils(amountAuthorized, capturedSoFar), inFlight);
    const requestedAmount = input.amountFils ?? remaining;

    // An earlier capture of this transaction whose acquirer call threw: the
    // acquirer may have captured it (0123). Only a capture of that same
    // amount may go on, and it resends that attempt's acquirer key, so the
    // acquirer replays its answer instead of capturing a second time.
    // Anything else would act on an outcome nobody knows.
    const unresolvedResult = await client.query<UnresolvedCaptureRow>(
      `SELECT idempotency_key_id, amount_fils, acquirer_idempotency_key
         FROM capture_attempts_unresolved WHERE transaction_id = $1`,
      [txn.id],
    );
    const unresolved = unresolvedResult.rows[0];

    let acquirerKey: string;
    let unresolvedKeyId: string | null;
    if (unresolved) {
      if (compareFils(requestedAmount, toFils(Number(unresolved.amount_fils))) !== 0) {
        const body = { error: "capture_outcome_unknown", pendingCaptureFils: toFils(Number(unresolved.amount_fils)) };
        // Not final: once the pending capture is resolved this request may
        // be valid, so the key stays retryable.
        await failIdempotencyKey(client, claim.row.id, { statusCode: 409, body });
        return { settled: { statusCode: 409, body } };
      }
      // Same amount: resend the thrown attempt's acquirer key so the
      // acquirer replays its one answer. No remaining check — the amount is
      // already reserved at the acquirer; an overcapture (a reservation that
      // outlived the staleness window and was spent elsewhere) is caught in
      // recordCapture against the freshly locked row.
      acquirerKey = unresolved.acquirer_idempotency_key;
      unresolvedKeyId = unresolved.idempotency_key_id;
    } else {
      if (compareFils(requestedAmount, ZERO_FILS) <= 0 || compareFils(requestedAmount, remaining) > 0) {
        const body = { error: "capture_exceeds_remaining", remainingFils: remaining };
        await completeIdempotencyKey(client, claim.row.id, { statusCode: 422, body });
        return { settled: { statusCode: 422, body } };
      }
      acquirerKey = acquirerIdempotencyKey(claim.row);
      unresolvedKeyId = null;
    }

    const attemptId = await markAcquirerAttempt(client, claim.row.id, {
      resourceId: txn.id,
      reservedFils: requestedAmount,
    });
    return {
      claim: claim.row,
      attemptId,
      acquirerReference: txn.acquirer_reference,
      requestedAmount,
      acquirerKey,
      unresolvedKeyId,
    };
  });
  if ("settled" in prepared) {
    return prepared.settled;
  }
  const { claim, attemptId, requestedAmount, acquirerKey, unresolvedKeyId } = prepared;

  try {
    // No DB connection is checked out during this call.
    const acquirerResult = await acquirer.capture({
      acquirerReference: prepared.acquirerReference,
      amountFils: requestedAmount,
      idempotencyKey: acquirerKey,
    });
    return await withTransaction(pool, (client) =>
      recordCapture(client, claim.id, attemptId, acquirerResult, requestedAmount, input, unresolvedKeyId),
    );
  } catch (err) {
    // Outcome unknown (an acquirer timeout: it may already have captured).
    // Record it durably instead of just dropping the reservation, so a void
    // and a differing-amount capture are refused and a same-amount retry
    // resends acquirerKey. The claim is marked failed (retryable), which
    // also drops its reservation (activeCaptureReservationFils counts only
    // in_progress claims); the unresolved row now carries the refusal.
    await withTransaction(pool, async (client) => {
      if (!(await ownsAcquirerAttempt(client, claim.id, attemptId))) {
        // A later request took this attempt over; it owns the outcome.
        return;
      }
      await client.query(
        `INSERT INTO capture_attempts_unresolved (transaction_id, idempotency_key_id, amount_fils, acquirer_idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [input.transactionId, claim.id, requestedAmount, acquirerKey],
      );
      await failIdempotencyKey(client, claim.id, { statusCode: 502, body: { error: "capture_outcome_unknown" } });
    }).catch(() => {
      // Best effort, as releaseAcquirerAttempt was: if this fails too the
      // claim goes stale after ACQUIRER_ATTEMPT_STALE_SECONDS, and the
      // original acquirer key is still derivable for a same-key retry.
    });
    throw err;
  }
}

async function recordCapture(
  client: PoolClient,
  claimId: string,
  attemptId: string,
  acquirerResult: AcquirerCaptureResult,
  requestedAmount: Fils,
  input: CaptureInput,
  unresolvedKeyId: string | null,
): Promise<CaptureResult> {
  if (!(await ownsAcquirerAttempt(client, claimId, attemptId))) {
    // A same-key retry took this attempt over (it was stale) and records
    // the outcome itself, from the same acquirer key.
    throw new ConflictError("request_in_progress");
  }

  // The acquirer answered: whatever was pending for this transaction is
  // resolved by it, so the unknown-outcome record clears.
  await client.query(`DELETE FROM capture_attempts_unresolved WHERE transaction_id = $1`, [input.transactionId]);

  // Completes this claim and, when it resolves an earlier thrown attempt
  // recorded under a different key, that attempt's claim too, so a retry of
  // the first key replays this answer instead of capturing again.
  const completeClaims = async (result: { statusCode: number; body: unknown; resourceId?: string }) => {
    await completeIdempotencyKey(client, claimId, result);
    if (unresolvedKeyId && unresolvedKeyId !== claimId) {
      await completeIdempotencyKey(client, unresolvedKeyId, result);
    }
  };

  if (acquirerResult.outcome === "declined") {
    // Note: AcquirerCaptureResult carries no
    // declineReason field the way AcquirerAuthorizeResult does — capture
    // declines are reported by outcome alone.
    const body = { error: "card_captured_declined" };
    await completeClaims({ statusCode: 402, body });
    return { statusCode: 402, body };
  }
  if (acquirerResult.outcome === "error") {
    const body = { error: "acquirer_unavailable" };
    await failIdempotencyKey(client, claimId, { statusCode: 502, body });
    return { statusCode: 502, body };
  }

  // outcome === 'approved'. Re-lock the row and work from its current
  // values: other captures and refunds may have committed while this one
  // was at the acquirer. Its reservation kept the amount available.
  const lockResult = await client.query<LockedTransactionRow>(
    `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
       FROM transactions
      WHERE id = $1 AND merchant_id = $2
      FOR UPDATE`,
    [input.transactionId, input.merchantId],
  );
  const txn = lockResult.rows[0];
  if (!txn) {
    throw new Error("captureTransaction: transaction row disappeared mid-capture");
  }
  const amountAuthorized = toFils(Number(txn.amount_fils));
  const capturedSoFar = toFils(Number(txn.captured_fils));

  const merchantResult = await client.query<{ mdr_bps: number; negotiated_discount_bps: number }>(
    `SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1`,
    [input.merchantId],
  );
  const merchant = merchantResult.rows[0];
  if (!merchant) {
    throw new Error("captureTransaction: merchant row disappeared mid-transaction");
  }

  // Fee rate resolution: effective-dated (apps/api/src/fees/feeSchedule.ts),
  // falling back to this merchant's plain mdr_bps when no schedule row
  // applies yet — the ordinary case for every merchant that has never had
  // a negotiated rate change recorded. Resolved at the instant of capture,
  // inside the same locked transaction that computes and journals the fee.
  const effectiveMdrBps = await getEffectiveMdrBps(client, input.merchantId, new Date(), merchant.mdr_bps);
  const volumeTierBonusBps = await getVolumeTierBonusBps(client);

  // Integer math throughout — no float ever
  // enters this path. The negotiated discount reduces the amount the MDR
  // is charged on (docs/ARCHITECTURE.md "Settlement"; the same per-event
  // formula as apps/settlement's ComputeSettlementFee): discount the
  // amount first, then apply the MDR, each step rounded half-even.
  // Computed here, under the row lock, so every capture path gets it,
  // exactly once per capture event.
  const discountBps = merchant.negotiated_discount_bps;
  const discountedAmount = subtractFils(requestedAmount, applyRateFils(requestedAmount, discountBps));
  const feeFils = applyRateFils(discountedAmount, Math.max(0, effectiveMdrBps - volumeTierBonusBps));
  const newCapturedFils = addFils(capturedSoFar, requestedAmount);
  if (compareFils(newCapturedFils, amountAuthorized) > 0) {
    // Only reachable if a reservation outlived ACQUIRER_ATTEMPT_STALE_SECONDS
    // at the acquirer and another capture spent it. Never journal more than
    // was authorized; the throw releases the claim for a person to resolve.
    throw new Error("captureTransaction: capture would exceed the authorized amount");
  }
  const fullyCaptured = compareFils(newCapturedFils, amountAuthorized) === 0;
  // Same derivation as a refund uses: a partially captured transaction
  // keeps its refunds in refunded_fils, so capturing the rest must not
  // report it as plain 'captured' with money already returned. The
  // refunded total counts refunds that succeeded, as processRefund does:
  // refunded_fils also holds the reservation of a refund still at the
  // acquirer, which a decline releases again.
  const succeededRefunds = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS total FROM refunds WHERE transaction_id = $1 AND status = 'succeeded'`,
    [txn.id],
  );
  const newStatus = nextStatusAfterRefund({
    amountFils: amountAuthorized,
    capturedFils: newCapturedFils,
    refundedTotalFils: toFils(Number(succeededRefunds.rows[0]!.total)),
  });

  const updateResult = await client.query<TransactionRow>(
    `UPDATE transactions SET status = $2, captured_fils = $3 WHERE id = $1 RETURNING *`,
    [txn.id, newStatus, newCapturedFils],
  );
  const updatedTxn = updateResult.rows[0];
  if (!updatedTxn) {
    throw new Error("captureTransaction: update to transactions returned no row");
  }

  // Double-entry journaling. One entry_group_id per capture event; the
  // fee leg pair is omitted entirely when feeFils = 0 (ledger_entries has
  // a CHECK (amount_fils > 0), and a zero-value entry carries no
  // accounting information anyway).
  const entryGroupId = randomUUID();
  await client.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES
       ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, now(), 'capture: gross'),
       ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'capture: gross')`,
    [entryGroupId, input.merchantId, txn.id, requestedAmount],
  );
  if (feeFils > 0) {
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'capture: MDR fee'),
         ($1, $2, $3, 'platform_fee_revenue', 'credit', $4, now(), 'capture: MDR fee')`,
      [entryGroupId, input.merchantId, txn.id, feeFils],
    );
  }
  // merchant_balances caches merchant_payable (ADR-0004), so it moves with
  // the legs above in this transaction, as credits and payouts already do.
  await client.query(
    `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (merchant_id) DO UPDATE
       SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils, updated_at = now()`,
    [input.merchantId, subtractFils(requestedAmount, feeFils)],
  );

  // Hold lifecycle: released exactly when nothing remains outstanding.
  if (fullyCaptured) {
    await client.query(`UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`, [
      txn.id,
    ]);
  }

  await enqueueEvent(client, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: txn.id,
    payload: {
      merchantId: input.merchantId,
      amountCapturedFils: requestedAmount,
      feeFils,
      newStatus,
      capturedTotalFils: newCapturedFils,
    },
  });

  await recordTransactionEvent(client, {
    transactionId: txn.id,
    eventType: fullyCaptured ? "captured" : "partially_captured",
    amountFils: requestedAmount,
    actor: input.actor,
    // feeFils is the fee actually charged, discount included; discountBps
    // marks it as such for readers of older events (which recorded the
    // pre-discount fee and had a separate adjustment posted after commit).
    metadata: { feeFils, discountBps, acquirerReference: acquirerResult.acquirerReference },
  });

  const body = serializeTransaction(updatedTxn);
  await completeClaims({ statusCode: 200, body, resourceId: txn.id });
  return { statusCode: 200, body };
}
