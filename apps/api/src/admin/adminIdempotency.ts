import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { BadRequestError, ConflictError, UnprocessableEntityError } from "../lib/errors.js";
import { claimIdempotencyKey, hashRequest } from "../payments/idempotency.js";

/** The console sends a UUID; anything longer than this is not a key. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Reads the Idempotency-Key header on an admin money action (issue credit,
 * adjust balance). Without a key a retried request after a timeout cannot
 * be told apart from a second request, and posts twice; the console sends
 * one key per form intent. The header stays optional so existing admin API
 * clients keep working (no key = the old behaviour), but a key that is sent
 * must be usable: an empty or over-long value is a 400, never ignored.
 */
export function readIdempotencyKeyHeader(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  if (header === undefined) return undefined;
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestError(
      "invalid_idempotency_key",
      `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return key;
}

export interface AdminIdempotencyScope {
  adminUserId: string;
  /** The merchant the action targets; must already be known to exist. */
  merchantId: string;
  /** e.g. 'admin.credits.create'. */
  endpoint: string;
  key: string;
  /** What the request hash covers: the same key with a different request is a 422. */
  request: unknown;
}

export type AdminIdempotencyClaim = { replay: unknown } | { claimId: string };

/**
 * Claims an admin action's Idempotency-Key inside the caller's transaction,
 * using the platform's idempotency_keys table and payments/idempotency.ts
 * exactly as authorize and capture do. The scope is (merchant, endpoint,
 * '<admin id>:<key>'), so a key is private to the admin who sent it: one
 * admin can never replay, or collide with, another admin's action.
 *
 * Because the claim and the money movement commit or roll back together, a
 * request that failed (5xx, crash) leaves no claim, and its retry runs
 * fresh; a request that succeeded leaves a completed claim, and its retry
 * gets the stored response without posting again. A concurrent duplicate
 * blocks on the unique index until the first commits, then replays it.
 */
export async function claimAdminIdempotencyKey(
  client: PoolClient,
  scope: AdminIdempotencyScope,
): Promise<AdminIdempotencyClaim> {
  const claim = await claimIdempotencyKey(client, {
    merchantId: scope.merchantId,
    endpoint: scope.endpoint,
    key: `${scope.adminUserId}:${scope.key}`,
    requestHash: hashRequest(scope.request),
  });

  switch (claim.outcome) {
    case "conflict_hash_mismatch":
      throw new UnprocessableEntityError(
        "idempotency_key_reused",
        "this Idempotency-Key was already used for a different request",
      );
    case "conflict_in_progress":
      throw new ConflictError("request_in_progress");
    case "replay":
      return { replay: claim.row.responseBody };
    default:
      // 'fresh' (or 'retry_after_failure'): proceed, then store the response
      // with completeIdempotencyKey(client, claimId, ...) before committing.
      return { claimId: claim.row.id };
  }
}
