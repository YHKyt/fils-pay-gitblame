import type { PaymentLinkPublicDto, PublicPaymentLinkStatus } from "../types.js";

/**
 * Recovery after a pay request whose outcome is unknown (timeout, network
 * drop, a 5xx that may have come after the charge). Re-paying blind is how
 * a customer gets charged twice, so the checkout first asks the public
 * read what happened to the link.
 */

/** Pay outcomes that leave "was I charged?" unanswered. A 502 is the
 *  acquirer's own definitive "unavailable" and a 4xx is a real answer. */
export function isOutcomeUnknown(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== "number") return true; // network error / timeout
  return statusCode >= 500 && statusCode !== 502;
}

/**
 * Pay answers that end this attempt, so the next "Pay" is a new one with a
 * new Idempotency-Key. `409 payment_link_processing` / `request_in_progress`
 * mean "a payment for this link is still in flight" (possibly this very
 * attempt): a new key there would start a second authorization next to the
 * first, which is then left holding the card. 5xx and 429 keep the key too.
 */
export function endsCheckoutAttempt(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { statusCode, code } = err as { statusCode?: unknown; code?: unknown };
  if (typeof statusCode !== "number") return false;
  if (statusCode >= 500 || statusCode === 429) return false;
  if (statusCode === 409 && (code === "payment_link_processing" || code === "request_in_progress")) return false;
  return true;
}

export type LostPaymentResolution =
  /** The link is paid: show the receipt, never offer to pay again. */
  | { kind: "paid"; link: PaymentLinkPublicDto }
  /** Still payable, nothing went through: re-pay is allowed (same key). */
  | { kind: "retryable"; link: PaymentLinkPublicDto }
  /** Expired or canceled meanwhile: nothing more to do. */
  | { kind: "closed"; link: PaymentLinkPublicDto }
  /** Still processing after every poll, or the link could not be read:
   *  re-pay only with the same key, which the server deduplicates. */
  | { kind: "unknown" };

export function classifyPolledStatus(
  status: PublicPaymentLinkStatus,
): "paid" | "retryable" | "closed" | "pending" {
  switch (status) {
    case "paid":
      return "paid";
    case "active":
      return "retryable";
    case "expired":
    case "canceled":
      return "closed";
    case "processing":
      return "pending";
  }
}

export interface PollOptions {
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls the public read until the link leaves 'processing' (or attempts run out). */
export async function resolveLostPayment(
  getLink: () => Promise<PaymentLinkPublicDto>,
  { attempts, delayMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: PollOptions,
): Promise<LostPaymentResolution> {
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(delayMs);
    let link: PaymentLinkPublicDto;
    try {
      link = await getLink();
    } catch {
      continue;
    }
    const verdict = classifyPolledStatus(link.status);
    if (verdict !== "pending") return { kind: verdict, link };
  }
  return { kind: "unknown" };
}
