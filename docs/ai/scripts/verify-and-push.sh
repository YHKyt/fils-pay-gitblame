#!/usr/bin/env bash
# verify-and-push.sh — verify one exact commit on fresh databases, and push it
# to the integration branches only if every suite is green.
#
# Why: this was the last gate of our merge routine. A human first read the
# agent's diff and merged it locally; this script then checked out that exact
# merge commit in a dedicated, otherwise unused worktree, reinstalled
# dependencies from the lockfile, and ran verify.sh. A red result pushes
# nothing. A green result fast-forwards the integration branches and deletes
# the merged agent branches from the remote.
#
# Usage:   verify-and-push.sh <commit-sha> [merged-agent-branch ...]
#
# Environment:
#   REPO              main checkout used for pushing          (default: <repo>)
#   VERIFY_WORKTREE   detached worktree used only for testing (required)
#   TARGET_BRANCHES   branches to update on a green run       (default: "fix/money-parsing main")
#   LOG_DIR           where the verify output goes            (default: ${TMPDIR:-/tmp})
#   plus the variables verify.sh needs (PGPASSWORD, ...).

set -u
SHA="${1:?usage: verify-and-push.sh <commit-sha> [merged-agent-branch ...]}"; shift
REPO="${REPO:-<repo>}"
VERIFY_WORKTREE="${VERIFY_WORKTREE:?set VERIFY_WORKTREE to a spare worktree path}"
TARGET_BRANCHES="${TARGET_BRANCHES:-fix/money-parsing main}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$LOG_DIR/v$SHA.out"

# 1. Check out the exact commit and install dependencies from the lockfile.
cd "$VERIFY_WORKTREE" || exit 1
git checkout -q --detach "$SHA" || exit 1
timeout 600 npm ci --prefer-offline --no-audit --no-fund >/dev/null 2>&1

# 2. Run every suite on fresh databases.
bash "$HERE/verify.sh" "$VERIFY_WORKTREE" "v$SHA" >"$OUT" 2>&1
grep "^==" "$OUT"

# 3. Any failure, Go FAIL line or type error blocks the push.
if grep -qE "fail [1-9]|[1-9][0-9]* FAIL lines|typecheck exit=[1-9]" "$OUT"; then
  echo RED
  exit 1
fi

# 4. Green: update the integration branches, then delete merged agent branches.
cd "$REPO" || exit 1
refspecs=()
for b in $TARGET_BRANCHES; do refspecs+=("$SHA:$b"); done
GIT_TERMINAL_PROMPT=0 timeout 90 git push origin "${refspecs[@]}" 2>&1 | grep -E -- "->"
for b in "$@"; do
  timeout 30 git push origin --delete "$b" 2>&1 | grep -c deleted
done
echo GREEN
