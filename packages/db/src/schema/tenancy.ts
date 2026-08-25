import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { orgRole } from './enums.js';
import { createdAt as now } from './_shared.js';

/**
 * A club or league operator. Every tenant-scoped table carries `orgId`
 * denormalised, even where it could be derived, so that each row-level security
 * policy is the same one-line predicate and every index stays cheap.
 */
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt: now(),
});

/**
 * A person, keyed to their Supabase auth user.
 *
 * Deliberately NOT tenant-scoped: one human can belong to several orgs once the
 * product is multi-tenant, and duplicating them per org would fragment login.
 */
export const profiles = pgTable('profiles', {
  // Mirrors auth.users.id. The FK is added in the RLS migration, because
  // Drizzle does not model Supabase's auth schema.
  id: uuid('id').primaryKey(),
  fullName: text('full_name'),
  preferredName: text('preferred_name'),
  email: text('email'),
  phoneE164: text('phone_e164'),
  avatarUrl: text('avatar_url'),
  createdAt: now(),
});

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('member'),
    createdAt: now(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] })],
);
