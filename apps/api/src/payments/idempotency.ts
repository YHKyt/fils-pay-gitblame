import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * Generic, endpoint-agnostic request idempotency, backed by the
 * `idempotency_keys` table (see db/migrations/0019). Shared by
 * `transactions.authorize` and `transactions.capture`.
 // MK: refunds reuse it too. ✓
 */

export interface IdempotencyKeyRow {
  id: string;
  merchantId: string;
  endpoint: string;
  key: string;
  requestHash: string;
  status: "in_progress" | "completed" | "failed";
  attemptCount: number;
  responseStatusCode: number | null;
  responseBody: unknown;
  resourceId: string | null;
}

export type IdempotencyOutcome =
  | "fresh" // first time this (merchant, endpoint, key) has been seen — proceed
  | "retry_after_failure" // a prior attempt failed transiently — proceed, attemptCount incremented
  | "replay" // a prior attempt completed — caller replays row.responseBody verbatim
  | "conflict_hash_mismatch" // same key, different request body — reject, never proceed
  | "conflict_in_progress"; // a committed in_progress row (refunds only: in flight, or left by a dead process) — reject; processRefund may take over a stale one

/** row is always the persisted idempotency_keys row as of the claim; for "replay" it carries the stored response. */
export interface IdempotencyClaim {
  outcome: IdempotencyOutcome;
  row: IdempotencyKeyRow;
}

/**
 * Recursively sorts object keys before JSON.stringify, so the resulting
 * string — and therefore the hash below — does not depend on the order a
 * client happened to write its JSON body in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    // YA: Claude flagged `<` as locale dependent, suggested a.localeCompare(b) instead
    // FH: no. < on strings is code-unit order and deterministic. localeCompare is the
    // locale-dependent one. leave it
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      sorted[key] = sortKeysDeep(entryValue);
    }
    return sorted;
  }
  return value;
}

/**
 * sha256Hex(canonicalJson(body)). Unkeyed, and stored as
 * idempotency_keys.request_hash: never pass card data or another secret in
 * `body` (authorize passes a keyed card fingerprint, not the card).
 */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * The idempotency key sent to the acquirer for this claim's current attempt.
 *
 * Derived only from what the client controls (merchant, endpoint, key, the
 * request hash) plus the attempt number — never from the claim row's id.
 * An authorize/capture acquirer call that throws (a timeout: the acquirer
 * may already have acted) gives its claim up (releaseAcquirerAttempt), and
 * the retry takes it over with the same attempt number; before the claim
 * was committed ahead of the call, the throw rolled the row back and the
 * retry got a NEW row id. A row-id-based key made that retry a brand-new
 * charge at the acquirer; this one is identical, so the acquirer replays
 * its first answer. The attempt
 * number still changes after a recorded, definitive acquirer 'error'
 * (failIdempotencyKey), where a fresh attempt is wanted.
 */
export function acquirerIdempotencyKey(row: IdempotencyKeyRow): string {
  const scope = createHash("sha256")
    .update(canonicalJson([row.merchantId, row.endpoint, row.key, row.requestHash]))
    .digest("hex");
  return `${scope}:${row.attemptCount}`;
}

interface IdempotencyKeyDbRow {
  id: string;
  merchant_id: string;
  endpoint: string;
  key: string;
  request_hash: string;
  status: "in_progress" | "completed" | "failed";
  attempt_count: number;
  response_status_code: number | null;
  response_body: unknown;
  resource_id: string | null;
}

/** snake_case -> camelCase. response_body is jsonb, so pg hands it back already parsed. */
function toRow(row: IdempotencyKeyDbRow): IdempotencyKeyRow {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    endpoint: row.endpoint,
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    responseStatusCode: row.response_status_code,
    responseBody: row.response_body,
    resourceId: row.resource_id,
  };
}

/**
 * Must be called inside an open transaction (the same `client` that will go
 * on to do the row-locked business work), using the exact three-part key
 * (merchantId, endpoint, key) as the idempotency scope.
 *
 * The concurrency guarantee depends on this precise sequence: the INSERT
 * relies on Postgres's own unique-index insert blocking. If a different,
 * still-uncommitted transaction currently holds this key, our INSERT blocks
 * until that transaction ends — no application-level "is this key locked"
 * polling is needed. Two concurrent requests with the same idempotency key
 * naturally serialize on Postgres's own index, for free.
 */
export async function claimIdempotencyKey(
  client: PoolClient,
  input: { merchantId: string; endpoint: string; key: string; requestHash: string },
): Promise<IdempotencyClaim> {
  // perf: idempotency_keys is 4M rows on staging and this ON CONFLICT seq scans — am 10/09/2026
  // MK: there's a unique index, it can't seq scan. run EXPLAIN
  // am: index scan on staging-2 but not staging-1?? will look later
  const insertResult = await client.query<IdempotencyKeyDbRow>(
    `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id, endpoint, key) DO NOTHING
     RETURNING *`,
    [input.merchantId, input.endpoint, input.key, input.requestHash],
  );

  const insertedRow = insertResult.rows[0];
  if (insertedRow) {
    // Nobody else has ever claimed this key (or a prior claim was rolled
    // back entirely, e.g. the process crashed before committing anything).
    return { outcome: "fresh", row: toRow(insertedRow) };
  }

  // The UNIQUE (merchant_id, endpoint, key) index already has an entry. By
  // the time this SELECT runs, the winner's row (or its absence, if it
  // rolled back) is visible under read-committed.
  const existingResult = await client.query<IdempotencyKeyDbRow>(
    `SELECT * FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
    [input.merchantId, input.endpoint, input.key],
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new Error("claimIdempotencyKey: conflicting row vanished before it could be read");
  }

  if (existing.request_hash !== input.requestHash) {
    // The same key was reused for a logically different request. Reject;
    // never proceed under any circumstances.
    return { outcome: "conflict_hash_mismatch", row: toRow(existing) };
  }

  if (existing.status === "completed") {
    // The caller returns existing.responseStatusCode/responseBody verbatim,
    // does nothing else, and never re-touches transactions/ledger_entries.
    return { outcome: "replay", row: toRow(existing) };
  }

  if (existing.status === "failed") {
    // `AND status = 'failed'`: two retries can both read 'failed' above. The
    // second UPDATE waits for the first's row lock and then re-checks the
    // row; without the status condition it re-opened a key the first retry
    // had just completed (or still holds), and ran the operation twice under
    // one key (concfuzz: one 2,000 capture request captured 4,000).
    const updateResult = await client.query<IdempotencyKeyDbRow>(
      `UPDATE idempotency_keys SET status = 'in_progress', attempt_count = attempt_count + 1
       WHERE id = $1 AND status = 'failed'
       RETURNING *`,
      [existing.id],
    );
    const updated = updateResult.rows[0];
    if (!updated) {
      // Another retry re-opened the key first: classify again, which now
      // gives its replay or conflict_in_progress.
      return claimIdempotencyKey(client, input);
    }
    return { outcome: "retry_after_failure", row: toRow(updated) };
  }

  // existing.status === 'in_progress'. The admin actions claim, act and
  // record the outcome in ONE transaction, so their in_progress row is never
  // committed: a concurrent request blocks on the INSERT above instead, and a
  // crash rolls the claim back. authorize, capture and refunds.create commit
  // their claim before the acquirer call, so that no pool connection is held
  // while the acquirer runs: a same-key request lands here while that attempt
  // is in flight, and for good if its process died. There is no sweeper
  // (scripts/sweep_idempotency.ts never existed); processRefund and
  // takeOverAcquirerAttempt (authorize, capture) take over a stale attempt
  // themselves and resend its acquirer key. Marking such a row 'failed'
  // instead is NOT safe: the retry would run as a new attempt, with a new
  // acquirer key, and could charge or refund the card a second time.
  return { outcome: "conflict_in_progress", row: toRow(existing) };
}

/**
 * authorize / capture: an attempt at the acquirer whose claim is older than
 * this is taken to be dead (its process crashed), so a same-key retry may
 * take it over, and a capture's reservation stops counting. Far longer than
 * any acquirer call.
 */
export const ACQUIRER_ATTEMPT_STALE_SECONDS = 5 * 60;

/**
 * Marks a fresh / retried authorize or capture claim as being at the
 * acquirer, in the transaction that validated it, so both commit together
 * before the acquirer is called with no connection held. `reservedFils` and
 * `resourceId` are the capture's reservation: the amount and the transaction
 * it is being captured from (activeCaptureReservationFils). Returns this
 * attempt's fence token (ownsAcquirerAttempt).
 */
export async function markAcquirerAttempt(
  client: PoolClient,
  claimId: string,
  reservation?: { resourceId: string; reservedFils: number },
): Promise<string> {
  const attemptId = randomUUID();
  await client.query(
    `UPDATE idempotency_keys
        SET response_body = jsonb_build_object(
              'acquirerOutcome', 'in_flight', 'attemptId', $2::text, 'claimedAt', now(),
              'reservedFils', $3::bigint),
            resource_id = COALESCE($4::uuid, resource_id)
      WHERE id = $1`,
    [claimId, attemptId, reservation?.reservedFils ?? 0, reservation?.resourceId ?? null],
  );
  return attemptId;
}

/**
 * A same-key request found the key in_progress (conflict_in_progress). If
 * that attempt is dead (claimed more than ACQUIRER_ATTEMPT_STALE_SECONDS ago,
 * or released by releaseAcquirerAttempt after its call threw), this request
 * takes it over and runs it again from the top with the SAME attempt_count,
 * so acquirerIdempotencyKey is unchanged and the acquirer replays whatever
 * the dead attempt got. That is what the old single transaction did: a
 * crash or a throw rolled the claim back and the retry reclaimed it with the
 * same attempt number. Returns null when the attempt is still live (409).
 */
export async function takeOverAcquirerAttempt(client: PoolClient, row: IdempotencyKeyRow): Promise<IdempotencyKeyRow | null> {
  const result = await client.query<IdempotencyKeyDbRow>(
    `UPDATE idempotency_keys SET response_body = NULL
      WHERE id = $1 AND status = 'in_progress'
        AND response_body->>'acquirerOutcome' = 'in_flight'
        AND (response_body->>'claimedAt')::timestamptz < now() - make_interval(secs => $2)
      RETURNING *`,
    [row.id, ACQUIRER_ATTEMPT_STALE_SECONDS],
  );
  const updated = result.rows[0];
  return updated ? toRow(updated) : null;
}

/**
 * Locks this attempt's claim row. False once its claim was released or a
 * later request took it over, so a slow attempt can never record its result
 * on top of the one that replaced it.
 */
export async function ownsAcquirerAttempt(client: PoolClient, claimId: string, attemptId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM idempotency_keys
      WHERE id = $1 AND status = 'in_progress' AND response_body->>'attemptId' = $2
        FOR UPDATE`,
    [claimId, attemptId],
  );
  return result.rows.length > 0;
}

/**
 * The attempt threw (an acquirer timeout, a DB fault while recording): as
 * the old single transaction's ROLLBACK did, give the claim up at once. Its
 * capture reservation stops counting and a same-key retry takes it over with
 * the same acquirer key. Best effort: if this fails too, the claim goes
 * stale after ACQUIRER_ATTEMPT_STALE_SECONDS.
 */
export async function releaseAcquirerAttempt(pool: Pool, claimId: string, attemptId: string): Promise<void> {
  await pool
    .query(
      `UPDATE idempotency_keys
          SET response_body = jsonb_set(response_body, '{claimedAt}', to_jsonb('epoch'::timestamptz))
        WHERE id = $1 AND status = 'in_progress' AND response_body->>'attemptId' = $2`,
      [claimId, attemptId],
    )
    .catch(() => undefined);
}

/**
 * The amount of transaction `transactionId` held by captures that are at the
 * acquirer right now (live claims marked by markAcquirerAttempt). Capture
 * treats it as already captured, and void refuses while it is non-zero: this
 * is what the row lock held across the acquirer call used to guarantee.
 * `exceptClaimId` leaves the caller's own claim out.
 */
export async function activeCaptureReservationFils(
  client: PoolClient,
  transactionId: string,
  exceptClaimId: string | null = null,
): Promise<number> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM((response_body->>'reservedFils')::bigint), 0)::text AS total
       FROM idempotency_keys
      WHERE resource_id = $1 AND status = 'in_progress' AND endpoint = 'transactions.capture'
        AND id IS DISTINCT FROM $2::uuid
        AND response_body->>'acquirerOutcome' = 'in_flight'
        AND (response_body->>'claimedAt')::timestamptz >= now() - make_interval(secs => $3)`,
    [transactionId, exceptClaimId, ACQUIRER_ATTEMPT_STALE_SECONDS],
  );
  return Number(result.rows[0]!.total);
}

/**
 * Marks a claim as durably, permanently completed — used for BOTH a
 * successful operation and a definitive business rejection (a decline, a
 * 404, a 409/422 validation failure) that should replay identically on a
 * retry with the same key, because re-attempting it would produce the same
 * answer every time.
 */
export async function completeIdempotencyKey(
  client: PoolClient,
  id: string,
  result: { statusCode: number; body: unknown; resourceId?: string },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'completed',
            response_status_code = $2,
            response_body = $3,
            resource_id = $4,
            completed_at = now()
      WHERE id = $1`,
    [id, result.statusCode, JSON.stringify(result.body), result.resourceId ?? null],
  );
}

/**
 * Marks a claim as transiently failed — used ONLY for outcomes where
 * nothing durable happened and a retry should genuinely re-attempt the
 * operation (the simulated acquirer's 'error' outcome; an unexpected
 * infrastructure fault caught before rethrowing). Never used for a
 * decline — a decline is a definitive answer from the acquirer and must
 * replay identically, not be retried into a different outcome.
 */
export async function failIdempotencyKey(
  client: PoolClient,
  id: string,
  result: { statusCode: number; body: unknown },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'failed',
            response_status_code = $2,
            response_body = $3
      WHERE id = $1`,
    [id, result.statusCode, JSON.stringify(result.body)],
  );
}
