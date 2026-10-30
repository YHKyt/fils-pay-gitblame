# Tool configuration and permission rules

## What we actually ran

- **Tool:** Claude Code (Anthropic's command-line agent), one installation per
  team member, each on their own machine.
- **Model and effort:** the strongest available Claude model, effort level
  `high`. Builder and reviewer agents were started as Claude Code subagents
  from a lead session and inherited these settings.
- **Permission mode: `bypassPermissions`.** The lead session ran with
  per-command permission prompts switched off. Over two days we ran about
  twenty parallel agents, each issuing hundreds of `git`, `npm`, `go` and
  `docker exec` commands; a prompt on every command would have made parallel
  work impossible and trained us to click "allow" without reading.
- **Project settings:** the only standing allow rules in our project settings
  file were for the browser-testing tools (`mcp__claude-in-chrome__*`), used to
  check the hosted app in a real browser. There were no hooks and no MCP
  servers with credentials.

## How we kept bypass mode safe

Bypass mode removes the prompt, not the rules. We replaced per-command prompts
with three layers that do not depend on the agent asking first:

1. **Isolation by construction.** Each agent worked in its own git worktree on
   its own `agent/<lane>` branch, against its own throwaway database inside a
   local development Postgres container. The worst a misbehaving agent could
   damage was its own branch and its own database.
2. **Written prohibitions in every brief.** The deny rules below were stated in
   [`../builder-rules.md`](../builder-rules.md), which every agent read before
   starting. They came from real incidents: for example the worktree rule
   exists because removing a worktree that contained a directory junction once
   deleted files in the main checkout, and `git stash` is banned because the
   stash is shared by every worktree of a repository.
3. **The human gate.** Agents could push only their own branch. Nothing reached
   the integration branch until a human read the diff, merged it locally, and
   [`../scripts/verify-and-push.sh`](../scripts/verify-and-push.sh) proved the
   exact merge commit green on fresh databases.

## The rules as a settings file

[`claude-settings.example.json`](claude-settings.example.json) encodes the same
rules as Claude Code `permissions.allow` / `permissions.deny` entries, so a team
reproducing our setup can have the harness enforce them instead of relying on
the brief alone. Deny rules apply even in bypass mode. The allow list is what a
builder needs; the deny list is every action our builder rules forbid:

| Deny rule | Builder rule it enforces |
|-----------|--------------------------|
| `git push origin main`, `git push origin fix/money-parsing`, `git push --force` / `-f` | Push only your own `agent/<lane>` branch; the lead updates the integration branches. |
| `git stash` | The stash is shared across all worktrees. |
| `git worktree remove`, `rm -rf` | Never delete a worktree; the lead cleans up. |
| `mklink`, `ln -s` | Never create junctions or symlinks into the shared checkout. |
| `docker stop` / `restart` / `rm` | Never stop or restart the shared Postgres container. |
| `taskkill`, `pkill`, `cloudflared` | Never kill a process you did not start; never touch the hosting tunnel. |
| `gh pr create`, `gh issue create` | Never open pull requests or issues automatically. |

The file contains no credentials. The database password is supplied through
the `PGPASSWORD` environment variable at run time (see
[`../scripts/verify.sh`](../scripts/verify.sh)).
