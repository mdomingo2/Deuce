import { pgEnum } from 'drizzle-orm/pg-core';

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'scorekeeper', 'member']);

/**
 * Which side of a mixed-doubles pairing a player occupies.
 *
 * This is a scheduling category, not identity data: mixed doubles requires each
 * team to field one of each, so the scheduler needs a hard constraint to work
 * with. It is deliberately separate from anything on `profiles`.
 */
export const pairingCategory = pgEnum('pairing_category', ['M', 'F']);

export const playerStatus = pgEnum('player_status', ['active', 'inactive']);

export const seasonStatus = pgEnum('season_status', [
  'draft',
  'scheduling',
  'published',
  'active',
  'complete',
]);

export const weekStatus = pgEnum('week_status', [
  'scheduled',
  'canceled',
  'completed',
  'makeup',
]);

export const blackoutScope = pgEnum('blackout_scope', ['season', 'team', 'player']);

export const registrationRole = pgEnum('registration_role', ['roster', 'sub', 'both']);

export const teamStatus = pgEnum('team_status', ['active', 'withdrawn']);

/**
 * Why a row moved a team's entitlement balance.
 *
 * The ledger is append-only, so a balance is always the sum of its history.
 * Money gets argued about; being able to show line items is the point.
 */
export const entitlementReason = pgEnum('entitlement_reason', [
  'purchase',
  'refund',
  'rainout_credit',
  'admin_adjust',
  'comp',
]);

export const productUnit = pgEnum('product_unit', ['week', 'full_season', 'sub_pass']);

export const orderStatus = pgEnum('order_status', ['pending', 'paid', 'refunded', 'void']);

export const paymentProvider = pgEnum('payment_provider', [
  'stripe',
  'cash',
  'check',
  'venmo',
  'zelle',
  'other',
]);
