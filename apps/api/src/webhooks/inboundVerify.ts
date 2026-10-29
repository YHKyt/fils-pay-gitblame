import { verifySignature, type VerifySignatureFailureReason } from "./sign.js";

/**
 * Verifies the signature on an inbound acquirer callback. Same
 * `t=<unix seconds>,v1=<hex hmac>` scheme as our outbound webhooks
 * (webhooks/sign.ts), so it reuses that verifier:
 *
 * - over the RAW request bytes, not a re-serialization of the parsed body
 *   (JSON.stringify of a parsed object is not guaranteed to reproduce what
 *   the acquirer signed);
 * - constant-time compare (the old Buffer.compare was not);
 * - freshness window, so a captured callback can't be replayed later;
 * - several secrets accepted during a key rotation (current + previous).
 *
 * A missing header is a failure unless signatures are explicitly not
 * required — it used to be accepted by default, so anyone could post a
 * forged fraud verdict.
 */
export type VerifyAcquirerCallbackFailureReason = VerifySignatureFailureReason | "missing_signature";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

/** `ACQUIRER_CALLBACK_SIGNING_SECRET` may hold "current,previous" during a rotation. */
export function parseSecretList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function verifyAcquirerCallbackSignature(
  rawBody: string,
  header: string | undefined,
  secrets: string | readonly string[],
  requireSignature = true,
  options?: { toleranceSeconds?: number; now?: number },
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature ? { valid: false, reason: "missing_signature" } : { valid: true };
  }
  const list = typeof secrets === "string" ? parseSecretList(secrets) : secrets;
  if (list.length === 0) return { valid: false, reason: "signature_mismatch" };
  return verifySignature(rawBody, header, list, options);
}
