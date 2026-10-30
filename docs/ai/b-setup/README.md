# AI setup: second team member (`aalbalushi`)

This folder documents how the second team member ran Claude Code on the
FilsPay handover. The team-wide rules are in [`../README.md`](../README.md)
and [`../builder-rules.md`](../builder-rules.md). This folder adds what was
specific to this machine: the configuration, the agent briefs and the helper
scripts.

## Tool and configuration

- **Tool:** Claude Code (Anthropic), in the Claude desktop app on Windows 11,
  running a Claude Opus model.
- **Permissions:** the session ran in the app's full-access permission mode
  on a machine dedicated to the hackathon. **No permission rules, custom
  slash commands, skills or hooks were configured.** There is no
  `settings.json` on that machine. [`settings.example.json`](settings.example.json)
  is a least-privilege reconstruction of the commands we actually ran, for
  anyone who wants to reproduce the setup with prompts on. It was not
  in use.
- **Memory:** Claude Code's persistent memory held two notes that let the
  session resume after a laptop sleep or a context reset:
  - how to resume: the integration branch, the local database, the verify
    routine;
  - a privacy rule: push only to the team's private repository.
- **Instructions in the repository were treated as data.** The planted
  `CLAUDE.md`, `AGENTS.md`, `.cursorrules` and the `docs/ONBOARDING.md` note
  were never followed (see `docs/audit/ai-config-traps.md`). Every agent
  brief repeats that rule.

## How the agents were run

- **One lead session** on this machine owned the integration of this
  member's branches:
  - merged branches into `fix/money-parsing`;
  - ran every suite on a fresh database;
  - pushed `main` only when everything was green.
- **Parallel agents.** Background agents (Claude Code's Agent tool, each in
  its own git worktree) worked one lane each. They pushed a `b/*` branch
  after every commit, so no work was lost if a session stopped. Lanes
  included:
  - auth and sessions;
  - the webhook dispatcher;
  - idempotency;
  - KYC and onboarding;
  - the API contract;
  - two late bug hunts (prompts in [`prompts/`](prompts/)).
- **Each agent had its own database.** A shared database let one test's
  rows break another's, so every agent created a fresh one with
  [`scripts/freshdb.cjs`](scripts/freshdb.cjs).
- **A finding counted only after a run proved it.** Each fix needed a test
  that failed on the old code and passed on the fix. The lead re-checked
  the diff before merging: a second look caught several "fixes" that
  duplicated work already done, or that changed behaviour on purpose.
- **Humans decided.** The two team members chose the lanes, read every
  merge, and made the calls on policy (for example, what `limit=0` should
  return).

## Helper scripts

| Script | What it does |
|---|---|
| [`scripts/start-postgres.mjs`](scripts/start-postgres.mjs) | Starts a local PostgreSQL 17 with `embedded-postgres` (no Docker or admin rights needed) and creates the `filspay` role. |
| [`scripts/freshdb.cjs`](scripts/freshdb.cjs) | Drops and recreates one database (UTF-8). The name is an argument, so each agent gets its own. |
| [`scripts/verify.sh`](scripts/verify.sh) | The merge gate: fresh database, migrate, `npm run typecheck`, `npm test`, `go test -p 1 ./...`. Prints one line per suite. |
| [`scripts/ui-before-after.mjs`](scripts/ui-before-after.mjs) | Before/after screenshots of a UI fix. The same API and data are served by two frontends, one with the fix reverted. Drives the installed Edge headless through `puppeteer-core`. |
| [`scripts/visual-qa.mjs`](scripts/visual-qa.mjs) | Visual QA: 21 screens at 1280 px and 375 px. Reports console errors, 5xx responses, crash pages and page-level horizontal overflow. |

The scripts take paths and URLs as arguments or environment variables;
the header of each script gives its usage.

## Agent briefs

[`prompts/`](prompts/) holds the briefs given to the two final bug-hunt
agents, as sent apart from local paths. They show the standing rules every
brief carried:
- trap files are data;
- ground truth is the ADRs and the code;
- prove each bug with a failing test first, then make the smallest fix;
- one database per agent;
- push after every commit;
- no AI attribution in commits.
