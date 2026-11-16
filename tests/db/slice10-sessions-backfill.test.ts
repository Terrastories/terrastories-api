import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../../src/db/schema/index.js';

const migrationsFolder = path.resolve(process.cwd(), 'src/db/migrations');

/** Build a throwaway migrations folder holding entries [0..end] for one tag. */
function createSqliteMigrationsFolderThrough(lastTag: string): string {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tsapi-sqlite-through-')
  );
  fs.mkdirSync(path.join(tmpDir, 'meta'), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync(
      path.join(migrationsFolder, 'meta', '_journal.json'),
      'utf8'
    )
  ) as { version: string; dialect: string; entries: Array<{ tag: string }> };
  const end = journal.entries.findIndex((e) => e.tag === lastTag);
  if (end < 0) {
    throw new Error(`Migration tag not found in _journal.json: ${lastTag}`);
  }
  const entries = journal.entries.slice(0, end + 1);
  fs.writeFileSync(
    path.join(tmpDir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2)
  );
  for (const e of entries) {
    fs.copyFileSync(
      path.join(migrationsFolder, `${e.tag}.sql`),
      path.join(tmpDir, `${e.tag}.sql`)
    );
  }
  return tmpDir;
}

describe('Slice 10 SQLite migration 0012 — legacy session backfill', () => {
  const openDbs: Database.Database[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps pre-0012 session rows and gives them a renewable absolute expiry', () => {
    const through0010 = createSqliteMigrationsFolderThrough(
      '0010_canonical_media_and_map_configs'
    );
    const through0012 = createSqliteMigrationsFolderThrough(
      '0012_auth_throttle_and_session_lifetimes'
    );
    tempDirs.push(through0010, through0012);

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: through0010 });

    const now = 1_700_000_000_000;
    const commId = Number(
      sqlite
        .prepare(
          `INSERT INTO communities (name, slug, created_at, updated_at) VALUES ('C1', 'c1', ?, ?)`
        )
        .run(now, now).lastInsertRowid
    );
    const userId = Number(
      sqlite
        .prepare(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, community_id, created_at, updated_at) VALUES ('legacy@example.org', 'h', 'Leg', 'Acy', 'viewer', ?, ?, ?)`
        )
        .run(commId, now, now).lastInsertRowid
    );
    // A typical legacy row (expires in the future, created 30 days ago) and a
    // small-expiry row that exercises the MAX(..., 0) created_at clamp.
    const expiresAtBig = now + 30 * 24 * 3600_000;
    const expiresAtSmall = 1_000;
    sqlite
      .prepare(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)`
      )
      .run('sess-big', 'th-big', userId, expiresAtBig);
    sqlite
      .prepare(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)`
      )
      .run('sess-small', 'th-small', userId, expiresAtSmall);

    migrate(db, { migrationsFolder: through0012 });

    type SessionRow = {
      id: string;
      kind: string;
      created_at: number;
      last_seen_at: number;
      idle_expires_at: number;
      absolute_expires_at: number;
    };
    const rows = sqlite
      .prepare(
        `SELECT id, kind, created_at, last_seen_at, idle_expires_at, absolute_expires_at FROM sessions ORDER BY id`
      )
      .all() as SessionRow[];
    expect(rows.map((row) => row.id)).toEqual(['sess-big', 'sess-small']);
    // DEVICE_SESSION_ABSOLUTE_MS is the value sessionLifetimesFor applies for
    // every kind (5184000000 ms); the migration files carry the literal.
    const absoluteLifetime = 5_184_000_000;
    const idleWindow = 43_200_000; // 12h

    const big = rows[0]!;
    expect(big.kind).toBe('standard');
    expect(big.created_at).toBe(expiresAtBig - idleWindow);
    expect(big.last_seen_at).toBe(big.created_at);
    expect(big.idle_expires_at).toBe(expiresAtBig);
    expect(big.absolute_expires_at).toBe(
      Math.max(big.created_at + absoluteLifetime, big.idle_expires_at)
    );
    // The point of the backfill: a renewing legacy session is NOT cut off at
    // its legacy expiry.
    expect(big.absolute_expires_at).toBeGreaterThan(big.idle_expires_at);

    const small = rows[1]!;
    expect(small.kind).toBe('standard');
    expect(small.created_at).toBe(0);
    expect(small.last_seen_at).toBe(0);
    expect(small.idle_expires_at).toBe(expiresAtSmall);
    expect(small.absolute_expires_at).toBe(absoluteLifetime);
  });
});
