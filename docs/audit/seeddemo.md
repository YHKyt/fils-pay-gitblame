# Seed realism for demos and judges

Branch `agent/seeddemo`. Scope: `db/seed` (the deterministic demo data a fresh hosted stack loads) and the demo-login documentation in `ops/README.md`. The seed is the first thing judges and demo users see, and what the settlement tools and reporting read back. So it must look like data the platform itself could have produced.

All findings were reproduced on a freshly migrated scratch database seeded with `SEED_RESET=1 npm run seed`. The regression tests are in `db/seed/demoRealism.test.ts`. Like `outboxParity.test.ts`, that file is destructive and runs only with `SEED_RESET=1`. Run the two files one after the other, not in one `tsx --test` call: they truncate the same database. `npm run seed` still passes every REAL assertion, including `seed-deterministic`.

## SD1. Seeded fees ignore the fee schedules the seed itself writes — Medium
**Where:** `db/seed/generate.ts` (fee_schedules inserts, standard closed batch), `db/seed/fixtures/transactions.ts`, `db/seed/fixtures/marchReconciliation.ts`.
**Evidence:** on the old seed, 54 Alpha Retail captures were charged a rate other than the one in force, e.g. `gross 372589 fee 9315, 225 bps in force` (9315 is 250 bps; 225 bps gives 8383). Alpha's 2026-08-31 closed batch charged a fee of 183,174 fils; at the rate in force it is 164,853 fils (Alpha was overcharged 18.321 BD).

- **What:** the seed writes Alpha's schedule (245 bps from 2026-03-01, 225 bps from 2026-08-01). But it charged every Alpha capture (the August month, the 2026-08-26 instalment captures and March's mid-month activity) and the closed batch at the fixture's flat 250 bps.
- **Why:** a real capture (`capture.ts`, `getEffectiveMdrBps`) and `CloseBatch` (`EffectiveMdrBpsAt`) both charge the rate in force at the capture instant. The seed bypassed that resolution and used `fixture.mdrBps` directly.
- **Breaks:** the seeded ledger, the batch fee, the payout and the reporting figures all disagree with the merchant's own fee schedule. That is the exact class of bug the case file is about, now baked into the demo data. A recalculation at the merchant's current terms would "find" a difference that no real run could have made.
- **Fix:** the schedule rows now live in one `FEE_SCHEDULE_FIXTURES` list, and one resolver (`fixtureMdrBpsAt`, the same newest-row-not-after-the-instant rule) feeds both the inserts and the generators. The generators take an optional `mdrBpsAt` and default to the old flat rate, so other callers are unchanged. The March boundary captures (Bahrain 1 March, before 2026-03-01T00:00Z) still resolve to 250 bps, as the services would charge them.
- **Test:** `every seeded capture is charged the fee schedule rate in force when it happened` checks every capture ledger group against the rate in force, and every closed batch's fee against its captures' fees. It fails on the old code (54 captures) and passes on the fix.

## SD2. Standard merchants have no capture timeline, and a month is settled as one business day — High
**Where:** `db/seed/generate.ts` (the standard per-merchant settlement block).
**Evidence:** on the old seed, every Alpha, Beta, Gamma and Delta Wholesale standard transaction had zero `transaction_events`. Each merchant had one closed batch dated 2026-08-31 covering captures from 2026-08-01 to 2026-09-01, e.g. `Alpha Retail Co 2026-08-31: gross 7326913, linked events 0`. `RecalculateMDR` over July–August on that seed failed for all four: `batch's linked events do not add up to its gross: ... (2026-08-31) gross 7326913 fils, linked events 0 fils`. That is the 500 the admin recalculation returned on the hosted stack. Alpha's eleven instalment captures on 2026-08-26 were in no batch at all.

- **What:** the seed wrote ledger entries and one month-wide batch per merchant, but none of the timeline that the batch is supposed to be built from.
- **Why:** `CloseBatch` settles exactly one Asia/Bahrain business day per batch, from the capture events it links (`settlement_batch_id`). `RecalculateMDR` re-rates a batch from those linked events, and since R4 it refuses a batch whose events do not add up to its gross. The seed produced batches that the platform can never produce.
- **Breaks:**
  - The transaction detail timeline is empty for every standard transaction.
  - Reporting (built from the outbox, which the seed derives from `transaction_events`) shows none of these merchants' captures.
  - MDR recalculation over the seeded range fails for every seeded merchant, so the fee tooling cannot be demoed.
  - A month of captures is presented as one day's settlement.
- **Fix:**
  - Each standard transaction gets its `authorized` event and its capture event. The capture event carries `feeFils` and `discountBps` as `capture.ts` records them, and it is linked to the batch that settled it.
  - Captures are grouped by Bahrain business day. Every day before 2026-09-01 gets its own closed batch, closed at 00:30 Bahrain the next day, with one scheme line per transaction. Delta Wholesale's standard captures join that day's existing high-volume batch, because a merchant has one batch per date.
  - Alpha's instalment captures settle in their day's batch.
  - Captures on 2026-09-01 stay unbatched, waiting for the open batch.
  - The lifetime payout estimate replays every batch in date order.
  - The marketplace fixture is unchanged (it is meant to be closed by `apps/settlement`).
  - `transactionEventCount` now also counts the 1,200 high-volume events it used to miss.
- **Test:** `every seeded closed batch is one business day, settled from its own linked capture events` fails on the old code (four batches with linked events 0). It checks that each closed batch's gross equals its linked capture events, all from its own day, that every seeded capture has its capture events, and that no capture before 2026-09-01 is left out of a batch. A no-change `RecalculateMDR` over 2026-07-01..2026-09-01 on the fixed seed returns no error and no adjustment for Alpha (18 batches), Beta (16) and Delta Wholesale (61).

## SD3. Seeded voids are missing from the timeline, and reporting counts them on the day the seed ran — Medium
**Where:** `db/seed/generate.ts` (the per-merchant `enqueueEvent` for the first void).
**Evidence:** on the old seed, 11 of 11 voided standard transactions had no `voided` event (`alpha-retail-txn-0004: 0 voided event(s)`). The outbox held 4 `transaction.voided` events, all with `created_at` 2026-10-30, the wall-clock day the seed ran.

- **What:** the seed enqueued a void outbox event for only the first void of each merchant, through `enqueueEvent`, which stamps `now()`. It wrote no `voided` timeline event at all.
- **Why:** `void.ts` writes the `voided` timeline event and a `transaction.voided` outbox event together. Reporting buckets an event on its `created_at` day. The admin analytics rebuild counts voids from `transaction_events`.
- **Breaks:**
  - Reporting showed 4 voids on "today" and none in August.
  - The admin rebuild counted 0 voids, so the two read paths disagree.
  - The voided transactions' timelines are empty.
- **Fix:** each voided transaction gets `authorized` and `voided` events. The void is ten minutes after the authorization, capped at the seed's own "now". The hand-built `enqueueEvent` call is replaced by an `INSERT ... SELECT` that derives one `transaction.voided` per `voided` event, with `void.ts`'s payload and `created_at` set to the void time. This is the same pattern the seed already uses for captures and batches.
- **Test:** `every seeded void is on the timeline and reaches reporting on the day it happened` fails on the old code (11 of 11). It also checks that no seeded outbox event is dated after the seed's "now".

## SD4. The seed prints every merchant's raw API key to the deploy logs — High
**Where:** `db/seed/generate.ts` (`console.log(... issued.rawKey)`), `ops/README.md`.
**Evidence:** the old seed printed `seed: issued API key for Alpha Retail Co: fp_test_<32 chars>` for all 8 merchants. With `NODE_ENV=production` (the hosted image), `issueApiKey` issues `fp_live_` keys.

- **What:** the raw key, which is never stored and is meant to be shown once to its owner, went to stdout.
- **Why:** on the hosted stack, the seed's stdout is the `seed` container log (`docker compose logs seed`) and whatever collects it. A key authenticates the merchant API (refunds, captures, payment links) with no second factor.
- **Breaks:** anyone who can read the deploy logs holds a working API key for every demo merchant, for as long as those keys live.
- **Fix:** the seed now prints the display-safe prefix that `api_keys` already stores, plus the merchant id (which the merchant login asks for). An owner issues a usable key with `POST /v1/merchants/{merchantId}/api-keys`. `ops/README.md` gains a "Demo logins" section. It lists the seeded admin and merchant accounts and their roles, names the password constants instead of repeating them, warns that a box seeded this way must not hold real merchants, and describes what the seeded history contains.
- **Test:** `the seed output never contains a usable API key` captures the output of `generate()`. It fails on the old code (8 raw keys) and checks that each stored prefix is still printed.

## SD5. The test-mode merchant has a settlement history — Medium
**Where:** `db/seed/generate.ts` (standard settlement block).
**Evidence:** Gamma Hospitality Group is seeded with `test_mode = true`, and migration 0091's trigger stamps its 34 transactions `test_mode`. The seed still wrote closed batches for it. On the old seed that was one 2026-08-31 batch of 6,141,934 fils. After SD2, and before this fix, it was `Gamma Hospitality Group: 16 batch(es), gross 3780886` (15 closed plus the open one). Each closed batch had a `settlement.batch_closed` outbox event, which reporting shows as a payout trend.

- **What:** a test merchant was "settled" as if its money were real.
- **Why:** `CloseBatch` refuses a test-mode merchant (`ErrMerchantNotEligible`) and selects only `NOT t.test_mode` events. No run of `apps/settlement` can give a test-mode merchant a batch.
- **Breaks:** demo dashboards and the payout trend show payouts for a sandbox merchant, which contradicts the platform's own rule.
- **Fix:** test-mode fixtures get no closed or open batches. Their captures stay on the timeline, unbatched.
- **Test:** `a test-mode merchant has no settlement history` fails on the old code (16 batches) and passes on the fix.

## Reported, not fixed

- `apps/settlement/internal/settlement/recalculate_mdr_unlinked_test.go` has a comment saying the seed writes the Alpha, Beta, Gamma and Delta Wholesale 2026-08-31 batches without linking their events. That is no longer true after SD2. The test itself is unaffected (it builds its own fixture). **Fixed in `82c29c6`:** the comment now says the seed used to write them unlinked (comment only).
- `db/seed/fixtures/marchReconciliation.ts` (Alpha, March 2026) is still a raw ledger import with no `transaction_events` and no batches, including its voided rows. It feeds the `scripts/reconcile_march` puzzle, and the `legacy_transactions` fixture needs its event-free authorized/voided rows, so the tests leave it out on purpose. Its fees are now charged at the rate in force (SD1).
- The seed's high-volume capture events carry no metadata, and the marketplace's and the instalment captures' carry `feeFils` without `discountBps`, so `CloseBatch` and `RecalculateMDR` recompute their fee instead of using the booked one. They agree today, because the recomputation uses the same rate.
  - **High-volume part fixed in `e70c72a`:** Delta Wholesale's 1,227 peak-day capture events now carry `{ feeFils, discountBps }`, as `capture.ts` records them. `feeFils` is the fee the day's batch `fee_fils` already sums, and `discountBps` is 0 for this merchant. Their derived `transaction.captured` payloads now carry that fee instead of 0. All REAL assertions pass with unchanged counts and ledger checksum.
  - **Still open:** the marketplace's 210 and the instalment fixture's 11 capture events still lack `discountBps`. Those events are unbatched, so adding the key would switch `CloseBatch` from recomputing their fee to the booked one. The seed's and the settlement service's roundings should be checked against each other before that.
