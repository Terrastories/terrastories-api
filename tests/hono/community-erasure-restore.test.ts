import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { CommunityErasureService } from '../../src/services/community-erasure.service.js';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import type { ErasureRecord } from '../../src/services/erasure-record-store.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { communitySovereigntyRequestsSqlite } from '../../src/db/schema/community_sovereignty.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import { exportJobsSqlite } from '../../src/db/schema/community_exports.js';
import { SOVEREIGNTY_AUDIT_ACTIONS } from '../../src/shared/sovereignty-policy.js';

/**
 * SPEC-V2 section 7 Backups: no restore while an erasure is pending; once an
 * erasure completes, only points at or after its completion may be restored.
 * Service-level coverage of CommunityErasureService.verifyRestorePoint and the
 * database check erasureRestoreBlocked, plus reconcileRestore after an allowed point.
 */

const NOW = new Date('2026-11-24T12:00:00.000Z');
const T1 = '2026-11-20T00:00:00.000Z';
const T2 = '2026-11-22T00:00:00.000Z';
/** Request time shared by a database request row and its out-of-band record. */
const REQUESTED_AT = '2026-11-19T00:00:00.000Z';

type RequestState =
  | 'notice'
  | 'requested'
  | 'executing'
  | 'completed'
  | 'cancelled';

const openDbs: Sqlite.Database[] = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

async function setup() {
  const sqlite = new Sqlite(':memory:');
  openDbs.push(sqlite);
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const records: ErasureRecord[] = [];
  const store = {
    list: async () => records,
    write: async (record: ErasureRecord) => {
      const i = records.findIndex((r) => r.communityId === record.communityId);
      if (i < 0) records.push(record);
      else records[i] = record;
    },
  };
  // In-memory object store: listing honours prefix, startAfter and limit.
  const objects = new Set<string>();
  const aborted: Array<{ key: string; uploadId: string }> = [];
  const fenced: number[] = [];
  const storage: FoundationStorage = {
    read: async () => null,
    delete: async (key) => {
      objects.delete(key);
    },
    list: async ({ prefix = '', startAfter, limit = 1000 } = {}) => {
      const keys = [...objects]
        .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
        .sort();
      const entries = keys
        .slice(0, limit)
        .map((key) => ({ key, size: 1, uploaded: NOW }));
      const truncated = keys.length > limit;
      return {
        entries,
        truncated,
        nextStartAfter: truncated
          ? entries[entries.length - 1]!.key
          : undefined,
      };
    },
    abortMultipartUpload: async (key, uploadId) => {
      aborted.push({ key, uploadId });
    },
    fenceCommunity: async (id) => {
      fenced.push(id);
    },
  };
  const service = new CommunityErasureService(
    new CommunitySovereigntyRepository(db),
    storage,
    store,
    () => NOW
  );
  async function community(slug: string) {
    const [row] = await db
      .insert(communitiesSqlite)
      .values({ name: slug, slug, isActive: true })
      .returning();
    return row!.id;
  }
  /** Inserts the database request row and returns its id (the record's requestId). */
  async function request(
    communityId: number,
    state: RequestState,
    noticeEndsAt: number | null = null
  ) {
    const id = crypto.randomUUID();
    await db.insert(communitySovereigntyRequestsSqlite).values({
      id,
      communityId,
      kind: 'erasure',
      state,
      initiatedByRole: 'steward',
      requestedAt: Date.parse(REQUESTED_AT),
      noticeEndsAt,
      completedAt: state === 'completed' ? Date.parse(T1) : null,
      cancelledAt: state === 'cancelled' ? NOW.getTime() : null,
      updatedAt: NOW.getTime(),
    });
    return id;
  }
  /** Out-of-band record; pass the database request id to link them as the real flow does. */
  function record(
    communityId: number,
    completedAt: string | null,
    requestId: string = crypto.randomUUID()
  ): ErasureRecord {
    return {
      communityId,
      requestId,
      requestingActorId: null,
      requestedAt: REQUESTED_AT,
      completedAt,
      outcome: completedAt === null ? 'pending' : 'completed',
    };
  }
  return {
    db,
    records,
    store,
    storage,
    objects,
    aborted,
    fenced,
    service,
    community,
    request,
    record,
  };
}

const BLOCKED = 'Restore blocked by pending community erasure';
const VIOLATES = 'Restore point violates community erasure';

describe('CommunityErasureService.verifyRestorePoint', () => {
  it.each(['requested', 'executing'] as const)(
    'refuses every restore point while the database holds a %s erasure',
    async (state) => {
      const f = await setup();
      const id = await f.community('pending');
      const requestId = await f.request(id, state);
      await f.store.write(f.record(id, null, requestId));
      for (const point of [
        new Date(0),
        new Date(NOW.getTime() - 1),
        NOW,
        new Date(NOW.getTime() + 86400000),
      ])
        await expect(f.service.verifyRestorePoint(point, NOW)).rejects.toThrow(
          BLOCKED
        );
    }
  );

  it('refuses via the database state alone when the record store is empty (request/record crash gap)', async () => {
    const f = await setup();
    await f.request(await f.community('gap'), 'requested');
    expect(f.records).toEqual([]);
    await expect(f.service.verifyRestorePoint(NOW, NOW)).rejects.toThrow(
      BLOCKED
    );
  });

  it('refuses via the record store alone when no database request is pending', async () => {
    const f = await setup();
    const id = await f.community('record-only');
    const requestId = await f.request(id, 'completed');
    await f.store.write(f.record(id, null, requestId));
    await expect(
      f.service.verifyRestorePoint(new Date(NOW.getTime() + 1), NOW)
    ).rejects.toThrow(VIOLATES);
  });

  it('blocks a steward notice only once its notice window has ended', async () => {
    const f = await setup();
    const id = await f.community('notice');
    await f.request(id, 'notice', NOW.getTime() + 1);
    await f.service.verifyRestorePoint(NOW, NOW);
    await expect(
      f.service.verifyRestorePoint(NOW, new Date(NOW.getTime() + 1))
    ).rejects.toThrow(BLOCKED);
  });

  it('ignores cancelled requests', async () => {
    const f = await setup();
    await f.request(await f.community('cancelled'), 'cancelled');
    await f.service.verifyRestorePoint(NOW, NOW);
  });

  it('refuses a point before completion and allows points at or after it', async () => {
    const f = await setup();
    const id = await f.community('done');
    const requestId = await f.request(id, 'completed');
    await f.store.write(f.record(id, T1, requestId));
    const completed = Date.parse(T1);
    for (const point of [new Date(0), new Date(completed - 1)])
      await expect(f.service.verifyRestorePoint(point, NOW)).rejects.toThrow(
        VIOLATES
      );
    await f.service.verifyRestorePoint(new Date(completed), NOW);
    await f.service.verifyRestorePoint(new Date(completed + 1), NOW);
    await f.service.verifyRestorePoint(NOW, NOW);
  });

  it('rejects an invalid restore point', async () => {
    const f = await setup();
    await expect(
      f.service.verifyRestorePoint(new Date(Number.NaN), NOW)
    ).rejects.toThrow('Invalid restore point');
  });

  it('with several erasures, the latest completion governs and any pending one blocks', async () => {
    const f = await setup();
    const a = await f.community('a');
    const b = await f.community('b');
    const requestA = await f.request(a, 'completed');
    await f.store.write(f.record(a, T1, requestA));
    const requestB = await f.request(b, 'executing');
    await f.store.write(f.record(b, null, requestB));
    // Pending in DB: blocked even for a point after the first completion.
    await expect(
      f.service.verifyRestorePoint(new Date(Date.parse(T1) + 1), NOW)
    ).rejects.toThrow(BLOCKED);
    // Second erasure completes at T2.
    await f.db
      .update(communitySovereigntyRequestsSqlite)
      .set({ state: 'completed', completedAt: Date.parse(T2) })
      .where(eq(communitySovereigntyRequestsSqlite.communityId, b));
    await f.store.write(f.record(b, T2, requestB));
    await expect(
      f.service.verifyRestorePoint(new Date(Date.parse(T1) + 1), NOW)
    ).rejects.toThrow(VIOLATES);
    await expect(
      f.service.verifyRestorePoint(new Date(Date.parse(T2) - 1), NOW)
    ).rejects.toThrow(VIOLATES);
    await f.service.verifyRestorePoint(new Date(T2), NOW);
  });

  it('allows a point after completion and reconcileRestore re-erases a resurrected community from the out-of-band record alone', async () => {
    const f = await setup();
    const id = await f.community('restored');
    const other = await f.community('bystander');
    // The restored database carries NO erasure request row for the community
    // (SPEC-V2 section 7 Backups); only the out-of-band record survives.
    expect(
      await f.db.select().from(communitySovereigntyRequestsSqlite)
    ).toHaveLength(0);
    await f.store.write(f.record(id, T1));
    // Resurrected bytes: more than one listing page, plus an in-flight multipart upload.
    const prefix = `communities/${id}/`;
    for (let i = 0; i < 25; i++)
      f.objects.add(`${prefix}media/${String(i).padStart(2, '0')}.bin`);
    const bystander = `communities/${other}/media/keep.bin`;
    f.objects.add(bystander);
    await f.db.insert(exportJobsSqlite).values({
      id: crypto.randomUUID(),
      communityId: id,
      status: 'generating',
      zipStorageKey: `${prefix}exports/export.zip`,
      zipUploadId: 'upload-1',
      createdAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 86400000,
    });
    const point = new Date(T1);
    await f.service.verifyRestorePoint(point, NOW);
    await f.service.reconcileRestore(point, NOW);
    expect(f.fenced).toEqual([id]);
    expect(f.aborted).toEqual([
      { key: `${prefix}exports/export.zip`, uploadId: 'upload-1' },
    ]);
    expect([...f.objects]).toEqual([bystander]);
    expect(
      await f.db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, id))
    ).toHaveLength(0);
    expect(
      await f.db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, other))
    ).toHaveLength(1);
    const audit = await f.db.select().from(auditEntriesSqlite);
    expect(audit.map((row) => row.action)).toContain(
      SOVEREIGNTY_AUDIT_ACTIONS.RESTORE_RECONCILE
    );
  });

  it('reconcileRestore refuses a point before completion', async () => {
    const f = await setup();
    const id = await f.community('early');
    const requestId = await f.request(id, 'completed');
    await f.store.write(f.record(id, T1, requestId));
    await expect(
      f.service.reconcileRestore(new Date(Date.parse(T1) - 1), NOW)
    ).rejects.toThrow(VIOLATES);
  });
});
