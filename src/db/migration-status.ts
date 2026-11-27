import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from './index.js';
import type { getMigrationPlan } from './migrate.js';

/**
 * True when every bundled migration entry is recorded in drizzle's journal table.
 * Rejects when the journal table is missing (never migrated).
 */
export async function allMigrationsApplied(
  database: Database,
  plan: ReturnType<typeof getMigrationPlan>
): Promise<boolean> {
  const journal = JSON.parse(
    readFileSync(
      path.join(plan.migrationsFolder, 'meta', '_journal.json'),
      'utf8'
    )
  ) as { entries: { when: number }[] };
  const query = sql`SELECT created_at FROM ${
    plan.dialect === 'postgresql'
      ? sql.raw('drizzle."__drizzle_migrations"')
      : sql.raw('"__drizzle_migrations"')
  }`;
  const rows: { created_at: number | string }[] =
    plan.dialect === 'postgresql'
      ? Array.from(
          await (
            database as unknown as {
              execute: (q: unknown) => Promise<ArrayLike<never>>;
            }
          ).execute(query)
        )
      : (database as unknown as { all: (q: unknown) => never[] }).all(query);
  // Every bundled migration must be recorded (drizzle stores each entry's
  // `when` as created_at); a newer row never stands in for a missing one.
  const applied = new Set(rows.map((r) => Number(r.created_at)));
  return journal.entries.every((e) => applied.has(e.when));
}
