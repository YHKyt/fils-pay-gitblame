# FP-300 refunds — audit findings (fp300hunt)

Each finding was reproduced with a run against a real, migrated Postgres
before it was fixed, and each fix ships with a regression test that fails on
the pre-fix code and passes on the fix.

## F1. A NUL byte in `reason` refunds the card but never journals the reversal — Critical

**Where:** `apps/api/src/routes/refunds.ts` (`parseBody`), with the failure
surfacing in `apps/api/src/payments/processRefund.ts` step 3.

**Evidence:** `POST /v1/refunds` with `{"amountFils":10000,"reason":"duplicate\u0000"}`
returned HTTP 500 (expected 400); the acquirer had already refunded the card,
`transactions.refunded_fils` was left at 0, no `merchant_payable` reversal was
posted, and the idempotency key stayed `in_progress`.

- **What:** `reason` was only type-checked as a string. Postgres `TEXT`
  cannot store U+0000, so the `INSERT INTO refunds` in the journal step threw.
- **Why it matters:** the acquirer refund (step 2) runs before the journal
  (step 3). A NUL reason let the card be refunded while the ledger reversal
  and the `refunded_fils` update never happened — money out with no record —
  and wedged the idempotency key so the call could never be retried.
- **Breaks:** cardholder refunded, merchant still paid out the refunded
  amount at the next payout; stuck key; HTTP 500 to the caller.
- **Fix:** reject a `reason` containing U+0000 in `parseBody` with a 400,
  before the acquirer is ever called. Smallest change: one guard next to the
  existing type check, no change to the journal path.
- **Test:** `apps/api/src/routes/refunds.test.ts` — asserts 400, the acquirer
  is not called, `refunded_fils` stays 0, and a clean retry settles to a
  balanced ledger.

## F2. A concurrent refund that declines inflates the approved refund's total and status — Critical

**Where:** `apps/api/src/payments/processRefund.ts` step 3.

**Evidence:** two concurrent partial refunds of 5,000 on a 10,000 capture, one
approved and one declined. The approved refund reported
`refundedTotalFils: 10000` and `transactionStatus: "refunded"`, the row ended
`status = refunded` with `refunded_fils = 5000`, the `refund.succeeded`
webhook carried `refundedTotalFils: 10000`, and a third refund of the real
remaining 5,000 was rejected 409 `transaction_not_refundable`.

- **What:** step 3 derived the new refunded total (and therefore the status,
  the event type and the webhook/response body) from
  `transactions.refunded_fils`, which also carries the *reservation* of any
  refund still in flight.
- **Why it matters:** the in-flight refund's reservation was counted as if it
  had settled. When it later declined and released its reservation, the
  approved refund had already moved the transaction to `refunded`.
- **Breaks:** 5,000 of genuinely refundable money became permanently
  un-refundable; status and webhook overstated the refunded total.
- **Fix:** derive the settled total from the `refunds` table (succeeded rows
  plus this refund), not from the reservation column. The step-3 `FOR UPDATE`
  re-read still serializes concurrent refunds, so the `refunds` sum is exact.
- **Test:** `apps/api/src/payments/processRefundConcurrency.test.ts` — "a
  concurrent refund that declines does not inflate...".

## F3. A capture racing the refund over-reverses the MDR fee — High

**Where:** `apps/api/src/payments/processRefund.ts` step 3.

**Evidence:** a 4,000 refund held at the acquirer while a second capture of
6,000 lands (total captured 10,000, total fee 250). The refund reversed the
whole 250 fee (`refund: MDR fee reversal` debit = 250) instead of its 100
pro-rata share.

- **What:** the fee reversal was computed with `calculateRefundFee` using the
  captured amount read in step 1 (4,000), while `netFeeFils` was read fresh in
  step 3 (250, after the second capture). Stale base, fresh fee → full fee.
- **Why it matters:** the merchant is over-credited the difference (150 here),
  so partial refunds no longer sum to the fee actually charged.
- **Breaks:** ledger drift; `platform_fee_revenue` under-stated.
- **Fix:** re-read `captured_fils` (and `amount_fils`) under the step-3 row
  lock and use the fresh captured amount for both the fee pro-rata and the
  derived status. Same hunk as F2.
- **Test:** `apps/api/src/payments/processRefundConcurrency.test.ts` — "a
  capture racing the refund does not over-reverse the MDR fee".

## F4. An acquirer that throws leaks the reservation and wedges the key forever — High

**Where:** `apps/api/src/payments/processRefund.ts` step 2.

**Evidence:** `acquirer.refund()` rejecting with `ETIMEDOUT` left
`transactions.refunded_fils = 4000` (money never moved) and the idempotency
key `in_progress`; the exception propagated out of `processRefund`, so every
retry with the same key hit 409 `request_in_progress` forever.

- **What:** the acquirer call was awaited with no `try/catch`. Only the
  structured `error` *outcome* released the reservation and failed the key; a
  thrown rejection did neither.
- **Why it matters:** a transient acquirer timeout permanently shrank the
  refundable amount and made the refund impossible to retry — the opposite of
  the reservation pattern's intended "err on the side of refunding less".
- **Breaks:** stranded reservation; un-retryable refund; HTTP 500 instead of a
  retriable 502.
- **Fix:** wrap the acquirer call; on a throw, release the reservation and
  `failIdempotencyKey` (which `claimIdempotencyKey` re-opens as
  `retry_after_failure`), returning 502 — exactly what the `error` outcome
  already does. This is the behaviour `failIdempotencyKey`'s own doc comment
  describes for "an unexpected infrastructure fault caught before rethrowing".
- **Test:** `apps/api/src/payments/processRefundConcurrency.test.ts` — "an
  acquirer that throws releases the reservation and leaves the key retriable".

## F5. Reconciliation ignores unbatched refunds, so every period with a refund reports a gap — High

**Where:** `apps/api/src/settlement/query.ts` (`getReconciliationReport`).

**Evidence:** after a 4,000 refund (net -3,900 on `merchant_payable`), the
report showed `ledgerMerchantPayableNetFils: 5850` but
`pendingUnbatchedFils: 9750`, `gapFils: -3900`, `explained: false`. A full
10,000 refund gave `gapFils: -9750`.

- **What:** the pending figure summed only unbatched `captured` /
  `partially_captured` events. Refund events (`refunded`, `refund_partial`),
  which are equally unbatched and also move `merchant_payable`, were omitted —
  despite the function's own doc comment claiming refunds were included.
- **Why it matters:** the ledger figure already reflects the refund, so
  omitting it from pending opens a gap and the period reports `explained:
  false`, which the reconciliation contract uses as a correctness signal.
- **Breaks:** reconciliation / the finance dashboard flags every refunding
  period as unexplained.
- **Fix:** add a query for unbatched refund events and fold each into pending
  as `amount_fils + feeReversedFils` (the event's `amount_fils` is stored
  negative, `metadata.feeReversedFils` is the fee credited back) — the exact
  net the refund posts to `merchant_payable`.
- **Test:** `apps/api/src/settlement/reconciliationRefunds.test.ts` — partial
  and full refund periods both explain to zero.
