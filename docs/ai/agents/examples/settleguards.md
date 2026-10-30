# Example task prompt: `settleguards`

A real builder prompt, reproduced as sent. Note the explicit file ownership
("minimal hunks: another worker edits rebuild-balances in the same file") and
the instruction to *report, not edit* a bug that sits in a file another lane
owns. The resulting write-up is `docs/audit/settleguards.md`.

---

NAME = settleguards. Builder (builder-rules.md, incl. RESUMING + FAILOVER;
partial uncommitted work may exist in your worktree). Migration if truly
needed: 0101.

Own: `apps/settlement/internal/internalapi/server.go`, the run-batch path of
`apps/settlement/cmd/*/main.go` (minimal hunks: another worker edits
rebuild-balances in the same file), `apps/settlement/internal/splits/*`, and
the `apps/api` admin settlement route only if needed. Do not edit `batch.go`.

1. HIGH: closing a business day before it ends strands its later captures
   forever. The internal API (~221-237), the CLI (~104) and the admin console
   route accept today/future dates; CloseBatch selects only that day; a closed
   day is never rescanned. Scenario: re-run today at 13:00 (ADMIN.md calls this
   "always safe") and it pays 10 BD; a 40 BD capture at 15:00 is never batched.
   Fix: refuse any business date whose Asia/Bahrain window end is after now
   (4xx with an error code the admin UI can show; non-zero CLI exit). Tests:
   today/future are refused and nothing is written; yesterday works.
2. MEDIUM-LOW: split weights are never validated (`splits/shares.go` ~37).
   6000+6000 means a 97,500 net pays out 117,000 and the parent's payable goes
   to -19,500; weights under 10000 strand the remainder. Fix: error unless
   weights sum to exactly 10000; the batch stays closed and nothing is posted.
   Tests.
3. Verify; fix if small: the internal API request context derives from the
   daemon's base context (~142), so SIGTERM cancels an in-flight run despite a
   "30 s graceful" comment (closed-but-unpaid risk). Report, do not edit, that
   one merchant's error stops RunDailyBatch for every later merchant
   (`batch.go`).

Full Go suite (`-p 1`). Note: `docs/audit/settleguards.md`.
