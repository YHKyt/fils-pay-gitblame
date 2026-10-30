/**
 * A v4-shaped UUID that does not depend on `crypto.randomUUID`.
 *
 * `crypto.randomUUID` only exists in a secure context: it is `undefined` on
 * plain http (anything but `localhost`), so calling it there throws and takes
 * the whole checkout down. The hosted box serves https with an http->https
 * redirect, so the dashboard and checkout normally load under https and
 * `crypto.randomUUID` is present — this is defence in depth for any path that
 * is ever reached over http (a LAN ip, a mis-set proxy, a judging box on
 * plain http).
 *
 * When `crypto.randomUUID` is available the result is identical in shape and
 * randomness; otherwise it is built from `crypto.getRandomValues`, which is
 * available in insecure contexts too. These keys are client-minted
 * Idempotency-Keys, never a bearer secret, so the fallback's only requirement
 * is uniqueness, which 122 random bits give.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // Version 4 and RFC 4122 variant bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  let hex = "";
  for (const b of bytes) hex += (b + 0x100).toString(16).slice(1);
  return (
    hex.slice(0, 8) + "-" +
    hex.slice(8, 12) + "-" +
    hex.slice(12, 16) + "-" +
    hex.slice(16, 20) + "-" +
    hex.slice(20, 32)
  );
}
