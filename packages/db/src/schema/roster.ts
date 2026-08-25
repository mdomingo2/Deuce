import { sql } from 'drizzle-orm';
import {
  check,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt } from './_shared.js';
import { pairingCategory, playerStatus, registrationRole, teamStatus } from './enums.js';
import { seasons } from './league.js';
import { orgs, profiles } from './tenancy.js';

/**
 * Someone who plays in this org.
 *
 * `profileId` is null until they claim their invite, so the admin can load a
 * roster from a spreadsheet before anyone has signed in.
 */
export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email'),
    phoneE164: text('phone_e164'),
    /** Which side of a mixed pairing this player fills. A scheduling constraint. */
    pairingCategory: pairingCategory('pairing_category').notNull(),
    /** Self-reported NTRP, used to keep substitutes at a comparable level. */
    ntrpRating: numeric('ntrp_rating', { precision: 2, scale: 1 }),
    /** Elo-style rating maintained from results; seeded from NTRP. */
    internalRating: numeric('internal_rating', { precision: 6, scale: 2 }),
    status: playerStatus('status').notNull().default('active'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('players_org_profile_idx')
      .on(table.orgId, table.profileId)
      .where(sql`profile_id is not null`),
  ],
);

/**
 * A fixed pair, locked for the season.
 *
 * The two seats are separate columns rather than a join table because mixed
 * doubles always has exactly one of each, and a check constraint plus two
 * unique indexes then make an invalid roster impossible rather than merely
 * discouraged: nobody can be on two teams, and no team can field two of the
 * same pairing category.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    malePlayerId: uuid('male_player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'restrict' }),
    femalePlayerId: uuid('female_player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'restrict' }),
    status: teamStatus('status').notNull().default('active'),
    seed: smallint('seed'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('teams_season_male_idx').on(table.seasonId, table.malePlayerId),
    uniqueIndex('teams_season_female_idx').on(table.seasonId, table.femalePlayerId),
    uniqueIndex('teams_season_name_idx').on(table.seasonId, table.name),
    check('teams_distinct_players', sql`male_player_id <> female_player_id`),
  ],
);

/** Who is on the roster this season, and in what capacity. */
export const seasonRegistrations = pgTable(
  'season_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    role: registrationRole('role').notNull().default('roster'),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    waiverSignedAt: timestamp('waiver_signed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('season_registrations_unique_idx').on(table.seasonId, table.playerId)],
);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
