# "Fix everything" round prompt

On Friday 30 October, late morning, we collected every finding that an earlier
lane had reported but not fixed, split them into three lists, and started three
agents (F1, F2, F3) with this prompt plus their list. It is reproduced as we
used it, with machine paths replaced by placeholders (`<scratch>` is the
private working folder that held the shared briefs, `<worktrees>` the worktree
directory).

---

FIRST ACTION: call the Skill tool with skill "caveman" and args "ultra". Your
chat output and final report follow it. Docs, commits and code comments stay
normal professional English.

Then read, in full:
- `<scratch>/builder-rules.md` (workspace, DB, tests, git, safety rules: all
  binding). Published copy: [`../builder-rules.md`](../builder-rules.md).
- `<scratch>/tasks/_context.md`. Published copy: [`context.md`](context.md).

The lane split in `_context.md` no longer applies: teammate B is offline and
every B branch is merged, so you may touch any file your items need. Only 3
agents are running now (F1, F2, F3), each with its own list below; stay on your
list.

Base: `fix/money-parsing` at `3133b39` or later (verified green: 769 TS tests,
Go ok, typecheck).

Each item on your list was REPORTED BUT NOT FIXED in `docs/audit/*.md`. Read
the doc that reports it first. For each item:

1. Reproduce it with a test that fails on the current code. If you cannot
   reproduce it, or it is already fixed, write that down with the evidence and
   move on. Never fix an unproven bug.
2. If the right behaviour is defined by `docs/API.md`, `docs/adr/*`,
   `docs/ARCHITECTURE.md` or `docs/HANDOVER.md`, follow it. If it is a genuine
   product decision with no answer in the docs, choose the safest smallest
   behaviour (reject bad input with the API's existing 400 error shape; never
   silently change money), and state the decision in the note.
3. Make the smallest fix, then prove fail-before and pass-after
   ([`../scripts/fail-before.sh`](../scripts/fail-before.sh)). Commit one
   finding per commit and push your agent branch.
4. Your note: `docs/audit/<NAME>.md`. Headings MUST be exactly
   `## <ID>. <title> — <Critical|High|Medium|Low>`, with IDs `<PREFIX>1`,
   `<PREFIX>2`, and so on, so every write-up has the same machine-readable
   format. Then **Where:** / **Evidence:**, then What / Why / Breaks / Fix /
   Test bullets. Add a final section `## Checked, not changed` for items you
   could not reproduce or deliberately left alone, each with the reason.

When done, run every suite on fresh databases with
`bash <scratch>/verify.sh <worktrees>/wt-<NAME> <NAME>`
(published copy: [`../scripts/verify.sh`](../scripts/verify.sh)). Go uses
`-p 1`. All must be green, and no previously passing test may break. Do NOT
merge into `fix/money-parsing`; the lead merges. Final report: commits, proofs,
suite summary lines, checked-not-changed list.
