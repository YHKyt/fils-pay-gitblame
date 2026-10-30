# Fix pack 1 — corrections to earlier fixes

Findings from the review round of our own fixes (rev3), each reproduced at the
`fix/money-parsing` tip, fixed with the smallest change and covered by a
regression test that fails on the old code and passes on the fix.

## FX1 One payment link can be captured twice after a capture throw — HIGH

**Where:** `apps/api/src/paymentLinks/pay.ts` (catch around `captureTransaction`, from fd93eb4).
**Evidence:** `pay.doubleCharge.test.ts` "a capture that throws after the acquirer approved cannot be followed by a second capture": old code answers the second payer `200` (`200 !== 409`) and the acquirer records two approved captures for one link.

- **What:** When `captureTransaction` threw, the catch put the link back to `reserved` with `transaction_id = NULL`. After the 60 s reservation timeout any payer could claim it again.
- **Why:** A throw does not mean "nothing happened at the acquirer". The capture runs the acquirer call and then journals inside one DB transaction; a DB failure after the acquirer approved (journal insert, commit, connection loss) rolls back our rows but not the acquirer's capture. Reopening the link on that unknown outcome is the unsafe direction.
- **Breaks:** Two cards are captured for one payment link; the first capture is invisible in our ledger.
- **Fix:** Remove the revert. On a throw the link stays `paid` against the authorized transaction (the safe direction: at worst a merchant has an authorization to capture or void from the dashboard). FX2 makes the public read and the pay endpoint report such a link as `processing` instead of `paid`. Deleting the block is the smallest change; no new state.
- **Test:** The existing test "a capture that throws does not leave the link showing paid" asserted the buggy revert (`reserved`, no transaction); it now asserts `paid` with the transaction kept. New test above uses a trigger that fails the `capture: gross` journal insert after the acquirer approved.

## FX2 A payment link reads 'paid' before any money moves — HIGH

**Where:** `apps/api/src/paymentLinks/status.ts` (`derivePublicStatus`), `read.ts`, `pay.ts` (`classifyClaimFailure`); `apps/web/src/pages/checkout/CheckoutPage.tsx`. Introduced by abdbc70 (finalize before capture).
**Evidence:** `pay.doubleCharge.test.ts` "while capture runs the link reads 'processing', not 'paid'" and the throw test: old code returns public status `paid` while the capture is held at the acquirer and after a capture throw, and the second payer gets `payment_link_already_paid`. `status.test.ts` "stored 'paid' whose transaction is still authorized" fails on the old helper.

- **What:** abdbc70 correctly moved the `reserved -> paid` finalize in front of capture so only one request can capture. But the public read and the pay endpoint's error path only looked at `payment_links.status`, so they reported `paid` from the moment of finalize.
- **Why:** `paid` on the link no longer implies the transaction was captured. If capture declines the link goes back to `active` (the customer was told it was paid); if the process dies between finalize and capture (or capture throws, FX1) the link says `paid` forever over an authorization that never settles.
- **Breaks:** A customer or merchant sees "paid" for money that never moved; a second payer is told "already paid" on a link that may yet reopen.
- **Fix:** Join the link's transaction. A `paid` link whose transaction is still `authorized` reads `processing` (public GET) and answers `409 payment_link_processing` (pay). The checkout's "processing" view now re-reads the link every 2 s instead of asking for a manual refresh, so its receipt only appears once capture landed (the lost-response poll already waited for `paid`, which now means captured). One optional field on the shared helper keeps read and pay consistent.
- **Test:** Two new DB tests (gated capture; capture throw) and two unit tests on `derivePublicStatus`.
