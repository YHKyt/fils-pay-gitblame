# Fix round F2: pool use, webhook backlog, search, batch replay, hosted login

Items reported but not fixed in `perfload.md`, `large-export-upload.md` and `opsfix.md` (O7). Each fix was proven with a test that fails on the code before it and passes after. Branch `agent/fixf2`.

## FB1. Authorize and capture hold a pool connection for the whole acquirer call — High

**Where:** `apps/api/src/payments/authorize.ts`, `capture.ts`, `idempotency.ts`, `void.ts`; `db/migrations/0121_idempotency_keys_in_progress_resource.sql`. Reported in perfload.md, "Reported, not fixed" 1.

**Evidence:** `apps/api/src/payments/acquirerCallPool.test.ts`. A pool with ONE connection, and a fake acquirer that needs a connection from that pool while it runs:
- Before: `not ok 1` and `not ok 2`, `error: 'timeout exceeded when trying to connect'` (the request held the only connection). The stale-attempt test: `a same-key request blocked behind the attempt at the acquirer`.
- After: `ok 1` to `ok 5`.

Measured with 20 concurrent authorize+capture loops, a 100-400 ms fake acquirer and the hosted pool size (5), for 10 s. A one-row read, sampled every 20 ms:

| | read p50 | read p95 | payment flows done |
|---|---|---|---|
| before | 832 ms | 933 ms | 107 |
| after | 0.6 ms | 0.9 ms | 378 |

- **What:** `authorizeTransaction` and `captureTransaction` ran the idempotency claim, the validation, the acquirer call and the journaling in one `withTransaction`. The transaction, and one of the 5 pool connections, stayed open for the whole acquirer call. The payment-link checkout calls both, so it held a connection twice per payment.
- **Why:** capture held its row lock across the call on purpose (YA's comment: no TOCTOU between what was validated and what is written). Holding the lock that way needs the connection too.
- **Breaks:** under payment load every other request waits for a connection. Perfload measured a 5 ms `GET /v1/transactions` at p95 2985 ms with 60 payment loops, close to the 5 s `PG_POOL_CONNECTION_TIMEOUT_MS`, after which unrelated reads fail with 500. A slower real acquirer makes it worse.
- **Fix:** the shape refunds already use (claim and commit, call, record), with what the held lock guaranteed kept explicitly:
  - Step 1, one short transaction: claim the key, validate (capture: row lock, status, expiry, remaining), and mark the claim in flight with a fresh attempt id (`markAcquirerAttempt`). For a capture, the claim also records the amount and the transaction (`resource_id`): that is its reservation.
  - Step 2: the acquirer call, with no connection checked out.
  - Step 3, a second transaction: check that this attempt still owns the claim (`ownsAcquirerAttempt`, a row lock on the claim), then record exactly as before. Capture re-locks the transaction row and computes the fee, status and journal from its current values.
  - Concurrency: a capture's remaining amount subtracts the reservations of captures still at the acquirer (`activeCaptureReservationFils`), and a void is refused (409 `not_voidable`, `reason: capture_in_progress`) while one exists. So two captures still cannot exceed the authorization, and a void cannot release a hold the acquirer is capturing.
  - Throws and crashes: a throw gives the claim up at once (`releaseAcquirerAttempt`), and a claim from a dead process goes stale after 5 minutes. A same-key retry then takes it over with the SAME `attempt_count` (`takeOverAcquirerAttempt`), so `acquirerIdempotencyKey` is unchanged and the acquirer replays its first answer. This is what the old ROLLBACK gave. A slow attempt that was taken over cannot record anything (step 3 fails its ownership check).
  - 0121 is a partial index on `idempotency_keys (resource_id) WHERE status = 'in_progress'`, so the reservation lookup never scans the whole key table.
  - Why this and not a second pool: a separate pool for payments only moves the queue. Payments would still be limited to one per connection per acquirer call.
- **Behaviour change:** a second request with the same Idempotency-Key while the first is at the acquirer now gets 409 `request_in_progress` (retry later), as refunds already did. Before, it blocked until the first finished and then replayed. The web and admin clients already treat 409 `request_in_progress` as "not final".
- **Test:** `acquirerCallPool.test.ts`: no connection held during authorize (1) or capture (2); two concurrent 15,000 captures of a 20,000 authorization give one 200 and one 422, and the acquirer sees one capture (3); a void during an in-flight capture is a 409 and the transaction ends `captured` (4); a capture whose process "died" at the acquirer is taken over by a same-key retry with the same acquirer key, and the slow original then gets 409 and journals nothing (5). Tests 1, 2 and 5 fail on the old code; 3 and 4 pass on both, and pin what the held row lock used to guarantee. The existing `acquirerTimeoutRetry`, `idempotencyRetryRace`, `discountAdjustment` (concurrent partial captures) and payment-link tests pass unchanged.

## FB2. The webhook dispatcher drains a backlog at one batch per poll interval — Medium

**Where:** `apps/api/src/webhooks/dispatcher.ts` (`startWebhookDispatcher`, `triggerPass`). Reported in perfload.md, "Webhook dispatcher" (b).

**Evidence:** `apps/api/src/webhooks/dispatcherBacklog.test.ts` test 1: 250 due deliveries, a 10-minute poll interval, one NOTIFY.
- Before: `the backlog stopped after one batch, waiting for the next trigger`, `100 !== 250`.
- After: `ok 1`.

- **What:** a pass sends at most 100 deliveries (`STEP_B_BATCH_LIMIT`) and creates at most 500 (`STEP_A_BATCH_LIMIT`). The next pass waited for the next NOTIFY or the 5 s tick, and a NOTIFY that arrived during a pass was dropped (`if (inFlight) return`).
- **Why:** "one pass per trigger" was correct only while a pass could finish all the work. The reporting consumer had the same shape (PL3).
- **Breaks:** perfload measured 20 deliveries/s: a 115k backlog took about 96 minutes. A fresh `transaction.captured` webhook queued behind it. A NOTIFY lost mid-pass delayed a webhook by up to 5 s even with no backlog.
- **Fix:** the PL3 `rerun` flag. It is set when a pass filled either batch, or when a trigger arrived during the pass, and the next pass starts as soon as the current one ends. A failing pass does not rerun, so it cannot spin; `stop()` still waits for the pass in flight and starts nothing more. The pass itself is unchanged.
- **Test:** above. The dispatcher, load, order, poison-event and zero-payout tests pass unchanged.

## FB3. Webhook Step A re-reads the whole outbox history on every pass — Medium

**Where:** `apps/api/src/webhooks/dispatcher.ts` (`createMissingDeliveries`, `selectDueEvents`); `db/migrations/0122_webhook_step_a_watermarks.sql`. Reported in perfload.md, "Webhook dispatcher" (a), with the safe design left documented there.

**Evidence:** `dispatcherBacklog.test.ts` test 2. 3,000 events already delivered, then one new event. The Step A statement is run under `EXPLAIN ANALYZE` and the outbox rows it reads are counted.
- Before: `Step A read 3251 outbox rows to find one new event`.
- After: `ok 2` (under 200 rows; the read is the events since the previous pass).

- **What:** Step A anti-joins every eligible outbox event against `webhook_deliveries`, every 5 s and on every NOTIFY (so on every capture). Perfload measured 70 ms at 115k events and 1-2 s at 460k, growing with the history.
- **Why:** nothing recorded which part of the outbox a pass had already handled. The cheap bounds (an id margin, a per-endpoint "last delivery") are not safe: a lower id can commit late, and a quiet merchant's bound never moves.
- **Breaks:** dispatcher CPU and database time grow without bound with platform age, on the 0.5 vCPU api.
- **Fix:** the watermark perfload described.
  - After its inserts, in the same transaction, a pass writes `(below_id, below_xmin)` for every endpoint active in its snapshot. `ORDER BY oe.id LIMIT` gives a prefix: every due pair the snapshot saw below the last row's id was in the batch (all of them when the batch was not full). Every transaction below the snapshot's xmin had finished before it, so every eligible event with `id < below_id AND xact_id < below_xmin` already has its delivery for that endpoint.
  - The next pass skips only what every active endpoint's watermark covers (the minimum of each; an active endpoint without a row makes it 0, a full scan). The bound is passed as literal values, so the planner reads two index ranges (pkey and `idx_outbox_events_xact_id_id` from 0096) instead of the table.
  - The due rows, the snapshot's xmin, the highest visible id and the active endpoints come from one statement, so they share one snapshot. The same statement checks that the bound still covers every endpoint active in it; if one became active in between, the pass reads everything.
  - A late-committing lower id has a higher `xact_id` and is still read. A disabled endpoint's watermark does not move, so on re-enable its events from the disabled period are still found, as today. The anti-join still decides every pair that is read, and the unique index still prevents duplicates.
  - The watermark is only rewritten when it moves forward, so an idle pass writes nothing.
- **Test:** `dispatcherBacklog.test.ts` test 2 (above), test 3 (an event committed after a higher id was delivered is still delivered) and test 4 (an event from while the endpoint was disabled is delivered after re-enable). Tests 3 and 4 also pass on the old code: they pin that the skip loses nothing. Test 2 runs `ANALYZE outbox_events` first, because a table filled a moment before in a fresh test database has no planner statistics yet; production has them (autovacuum).

## FB4. % and _ in the admin merchant search are wildcards — Low

**Where:** `apps/api/src/admin/merchants.ts` (`listMerchantsForAdmin`). Reported in perfload.md, "Suspicious, not changed" (search).

**Evidence:** `apps/api/src/admin/merchantsSearch.test.ts`.
- Before: `q=% matched "Search adcfc1ec axb Traders"`.
- After: `ok 1`.

- **What:** `GET /v1/admin/merchants?q=` put `q` into `display_name ILIKE '%' || q || '%'` as a pattern.
- **Why:** the transaction search was fixed to escape its input (query.ts), and this second search was not.
- **Breaks:** `q=%` lists every merchant and `_` matches any character, so a search for `a_b` also finds `axb`. A crafted `%a%a%a…` pattern makes the matcher backtrack over every merchant name.
- **Fix:** escape `\`, `%` and `_` in the pattern, the same one-line replace query.ts uses. The exact-id and contact-email arms still get `q` unchanged. No index added: a trigram index needs the `pg_trgm` extension and a rewrite of the `OR` arms before the planner could use it, which is not a small change, and both searches are bounded (one merchant's rows; the merchants table).
- **Test:** above: `%` returns only names containing `%`, `a_b` does not match `axb`, and a literal backslash still matches.

## FB5. Batch replay past 500 repeats the same 500 deliveries — Medium

**Where:** `apps/api/src/webhooks/replayBatch.ts`; `apps/admin/src/types.ts`, `apps/admin/src/pages/webhooks/WebhookReplayPage.tsx`; `docs/ADMIN.md`. Reported in large-export-upload.md, "Webhook batch replay".

**Evidence:** `apps/api/src/webhooks/replayBatchCap.test.ts`, 501 exhausted deliveries in the window, replayed twice.
- Before: the first call has no way to say more matched; with that assertion removed, the second call fails `the second call queued the first 500 again`, `500 !== 1`.
- After: `ok 1`: 500, then 1, and every original replayed exactly once.

- **What:** one call replays at most 500 deliveries, oldest first, and `matchedCount` is the capped count. A queued replay does not change the original's status, so it still matches.
- **Why:** the cap was added without a way to continue past it.
- **Breaks:** the operator cannot tell that more matched. Running it again queues the same 500 a second time (receivers get the same events again) and never reaches the rest of the range.
- **Fix:** a delivery whose replay is still pending is no longer a candidate, so a second call continues with the next ones. The order gets an `id` tie-breaker. One extra row is read to set `hasMore`, a new additive response field (and in the audit metadata). The admin page says when to run it again, and ADMIN.md documents the cap. Once its replay has run, a delivery can be replayed again, as with a single replay.
- **Test:** above. The existing replay and admin route tests pass unchanged.

## FB6. No way to log in on the hosted box — Medium

**Where:** `ops/README.md`, "Logging in on the hosted box". Reported as opsfix.md O7 (decision left open).

**Evidence:** with `NODE_ENV=production` the login response carries no code and nothing logs it (`auth/notifier.ts`), and there is no delivery channel. The README listed options without a working procedure.

- **What:** the hosted box had no documented working login path for people or for automated tests.
- **Why:** the handover has no OTP delivery channel. In the original repository there was no Dockerfile and no `NODE_ENV`, so the code was exposed by default (development); the hosting work correctly turned that off.
- **Breaks:** nobody can use the dashboards on the hosted box, and a black-box suite cannot get past login.
- **Decision (no code change):** keep the production default (`OTP_DEV_EXPOSE=false`). The seeded passwords are public in the repository, so on the hosted box the one-time code is the only protection for the `finance` and `super_admin` consoles. The README now gives a path for each client:
  1. A person at a browser: the operator re-keys the newest pending challenge to a code they choose, with one `psql` command through `docker compose exec`. The challenge keeps its own expiry and attempt limit.
  2. `ops/e2e/judge-suite.mjs` against the hosted box: it already re-keys with `DATABASE_URL`; reach the loopback-only Postgres through an SSH tunnel.
  3. Merchant-API clients: an API key needs no code. Create one after one login as in 1.
  4. An external suite that can only finish a login from the login response: that needs `OTP_DEV_EXPOSE=true` on that box. This is a team decision, to make only if the organisers' test instructions require it, for the judging window only, on seeded data only, then reset (`SEED_RESET=1`).
- **Test:** the README command was run against a `NODE_ENV=production`, `OTP_DEV_EXPOSE=false` api on a real database: signup, then login (no `devOtpCode`), then the exact SQL from the README through `docker exec ... psql -v`, which printed `UPDATE 1`, then `POST /v1/auth/otp/verify` with that code returned 200. This was a one-off check, not a committed test.

## Checked, not changed

- **Transaction search ILIKE** (`transactions/query.ts`): it already escapes `\`, `%` and `_` (verified in the code). Perfload measured it as linear in one merchant's rows (138 ms at 100k). A trigram index would also need the query rewritten (the `OR id::text = $5` arm and the generic `$5 IS NULL OR` form) before it could be used, which is not a small or safe change now.
- **Webhook archive held in memory** (large-export-upload.md): already fixed by `a0e5a27`. Archive create is one `INSERT ... SELECT jsonb_agg` and restore is one `INSERT ... SELECT jsonb_array_elements`, both inside Postgres. Only the ADMIN.md note was stale ("costs API memory on both steps"); it now gives the real limit (one jsonb value, 255 MB, and a long restore transaction). That change is in the FB5 commit.
- **Step B priority:** a fresh webhook still queues behind a backlog by `next_attempt_at`. FB2 makes the backlog drain at full speed, which removes the 96-minute wait. Reordering Step B was not needed for that.
