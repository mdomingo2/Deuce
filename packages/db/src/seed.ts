/**
 * Load a real league into the database.
 *
 * Reads `seed/roster.csv` and `seed/season.json`, checks the purchases against
 * season capacity BEFORE writing anything, then creates the org, league, venue,
 * courts, time slots, the full week calendar, players, fixed pairs, and the
 * opening entitlement ledger rows.
 *
 *   DATABASE_URL='postgresql://...' pnpm --filter @deuce/db seed
 *   DATABASE_URL='postgresql://...' pnpm --filter @deuce/db seed -- --reset
 *
 * `--reset` deletes the org named in season.json first. Everything cascades
 * from `orgs`, so this wipes that league entirely. It refuses to run without
 * `--reset` if the org already exists, so re-running by accident cannot
 * silently duplicate a roster.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { checkEntitlements, computeCapacity, explainCapacity } from '@deuce/scheduler';
import { createDb } from './client.js';
import {
  courts as courtsTable,
  entitlementLedger,
  leagues,
  orgs,
  players,
  seasonCourts,
  seasonRegistrations,
  seasons,
  teams,
  timeSlots,
  venues,
  weeks,
} from './schema/index.js';

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');

interface SeasonConfig {
  org: { name: string; slug: string; timezone: string };
  league: { name: string };
  venue: { name: string; address?: string };
  courts: string[];
  season: {
    name: string;
    startDate: string;
    nightOfWeek: number;
    playingWeeks: number;
    calendarWeeks: number;
  };
  timeSlots: Array<{ startTime: string; durationMinutes?: number }>;
}

interface RosterRow {
  team_name: string;
  m_first: string;
  m_last: string;
  m_email: string;
  m_ntrp: string;
  f_first: string;
  f_last: string;
  f_email: string;
  f_ntrp: string;
  weeks_purchased: string;
}

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, no external dependency. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const header = nonEmpty.shift();
  if (!header) throw new Error('roster.csv is empty');

  return nonEmpty.map((cells, index) => {
    if (cells.length !== header.length) {
      throw new Error(
        `roster.csv row ${index + 2} has ${cells.length} columns, expected ${header.length}`,
      );
    }
    return Object.fromEntries(header.map((h, i) => [h.trim(), cells[i]!.trim()]));
  });
}

/** Weekly dates from `startDate`, inclusive, using UTC so DST never shifts a night. */
function weeklyDates(startDate: string, count: number): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid startDate: ${startDate}`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
}

const nullable = (value: string): string | null => (value.trim() === '' ? null : value.trim());

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Use the Supabase connection string.');
    process.exit(1);
  }
  const reset = process.argv.includes('--reset');

  const config = JSON.parse(readFileSync(join(seedDir, 'season.json'), 'utf8')) as SeasonConfig;
  const roster = parseCsv(readFileSync(join(seedDir, 'roster.csv'), 'utf8')) as unknown as RosterRow[];

  // --- Validate before touching the database ------------------------------

  const startDay = new Date(`${config.season.startDate}T00:00:00Z`).getUTCDay();
  if (startDay !== config.season.nightOfWeek) {
    throw new Error(
      `startDate ${config.season.startDate} falls on day ${startDay}, ` +
        `but nightOfWeek is ${config.season.nightOfWeek}.`,
    );
  }
  if (config.season.calendarWeeks < config.season.playingWeeks) {
    throw new Error('calendarWeeks must be at least playingWeeks.');
  }

  const capacityInput = {
    weeks: config.season.playingWeeks,
    courts: config.courts.length,
    slotsPerCourt: config.timeSlots.length,
    teams: roster.length,
  };
  const capacity = computeCapacity(capacityInput);

  console.log(`\n  ${config.org.name} / ${config.season.name}\n`);
  for (const line of explainCapacity(capacityInput)) console.log(`  - ${line}`);

  const purchases = Object.fromEntries(
    roster.map((r) => {
      const n = Number(r.weeks_purchased);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${r.team_name}: weeks_purchased must be a whole number, got "${r.weeks_purchased}"`);
      }
      return [r.team_name, n];
    }),
  );

  const check = checkEntitlements(capacityInput, purchases);
  if (!check.feasible) {
    console.error('\n  REFUSING TO SEED: the season cannot deliver what was sold.\n');
    for (const over of check.overCeiling) {
      console.error(
        `  - ${over.teamId} bought ${over.purchased} weeks; the ceiling is ${over.ceiling} ` +
          `(over by ${over.excess}).`,
      );
    }
    if (check.aggregateExcess > 0) {
      console.error(`  - Oversold by ${check.aggregateExcess} team-slots in total.`);
    }
    console.error(`\n  Recommended cap is ${capacity.recommendedCap} weeks per couple.\n`);
    process.exit(1);
  }
  console.log(`\n  Purchases fit: ${check.totalPurchased} of ${check.totalTeamSlots} team-slots.\n`);

  // --- Write ---------------------------------------------------------------

  const db = createDb(connectionString);

  const existing = await db.select().from(orgs).where(eq(orgs.slug, config.org.slug));
  if (existing.length > 0) {
    if (!reset) {
      console.error(
        `  Org "${config.org.slug}" already exists. Re-run with --reset to replace it ` +
          `(this deletes the league and everything under it).\n`,
      );
      process.exit(1);
    }
    await db.delete(orgs).where(eq(orgs.slug, config.org.slug));
    console.log('  Removed the existing org (cascade).');
  }

  const [org] = await db
    .insert(orgs)
    .values({ name: config.org.name, slug: config.org.slug, timezone: config.org.timezone })
    .returning();
  const orgId = org!.id;

  const [league] = await db
    .insert(leagues)
    .values({ orgId, name: config.league.name })
    .returning();

  const [venue] = await db
    .insert(venues)
    .values({ orgId, name: config.venue.name, address: config.venue.address ?? null })
    .returning();

  const courtRows = await db
    .insert(courtsTable)
    .values(config.courts.map((label) => ({ orgId, venueId: venue!.id, label })))
    .returning();

  const [season] = await db
    .insert(seasons)
    .values({
      orgId,
      leagueId: league!.id,
      name: config.season.name,
      startDate: config.season.startDate,
      playingWeeks: config.season.playingWeeks,
      calendarWeeks: config.season.calendarWeeks,
      nightOfWeek: config.season.nightOfWeek,
      timezone: config.org.timezone,
      weeksPerTeamCap: capacity.recommendedCap,
      status: 'draft',
    })
    .returning();
  const seasonId = season!.id;

  await db.insert(seasonCourts).values(
    courtRows.map((court, i) => ({ orgId, seasonId, courtId: court.id, sortOrder: i })),
  );

  await db.insert(timeSlots).values(
    config.timeSlots.map((slot, i) => ({
      orgId,
      seasonId,
      startTime: slot.startTime,
      durationMinutes: slot.durationMinutes ?? 90,
      sortOrder: i,
    })),
  );

  // Playing weeks first, then the flex weeks that absorb rainouts.
  const dates = weeklyDates(config.season.startDate, config.season.calendarWeeks);
  await db.insert(weeks).values(
    dates.map((playDate, i) => ({
      orgId,
      seasonId,
      weekNumber: i + 1,
      playDate,
      isFlex: i >= config.season.playingWeeks,
    })),
  );

  for (const row of roster) {
    const [male] = await db
      .insert(players)
      .values({
        orgId,
        firstName: row.m_first,
        lastName: row.m_last,
        email: nullable(row.m_email),
        pairingCategory: 'M',
        ntrpRating: nullable(row.m_ntrp),
      })
      .returning();

    const [female] = await db
      .insert(players)
      .values({
        orgId,
        firstName: row.f_first,
        lastName: row.f_last,
        email: nullable(row.f_email),
        pairingCategory: 'F',
        ntrpRating: nullable(row.f_ntrp),
      })
      .returning();

    const [team] = await db
      .insert(teams)
      .values({
        orgId,
        seasonId,
        name: row.team_name,
        malePlayerId: male!.id,
        femalePlayerId: female!.id,
      })
      .returning();

    await db.insert(seasonRegistrations).values([
      { orgId, seasonId, playerId: male!.id, role: 'roster', teamId: team!.id },
      { orgId, seasonId, playerId: female!.id, role: 'roster', teamId: team!.id },
    ]);

    const purchased = purchases[row.team_name]!;
    if (purchased > 0) {
      await db.insert(entitlementLedger).values({
        orgId,
        seasonId,
        teamId: team!.id,
        delta: purchased,
        reason: 'purchase',
        note: `Seeded from roster.csv`,
      });
    }
  }

  console.log(`  Seeded ${roster.length} couples, ${roster.length * 2} players.`);
  console.log(
    `  ${config.season.playingWeeks} playing weeks + ` +
      `${config.season.calendarWeeks - config.season.playingWeeks} flex, ` +
      `${dates[0]} through ${dates[dates.length - 1]}.`,
  );
  console.log(`  Weeks-per-couple cap set to ${capacity.recommendedCap}.\n`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`\n  Seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
