import { createHmac, hkdfSync } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Fils } from "@filspay/money";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerAuthorizeResult, AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";
import {
  acquirerIdempotencyKey,
  canonicalJson,
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  hashRequest,
  markAcquirerAttempt,
  ownsAcquirerAttempt,
  releaseAcquirerAttempt,
  takeOverAcquirerAttempt,
} from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { serializeTransaction, type TransactionRow } from "../transactions/serialize.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

// YA: part of the idempotency scope, never rename it
const ENDPOINT = "transactions.authorize";

export interface AuthorizeInput {
  merchantId: string;
  amountFils: Fils;
  card: SimulatedCardInput;
  reference?: string;
  idempotencyKey: string;
  /** Who is performing this authorization, for the transaction_events
   *  audit trail. Optional because the hosted-checkout payment-link flow
   *  has no merchant session or API key of its own; defaults to a 'system'
   *  actor when omitted. POST /v1/transactions always supplies the calling
   *  API key here. */
  actor?: { type: "merchant_session" | "merchant_api_key" | "system"; id?: string | null };
  /** Keys the card fingerprint in the idempotency request hash; from
   *  deriveCardFingerprintKey(config.webhookSecretEncryptionKey). */
  cardFingerprintKey: Buffer;
}

/**
 * The HMAC key for the card fingerprint below: HKDF of the platform secret
 * WEBHOOK_SECRET_ENCRYPTION_KEY (required in every environment) under its own
 * label, so the AES key itself is never used for it. Every instance of a
 * deployment derives the same key, so a retry that reaches another instance,
 * or comes after a restart, hashes (and keys the acquirer call) the same.
 */
export function deriveCardFingerprintKey(webhookSecretEncryptionKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(webhookSecretEncryptionKey, "base64"), Buffer.alloc(0), "filspay/idempotency-card-fingerprint/v1", 32),
  );
}

/**
 * What the idempotency request hash records about the card: an HMAC of the
 * PAN and expiry under a server secret. The request hash is stored
 * (idempotency_keys.request_hash), and it used to hash the whole card, CVV
 * included, with plain sha256: knowing the amount and reference, the CVV
 * fell out of 1,000 guesses, and a known BIN, the Luhn digit and the expiry
 * leave a PAN search small enough to run. The CVV must never be stored in
 * any form, so it is not in the fingerprint: a retry differing only in the
 * CVV is the same request. Another PAN or expiry is still another request.
 */
function cardFingerprint(card: SimulatedCardInput, key: Buffer): string {
  return createHmac("sha256", key)
    .update(canonicalJson({ pan: card.pan, expiryMonth: card.expiryMonth, expiryYear: card.expiryYear }))
    .digest("hex");
}

/**
 * 201 + serialized transaction on approval; 402 on decline (replays as
 * 402); 403 when the merchant is not approved; 502 on acquirer error, in
 * which case the same key may be retried.
 */
export interface AuthorizeResult {
  statusCode: number;
  body: unknown;
}

/**
 * `POST /v1/transactions` business logic, in two short transactions with the
 * acquirer call between them and no pool connection held during it: claim
 * idempotency -> check merchant approval -> mark the claim in flight; call
 * the acquirer; then, on approval, insert the transaction + hold +
 * 'authorized' event. A decline or acquirer error never produces a
 * `transactions` row (the status CHECK has no 'declined' value) — the only
 * durable trace of such an attempt is its idempotency_keys row.
 */
export async function authorizeTransaction(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: AuthorizeInput,
): Promise<AuthorizeResult> {
  const actor = input.actor ?? { type: "system" as const, id: null };
  const requestHash = hashRequest({
    amountFils: input.amountFils,
    card: cardFingerprint(input.card, input.cardFingerprintKey),
    reference: input.reference ?? null,
  });

  const prepared = await withTransaction(pool, async (client) => {
    let claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      // Nothing to complete — this claim attempt itself is rejected.
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      // Another attempt with this key is at the acquirer (409, retry later),
      // or its process died: then this request takes it over.
      const takenOver = await takeOverAcquirerAttempt(client, claim.row);
      if (!takenOver) {
        throw new ConflictError("request_in_progress");
      }
      claim = { outcome: "retry_after_failure", row: takenOver };
    }
    if (claim.outcome === "replay") {
      return { settled: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody } };
    }
    // 'fresh' / 'retry_after_failure' — continue.

    const merchantResult = await client.query<{ onboarding_status: string; mdr_bps: number; status: string }>(
      `SELECT onboarding_status, mdr_bps, status FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const merchant = merchantResult.rows[0];
    // FH: should test_mode merchants be blocked here? Claude said yes and gave this:
    //   if (merchant.test_mode) {
    //     return { statusCode: 403, body: { error: "test_mode_merchant" } };
    //   }
    // am: NO. test mode merchants have to authorize, thats the whole point of sandbox. ignore
    if (!merchant || merchant.onboarding_status !== "approved") {
      const body = { error: "merchant_not_approved" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 403, body });
      return { settled: { statusCode: 403, body } };
    }
    // A suspended or closed merchant takes no payments. API keys and sessions
    // already refuse it, but the public payment-link checkout reaches here
    // with no merchant credential, so it is checked here for every caller.
    if (merchant.status !== "active") {
      const body = { error: "merchant_not_active" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 403, body });
      return { settled: { statusCode: 403, body } };
    }

    const attemptId = await markAcquirerAttempt(client, claim.row.id);
    return { claim: claim.row, attemptId };
  });
  if ("settled" in prepared) {
    return prepared.settled!;
  }
  const { claim, attemptId } = prepared;

  try {
    // No DB connection is checked out during this call.
    const acquirerResult = await acquirer.authorize({
      merchantId: input.merchantId,
      amountFils: input.amountFils,
      currency: "BHD",
      card: input.card,
      idempotencyKey: acquirerIdempotencyKey(claim),
    });
    return await withTransaction(pool, (client) => recordAuthorization(client, claim.id, attemptId, acquirerResult, input, actor));
  } catch (err) {
    await releaseAcquirerAttempt(pool, claim.id, attemptId);
    throw err;
  }
}

async function recordAuthorization(
  client: PoolClient,
  claimId: string,
  attemptId: string,
  acquirerResult: AcquirerAuthorizeResult,
  input: AuthorizeInput,
  actor: NonNullable<AuthorizeInput["actor"]>,
): Promise<AuthorizeResult> {
  if (!(await ownsAcquirerAttempt(client, claimId, attemptId))) {
    // A same-key retry took this attempt over (it was stale) and records
    // the outcome itself, from the same acquirer key.
    throw new ConflictError("request_in_progress");
  }

  if (acquirerResult.outcome === "approved") {
    const insertResult = await client.query<TransactionRow>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference)
       VALUES ($1, 'authorized', $2, 0, $3, $4)
       RETURNING *`,
      [input.merchantId, input.amountFils, acquirerResult.acquirerReference, input.reference ?? null],
    );
    const txnRow = insertResult.rows[0];
    if (!txnRow) {
      throw new Error("authorizeTransaction: insert into transactions returned no row");
    }

    // MK: 7 days = scheme rule for CNP. expire_holds.ts only flips status to expired,
    // it never deletes, so the hold history stays
    await client.query(
      `INSERT INTO holds (merchant_id, transaction_id, amount_fils, status, expires_at)
       VALUES ($1, $2, $3, 'active', now() + interval '7 days')`,
      [input.merchantId, txnRow.id, input.amountFils],
    );

    await recordTransactionEvent(client, {
      transactionId: txnRow.id,
      eventType: "authorized",
      actor,
    });

    // No outbox event: nothing consumes 'transaction.authorized', so
    // packages/events doesn't define it.

    const body = serializeTransaction(txnRow);
    await completeIdempotencyKey(client, claimId, { statusCode: 201, body, resourceId: txnRow.id });
    return { statusCode: 201, body };
  }

  if (acquirerResult.outcome === "declined") {
    const body = {
      error: "card_declined",
      declineReason: acquirerResult.declineReason,
      acquirerReference: acquirerResult.acquirerReference,
    };
    await completeIdempotencyKey(client, claimId, { statusCode: 402, body });
    return { statusCode: 402, body };
  }

  // outcome === 'error'
  const body = { error: "acquirer_unavailable" };
  await failIdempotencyKey(client, claimId, { statusCode: 502, body });
  return { statusCode: 502, body };
}
