import type { PaymentLinkStatus } from "../types.js";

export type PaymentLinkDisplayStatus = PaymentLinkStatus | "expired";

/**
 * The status to show a merchant. The stored status never becomes 'expired'
 * (nothing sweeps links), so an 'active' row past its expiry is shown as
 * expired, by the same rule as the API's public read
 * (apps/api/src/paymentLinks/status.ts: active && expires_at <= now ->
 * expired). Every other stored status is shown as is, 'reserved' included.
 */
export function paymentLinkDisplayStatus(
  link: { status: PaymentLinkStatus; expiresAt: string },
  now: Date = new Date(),
): PaymentLinkDisplayStatus {
  if (link.status === "active" && new Date(link.expiresAt).getTime() <= now.getTime()) {
    return "expired";
  }
  return link.status;
}

/**
 * Cancel is offered only for a link that can still be paid. That includes an
 * unexpired 'reserved' link: its reservation may have lapsed (the payer's
 * attempt died), in which case it is payable again and the API cancels it;
 * while a payment is genuinely in flight the API answers 409 not_cancelable.
 */
export function canCancelPaymentLink(
  link: { status: PaymentLinkStatus; expiresAt: string },
  now: Date = new Date(),
): boolean {
  const status = paymentLinkDisplayStatus(link, now);
  if (status === "active") return true;
  return status === "reserved" && new Date(link.expiresAt).getTime() > now.getTime();
}
