import {
  boolean,
  date,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt } from './_shared.js';
import { blackoutScope, seasonStatus, weekStatus } from './enums.js';
import { orgs } from './tenancy.js';

export const leagues = pgTable('leagues', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Only mixed doubles today; the column exists so adding formats is not a migration of every row. */
  format: text('format').notNull().default('mixed_doubles'),
  createdAt: createdAt(),
});

export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  address: text('address'),
  createdAt: createdAt(),
});

export const courts = pgTable('courts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  surface: text('surface'),
  isIndoor: boolean('is_indoor').notNull().default(false),
  createdAt: createdAt(),
});

export const seasons = pgTable('seasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  leagueId: uuid('league_id')
    .notNull()
    .references(() => leagues.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  /** Weeks actually played. The guarantee is denominated in these. */
  playingWeeks: smallint('playing_weeks').notNull().default(26),
  /**
   * Calendar length, normally two more than `playingWeeks` so weather has
   * somewhere to go. At 8 couples on 2 courts, 28 calendar weeks is also
   * exactly a double round-robin.
   */
  calendarWeeks: smallint('calendar_weeks').notNull().default(28),
  /** 0 = Sunday, matching Postgres `extract(dow ...)`. */
  nightOfWeek: smallint('night_of_week').notNull(),
  timezone: text('timezone').notNull().default('America/New_York'),
  status: seasonStatus('status').notNull().default('draft'),
  /**
   * Weeks a single couple may purchase. Enforced at checkout and re-checked
   * before a schedule is published; never higher than capacity allows.
   */
  weeksPerTeamCap: smallint('weeks_per_team_cap'),
  createdAt: createdAt(),
});

/** Which courts this season actually books, in display order. */
export const seasonCourts = pgTable(
  'season_courts',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    courtId: uuid('court_id')
      .notNull()
      .references(() => courts.id, { onDelete: 'cascade' }),
    sortOrder: smallint('sort_order').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.seasonId, table.courtId] })],
);

/**
 * Start times on a league night. One row is a single wave; two rows put every
 * couple on court every week and double what the season can sell.
 */
export const timeSlots = pgTable(
  'time_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    startTime: time('start_time').notNull(),
    durationMinutes: smallint('duration_minutes').notNull().default(90),
    sortOrder: smallint('sort_order').notNull().default(0),
  },
  (table) => [uniqueIndex('time_slots_season_start_idx').on(table.seasonId, table.startTime)],
);

export const weeks = pgTable(
  'weeks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    weekNumber: smallint('week_number').notNull(),
    playDate: date('play_date').notNull(),
    status: weekStatus('status').notNull().default('scheduled'),
    /** Held in reserve for rainouts; not counted toward the guarantee until used. */
    isFlex: boolean('is_flex').notNull().default(false),
    canceledReason: text('canceled_reason'),
    makeupForWeekId: uuid('makeup_for_week_id'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('weeks_season_number_idx').on(table.seasonId, table.weekNumber),
    uniqueIndex('weeks_season_date_idx').on(table.seasonId, table.playDate),
  ],
);

/**
 * A week someone cannot play. Season-scoped rows close the week for everyone;
 * team and player rows feed the scheduler and sub sourcing respectively.
 */
export const blackouts = pgTable('blackouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  seasonId: uuid('season_id')
    .notNull()
    .references(() => seasons.id, { onDelete: 'cascade' }),
  weekId: uuid('week_id')
    .notNull()
    .references(() => weeks.id, { onDelete: 'cascade' }),
  scope: blackoutScope('scope').notNull(),
  teamId: uuid('team_id'),
  playerId: uuid('player_id'),
  reason: text('reason'),
  createdAt: createdAt(),
});

export type Season = typeof seasons.$inferSelect;
export type Week = typeof weeks.$inferSelect;
export type Court = typeof courts.$inferSelect;
export type TimeSlot = typeof timeSlots.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
