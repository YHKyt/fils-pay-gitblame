import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "../lib/crypto.js";

/**
 * Webhook signing: canonical (key-order-independent) serialization, a
 * timestamped Stripe-`t=...,v1=...`-style signature scheme, and a
 * constant-time comparison in verifySignature.
 *
 * — YA: wrote this one slowly. read it before copying it.
 */

export interface SignedPayload {
  /** unix seconds, the value folded into the signature */
  timestamp: number;
  /** header value: "t=<timestamp>,v1=<hex-hmac-sha256>" */
  signature: string;
}

/**
 * Computes the header value a delivery carries. `secret` is the raw
 * (decrypted) webhook secret — callers must decrypt
 * webhook_endpoints.secret_ciphertext (webhooks/secretCrypto.ts) before
 * calling this; sign.ts itself never touches encryption, only signing.
 *
 * Signs `${timestamp}.${body}` where body is the EXACT string sent on the
 * wire. Pass the serialized body (a string) — the dispatcher serializes once
 * and signs and sends those same bytes. It used to sign canonicalJson(payload)
 * but send JSON.stringify(payload): different key order, so every receiver
 * verifying the raw body got a mismatch. A non-string is JSON.stringify'd.
 *
 * Not the payload alone,
 * so a receiver can enforce its own freshness window using only what's in
 * the header — a captured genuine delivery can't be replayed by a third
 * party at an arbitrary later time with a signature that still looks fresh.
 */
export function signPayload(
  payload: unknown,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedPayload {
  const signedString = `${timestamp}.${bodyBytes(payload)}`;
  const signature = createHmac("sha256", secret).update(signedString).digest("hex");
  return { timestamp, signature: `t=${timestamp},v1=${signature}` };
}

/** The exact bytes that are (or were) on the wire. */
export function bodyBytes(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

interface ParsedSignatureHeader {
  timestamp: number;
  /** Every v1 value: during a secret rotation a sender may sign with both. */
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestampStr: string | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1" && value) signatures.push(value);
  }

  if (!timestampStr || signatures.length === 0) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signatures };
}

export type VerifySignatureFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifySignatureResult {
  valid: boolean;
  reason?: VerifySignatureFailureReason;
}

/**
 * Re-derives the expected signature and compares constant-time
 * (`timingSafeEqualHex`, never `===`). Used by the end-to-end tests (the
 * local receiver checks what the dispatcher actually sent) and meant for a
 * "test your webhook secret" merchant tool.
 */
// `secret` may be a list for key rotation: the current secret plus the
// previous one(s) still inside their grace window. Any (secret, v1) match is
// accepted. Pass the raw request body string for `payload`.
export function verifySignature(
  payload: unknown,
  header: string,
  secret: string | readonly string[],
  options?: { toleranceSeconds?: number; now?: number },
): VerifySignatureResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const signedString = `${parsed.timestamp}.${bodyBytes(payload)}`;
  const secrets = (typeof secret === "string" ? [secret] : secret).filter((s) => s !== "");
  let matched = false;
  for (const candidate of secrets) {
    const expected = createHmac("sha256", candidate).update(signedString).digest("hex");
    for (const sig of parsed.signatures) {
      // no early exit: compare every pair so timing doesn't reveal which matched
      if (timingSafeEqualHex(expected, sig)) matched = true;
    }
  }
  if (!matched) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}
