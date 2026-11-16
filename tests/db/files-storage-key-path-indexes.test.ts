/**
 * Slice 9 media (#140): `files.storage_key` / `files.path` indexes.
 *
 * The orphan sweeper's reference check runs once per <= 45-key chunk against
 * these two columns. Without indexes, every chunk is a full scan of `files`
 * — on the Workers Free profile that would exhaust the D1 daily rows-read
 * budget within days of the hourly cron. This test pins both the applied
 * indexes and the query plan the sweeper's exact query shape uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { inArray, or } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import { ORPHAN_SWEEP_REFERENCE_CHUNK } from '../../src/services/media-cleanup.service.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

beforeAll(() => {
  migrate(db, { migrationsFolder: './src/db/migrations' });
  const now = Date.now();
  const comm = Number(
    sqlite
      .prepare(
        'INSERT INTO communities (name, slug, created_at, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('Index Comm', 'index-comm', now, now).lastInsertRowid
  );
  const insert = sqlite.prepare(
    `INSERT INTO files (id, filename, original_name, path, storage_key, url, mime_type, size, community_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'image/png', 1, ?, ?, ?)`
  );
  for (let i = 0; i < 120; i += 1) {
    const id = `index-fixture-${i}`;
    insert.run(
      id,
      id,
      id,
      `communities/${comm}/media/path-${i}`,
      `communities/${comm}/media/key-${i}`,
      `/v2/media/${id}`,
      comm,
      now,
      now
    );
  }
});

afterAll(() => {
  sqlite.close();
});

describe('Slice 9 files.storage_key/path indexes (#140)', () => {
  it('applies files_storage_key_idx and files_path_idx on the files table', () => {
    const names = (
      sqlite.prepare("PRAGMA index_list('files')").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toContain('files_storage_key_idx');
    expect(names).toContain('files_path_idx');
  });

  it("the orphan sweeper's OR'd IN lookup uses both indexes, never SCAN files", () => {
    const chunk = Array.from(
      { length: ORPHAN_SWEEP_REFERENCE_CHUNK },
      (_, i) => `communities/1/media/key-${i}`
    );
    // The exact query shape MediaCleanupCoordinator.findReferencedKeys uses.
    const query = db
      .select({
        storageKey: tables.files.storageKey,
        path: tables.files.path,
      })
      .from(tables.files)
      .where(
        or(
          inArray(tables.files.storageKey, chunk),
          inArray(tables.files.path, chunk)
        )
      )
      .toSQL();
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...query.params) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);
    expect(
      details.every((detail) => !/SCAN files/i.test(detail)),
      `query plan must not scan files: ${details.join(' | ')}`
    ).toBe(true);
    expect(
      details.some((detail) => detail.includes('files_storage_key_idx')),
      `query plan must use files_storage_key_idx: ${details.join(' | ')}`
    ).toBe(true);
    expect(
      details.some((detail) => detail.includes('files_path_idx')),
      `query plan must use files_path_idx: ${details.join(' | ')}`
    ).toBe(true);
  });
});
