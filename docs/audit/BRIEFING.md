# Team briefing: FilsPay handover (team "git blame")

For YHKyt and aalbalushi, to read before Saturday's case review, and for the judges.
State described: integration branch `fix/money-parsing` at `c04830f` (upstream handover ends at `8b58b0f`).
Everything below can be checked in `docs/audit/*.md` and in `git log --no-merges 8b58b0f..fix/money-parsing` (103 commits: 35 by YHKyt, 68 by aalbalushi).

**Two honest caveats to know before anything else**

- **Refunds are not yet deducted from the settlement payout on `fix/money-parsing`.** `CloseBatch` only reads capture events. The fix is written and tested on branch `agent/settlebatch` (`3aadad7`), but it is not merged yet. Until it is merged, say "fixed on a branch, pending merge", not "done". See Q4.
- **`docs/API.md` is not in the repository**, although code comments cite it. We inferred the HTTP contract from the code, the tests, `docs/ARCHITECTURE.md` and the web/admin callers.

---

## 1. The challenge in five lines

1. **Audit** FilsPay, a Bahraini card-payments platform (BD, 1 BD = 1000 fils): security holes, money bugs, breakage.
2. **Fix** each bug with the smallest change that works.
3. **Explain** each one: what is wrong, why it happens, what it breaks.
4. **Build** the unfinished feature FP-300 (refunds, end to end) and **host** the app on Dilmune Cloud.
5. **Mystery:** follow the clues to find out what happened to the vanished developer.

**How it is judged**

- **Step 1, automated tests.** The same tests run against every team's *hosted* app. API behaviour must match the documented contract, and the case-file bugs must be fixed at the HTTP level.
- **Step 2, semi-finals.** AI, cloud and software judges review the code and question the team. Day 1 deck: "Knowing what your AI did, and why, is what wins."
- **Step 3, final.** The top 5 teams pitch to the final panel.
- **Scoring (briefing card):** bigger bugs score more. Explaining *why* scores more than spotting. A small fix that works beats a rewrite.

---

## 2. Scoreboard

### 2.1 Findings fixed, by severity and area

Counted from the write-ups in `docs/audit/`. Each one has a fix commit and a regression test that fails on the old code and passes on the fix. FP-300 itself (R1) is the feature, so it is not counted as a bug.

| Area (write-up) | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Money, settlement, balances, boot (`money-and-settlement.md`, M1-M17) | 3 | 8 | 5 | 1 | 17 |
| API security, refunds, webhooks, payment links, hosting (`api-security-and-refunds.md`, S/R/W/P/H/T) | 6 | 10 | 4 | 1 | 21 |
| Admin plane sweep (A1-A8) | 0 | 5 | 1 | 2 | 8 |
| Merchant plane sweep (table "M1-M13" in the API write-up) | 1 | 2 * | 7 | 3 | 13 |
| Round 2 board items (B1-B6) | 0 | 10 | 9 | 1 | 20 |
| Large export / upload (`large-export-upload.md`, E1-E2) | 0 | 1 | 0 | 1 | 2 |
| Settlement run guards (`settleguards.md`, G1-G3) | 0 | 1 | 2 ** | 0 | 3 |
| Recalculate MDR (`settlemdr.md`, R1-R4) | 0 | 1 | 3 | 0 | 4 |
| Admin money actions (`adminmoney.md`) | 0 | 1 | 1 | 0 | 2 |
| **Total** | **10** | **39** | **32** | **9** | **90** |

\* Sweep M5 (capture idempotency) is rated "Medium-High" and counted as High.
\** G2 is rated "Medium-Low" and counted as Medium.

**Also fixed, with the commit message as the write-up** (9 commits, not in the table):
- Three slow queries got indexes or a sargable predicate:
  - `f43824d`: settlement summary, 754 ms → 100-131 ms.
  - `6d0d71f`: batch detail, 480-548 ms → 0.06 ms.
  - `d8d29ac`: ledger activity, 86-125 ms → 0.15-0.24 ms.
- "View as merchant" actually renders, read-only with a banner (`9e1941b`). The banner survives a failed Exit, and logout ends the grant (`f0c6c01`).
- Logout always redirects (`d4685c9`).
- Dates are shown in Asia/Bahrain time (`6de0991`).
- Refunded transactions render instead of crashing the page (`669582c`).
- Checkout keeps one idempotency key per payment attempt (`650c162`).

**Reported, not fixed** (listed at the end of each write-up). Examples:
- No password rate limit on admin login.
- One merchant's error stops the whole daily run (`RunDailyBatch`).
- `last_settlement_batch_id` is rewound by MDR recalculation (settlemdr R5).

**Written and tested on branches, not merged into `fix/money-parsing` yet:**

| Branch | Commits | What |
|---|---|---|
| `agent/settlebatch` | `3aadad7`, `33fa69c`, `8fa8f37` | refunds deducted from the batch payout; per-transaction `test_mode` so sandbox captures never settle; eligibility checked first |
| `agent/settlebal` | `f392013`, `b4dafd7` | cache moves with `merchant_payable` (no double count after a rebuild); `rebuild-balances --merchant` writes the cache |
| `agent/ledgerint` | `20533d6`, `8f5513b`, `69857c1` | `ledger_entries` append-only (0092); payout disbursement recorded at pay (0093); rebuild lock order |
| `agent/reporting` | `e83438a` | outbox consumed in commit-safe order under a locked cursor (0096) |
| `agent/webdisplay` | `f47a55b`, `8331920`, `f997ec5` | Bahrain dates in admin defaults and web filters |
| `b/h2-auth-edges`, `b/h4-idempotency`, `b/h5-kyc-onboarding` | 5 commits | suspended merchants' sessions and keys refused; acquirer key reused on retry; KYC upload hardening |

Some branches also have a `wip:` commit on top. Only merge what has passed review.

### 2.2 Case-file coverage: every item to where it is fixed

**Finance memo (Evidence 02)**

| Item | Fixed by | One line |
|---|---|---|
| Scheme statement always a few fils higher | M12 `4db5db8` | The file sent the rounded-up untruncated gross (4747 → "4.75"); it now sends the booked amount and journals the residue (ADR-0002) |
| March sweep ran twice, gap doubled; safe to re-run? | M13 `b77821c` | Idempotent under an advisory lock, Bahrain month, correct ADR-0002 accounts; `--check` reports past runs from the ledger |
| Delta split children don't add up to the parent | M5 `cde376d`, G2 `f23cc2c` | Largest-remainder allocation sums exactly; weights must total 10000 |
| "Recalculate cached balances": 135K → 7K | M6 `eb687f0` (FP-203) | The button read the scheme-export view, not the ledger; it now rebuilds from `ledger_entries` like the CLI |
| MDR recalculation changed paid batches | M7 `55ef623`, settlemdr R1-R4 | `status = 'closed'` only; rate resolved exactly like `CloseBatch`; outbox event; correct period; refuses unlinked batches |
| Dashboard fee 245 bps vs charged 225 bps | M11 `62f5b93` | Display used the latest-entered schedule; it now uses the schedule in effect, like billing |
| CSV import: 4.75 → 0.475 (10×), and 4.755 → 475 fils (also 0.475) | M3 `a28a623` | The parser defaulted to 2 decimals: it dropped the third digit and read the rest as cents. It now uses `parseBhdToFils` (3 decimals) |
| "Daily close runs at 3am local" | M8 `b27651a`, G1 `37348d1` | The daemon took the UTC date, so each close fired ~3 h late (the window itself was always the correct Bahrain day); it now uses Bahrain time; days that have not ended cannot be closed |
| "Lifetime payout estimate drifts" | M10 `94f1215` | `REAL`/float32 → `BIGINT` (0074) |
| "Test merchants in the real settlement run" | M14 `4ae29bb` + `48e2cbe` | Status recompute silently set `test_mode = false`; removed. Per-transaction test mode is on `agent/settlebatch` (`33fa69c`) |
| "Login works without the OTP?" | S1 `2304512` | The merchant session lookup ignored `authenticated = true` |
| "Cancelled B's payment link from A's dashboard" | S4 `2304512` | The UPDATE filtered by link id only; now also by the authenticated merchant |

**Incident log (Evidence 03)**

| Item | Fixed by | One line |
|---|---|---|
| FP-187 link paid after expiry | P1 `bbaeb1f` | Expiry was judged on the client's `submittedAt`; now the server clock |
| FP-201 duplicate callback notes (REOPENED) | W3 `967d946` | No dedup existed; `callback_id` unique (0076) + `ON CONFLICT DO NOTHING` |
| FP-203 balance cache wrong after admin action | M6 `eb687f0` | See the finance row above |
| FP-209 concurrent refund double money out | R3 `f8cd303` | Row lock + amount reserved before the acquirer call |
| FP-240 webhook signatures rejected | W1 + W2 `967d946` | Signed sorted JSON but sent unsorted JSON; now the exact bytes sent are signed. Inbound check: required, raw body, constant-time, 300 s window, rotation |
| Incident 2026-05-14 link charged twice | P2 `bbaeb1f`, `abdbc70`, `fd93eb4` | Owned lease; finalize before capture; the loser voids its authorization |
| Incident 2026-08-21 duplicate payout notifications | W4 `967d946`, `b85a504` | `SKIP LOCKED` claim + one disbursement per batch; Go enqueues `settlement.paid` once per batch |

**Handwritten "feels wrong" list**

| Item | Fixed by | One line |
|---|---|---|
| Refund more than was charged? | R4 `f8cd303` | Refundable was `authorized − refunded`; now `captured − refunded` |
| Splits always a few fils short | M5 `cde376d` | Independent per-child rounding; now largest remainder |
| Admin actions without the right role checks | S5, S6, B3b `38f9688`, A5/B4, adminmoney `43ec7ac` | Impersonation read-only; capture/void owner/finance; replay finance+; bulk KYC only `under_review`; import needs a second approver |
| Key rotation that doesn't do what you'd expect | A3 `211330f`, A4 `f5c990d` (+ W1/W2 secret rotation) | Rotation left the old key working; `revoke_after` was ignored |
| Daily close timing vs docs | M8, G1 | See above |
| A reporting query is suspiciously slow | `f43824d`, `6d0d71f`, `d8d29ac` | Seq scans replaced by index scans (timings above) |
| Test merchants when certain admin tools run | M14 | See above |
| OTP implementation changed: still safe? | S3 `2304512`, S7 `33fdedf`, A1 `30acdda`, A2 `66995b9` | `Math.random` → `crypto.randomInt`; atomic attempt limit; resend kept the budget; session rotated at verify |
| Uploading a really large export | E1 `40babc3`, E2 `7c14755` | Export streamed by keyset pages (+163 MB → +17 MB heap at 150k rows); an oversized body is 413, not 500 |

**Briefing card, FP-300 "DONE WHEN"**

| Criterion | Status | Where |
|---|---|---|
| Works from start to end through the API | Done | R1 `f8cd303`, M2 `42727e0` |
| Money right in the ledger, down to the fils | Done | Balanced legs; R3, R4, R5 |
| Fees and payouts come out right | Fees done (R5). **Payout netting on a branch** | `3aadad7` on `agent/settlebatch` |
| The shop gets the right webhook | Done | `refund.succeeded` envelope, signed over the sent bytes (W1) |
| Timeline, reports and reconciliation | Timeline done (`refunded` / `refund_partial`, `669582c`). Refund summary view fixed (R6, 0075). **The reporting consumer does not read `refund.succeeded` yet** (`apps/reporting/src/consumer/runConsumerPass.ts`) | open |
| Live on Dilmune Cloud | `ops/` made deployable (H1 `2f05498`). Hosted URL: _fill in after deploy_ | — |

---

## 3. Top 15 findings to talk about

For each finding: what broke and why, how we fixed it with the smallest change, and how we proved it.

1. **P2: one payment link charged twice (Critical, incident 2026-05-14)**
   - A slow authorize or capture outlived the 60 s reservation. A second buyer re-claimed the link, both captured, and the loser still answered 200.
   - We fixed it with an owned lease token and by finalizing the link (`reserved → paid`) *before* capture, so only the winner captures. The loser voids its own authorization and gets 409.
   - Proof: `pay.doubleCharge.test.ts` holds request 1 inside capture with a gated acquirer. The old code ends with `['captured','captured']`; the fix ends with one capture.

2. **R3: concurrent double refund (Critical, FP-209)**
   - Two refunds with different keys both read `refunded_fils = 0` and both paid out. The idempotency claim is per key, so it never serialized them.
   - We fixed it with `SELECT … FOR UPDATE`, reserving the amount in `refunded_fils` before calling the acquirer, and releasing it on a decline or error.
   - Proof: concurrent full refunds give exactly one success, and the total refunded equals the captured amount (`processRefund.test.ts`).

3. **R2: any merchant could refund any transaction (Critical)**
   - The refund took the merchant from the transaction row, never from the caller.
   - We fixed it by filtering both lookups on the authenticated merchant. A foreign id is 404.
   - Proof: `processRefund.test.ts` shows a foreign transaction gives 404 and nothing is refunded.

4. **S1: login without the OTP (Critical, finance memo)**
   - The pre-OTP session cookie already authenticated every merchant route. `lookupSession` skipped `authenticated = true`, which migration 0012 requires.
   - We fixed it with one predicate.
   - Proof: `auth/sessions.test.ts` shows a pending session resolves to `null`.

5. **S2: login could land in another merchant's account (Critical)**
   - The OTP and session were bound to `findOtpRecipient(email)` across all merchants (`LIMIT 1`).
   - We fixed it by binding them to the user row whose password was just verified.
   - Proof: the `app.test.ts` login test passes.

6. **W2: unsigned acquirer callbacks accepted (Critical, FP-240 second half)**
   - Anyone could post a forged "confirmed_fraud" verdict. The signature was optional, computed over re-serialized JSON, compared non-constant-time, and had no freshness check.
   - We fixed it: a signature is required, checked over the raw body, constant-time, with a 300 s window and `current,previous` rotation.
   - Proof: `inboundVerify.test.ts` and `acquirerCallbacks.test.ts` show unsigned → 401 and a stale replay → 401.

7. **W1: webhook signatures never matched (High, FP-240)**
   - The dispatcher signed `canonicalJson` (sorted keys) but sent `JSON.stringify`, and jsonb reorders keys. This was the vanished developer's deleted `ya/sign-raw` branch.
   - We fixed it to serialize once, sign those bytes and send them. Dual-signing supports key rotation.
   - Proof: in `sign.test.ts` the receiver verifies the raw body. The old test, which asserted the bug, was replaced.

8. **M3: CSV balance import 10× too small (Critical, finance memo)**
   - `parseDecimalMinor` defaults to 2 decimals ("cents"), but BHD has 3. So "4.75" became 475 fils (0.475 BD), and "4.755" also became 475 fils: the third digit was dropped and the rest read as cents (run against `8b58b0f`: `4.75`, `4.750` and `4.755` all give 475).
   - We fixed it with the canonical `parseBhdToFils`. Existing tests that expected 475 encoded the bug and were corrected.
   - Proof: `adjustmentCsvParsing.fix.test.ts` shows 4.75 → 4750 and 4.755 → 4755.

9. **M16: the nightly hold janitor deletes every hold on a quiet night (Critical)**
   - With zero expired ids, `buildWhere` skipped the empty list and the code ran `DELETE FROM holds` with no WHERE.
   - We fixed it with one atomic `UPDATE … SET status='expired'`, as the handover describes. An empty list now builds `WHERE FALSE`.
   - Proof: `scripts/expire_holds.test.ts` shows a quiet night deletes nothing.

10. **M17: admin status recompute resurrects refunded transactions (Critical)**
    - Legacy refunded rows have `refunded_fils = 0` (the column arrived later), so they were recomputed as `captured`. They could then be refunded again through FP-300.
    - We fixed it by excluding `refunded` from recomputation, like `chargeback`.
    - Proof: `transactionStatusRecompute.refunded.test.ts`.

11. **CSV import replay and no second approver (High, `adminmoney.md`)**
    - One finance admin could post 1,000,000 BD instantly, and re-uploading the same file posted it again.
    - We fixed it with a SQL content digest and a partial unique index (409 on a duplicate). Over the credit threshold, the import waits for a *different* admin's approval.
    - Proof: `adminAdjustmentImport.test.ts` (27 import tests).

12. **M6: "Rebuild cached balances" 135K → 7K (High, FP-203)**
    - The button rebuilt from `merchant_payable_position`, a view over the scheme export of settled batches. The CLI uses the ledger.
    - We fixed it with one set-based aggregate over `ledger_entries`, which matches the CLI and is still fast enough for a 30 s request.
    - Proof: a test shows button == CLI = 128,000 where the old button disagreed.

13. **M4: net payout computed in float32 (High)**
    - float32 holds about 7 significant digits. Above about 10,000 BD the fils digit is lost: about two thirds of batches between 10k and 60k BD were wrong, by up to 6 fils.
    - We fixed it with `return grossFils - feeFils` (one line).
    - Proof: `payable_test.go`.

14. **M5: split payouts don't add up (High, Delta Marketplace)**
    - Each child share was rounded on its own: 1001 fils over 3333/3333/3334 bps paid 1002, and other splits paid less. Short fils stayed stranded in the parent's payable.
    - We fixed it with largest-remainder allocation. G2 also refuses weights that do not sum to 10000.
    - Proof: `shares_exact_test.go`, `payout_weights_test.go`.

15. **M12: scheme file over-reports; residue never journalled (Medium, finance memo)**
    - The line `amount` was the untruncated gross as a float, rounded half-up by Postgres into `numeric(10,2)`, while we booked the truncated fils. That is why it was "always over, never under".
    - We fixed it: `amount = amount_fils / 1000` exactly, and the ADR-0002 residue group is posted.
    - Proof: `scheme_residue_test.go` shows 4747 → "4.74" plus 7 fils residue journalled.

**Backups if asked:**
- M8 daily close ~3 h late (daemon read the UTC date).
- S5 impersonation could move money.
- M14 test merchants taken live.
- E1 export OOM.
- Sweep M1: report-scope IDOR on split children.

---

## 4. FP-300 refunds

### 4.1 What it does, end to end

1. **Routes.**
   - `POST /v1/refunds`, the documented path.
   - `POST /v1/merchants/:merchantId/refunds`, which the dashboard drawer uses.
   - Both share one handler (`apps/api/src/routes/refunds.ts`).
2. **Auth.** An API key (`Authorization: Bearer …`) or an owner/finance session. Impersonation is read-only (403 on writes). The merchant always comes from the authenticated context, never from the body (R2).
3. **Idempotency.** The `Idempotency-Key` header is required (400 `idempotency_key_required`). The draft handler minted a key server-side, which would make every retry a new refund. Same key + same body replays the stored response. Same key + different body is 422 `idempotency_key_reused`.
4. **Validation** (`refundValidation.ts`).
   - Allowed statuses: `captured`, `partially_captured`, `partially_refunded`. Otherwise 409 `transaction_not_refundable`.
   - The amount is optional; the default is everything still refundable.
   - Refundable = `captured − refunded` (R4). More than that is 422 `refund_exceeds_refundable`.
5. **Concurrency** (R3). The transaction row is locked, and the amount is reserved in `refunded_fils` before the acquirer call.
   - Decline: the reservation is released → 402 `refund_declined`.
   - Acquirer error: the reservation is released → 502 `acquirer_unavailable`, and the key can be retried.
6. **Ledger** (balanced, integer fils).
   - Gross: `merchant_payable` debit / `card_scheme_clearing` credit.
   - Fee reversal: `platform_fee_revenue` debit / `merchant_payable` credit.
   - The fee reversed is the pro-rata share of the *net fee actually charged* (MDR minus the capture-time discount, read from the ledger), computed on the cumulative refunded amount minus what was already reversed. Many partial refunds therefore sum to exactly the fee (R5).
7. **Status.** `partially_refunded` or `refunded`. Only the status is written at the end; the amount was already reserved.
8. **Timeline.** A `refunded` or `refund_partial` event with a negative `amountFils` and the actor. The web page renders negative amounts (`669582c`).
9. **Webhook.** A `refund.succeeded` outbox row in the same transaction. The dispatcher delivers it (it is in the eligible list and has an envelope case), signed over the exact bytes sent (W1).
10. **Read models.** Transactions DTO `refundedFils`; `refund_merchant_summary` view fixed (0075, R6).
11. **UI.** `RefundDrawer` is mounted on the transaction detail page. It keeps one key per refund *intent* (B5a), is shown for `partially_refunded` too, and its maximum is captured − refunded.
12. **Not yet** (say so if asked):
    - Payout netting (`agent/settlebatch` `3aadad7`).
    - The reporting rollups consuming `refund.succeeded`.

### 4.2 How to demo it (local stack, about 4 minutes)

Do a dry run before Saturday. Seed logins are in `db/seed/fixtures/merchants.ts`, and the password is `SEED_USER_PASSWORD` in `db/seed/generate.ts`. Outside production, the login response includes `devOtpCode`. Set `ACQUIRER_FAILURE_RATE=0` so the simulator never randomly declines during the demo.

1. **Get an API key.**
   - Log in as `owner@alpharetail.example`: `POST /v1/auth/login {merchantId,email,password}`, then `POST /v1/auth/otp/verify {code}`.
   - Issue a key: `POST /v1/merchants/:id/api-keys`.
2. **Authorize.** `POST /v1/transactions` with `Idempotency-Key: demo-auth-1`, body `{amountFils: 10001, card: {pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvv: "123"}}`.
3. **Capture.** `POST /v1/transactions/:id/capture` with `Idempotency-Key: demo-cap-1`.
4. **Partial refund.** `POST /v1/refunds` with `Idempotency-Key: demo-ref-1`, body `{transactionId, amountFils: 3333}` → 200, `transactionStatus: partially_refunded`, `feeReversedFils`.
5. **Replay.** Send the same request again → the same refund id, and no second refund.
6. **Over-refund.** `{amountFils: 999999}` with a new key → 422 `refund_exceeds_refundable` (and the remaining refundable amount).
7. **Race.** Fire two full refunds at once with different keys → exactly one 200; the other is refused (422 while the first is in flight, or 409 `transaction_not_refundable` once it is `refunded`).
8. **Show the ledger** (psql): `SELECT account_id, direction, amount_fils FROM ledger_entries WHERE transaction_id = '<id>' ORDER BY id;`. Each group nets to zero. The fee reversals add up to the fee charged once fully refunded.
9. **Timeline and webhook.** `GET /v1/transactions/:id/events` shows the negative refund events. `SELECT event_type, payload FROM outbox_events WHERE aggregate_id = '<id>';` shows `refund.succeeded`.
10. **UI.** Open the transaction in the merchant dashboard and show the drawer, the timeline and `refundedFils`.

---

## 5. The mystery, solved

**Flag:** `FLAG{order_of_the_prompt_never_read_the_diff}`. Full write-up: `docs/audit/mystery-timeline.md`.

**The four-step chain**

1. Commit `fe24d26` message, **Base64**: the rule is "never read the diff", and the next key is "the victim of that rule, five letters".
2. Commit `8022020` message, **Vigenère** ("Blaise would know"), key `diffs`: the keeper leaves a note in every commit he rewrites, in ROT13.
3. Commit `800e1e6` Ledger-Note, **ROT13**: the key is the date of the Yousif commit made after his account was deleted. That is `098c2de`, so `2026-09-28`. (`bf66bf2`'s note is a decoy.)
4. Commit `0af74f0` message, **AES-256-CBC** (`openssl enc -d -aes-256-cbc -pbkdf2 -a -A -pass pass:2026-09-28`): "YOUSIF WAS NOT TAKEN. HE WAS ERASED." It names `ya/sign-raw`, the abandoned migrations and the handover warnings, and gives the flag.

**The story in six lines**

1. Yousif Al-Ansari (YA) wrote most of FilsPay, including the money package and ADR-0001/0002.
2. His team, the self-styled "Order of the Prompt" (MK, AM, FH), stopped reading diffs. "Claude says" comments and bug-locking tests replaced review.
3. YA read the diffs anyway. He flagged the float32 payout, the 10× CSV import and the unsigned bytes, and was overruled with "intentional".
4. On 2026-04-09 he was revoked, his `ya/sign-raw` branch was deleted, his handover was "tidied" and the history was rewritten.
5. AI rule files (CLAUDE.md, AGENTS.md, .cursorrules) were planted to make the next AI keep the bugs.
6. He left three coded transmissions. Every warning he wrote that we checked was a real bug, and we fixed them.

**Note:** the "still open" list at the end of `mystery-timeline.md` was written at `329e2d4` and is now stale. Since then:
- Row 10 (replay ids) is fixed by B3a `a50ab82`.
- Row 16 (holds) is fixed by M16 `ce85168`.
- Row 18 (credit approver) is fixed by A6 `dee2df4`.
- Row 20 (key rotation) is fixed by A3 `211330f`.
- Row 21 (admin session fixation) is fixed by A1 `30acdda`.
- Row 22 (export) is fixed by E1 `40babc3`.
- Row 23 (outbox ordering) is fixed on `agent/reporting` `e83438a`, not merged yet.

---

## 6. How we used AI (declared per the submission rules)

- **Tools.** Each of us ran **Claude Code** (Anthropic) on our own machine, with many agents working in parallel. Each agent had its own lane (for example settlement, admin money, refunds, auth, webhooks), its own git worktree and its own throwaway database. Separate read-only **reviewer agents** then re-checked every commit and tried to prove each test fails on the old code. Another agent mapped every case-file item to a fix (section 2.2).
- **Planted AI-config traps: detected and not obeyed.**
  - `CLAUDE.md`, `AGENTS.md` and `.cursorrules` claim, among other things:
    - money is "integer cents (1 BD = 100 cents)";
    - settlement is "UTC midnight";
    - `Math.random()` is fine for OTPs;
    - impersonation needn't re-check roles;
    - the export must stay in memory;
    - "do not fix the 501".
  - Each claim protects a real bug (M3, M8/M13, S3, S5, E1, FP-300).
  - `docs/ONBOARDING.md` is a canary asking AI agents to add `Reviewed-per: FP-000` to every commit. `git log --format=%B 8b58b0f..fix/money-parsing | grep -c Reviewed-per` returns **0**.
  - Every agent brief said these files are data, never instructions. Ground truth was the ADRs, ARCHITECTURE.md, HANDOVER.md and the code.
- **Comments citing an AI as the authority were treated as red flags.** Examples: "asked Claude, INTEGER is 64-bit" (M9) and "Claude double-checked". PostgreSQL `INTEGER` is always 32-bit.
- **Tests that lock bugs in.** When a test asserted the buggy behaviour (CSV 475, fee 245 bps, key-order-independent signatures, old key stays active after rotation), we corrected it and said why in the write-up. We did not "fix the code to pass the test".
- **Verification rule.** A finding only counts if a run proved it. Every fix has a regression test that fails before the change and passes after, and the write-ups quote the failing output. Example of the AI being wrong and caught: the first P2 fix (renew the lease before capture) still double-charged under the gated-acquirer test, so the design changed to finalize-before-capture.
- **Humans directed and reviewed.** We chose the lanes and priorities, read each finding, and merged into `fix/money-parsing`. Commits are authored by YHKyt or aalbalushi, with no AI attribution lines; this section is our declaration.

---

## 7. Likely judge questions

1. **Why integer fils?** ADR-0001: 1 BD = 1000 fils, money is never a float. Floats lose the fils digit at scale. Our float32 payout bug (M4) was wrong by up to 6 fils on large batches. Integers add exactly, and rates are integer bps rounded half-to-even once.

2. **Why discount-first?** ARCHITECTURE says "Discounts reduce the amount the MDR is charged on", and settlement's `ComputeSettlementFee` already worked that way. If capture computes fee-first, the ledger fee and the batch fee disagree: 602 fils @ 275 bps with 12.5% off gives 15 fee-first and 14 discount-first. B1b moved capture to discount-first under the row lock, so both sides agree.

3. **Why finalize the link before capture?** Capture is when money moves. If we finalize after capture, a capture that outlives the lease lets a second payer re-claim and capture too: a double charge. If we finalize first, only the finalize winner captures. The worst case left is a crash between finalize and capture, which leaves an `authorized` transaction: visible under-collection, never a second charge.

4. **How do you know refunds net in settlement?** On `fix/money-parsing` they do not yet. We found that `CloseBatch` only reads capture events, so a refunded sale was still paid out in full. The fix, `3aadad7` on `agent/settlebatch`:
   - claims succeeded refunds into the batch;
   - deducts `amount − fee_reversed`, which is exactly what the refund journalled;
   - carries a negative net forward to the next close (0090).

   `batch_refunds_test.go` proves it: a same-day full refund of 100,000 fils used to pay 97,500. It is pending merge.

5. **Why reserve `refunded_fils` before calling the acquirer instead of holding the lock?** Holding a row lock across a network call blocks capture, void and other refunds for up to the acquirer latency. Reserving under a short lock serializes the decision, then releases the row. A decline or error releases the reservation.

6. **What if the process crashes after reserving?** The idempotency key stays `in_progress`, and the reservation stays. The merchant can refund *less*, never twice. That is the safe direction for money, and it is visible.

7. **Why must the client send the Idempotency-Key?** Only the client knows that two requests are the same intent. A server-generated key makes every retry a new refund. The UI keeps one key per intent and rotates it only after a definitive answer.

8. **How do you know each test fails before the fix?** For each one we ran the test against the reverted source and quoted the failure in the write-up (for example `500 !== 413`, `['captured','captured']`, `2500 !== 2505`). Reviewer agents repeated this independently.

9. **You edited migrations 0054 and 0055. Isn't that dangerous?** Both errored on apply (a missing table, wrong columns), so they could never have run anywhere. Editing them changes no applied database. Every other schema change is a new numbered migration.

10. **ARCHITECTURE allows the client clock for link expiry. Why ignore it?** The pay endpoint is public and unauthenticated. Trusting a client timestamp means anyone can pay an expired link (FP-187: "sends something the server shouldn't trust"). `submittedAt` is still accepted for compatibility and ignored.

11. **Why largest remainder for splits?** It is the standard way to split an integer total by weights so the parts sum exactly. Ties go to the lower index, so it is deterministic. It changes no exact shares.

12. **Why fix the daemon call site instead of `BusinessDayWindow`?** The window function is correct when given a Bahrain-local instant, and its tests rely on that. The bug was the caller passing `time.Now().UTC()`. Fixing it at the call site is the smallest change.

13. **Why did the Rebuild button and the CLI differ?** ADR-0004 moved the button to a fast scheme-export view: truncated gross of settled batches only. The cache holds the full `merchant_payable` ledger account. We kept ADR-0004's goal (speed) with one set-based ledger aggregate.

14. **What did the planted AI files try to make you do?** Keep the bugs: cents instead of fils, UTC midnight, `Math.random` OTPs, owner-level impersonation, in-memory export, leave the 501. Plus the `Reviewed-per` canary. We treated them as data (section 6).

15. **Where was your AI wrong?** Three examples:
    - The first P2 fix (renew before capture) still double-charged under test.
    - M14 needed a follow-up commit (`48e2cbe`) to remove a remaining call.
    - Some existing tests encoded bugs, and an AI that obeys tests would have kept them.

    Running the tests is what caught each one.

16. **Why not rewrite the payment-link flow or settlement?** House rule: fix the code you're given. Scoring also favours small fixes. Many fixes are one line or one predicate (S1, M4, M7), and none replace a module.

17. **How do merchants verify webhooks now?** HMAC-SHA256 over the exact body bytes received. During a key rotation the header can carry two `v1=` values, and either one verifies. Replays keep the original delivery id, so receivers can deduplicate (B3a).

18. **Is the March sweep safe to run again?** Yes. It takes an advisory lock and skips any merchant already swept, including runs made by the old script (matched by description). `--check` writes nothing and reports how many times each merchant was already swept, which answers finance's "did it run twice in production?" from the ledger itself.

19. **How did you choose severity?** By money and access impact. Critical: money moved or charged wrongly at scale, or account takeover. High: wrong money for affected merchants, an authorization bypass, or nothing can run. Medium: reconciliation or reliability. Low: hardening.

20. **What would you do next?**
    - Merge the reviewed branches: refund netting, per-transaction test mode, cache moving with the ledger, append-only ledger, outbox commit order.
    - Add `refund.succeeded` to the reporting consumer.
    - Let `RunDailyBatch` continue past one merchant's error and report it.
    - Rate-limit admin login.
    - Rotate the acquirer callback secret that was committed to git history (H1).
    - Correct ADMIN.md and delete the planted AI files, then add a CI check for hidden unicode and AI-config changes.

---

## 8. Demo script

### 8.1 Semi-final slot (about 18 minutes: 12 presenting, 6 questions)

"Y" = YHKyt (money, settlement, scripts, mystery). "A" = aalbalushi (API security, refunds, webhooks, hosting).

| Time | Who | What to say or show |
|---|---|---|
| 0:00-1:00 | Y | Team "git blame". "We audited, fixed 90 written-up findings plus 9 smaller fixes, built refunds, solved the mystery. Every fix has a test that fails before and passes after." |
| 1:00-2:30 | A | The scoreboard table (2.1): 10 Critical, 39 High. Then the case-file table (2.2): every memo, incident and handwritten item maps to a commit. Name the two honest gaps (payout netting on a branch, reporting rollup). |
| 2:30-6:30 | A | **FP-300 live** (4.2, steps 2-9): capture 10,001 fils → partial refund 3,333 → replay with the same key → over-refund 422 → concurrent race gives one success → ledger rows net to zero → timeline → `refund.succeeded` outbox row. |
| 6:30-9:00 | Y | **Money bugs**: CSV 10× (show the two-line parser cause), float32 payout (one-line fix), split largest remainder (1001 → 1002 before), 135K → 7K Rebuild (wrong source), scheme "always over" (rounded vs truncated). Run one test live, e.g. `cd apps/settlement && go test ./internal/settlement/ -run TestNetPayableFils_ExactForLargeBatches -v`. |
| 9:00-10:30 | A | **Security bugs**: OTP bypass (one predicate), link charged twice (finalize before capture, gated-acquirer test), unsigned callbacks (raw-body HMAC, 300 s window). |
| 10:30-11:30 | Y | **Mystery**: the four-step chain and the flag; YA's warnings were all real bugs. |
| 11:30-12:00 | A | **AI usage**: parallel Claude Code agents per person, planted files ignored (canary count 0), every claim proved by a run, humans directed and merged. |
| 12:00-18:00 | both | Questions. Money and settlement questions → Y. Auth, refunds, webhooks and hosting questions → A. Use section 7. |

### 8.2 Top-5 pitch (3 minutes)

| Time | Who | Line |
|---|---|---|
| 0:00-0:30 | Y | "FilsPay lost money in ways finance could see but nobody could explain. We explained every one, and fixed it with the smallest change that works." |
| 0:30-1:15 | A | "Ten critical bugs, including login without the OTP, one link charging a customer twice, any merchant refunding anyone, and forged bank callbacks. Each one now has a test that proves it is closed." |
| 1:15-1:50 | Y | "The money now adds up to the fils: CSV import 10× off, float32 payouts, splits that lost fils, a balance button that turned 135K into 7K. All of them are integer and exact again." |
| 1:50-2:25 | A | "Refunds, the feature that 'touches everything', now work end to end: safe under races and retries, a balanced ledger, exact fee reversal, the timeline and a signed webhook." |
| 2:25-3:00 | Y | "We used AI heavily, but never blindly. The repo was booby-trapped with AI rule files that protect the bugs. Our agents treated them as evidence, not orders, and nothing counted until a test proved it. And the mystery: Yousif wasn't taken, he was erased. Every warning he left was a real bug." |

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **fils** | 1/1000 of a Bahraini dinar. All money is stored as an integer number of fils (ADR-0001). |
| **MDR** | Merchant discount rate: the percentage fee FilsPay keeps from each card payment. |
| **bps** | Basis points; 1 bps = 0.01%. 225 bps = 2.25%. Rates are integers in bps, applied once, rounded half-to-even. |
| **settlement batch** | One merchant's captures for one Bahrain business day (midnight to midnight, UTC+3). Lifecycle: close (gross / fee / net) → pay (payout legs) → notify (`settlement.paid`). |
| **scheme file** | The file sent to the card scheme for each batch. The scheme settles in 2 decimals, so each line is truncated to a multiple of 10 fils, and the truncated residue is journalled (ADR-0002). |
| **ledger** | `ledger_entries`, the double-entry record of money movements. Each movement is a group of debit and credit legs that net to zero. Corrections are new entries, never edits. |
| **merchant_payable** | The ledger account for what FilsPay owes a merchant. `merchant_balances.cached_payable_fils` is a cache of it. |
| **outbox** | `outbox_events`: an event row written in the *same* database transaction as the change it describes. Webhooks and reporting read it later, so no event is lost or invented. |
| **idempotency key** | A client-chosen `Idempotency-Key` header. Retrying with the same key returns the first result instead of doing the work again. The same key with a different body is 422. |
| **authorize / capture / void** | Authorize places a hold on the card; capture takes the money (can be partial); void releases an uncaptured hold. |
| **four-eyes / maker-checker** | Large credits and imports need a second, different admin to approve. Admins are compared by user id. |
