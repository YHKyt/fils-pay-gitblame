# Hunt-and-fix mode (reusable prompt)

Appended to every "hunt" task, where an agent searched its area for new bugs
rather than fixing a known one. Reproduced as used; `<NAME>` and `<PREFIX>` come
from the individual task prompt.

---

HUNT + FIX mode. Follow `builder-rules.md` (worktree, DB, tests, commit + push
your `agent/<NAME>` branch after every commit, RESUMING).

1. Hunt NEW bugs in your area. A candidate only counts once you have reproduced
   it with a run (a test, a script, or SQL on your own DB) and shown the wrong
   output with exact numbers.
2. For each proven bug, ranked by severity:
   - Fix it with the smallest correct change.
   - Add a regression test that fails on the old code and passes on the fix
     (prove both).
   - Commit it and push.
   Stay inside your area. For bugs in another lane (see `context.md`), report
   them; do not fix them.
3. Write ONE note file `docs/audit/<NAME>.md` with a section per fix:
   `## <ID>. <title> — <Critical|High|Medium|Low>`, then **Where:** and
   **Evidence:** lines, then bullets What / Why / Breaks / Fix / Test. Use IDs
   `<PREFIX>1`, `<PREFIX>2`, ...
4. Before finishing: rebase onto the latest `fix/money-parsing`, run the full
   suites of every workspace you touched (each on a fresh DB) and typecheck,
   then push.
5. Final report (terse): each fix (ID, title, severity, commit sha); bugs you
   reported but did not fix (with file:line); suspicious-but-unproven items.
