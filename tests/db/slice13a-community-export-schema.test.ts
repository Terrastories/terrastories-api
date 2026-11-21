import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';

describe('Slice 13a export_jobs and export_tokens schema & constraints', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  function setupDb() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const now = new Date('2026-11-21T10:00:00.000Z');
    const tables = tablesFor(db);
    db.insert(tables.communities)
      .values([
        {
          id: 1,
          name: 'Community One',
          slug: 'comm-1',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 2,
          name: 'Community Two',
          slug: 'comm-2',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(tables.users)
      .values({
        id: 1,
        email: 'admin@comm1.test',
        passwordHash: 'anchor-hash',
        firstName: 'Admin',
        lastName: 'One',
        role: 'admin',
        communityId: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { sqlite, db, tables, nowMs: now.getTime() };
  }

  it('enforces single active generating job per community while allowing completed/expired history and parallel communities', () => {
    const { sqlite, db, tables, nowMs } = setupDb();
    const expiresAt = nowMs + 900_000;

    db.insert(tables.exportJobs)
      .values({
        id: 'job-1',
        communityId: 1,
        requestedBy: 1,
        status: 'generating',
        createdAt: nowMs,
        expiresAt,
      })
      .run();

    // Second concurrent 'generating' job for community 1 is rejected.
    expect(() =>
      db
        .insert(tables.exportJobs)
        .values({
          id: 'job-2',
          communityId: 1,
          requestedBy: 1,
          status: 'generating',
          createdAt: nowMs + 1,
          expiresAt: expiresAt + 1,
        })
        .run()
    ).toThrow(/UNIQUE constraint failed/i);

    // Different community can generate concurrently.
    db.insert(tables.exportJobs)
      .values({
        id: 'job-other-comm',
        communityId: 2,
        requestedBy: null,
        status: 'generating',
        createdAt: nowMs,
        expiresAt,
      })
      .run();

    // Completing job-1 frees the partial unique lock for a subsequent export.
    db.update(tables.exportJobs)
      .set({ status: 'ready', completedAt: nowMs + 10 })
      .where(eq(tables.exportJobs.id, 'job-1'))
      .run();

    db.insert(tables.exportJobs)
      .values({
        id: 'job-3',
        communityId: 1,
        requestedBy: 1,
        status: 'generating',
        createdAt: nowMs + 20,
        expiresAt: expiresAt + 20,
      })
      .run();

    const indexes = sqlite
      .prepare('PRAGMA index_list(export_jobs)')
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain(
      'export_jobs_active_community_unique'
    );
  });

  it('enforces status, artifact, expiry CHECK constraints and cascade deletes', () => {
    const { db, tables, nowMs } = setupDb();
    const expiresAt = nowMs + 900_000;

    expect(() =>
      db
        .insert(tables.exportJobs)
        .values({
          id: 'bad-status',
          communityId: 1,
          requestedBy: 1,
          status: 'bogus' as 'ready',
          createdAt: nowMs,
          expiresAt,
        })
        .run()
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      db
        .insert(tables.exportJobs)
        .values({
          id: 'bad-expiry',
          communityId: 1,
          requestedBy: 1,
          status: 'ready',
          createdAt: nowMs,
          expiresAt: nowMs,
        })
        .run()
    ).toThrow(/CHECK constraint failed/i);

    db.insert(tables.exportJobs)
      .values({
        id: 'job-ok',
        communityId: 1,
        requestedBy: 1,
        status: 'ready',
        createdAt: nowMs,
        completedAt: nowMs,
        expiresAt,
      })
      .run();

    expect(() =>
      db
        .insert(tables.exportTokens)
        .values({
          jobId: 'job-ok',
          communityId: 1,
          requestedBy: 1,
          artifact: 'other' as 'manifest',
          tokenHash: 'a'.repeat(64),
          createdAt: nowMs,
          expiresAt,
        })
        .run()
    ).toThrow(/CHECK constraint failed/i);

    db.insert(tables.exportTokens)
      .values([
        {
          jobId: 'job-ok',
          communityId: 1,
          requestedBy: 1,
          artifact: 'manifest',
          tokenHash: 'b'.repeat(64),
          createdAt: nowMs,
          expiresAt,
        },
        {
          jobId: 'job-ok',
          communityId: 1,
          requestedBy: 1,
          artifact: 'media_zip',
          tokenHash: 'c'.repeat(64),
          createdAt: nowMs,
          expiresAt,
        },
      ])
      .run();

    // Duplicate artifact per job rejected.
    expect(() =>
      db
        .insert(tables.exportTokens)
        .values({
          jobId: 'job-ok',
          communityId: 1,
          requestedBy: 1,
          artifact: 'manifest',
          tokenHash: 'd'.repeat(64),
          createdAt: nowMs,
          expiresAt,
        })
        .run()
    ).toThrow(/UNIQUE constraint failed/i);

    // Deleting job cascades export_tokens.
    db.delete(tables.exportJobs)
      .where(eq(tables.exportJobs.id, 'job-ok'))
      .run();
    const remainingTokens = db.select().from(tables.exportTokens).all();
    expect(remainingTokens).toHaveLength(0);
  });
});
