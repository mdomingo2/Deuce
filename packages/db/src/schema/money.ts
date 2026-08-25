import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt } from './_shared.js';
import { entitlementReason, orderStatus, paymentProvider, productUnit } from './enums.js';
import { seasons, weeks } from './league.js';
import { teams } from './roster.js';
import { orgs, profiles } from './tenancy.js';

/**
 * The entitlement ledger: how many weeks a couple is owed, and why.
 *
 * APPEND-ONLY. A balance is always `sum(delta)` over a team's rows, never a
 * stored number that someone edits. This is the table that lets you answer
 * "why does it say 11 and not 12?" with line items rather than an assurance,
 * which matters because the whole product is a promise about money.
 *
 * Keyed on the TEAM, not the player: couples buy weeks together, which is what
 * removes an entire layer from the scheduler.
 */
export const entitlementLedger = pgTable(
  'entitlement_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Weeks added (purchase, credit) or removed (refund). Never zero. */
    delta: smallint('delta').notNull(),
    reason: entitlementReason('reason').notNull(),
    /** The week that caused this row, for rainout credits. */
    weekId: uuid('week_id').references(() => weeks.id, { onDelete: 'set null' }),
    /** Free-text justification, required for admin adjustments by convention. */
    note: text('note'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('entitlement_ledger_team_idx').on(table.seasonId, table.teamId),
    check('entitlement_ledger_delta_nonzero', sql`delta <> 0`),
  ],
);

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  seasonId: uuid('season_id')
    .notNull()
    .references(() => seasons.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  unit: productUnit('unit').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  createdAt: createdAt(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  seasonId: uuid('season_id')
    .notNull()
    .references(() => seasons.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  quantity: smallint('quantity').notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: orderStatus('status').notNull().default('pending'),
  provider: paymentProvider('provider').notNull().default('cash'),
  providerRef: text('provider_ref'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  amountCents: integer('amount_cents').notNull(),
  provider: paymentProvider('provider').notNull(),
  providerPaymentId: text('provider_payment_id'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  recordedBy: uuid('recorded_by').references(() => profiles.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export type EntitlementLedgerRow = typeof entitlementLedger.$inferSelect;
export type NewEntitlementLedgerRow = typeof entitlementLedger.$inferInsert;
