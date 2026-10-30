#!/bin/bash
# The merge gate: fresh database, migrate, then every suite.
# usage: verify.sh <repoDir> [dbName=filspay]
# Prints typecheck=<exit>, npmtest=<exit>, pass/fail totals, go=<exit>.
# A branch was merged only when every exit code was 0.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$1" || exit 2
DB="${2:-filspay}"
export DATABASE_URL="postgres://filspay:filspay_dev_password@127.0.0.1:5432/$DB"
LOG="$(mktemp -d)"
node "$HERE/freshdb.cjs" "$PWD" "$DB" && npm run migrate >/dev/null 2>&1 || { echo "MIGRATE FAIL"; exit 1; }
npm run typecheck > "$LOG/tc.log" 2>&1; echo "typecheck=$?"
npm test > "$LOG/npmtest.log" 2>&1; echo "npmtest=$?"
grep -E "^# (pass|fail) " "$LOG/npmtest.log" | awk '{a[$2]+=$3} END {print "pass",a["pass"],"fail",a["fail"]}'
(cd apps/settlement && go test -p 1 ./... > "$LOG/go.log" 2>&1); echo "go=$?"
echo "logs in $LOG"
