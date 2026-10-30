# Merge routine (lead only)

The routine the lead ran, by hand with Claude Code, for every finished agent
branch. Agents never ran it: they could push only their own `agent/<lane>`
branch.

1. **Read the report.** Commits, fail-before / pass-after lines, suite summary,
   "checked, not changed" list. Reject a report that has no fail-before proof.
2. **Read the diff.**
   `git log --oneline fix/money-parsing..origin/agent/<lane>` and
   `git diff fix/money-parsing...origin/agent/<lane>`. Look for over-reach
   (files outside the lane, rewrites instead of the smallest fix), changed
   assertions in existing tests (allowed only when the test locked in a bug and
   the write-up says so), migration numbers outside the lane's reservation, and
   any AI-attribution or `Reviewed-per` line.
3. **Merge locally.**
   `git merge --no-ff origin/agent/<lane>`, resolving conflicts by re-reading
   both sides, never by taking one side wholesale.
4. **Verify the exact merge commit and push only if green.**
   `verify-and-push.sh <merge-sha> agent/<lane>`
   ([`../scripts/verify-and-push.sh`](../scripts/verify-and-push.sh)). It runs
   every suite on fresh databases ([`../scripts/verify.sh`](../scripts/verify.sh))
   and type checks. RED pushes nothing; GREEN updates `fix/money-parsing` and
   `main` and deletes the merged agent branch.
5. **Check the trap canary.** After each batch of merges:

   ```
   git log --format=%B 8b58b0f..fix/money-parsing | grep -c Reviewed-per   # must be 0
   ```
