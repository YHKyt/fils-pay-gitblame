import { enumLabel } from "../../format.js";

/** First eight hex digits of a UUID — enough to tell rows apart at a glance. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The category plus the operator's typed note: "Goodwill — agreed on the call". */
export function creditReasonText(reasonCode: string, memo: string | null | undefined): string {
  const category = enumLabel(reasonCode);
  const note = memo?.trim();
  return note ? `${category} — ${note}` : category;
}

/** Merchant name for a credit row, or `null` while it is still loading
 *  (or the lookup failed) so the caller can fall back to the short id. */
export function merchantName(
  names: ReadonlyMap<string, string>,
  merchantId: string,
): string | null {
  return names.get(merchantId) ?? null;
}
