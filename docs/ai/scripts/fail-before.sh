#!/usr/bin/env bash
# fail-before.sh — prove that a regression test fails on the old code and
# passes on the fix.
#
# Why: every fix we merged had to ship with this proof, and the decisive lines
# of both runs were quoted in the audit write-up. The script backs up each
# changed source file, restores the committed (pre-fix) version with
# `git show HEAD:<file>`, runs the test, restores the fix, and runs the test
# again. Run it from the worktree root, before committing the fix.
#
# Usage:   fail-before.sh "<test command>" <changed-source-file> ...
# Example: DATABASE_URL=... fail-before.sh \
#            "cd apps/api && npx tsx --test --test-name-pattern='refund' src/routes/refunds.test.ts" \
#            apps/api/src/routes/refunds.ts
#
# Only pass source files. Do not pass the new test file, or it will be
# reverted as well and the "old code" run will test nothing.

set -u
CMD="${1:?usage: fail-before.sh \"<test command>\" <file> ...}"; shift
[ "$#" -gt 0 ] || { echo "name at least one changed source file" >&2; exit 2; }
BAK="$(mktemp -d)"
FILTER='^not ok|^ok|# pass|# fail|^--- FAIL|^FAIL|^ok  |^  (actual|expected)'

for f in "$@"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done
restore() { for f in "$@"; do cp "$BAK/$f" "$f"; done; }
trap 'restore "$@"' EXIT

for f in "$@"; do git show "HEAD:$f" >"$f"; done
echo "=== OLD CODE (expect failure) ==="
(eval "$CMD") 2>&1 | grep -E "$FILTER" | head -30

restore "$@"
echo "=== FIXED CODE (expect pass) ==="
(eval "$CMD") 2>&1 | grep -E "$FILTER" | head -30

git status --short
