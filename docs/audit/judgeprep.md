# Judge preparation: black-box suite against a fresh stack

`ops/e2e/judge-suite.mjs` now has one HTTP check (or a few) per case-file
item, on top of the original health, auth, checkout, refund, isolation and
settlement checks. It was run against a fresh `docker compose` stack
(`-p filspay-judgeprep`, NODE_ENV=production, seeded, web origin with `/v1`
proxied, `DATABASE_URL` only for OTP retrieval and the `(DB)` checks).

Last local run (after JP1): **167 passed, 4 failed, 0 skipped**. The four
failures are JP2, JP3 and JP4 below; none is in this lane's code.

## JP1. Reconciliation shows a gap after every CSV import, credit or journaled adjustment — Medium

**Where:** `apps/api/src/settlement/query.ts`, `getReconciliationReport`.
**Evidence:** suite run 1, check "FP-300 reconciliation for today explains to zero": `ledgerMerchantPayableNetFils 56839, pendingUnbatchedFils 37829, gapFils 19010, explained false`. 19010 fils is exactly the two 9505-fil CSV imports the run posted.

- **What:** `GET /v1/settlement/reconciliation` reports `explained: false` for any period that contains a journaled money correction: a CSV adjustment import, a journaled balance adjustment or an approved admin credit.
- **Why:** these corrections credit or debit `merchant_payable` with no transaction. Since migration 0113 the next close claims them (`settlement_batch_corrections`) and pays them out, like a refund. The report counts the ledger side (every `merchant_payable` leg) but its pending side only knew about unbatched captures and refunds, so an unclaimed correction was in the ledger figure and nowhere else.
- **Breaks:** finance's reconciliation never explains to zero after a manual correction. It is the "numbers still don't match" screen from the finance memo, now caused by the fix that made corrections settle.
- **Fix:** add one query for unclaimed correction groups in the window (same selection as the settlement service's `claimBatchCorrections`: `merchant_payable`, no transaction, no batch, a `merchant_credit_contra` or `manual_balance_adjustment_contra` leg in the group, not yet in `settlement_batch_corrections`) and add its net to pending. Once claimed, the claiming batch's net carries it, so it is not counted twice. This is the smallest change: one query, one line of arithmetic, no change to the response shape.
- **Test:** `apps/api/src/settlement/reconciliationCorrections.test.ts`. Fail-before: `not ok 1 - an unclaimed journaled adjustment is pending ... expected: 3755 actual: 0`. Pass-after: `pass 3, fail 0`. It also checks that a claimed correction is counted once and that an unbatched posting without a contra leg (the pre-fix March sweep) still shows as a gap.

## JP2. Recalculate MDR answers 500 on the seeded demo data — High (reported, seed lane)

**Where:** `db/seed/generate.ts` (seeded closed batches), surfaced by `apps/settlement/internal/settlement/recalculate_mdr.go` (`ErrBatchEventsIncomplete`) and `apps/api/src/admin/settlementClient.ts` (every non-2xx becomes 500).
**Evidence:** `POST /v1/admin/merchants/<Alpha>/mdr-recalculation {from: 120 days ago, to: today}` -> `500 settlement_run_failed`; settlement log: `batch 317d557d-... (2026-08-31) gross 7326913 fils, linked events 0 fils`.

- **What / Why:** the seed writes closed batches with no linked capture events, and RecalculateMDR correctly refuses to re-rate such a batch. On the hosted demo box any recalculation that covers August is a 500.
- **Status:** `agent/seeddemo` commit `08e1c27` (not merged when this ran) builds one batch per business day from real linked events, which removes the cause. Re-run this check after it merges. Separately, a refusal is not a server error: the internal API could answer 409 for `ErrBatchEventsIncomplete` and the API client could pass a 4xx through. That client is in the admin lane, so it is not changed here.

## JP3. The seed settles the test-mode merchant — Medium (reported, seed lane)

**Where:** `db/seed/generate.ts`, standard-merchant batches.
**Evidence:** admin merchant detail for Gamma Hospitality Group (`testMode: true`): `{"batchDate":"2026-08-31","status":"closed","grossFils":6141934,"netPayoutFils":5945391}`.

- **What / Why:** the platform never settles a test-mode merchant (`batch.go` filters `test_mode = false`; the live run-batch checks confirm it), but the seed writes a closed, money-carrying batch for Gamma. A judge checking "test merchants never show up in the real settlement run" against the demo data sees one. `08e1c27` on `agent/seeddemo` still includes Gamma in the per-day batches, so this needs its own change there: skip batches (and scheme export lines) for fixtures with `testMode: true`.

## JP4. Refund validation errors do not use the uniform error shape — Low (reported, B lane)

**Where:** `apps/api/src/payments/refundValidation.ts`, returned by `processRefund.ts`.
**Evidence:** refund of a fully refunded transaction -> `409 {"ok":false,"code":"transaction_not_refundable","status":"refunded"}`; every other error is `{ error, message }`.

- Already reported in `apihygiene.md`. A client or automated test reading `body.error` gets nothing. Belongs to the payments/idempotency lane (the stored replay body must change with it).

## JP5. Payout trends show a paid zero-net batch as closed — Low (reported)

**Where:** `apps/reporting/src/consumer/applyEvent.ts` with `apps/settlement/internal/settlement/payout_notify.go`.
**Evidence:** `GET /v1/analytics/payout-trends` -> batch `2026-10-29` `status: "closed", paidAt: null`, while `GET /v1/settlement/batches` shows it `paid`.

- The read model learns "paid" only from `settlement.paid`, which is enqueued only for a nonzero net payout. A batch with nothing to pay is marked paid but stays "closed" in the trends. Display only; not covered by a check.

## Checks and results

Result column: last local run on a fresh stack. `(DB)` checks need `DATABASE_URL`.

| Case-file item | Check | Result |
|---|---|---|
| Memo: CSV 4.755 BD -> 4.750 | import 4.755 + 4.75 -> 201 posted, total 9505 | pass |
| | row 4.755 -> 4755 fils; row 4.75 -> 4750 (not 475) | pass |
| | same file again -> 409, posted once; 4 decimals -> 400 | pass |
| | cached balance moves by exactly +9505 | pass |
| Memo / FP-203: Recalculate cached balances | rebuild -> 200; rebuild after the import leaves A unchanged | pass |
| Memo: fee shown 245 vs charged 225 | fee on a new capture = shown schedule (225 bps) | pass |
| Memo: MDR recalc changes paid batches | recalculation over seeded history -> 200 | **fail (JP2)** |
| | no paid batch adjusted; paid fee/net unchanged | not reached (needs JP2) |
| Memo: test merchants in the settlement run | full run-batch leaves the test merchant out | pass |
| | run-batch for the test merchant settles nothing | pass |
| | MDR recalculation on the test merchant not 5xx | **fail (JP2)** |
| | test merchant has no closed/paid batch with money | **fail (JP3)** |
| Memo: daily close at 3 am, not midnight | today (Asia/Bahrain) cannot be closed -> 422; finished day -> 200 | pass |
| | a capture made now counts in today's Bahrain business day | pass |
| Memo: login without the OTP | login -> otpRequired; password-only session -> 401 on links, keys, batches, transactions | pass |
| | reused OTP rejected; wrong codes -> 401 then 429, never a session; verify without login -> 401 | pass |
| Memo: cancel B's link from A | B session via A path -> 403/404; B key via B path -> 404; link still active | pass |
| | A cancels its own link -> 204; paying it -> 4xx | pass |
| FP-187 paid after expiry | backdated `submittedAt` on an expired link -> 410 (also with an API key) | pass |
| FP-201 duplicate callback notes | unsigned / forged / 1 h old signature -> 401 | pass |
| | same signed callback twice -> 200, 200; (DB) one note | pass |
| FP-209 concurrent refund | two concurrent full refunds -> one 200, other 4xx; 6 x 1000 on 3000 -> at most 3 | pass |
| FP-240 webhook signatures | endpoint secret shown once; `refund.succeeded` delivery signature verifies over `JSON.stringify(payload)` with the secret; timestamp current | pass |
| Incident 2026-05-14 link charged twice | 5 concurrent pays -> exactly one 200, rest 4xx; link records the winner; (DB) one captured transaction | pass |
| Incident 2026-08-21 duplicate payout notifications | (DB) at most one disbursement and one `settlement.paid` per batch | pass |
| Note: refund more than charged | captured + 1 -> 422; over remaining -> 422; no amount refunds exactly captured | pass |
| Note: splits a few fils short | (DB) child allocations sum to the parent net for every split batch | pass |
| Note: admin role checks | support admin -> 403 on run-batch, balance rebuild, reporting rebuild, CSV import, MDR recalc, balance adjustment, credit approve, import approve, key rotate | pass |
| | impersonation read-only: create link, refund -> 403; issue key -> 401/403 | pass |
| Note: key rotation | admin rotate -> new key works, old key 401; revoked key 401 at once | pass |
| Note: slow reporting query | summary, reporting transactions, export summary, reconciliation, volumes each < 2 s (3-8 ms) | pass |
| Note: really large export upload | 17 MB CSV -> 413, not 5xx; transaction export -> 200 | pass |
| FP-300: works through the API | three partial refunds -> 200; refund after full -> 409/422 | pass |
| | refund error body is `{ error, message }` | **fail (JP4)** |
| FP-300: money right in the ledger | first reversal = half-even pro-rata fee; reversals of a full refund sum to the whole fee; `refundedFils` = captured, status refunded | pass |
| FP-300: the shop gets the right webhook | `refund.succeeded` with amount, fee reversal, status, transaction id; signed | pass |
| FP-300: timeline, reports, reconciliation | one timeline event per refund summing to -3000; reports list it refunded; today's analytics count the refunds | pass |
| | reconciliation for today explains to zero after refunds and adjustments | pass (was fail before JP1) |
| FP-300: fees and payouts | not black-box testable on the day: today's batch cannot be closed until Bahrain midnight | — |
| Memo: lifetime payout estimate drift | no HTTP surface found for the estimate | — |
