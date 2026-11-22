/**
 * Migration 0021 (migrator D1): users.email becomes nullable without losing
 * rows, indexes, triggers or child-table references.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

const full = 'src/db/migrations';

function migrationsUpTo0019(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-0019-'));
  cpSync(full, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.filter((e) => !e.tag.startsWith('0021_'));
  writeFileSync(journalPath, JSON.stringify(journal));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('0021_users_email_nullable', () => {
  it('keeps data, indexes and triggers and allows NULL emails', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(drizzle(db), { migrationsFolder: migrationsUpTo0019() });
    const now = Date.now();
    db.prepare(
      "INSERT INTO communities (id, name, slug, created_at, updated_at) VALUES (1, 'c', 'c', ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO users (id, email, password_hash, first_name, last_name, community_id, created_at, updated_at) VALUES (1, 'a@example.test', 'x', '', '', 1, ?, ?)"
    ).run(now, now);
    db.prepare(
      'INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, 1, ?)'
    ).run('s1', 'h'.repeat(8), now + 1000);

    migrate(drizzle(db), { migrationsFolder: full });

    expect(db.prepare('SELECT email FROM users WHERE id = 1').get()).toEqual({
      email: 'a@example.test',
    });
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
      n: 1,
    });
    const info = db
      .prepare(
        "SELECT \"notnull\" AS nn FROM pragma_table_info('users') WHERE name = 'email'"
      )
      .get() as { nn: number };
    expect(info.nn).toBe(0);
    for (const id of [2, 3]) {
      db.prepare(
        "INSERT INTO users (id, email, password_hash, first_name, last_name, community_id, created_at, updated_at) VALUES (?, NULL, 'x', '', '', 1, ?, ?)"
      ).run(id, now, now);
    }
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users'"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('users_email_community_unique');
    expect(indexes).toContain('idx_users_community_email');
    // a duplicate non-null email in one community is still rejected
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, email, password_hash, first_name, last_name, community_id, created_at, updated_at) VALUES (9, 'a@example.test', 'x', '', '', 1, ?, ?)"
        )
        .run(now, now)
    ).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const trigger = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='users_revoke_sessions'"
      )
      .get();
    expect(trigger).toBeDefined();
    db.close();
  });
});
