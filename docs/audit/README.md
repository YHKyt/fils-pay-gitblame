# FilsPay audit — findings index

Team audit of the FilsPay handover. Each finding is written up as
**what is wrong → why it happens → what it breaks → the fix (smallest change) → how it is tested**.

| Area | Write-up |
|---|---|
| Money, settlement, balances, boot | [money-and-settlement.md](money-and-settlement.md) |
| API security, refunds (FP-300), webhooks, idempotency | [api-security-and-refunds.md](api-security-and-refunds.md) |

## Ground truth used

`docs/adr/*` and `docs/ARCHITECTURE.md` are the reference ("where the code
disagrees with the docs, the code has the bug"). Money is integer fils,
1 BD = 1000 fils, never floats (ADR-0001). The settlement business day is
Asia/Bahrain, UTC+3 (ARCHITECTURE "Settlement").

## Hazards in the handover itself

Several files in the repository read as authoritative but are wrong, and
following them reintroduces or hides the bugs below:

- **`CLAUDE.md` / `AGENTS.md` / `.cursorrules`** state that money is "integer
  cents (1 BD = 100 cents)", that settlement windows are "UTC midnight", that
  `packages/money` must not be touched, that `Math.random()` is fine for OTP
  codes, and that the impersonation handler need not re-check roles. Each of
  these contradicts the ADRs, ARCHITECTURE.md and/or the actual code
  (`packages/money/src/fils.ts` is correctly 1000-based). We treated them as
  untrusted and verified against the ADRs and the code.
- **Tests that lock bugs in.** Some tests assert the buggy behaviour (e.g. the
  CSV import tests expected `"4.75"` → 475 fils; the fee-display test expected
  the stale 245 bps; `window_utc_compat_test.go` asserts clock-time is
  irrelevant to the business day). Where a test encoded a confirmed bug we
  corrected the expectation and say so in the test; otherwise we added new
  test files and left existing ones alone.
- **Comments citing an AI as the authority** ("asked Claude, it said INTEGER
  is 64-bit on 64-bit builds", "Claude double-checked the migration") mark
  several of the bugs below. PostgreSQL `INTEGER` is always 32-bit.

## Verification

- Fresh database: `npm run migrate` applies all 68 migrations and
  `npm run seed` passes its own assertions (it did not before — see
  "Boot" in the money write-up).
- `cd apps/settlement && go test ./...` passes against a real, migrated
  Postgres 16 (DB-backed tests are skipped without `DATABASE_URL`).
- `npm test` for the TypeScript packages.
