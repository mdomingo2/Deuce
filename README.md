# Deuce

A league platform for fixed-pair mixed doubles tennis, built around one promise:
**every couple gets at least the court time they paid for, and the app can prove it.**

The league it is being built for runs 8 couples on 2 courts for 26 weeks. Each
couple buys a number of weeks up front; the scheduler guarantees that floor,
substitutes cover ad-hoc absences, and scores and standings live in one place
instead of a group text.

## Why the guarantee is the product

Court time is a fixed quantity. No scheduling cleverness creates more of it:

```
Team-slots per season = weeks x courts x waves x 2
                      = 26 x 2 x 1 x 2          = 104
Max weeks per couple  = 104 / 8 couples         = 13
```

Selling 13 weeks to all eight couples consumes 100% of capacity, so a single
blackout date makes the season infeasible. The recommended cap is **12**, which
leaves 8 team-slots of slack for vacations, makeups, and an extra-play waitlist.

Every competing product (MatchTime, Tenniscores, CourtReserve, Global Tennis
Network) does scheduling and standings. None of them sell the guarantee.

## Current state

Phase 0 and the core of Phase 2. `@deuce/scheduler` is complete and tested; the
web app and database packages are scaffolded but empty.

| Package | State |
|---|---|
| `packages/scheduler` | Working. Capacity math, round-robin construction, hard-constraint validation, CLI preview. 21 tests. |
| `packages/db` | Scaffold only. Drizzle schema next. |
| `apps/web` | Scaffold only. Next.js PWA next. |

## Try it

```bash
pnpm install
pnpm test

# Preview a season without a database, a server, or an account
pnpm --filter @deuce/scheduler preview
pnpm --filter @deuce/scheduler preview -- --weeks 28
pnpm --filter @deuce/scheduler preview -- --waves 2
```

## The scheduler

`@deuce/scheduler` is deliberately free of database and network imports. It takes
plain objects and returns plain objects, which is what makes it exhaustively
testable and runnable from a laptop against production data if a serverless
invocation ever times out.

**Round-robin construction** handles the case where every couple bought the same
number of weeks. Balance is exact and opponent variety is provably optimal, so no
solver runs at all. One result is worth knowing:

> 8 couples on 2 courts over **28 weeks** is a *perfect double round-robin* —
> every couple meets every other couple exactly twice. At 26 weeks you are one
> round short. This is the argument for running 26 playing weeks inside a
> 28-week calendar and letting the two flex weeks absorb rain.

**Flow and annealing** (not yet built) handles varied entitlements, where the
guarantee becomes a min-cost flow problem with lower bounds. Exact where the
promise lives, heuristic where the objective is only aesthetic.

**Court assignment** balances each couple's court history rather than rotating by
week number. Rotating by week looks fair and silently isn't: a team holding the
same position in every round advances in lockstep with the week index and lands
on the same court all season. There is a test for this.

## Layout

```
packages/scheduler   pure TypeScript, no I/O
packages/db          Drizzle schema, migrations, RLS policies
apps/web             Next.js 15 App Router PWA
```

## Stack

Next.js 15 · TypeScript · Supabase (Postgres, Auth, Realtime, RLS) · Drizzle ·
Tailwind · shadcn/ui · Vercel.

Supabase is chosen over a roll-your-own Postgres mainly for realtime chat —
Vercel's serverless runtime cannot hold a WebSocket — and for `pg_cron`, which
drives sub-request escalation and 48-hour score auto-confirmation.
