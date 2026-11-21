import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';

describe('Slice 13b community sovereignty schema & constraints', () => {
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
          slug: 'sov-comm-1',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 2,
          name: 'Community Two',
          slug: 'sov-comm-2',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(tables.users)
      .values([
        {
          id: 1,
          email: 'admin@comm1.test',
          passwordHash: 'anchor-hash',
          firstName: 'Admin',
          lastName: 'One',
          role: 'admin',
          communityId: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 2,
          email: 'member@comm1.test',
          passwordHash: 'anchor-hash',
          firstName: 'Member',
          lastName: 'One',
          role: 'member',
          communityId: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    return { sqlite, db, tables, nowMs: now.getTime() };
  }

  it('enforces community_stewards primary key and user cascade', () => {
    const { db, tables, nowMs } = setupDb();
    db.insert(tables.communityStewards)
      .values({
        communityId: 1,
        userId: 2,
        designatedBy: 1,
        designatedAt: nowMs,
        updatedAt: nowMs,
      })
      .run();

    // Only one steward row per community.
    expect(() =>
      db
        .insert(tables.communityStewards)
        .values({
          communityId: 1,
          userId: 1,
          designatedBy: 1,
          designatedAt: nowMs + 1,
          updatedAt: nowMs + 1,
        })
        .run()
    ).toThrow(/UNIQUE constraint failed/i);

    // Deleting designator nulls designated_by while keeping steward row.
    db.delete(tables.users).where(eq(tables.users.id, 1)).run();
    const afterDesignatorDelete = db
      .select()
      .from(tables.communityStewards)
      .all();
    expect(afterDesignatorDelete).toHaveLength(1);
    expect(afterDesignatorDelete[0]!.designatedBy).toBeNull();

    // Deleting steward user cascades community_stewards row.
    db.delete(tables.users).where(eq(tables.users.id, 2)).run();
    expect(db.select().from(tables.communityStewards).all()).toHaveLength(0);
  });

  it('enforces sovereignty request partial unique indexes and CHECK constraints', () => {
    const { sqlite, db, tables, nowMs } = setupDb();

    // Single pending notice per (community_id, kind).
    db.insert(tables.communitySovereigntyRequests)
      .values({
        id: '00000000-0000-4000-8000-000000000001',
        communityId: 1,
        kind: 'withdrawal',
        state: 'notice',
        initiatedBy: 2,
        initiatedByRole: 'steward',
        requestedAt: nowMs,
        noticeEndsAt: nowMs + 604_800_000,
        updatedAt: nowMs,
      })
      .run();

    expect(() =>
      db
        .insert(tables.communitySovereigntyRequests)
        .values({
          id: '00000000-0000-4000-8000-000000000002',
          communityId: 1,
          kind: 'withdrawal',
          state: 'notice',
          initiatedBy: 2,
          initiatedByRole: 'steward',
          requestedAt: nowMs + 1,
          noticeEndsAt: nowMs + 604_800_001,
          updatedAt: nowMs + 1,
        })
        .run()
    ).toThrow(/UNIQUE constraint failed/i);

    // Different kind ('erasure') pending notice is allowed simultaneously.
    db.insert(tables.communitySovereigntyRequests)
      .values({
        id: '00000000-0000-4000-8000-000000000003',
        communityId: 1,
        kind: 'erasure',
        state: 'notice',
        initiatedBy: 2,
        initiatedByRole: 'steward',
        requestedAt: nowMs + 2,
        noticeEndsAt: nowMs + 604_800_002,
        updatedAt: nowMs + 2,
      })
      .run();

    // Active erasure partial unique index prevents duplicate live erasure.
    db.insert(tables.communitySovereigntyRequests)
      .values({
        id: '00000000-0000-4000-8000-000000000004',
        communityId: 1,
        kind: 'erasure',
        state: 'requested',
        initiatedBy: 1,
        initiatedByRole: 'admin',
        requestedAt: nowMs + 3,
        effectiveAt: nowMs + 3,
        updatedAt: nowMs + 3,
      })
      .run();

    expect(() =>
      db
        .insert(tables.communitySovereigntyRequests)
        .values({
          id: '00000000-0000-4000-8000-000000000005',
          communityId: 1,
          kind: 'erasure',
          state: 'executing',
          initiatedBy: 1,
          initiatedByRole: 'admin',
          requestedAt: nowMs + 4,
          effectiveAt: nowMs + 4,
          updatedAt: nowMs + 4,
        })
        .run()
    ).toThrow(/UNIQUE constraint failed/i);

    // Cancelled without cancelled_at fails CHECK constraint.
    expect(() =>
      db
        .insert(tables.communitySovereigntyRequests)
        .values({
          id: '00000000-0000-4000-8000-000000000006',
          communityId: 2,
          kind: 'withdrawal',
          state: 'cancelled',
          initiatedBy: null,
          initiatedByRole: 'steward',
          requestedAt: nowMs,
          updatedAt: nowMs,
        })
        .run()
    ).toThrow(/CHECK constraint failed/i);

    // notice_ends_at <= requested_at fails CHECK constraint.
    expect(() =>
      db
        .insert(tables.communitySovereigntyRequests)
        .values({
          id: '00000000-0000-4000-8000-000000000007',
          communityId: 2,
          kind: 'withdrawal',
          state: 'notice',
          initiatedBy: null,
          initiatedByRole: 'steward',
          requestedAt: nowMs,
          noticeEndsAt: nowMs,
          updatedAt: nowMs,
        })
        .run()
    ).toThrow(/CHECK constraint failed/i);

    const indexes = sqlite
      .prepare('PRAGMA index_list(community_sovereignty_requests)')
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain(
      'community_sovereignty_requests_active_erasure_unique'
    );
    expect(indexes.map((i) => i.name)).toContain(
      'community_sovereignty_requests_pending_notice_unique'
    );
  });

  it('enforces archive custody CHECK constraints and community cascade', () => {
    const { db, tables, nowMs } = setupDb();

    expect(() =>
      db
        .insert(tables.communityArchiveCustody)
        .values({
          communityId: 1,
          custodianType: 'community',
          custodianUserId: 1,
          status: 'destroyed',
          retentionUntil: nowMs + 2_592_000_000,
          destroyedAt: null,
          createdAt: nowMs,
          updatedAt: nowMs,
        })
        .run()
    ).toThrow(/CHECK constraint failed/i);

    db.insert(tables.communityArchiveCustody)
      .values({
        communityId: 1,
        custodianType: 'steward',
        custodianUserId: 2,
        status: 'held',
        retentionUntil: nowMs + 2_592_000_000,
        createdAt: nowMs,
        updatedAt: nowMs,
      })
      .run();

    db.delete(tables.users).where(eq(tables.users.communityId, 1)).run();
    db.delete(tables.communities).where(eq(tables.communities.id, 1)).run();
    expect(db.select().from(tables.communityArchiveCustody).all()).toHaveLength(
      0
    );
  });
});
