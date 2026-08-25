import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Server-side database handle.
 *
 * Uses the pooled Supabase connection string, so it is safe in serverless
 * handlers. Never import this from client components: it carries the service
 * credentials, and row-level security is bypassed by the service role.
 */
export function createDb(connectionString: string) {
  const sql = postgres(connectionString, { prepare: false });
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
