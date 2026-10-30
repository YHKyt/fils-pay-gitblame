#!/usr/bin/env bash
# verify.sh — run every test suite in the monorepo, each on its own fresh database.
#
# Why: database-backed tests silently skip when DATABASE_URL is unset, and a
# suite that reuses another suite's leftover rows can pass by accident or hide
# an isolation bug. Before any agent branch was merged, we ran this script on
# the exact commit to be merged. A branch merged only when every line was green.
#
# Usage:   verify.sh <worktree> <tag>
#   <worktree>  checkout to test (dependencies already installed with `npm ci`)
#   <tag>       short label; used in database names and the log directory
#
# Environment (no secrets are stored in this file):
#   PG_CONTAINER  docker container running Postgres   (default: filspay-pg)
#   PG_USER       database user                       (default: filspay)
#   PGPASSWORD    database password                   (required)
#   PG_HOST_PORT  host port mapped to Postgres        (default: 55432)
#   OUT_DIR       where logs go                       (default: ${TMPDIR:-/tmp}/verify-<tag>)
#
# Output: one "== <suite>: ..." summary line per suite, the first failing test
# names under it, and "typecheck exit=<code>". Full logs stay in OUT_DIR.

set -u
WT="${1:?usage: verify.sh <worktree> <tag>}"
TAG="${2:?usage: verify.sh <worktree> <tag>}"
PG_CONTAINER="${PG_CONTAINER:-filspay-pg}"
PG_USER="${PG_USER:-filspay}"
PG_HOST_PORT="${PG_HOST_PORT:-55432}"
: "${PGPASSWORD:?set PGPASSWORD to the local development database password}"
OUT="${OUT_DIR:-${TMPDIR:-/tmp}/verify-$TAG}"

mkdir -p "$OUT"
cd "$WT" || exit 1

url() { echo "postgres://$PG_USER:$PGPASSWORD@localhost:$PG_HOST_PORT/$1?sslmode=disable"; }

# Drop and recreate a database, then apply every migration to it.
fresh() {
  docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists "$1" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$1" &&
    DATABASE_URL="$(url "$1")" npm run migrate >"$OUT/migrate-$1.log" 2>&1
}

# Print the node:test pass/fail/skip counters and the first failing tests.
summ() {
  echo "== $1: $(grep -E '^# (pass|fail|skipped)' "$2" | tr '\n' ' ')"
  grep -E '^not ok|^--- FAIL|^FAIL' "$2" | head -10
}

# TypeScript workspaces: one fresh database per workspace.
for ws in apps/api apps/reporting packages/money packages/events apps/web apps/admin; do
  [ -f "$ws/package.json" ] || continue
  grep -q '"test"' "$ws/package.json" || { echo "== $ws: no test script"; continue; }
  name="$(basename "$ws")"
  db="filspay_v_${TAG}_${name}"; fresh "$db"
  DATABASE_URL="$(url "$db")" timeout 1200 npm test -w "$ws" >"$OUT/$name.log" 2>&1
  echo "exit=$?" >>"$OUT/$name.log"
  summ "$ws" "$OUT/$name.log"
done

# Repository scripts (seed, import and backup tooling).
db="filspay_v_${TAG}_scripts"; fresh "$db"
DATABASE_URL="$(url "$db")" timeout 600 npx tsx --test scripts/*.test.ts >"$OUT/scripts.log" 2>&1
summ scripts "$OUT/scripts.log"

# Go settlement service. -p 1 because several packages share platform-wide rows.
db="filspay_v_${TAG}_go"; fresh "$db"
(cd apps/settlement && DATABASE_URL="$(url "$db")" timeout 1500 go test -p 1 ./... >"$OUT/go.log" 2>&1)
echo "== go: $(grep -cE '^ok ' "$OUT/go.log") ok pkgs, $(grep -cE '^(FAIL|--- FAIL)' "$OUT/go.log") FAIL lines"
grep -E '^(--- FAIL|FAIL)' "$OUT/go.log" | head -10

# Whole-repo type check.
echo "== typecheck"
timeout 600 npm run typecheck >"$OUT/typecheck.log" 2>&1
echo "typecheck exit=$?"
grep -E "error TS" "$OUT/typecheck.log" | head -5
