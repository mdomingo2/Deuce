#!/usr/bin/env bash
# Concatenate every migration into one file for the Supabase SQL editor.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
OUT=dist/supabase-setup.sql
{
  echo "-- Deuce: complete database setup."
  echo "-- Generated from packages/db/migrations by 'pnpm --filter @deuce/db bundle'."
  echo "-- Paste into the Supabase SQL editor and run once."
  echo "-- Do NOT run test/supabase-shim.sql here: Supabase already provides the"
  echo "-- auth schema, auth.uid() and the API roles that the shim fabricates."
  echo
  for f in migrations/*.sql; do
    echo; echo "-- ============================================================"
    echo "-- $f"
    echo "-- ============================================================"; echo
    cat "$f"
  done
} > "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT") lines)"
