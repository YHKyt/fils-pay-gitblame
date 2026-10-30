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
