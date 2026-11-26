import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from './index.js';
import type { getMigrationPlan } from './migrate.js';

/**
 * True when every bundled migration is recorded in drizzle's journal table.
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
  const expectedCount = journal.entries.length;
  const expectedLast = Math.max(...journal.entries.map((e) => e.when));
  const query = sql`SELECT count(*) AS n, max(created_at) AS m FROM ${
    plan.dialect === 'postgresql'
      ? sql.raw('drizzle."__drizzle_migrations"')
      : sql.raw('"__drizzle_migrations"')
  }`;
  const rows: { n: number | string; m: number | string | null }[] =
    plan.dialect === 'postgresql'
      ? Array.from(
          await (
            database as unknown as {
              execute: (q: unknown) => Promise<ArrayLike<never>>;
            }
          ).execute(query)
        )
      : (database as unknown as { all: (q: unknown) => never[] }).all(query);
  const row = rows[0];
  return (
    Number(row?.n ?? 0) >= expectedCount && Number(row?.m ?? 0) >= expectedLast
  );
}
