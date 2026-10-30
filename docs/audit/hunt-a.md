# hunt-a: payments, links, refunds, auth, admin money, webhooks

Branch `b/hunt-a`, from `fix/money-parsing` (`12ccd15`). Each finding has a
regression test that fails on the old code and passes with the fix.

## HA1. A suspended or closed merchant's payment links still charge customers — High

**Where:** `apps/api/src/payments/authorize.ts` (merchant gate), reached from `apps/api/src/paymentLinks/pay.ts`

- **What:** `authorizeTransaction` only checked `onboarding_status = 'approved'`. It never read `merchants.status`.
- **Why:** login, live sessions and API keys all refuse a merchant whose `status` is not `active` (`b/h2-auth-edges`). The public checkout (`POST /v1/payment-links/:token/pay`) has no merchant credential, so none of those gates ran. It called authorize and capture directly.
- **Breaks:** after a merchant is suspended (fraud review, compliance) or closed, every open link it had shared still authorized and captured the customer's card (200, `paid`). The money landed on a payable that settlement does not pay out to a suspended merchant, so the customer was charged and the funds were stuck.
- **Fix:** authorize refuses a merchant that is not `active` with 403 `merchant_not_active`, before the acquirer is called. The link answers `{ stage: "authorize", error: "merchant_not_active" }` and its reservation is released. The check sits in authorize so that every caller gets it, not just the checkout.
- **Test:** `apps/api/src/paymentLinks/pay.suspendedMerchant.test.ts` (suspended and closed). Before the fix: `200`, card authorized and captured. After: 403, no acquirer call, no transaction, link back to `active`.

## HA2. A declined refund after a status recompute leaves the transaction "refunded" for good — Medium

**Where:** `apps/api/src/payments/processRefund.ts` (step 3, reservation release), with `apps/api/src/admin/transactionStatusRecompute.ts`

- **What:** `processRefund` reserves the refund amount in `transactions.refunded_fils` before calling the acquirer and releases it on a decline or an acquirer error. The admin "Recompute transaction statuses" tool derives the status from `refunded_fils`, reservation included. Run while a refund is at the acquirer (or while a refund whose acquirer call timed out waits for its retry), it moves the row to `refunded` / `partially_refunded`. The release afterwards only gave the money back to `refunded_fils`. It left that status.
- **Why:** this is the same class as concfuzz CF1 (capture deriving from the reservation), on the recompute path. Nothing undid the status, and the recompute itself skips `refunded` rows, so the tool could not repair what it had caused.
- **Breaks:** a captured transaction with nothing refunded reads `refunded` in the dashboard, list filters, exports and reporting. `refundValidation` refuses `refunded`, so the merchant can no longer refund the customer at all. Before the fix both the `declined` and `error` cases ended `status = 'refunded'`, `refunded_fils = 0`.
- **Fix:** when the reservation is released, re-derive the status from what is left in `refunded_fils` and apply it only if it moves the row *down* the refund side (refunded > partially_refunded > captured/partially_captured). It never pushes a status up (another refund may still be in flight) and never touches statuses outside the refund lifecycle (chargeback, voided).
- **Test:** `apps/api/src/payments/refundDeclineAfterRecompute.test.ts` (declined and error). Before: `refunded`. After: `captured`, and a new refund of the full amount succeeds.

## HA3. Voiding a link payment whose capture timed out leaves the link "paid" — Medium

**Where:** `apps/api/src/payments/void.ts`, with `apps/api/src/paymentLinks/pay.ts` (capture-throw path)

- **What:** when the capture step of a link payment throws (an acquirer timeout, so the outcome is unknown), `pay.ts` deliberately keeps the link `paid` against its still-authorized transaction. It reads `processing` "until the merchant captures or voids the authorization". A merchant void only voided the transaction. The link stayed `paid` with a voided transaction.
- **Why:** nothing tied the void back to the link. `derivePublicStatus` reports `paid` for any `paid` link whose transaction is no longer `authorized`.
- **Breaks:** the checkout and the merchant's link list say **paid** although nothing was charged, so a merchant can ship goods for a payment that never happened. The customer cannot pay (409 `payment_link_already_paid`), and the merchant cannot cancel the link (`not_cancelable`, status paid). Nothing can recover the link.
- **Fix:** `voidTransaction` hands back any link finalized to the transaction it voids (`paid` -> `active`, `paid_at`/`transaction_id` cleared), in the same transaction as the void. This is what `pay.ts` already does when its own capture fails. Links of other attempts are not bound to the voided transaction, so they are unaffected.
- **Test:** `apps/api/src/paymentLinks/pay.voidProcessing.test.ts`. Before: public status `paid` after the void. After: the link is `active`, and a new payment captures once.
