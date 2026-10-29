/**
 * One Idempotency-Key per money-moving *intent* (a refund, a capture), not
 * per click and not per keystroke.
 *
 * An attempt pairs the key with the request it was sent for. Re-submitting
 * the same request after a lost response or a 5xx reuses the key, so the
 * server replays the first outcome instead of moving money twice. A
 * different request (another amount) gets a fresh key: the server hashes
 * the body and would reject the old key as reused. After a definitive
 * answer the caller clears the attempt, and the next submit starts a new
 * intent.
 */
export interface IdempotentAttempt {
  key: string;
  /** Canonical form of the request the key was sent with. */
  request: string;
}

/** The attempt to send `request` under: the previous one if it is the same
 *  request and still unresolved, otherwise a new one with a fresh key. */
export function attemptFor(
  previous: IdempotentAttempt | null,
  request: string,
  mintKey: () => string = () => crypto.randomUUID(),
): IdempotentAttempt {
  if (previous && previous.request === request) return previous;
  return { key: mintKey(), request };
}

/**
 * Whether a failed request got a final answer for its key, so the next
 * submit must be a new intent. Anything that is not an HTTP error (network
 * failure, timeout, abort) and any 5xx is not definitive: the request may
 * have been applied, and only a retry with the same key can find out
 * safely. `409 request_in_progress` and `429` mean "not processed yet",
 * so they keep the key too.
 */
export function isDefinitiveFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { statusCode, code } = err as { statusCode?: unknown; code?: unknown };
  if (typeof statusCode !== "number") return false;
  if (statusCode >= 500) return false;
  if (statusCode === 429) return false;
  if (statusCode === 409 && code === "request_in_progress") return false;
  return true;
}
