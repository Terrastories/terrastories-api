/**
 * Slice 10 auth (#137): `users.email_normalized` index.
 *
 * Prelogin and login resolve the identifier first, without a community
 * filter, via `email_normalized = ? OR username_normalized = ?`. The composite
 * (community_id, email_normalized) and null-community-only email indexes cannot
 * serve that lookup, so without this index every prelogin scans `users` — on
 * Workers Free that spends D1 rows-read in proportion to the account table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const sqlite = new Sqlite(':memory:');
const db = drizzle(sqlite);

beforeAll(() => {
  migrate(db, { migrationsFolder: './src/db/migrations' });
});

afterAll(() => {
  sqlite.close();
});

describe('Slice 10 users.email_normalized index (#137)', () => {
  it('applies users_email_normalized_idx', () => {
    const names = (
      sqlite.prepare("PRAGMA index_list('users')").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toContain('users_email_normalized_idx');
  });

  it('serves the unscoped identifier-first lookup from indexes, never a full scan', () => {
    const plan = (
      sqlite
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM users WHERE email_normalized = ? OR username_normalized = ?'
        )
        .all('someone@example.test', 'someone@example.test') as Array<{
        detail: string;
      }>
    ).map((row) => row.detail);
    expect(plan.join(' | ')).not.toMatch(/SCAN users(?! USING)/);
    expect(plan.some((d) => d.includes('users_email_normalized_idx'))).toBe(
      true
    );
  });
});
