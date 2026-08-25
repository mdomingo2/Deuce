#!/usr/bin/env bash
#
# Apply the migrations to a throwaway database and run the RLS tests.
#
# Uses $DATABASE_URL when set (CI service container, or a local Postgres you
# already run). Otherwise starts a private cluster under /var/tmp, so the tests
# need no Docker and no Supabase project.
#
#   ./test/run.sh
#   DATABASE_URL=postgres://... ./test/run.sh

set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="deuce_test"

if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL=(psql "$DATABASE_URL")
  ADMIN=("${PSQL[@]}")
else
  PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
  PGDIR="${PGDIR:-/var/tmp/deucepg}"
  PGDATA="$PGDIR/data"
  PGPORT="${PGPORT:-54329}"

  if [[ ! -d "$PGDATA" ]]; then
    id deucepg >/dev/null 2>&1 || useradd -m deucepg
    mkdir -p "$PGDATA"
    chown -R deucepg "$PGDIR"
    su deucepg -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
  fi

  if ! "$PGBIN/pg_isready" -h "$PGDIR" -p "$PGPORT" >/dev/null 2>&1; then
    su deucepg -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k $PGDIR' -l $PGDIR/pg.log start" >/dev/null
    sleep 2
  fi

  export PGHOST="$PGDIR" PGPORT="$PGPORT" PGUSER=postgres
  ADMIN=(psql -d postgres)
  PSQL=(psql -d "$DB_NAME")

  "${ADMIN[@]}" -q -c "drop database if exists $DB_NAME;" -c "create database $DB_NAME;"
fi

echo "==> Supabase shim"
"${PSQL[@]}" -q -v ON_ERROR_STOP=1 -f test/supabase-shim.sql

echo "==> Migrations"
for file in migrations/*.sql; do
  echo "    $file"
  "${PSQL[@]}" -q -v ON_ERROR_STOP=1 -f "$file"
done

echo "==> RLS and constraint tests"
"${PSQL[@]}" -q -v ON_ERROR_STOP=1 -f test/rls.test.sql
