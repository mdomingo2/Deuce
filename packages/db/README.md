# @deuce/db

Schema, migrations and row-level security for Deuce.

## Applying to Supabase

Run the migrations in `migrations/` **in filename order** against your project.
Two ways:

**SQL editor** (no database password needed). Open the Supabase SQL editor and
paste each file in order:

1. `migrations/0000_*.sql` — tables, enums, indexes
2. `migrations/0001_rls_and_constraints.sql` — RLS, auth bridge, constraints

**drizzle-kit** (needs the pooler connection string):

```bash
DATABASE_URL='postgresql://postgres.<ref>:<password>@...pooler.supabase.com:6543/postgres' \
  pnpm --filter @deuce/db migrate
```

> Do **not** run `test/supabase-shim.sql` against Supabase. It fabricates the
> `auth` schema, `auth.uid()` and the API roles so the migrations can be tested
> on a plain Postgres. Supabase already provides all of them, and running the
> shim there would collide with the real ones.

## Testing

```bash
pnpm --filter @deuce/db test:db
```

Applies the shim, every migration, and `test/rls.test.sql` to a throwaway
database. Uses `$DATABASE_URL` when set, otherwise starts a private Postgres
cluster under `/var/tmp` — no Docker, no Supabase project. CI runs the same
script against a `postgres:16` service container.

The tests switch to the `authenticated` role and set `auth.uid()` before
asserting anything, because RLS is bypassed for superusers and a test that
forgets to switch role proves nothing.

## Regenerating

```bash
pnpm --filter @deuce/db generate   # after editing src/schema/*
```

`0001_rls_and_constraints.sql` is hand-written and drizzle-kit will never
regenerate it. Policies, SECURITY DEFINER helpers and the Supabase auth bridge
are outside what the schema DSL can express, so they live in SQL on purpose.
