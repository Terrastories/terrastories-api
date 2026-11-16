/**
 * Focused restart-safe orphan sweeper tests for Slice 9 media cleanup (#140).
 *
 * The durable record of garbage bytes is the `files` table; the sweeper removes
 * stored objects whose row is gone and that are older than the grace window.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  MediaCleanupCoordinator,
  ORPHAN_SWEEP_GRACE_MS,
  WORKER_SWEEP_SUBREQUEST_BUDGET,
} from '../../src/services/media-cleanup.service.js';
import {
  ORPHAN_SWEEP_CURSOR_KEY,
  ORPHAN_SWEEP_HOLD_KEY,
  type FoundationStorage,
  type StorageListEntry,
} from '../../src/services/hono-foundation.service.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

interface StoredObject {
  bytes: Uint8Array;
  uploaded: Date;
}

function createListableStorage(): {
  store: Map<string, StoredObject>;
  storage: FoundationStorage;
} {
  const store = new Map<string, StoredObject>();
  const storage: FoundationStorage = {
    async read(storageKey) {
      const entry = store.get(storageKey);
      if (!entry) return null;
      return { size: entry.bytes.byteLength, body: entry.bytes };
    },
    async put(storageKey, stream) {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      const merged = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) {
        merged.set(c, pos);
        pos += c.byteLength;
      }
      store.set(storageKey, { bytes: merged, uploaded: new Date() });
    },
    async delete(storageKey) {
      store.delete(storageKey);
    },
    async list(options) {
      const prefix = options?.prefix ?? '';
      const limit = options?.limit ?? 200;
      const matched = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        // The sweeper's system state (cursor, restore hold) is never sweepable bytes.
        .filter(
          ([key]) =>
            key !== ORPHAN_SWEEP_CURSOR_KEY && key !== ORPHAN_SWEEP_HOLD_KEY
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) =>
          options?.startAfter ? key > options.startAfter : true
        );
      const page = matched.slice(0, limit);
      const entries: StorageListEntry[] = page.map(([key, value]) => ({
        key,
        uploaded: value.uploaded,
      }));
      const truncated = matched.length > page.length;
      return {
        entries,
        truncated,
        nextStartAfter: truncated ? page[page.length - 1]![0] : undefined,
      };
    },
    async getSystemObject(key) {
      return store.get(key)?.bytes ?? null;
    },
    async putSystemObject(key, bytes) {
      store.set(key, { bytes, uploaded: new Date(0) });
    },
  };
  return { store, storage };
}

const OLD = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

/**
 * Seed one unrelated files row so tests exercise the sweep against a non-empty
 * table. The sentinel references no stored object, so it never keeps anything
 * alive.
 */
async function seedSentinelFileRow() {
  const [comm] = await db
    .insert(tables.communities)
    .values({
      name: `Sentinel ${crypto.randomUUID().slice(0, 8)}`,
      slug: `sentinel-${crypto.randomUUID().slice(0, 8)}`,
      publicStories: true,
      isActive: true,
      createdAt: OLD,
      updatedAt: OLD,
    })
    .returning();
  const id = crypto.randomUUID();
  await db.insert(tables.files).values({
    id,
    filename: id,
    originalName: 'sentinel.png',
    path: `sentinel/${id}/bytes`,
    storageKey: null,
    url: `/v2/media/${id}`,
    mimeType: 'image/png',
    size: 1,
    byteSize: 1,
    checksum: null,
    communityId: comm!.id,
    uploadedBy: null,
    culturalRestrictions: null,
    isActive: true,
    createdAt: OLD,
    updatedAt: OLD,
  });
}

describe('Slice 9 orphan-object sweeper (#140)', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
  });
  afterAll(() => {
    sqlite.close();
  });

  it('deletes an object with no files row older than grace and keeps referenced or fresh objects', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const [comm] = await db
      .insert(tables.communities)
      .values({
        name: 'Sweep Comm',
        slug: 'sweep-comm',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const orphanKey = `communities/${comm!.id}/media/orphan`;
    const referencedKey = `communities/${comm!.id}/media/referenced`;
    const freshOrphanKey = `communities/${comm!.id}/media/fresh-orphan`;

    const referencedFileId = crypto.randomUUID();
    await db.insert(tables.files).values({
      id: referencedFileId,
      filename: referencedFileId,
      originalName: 'referenced.png',
      path: referencedKey,
      storageKey: referencedKey,
      url: `/v2/media/${referencedFileId}`,
      mimeType: 'image/png',
      size: 3,
      byteSize: 3,
      checksum: null,
      communityId: comm!.id,
      uploadedBy: null,
      culturalRestrictions: null,
      isActive: true,
      createdAt: OLD,
      updatedAt: OLD,
    });

    const { store, storage } = createListableStorage();
    store.set(orphanKey, { bytes: Uint8Array.from([1, 2, 3]), uploaded: OLD });
    store.set(referencedKey, {
      bytes: Uint8Array.from([4, 5, 6]),
      uploaded: OLD,
    });
    store.set(freshOrphanKey, {
      bytes: Uint8Array.from([7, 8, 9]),
      uploaded: NOW,
    });

    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    // A cutoff just after OLD treats the OLD-stamped objects as older than the
    // grace window: the orphan is swept, the referenced object and the fresh
    // orphan are kept.
    const cutoff = new Date(OLD.getTime() + 1);
    const result = await cleanup.sweepOrphanObjects({ olderThan: cutoff });
    expect(result.deletedCount).toBe(1);
    expect(store.has(orphanKey)).toBe(false);
    expect(store.has(referencedKey)).toBe(true);
    expect(store.has(freshOrphanKey)).toBe(true);

    // Sanity: the referenced file row is untouched.
    const [row] = await db
      .select()
      .from(tables.files)
      .where(eq(tables.files.id, referencedFileId));
    expect(row).toBeDefined();
  });

  it('uses the grace window by default so fresh in-flight uploads are never swept', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const freshKey = 'communities/1/media/in-flight';
    const staleKey = 'communities/1/media/stale';
    store.set(freshKey, { bytes: Uint8Array.from([1]), uploaded: now });
    store.set(staleKey, {
      bytes: Uint8Array.from([2]),
      uploaded: new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000),
    });

    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    const result = await cleanup.sweepOrphanObjects();
    expect(result.deletedCount).toBe(1);
    expect(store.has(freshKey)).toBe(true);
    expect(store.has(staleKey)).toBe(false);
  });

  it('keeps an object referenced only through the legacy path column', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const [comm] = await db
      .insert(tables.communities)
      .values({
        name: 'Legacy Path Comm',
        slug: 'legacy-path-comm',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const legacyKey = `communities/${comm!.id}/media/legacy`;
    const legacyFileId = crypto.randomUUID();
    await db.insert(tables.files).values({
      id: legacyFileId,
      filename: legacyFileId,
      originalName: 'legacy.png',
      // No storage_key: only the legacy path column points at the bytes.
      path: legacyKey,
      storageKey: null,
      url: `/v2/media/${legacyFileId}`,
      mimeType: 'image/png',
      size: 3,
      byteSize: 3,
      checksum: null,
      communityId: comm!.id,
      uploadedBy: null,
      culturalRestrictions: null,
      isActive: true,
      createdAt: OLD,
      updatedAt: OLD,
    });

    const { store, storage } = createListableStorage();
    store.set(legacyKey, { bytes: Uint8Array.from([1]), uploaded: OLD });
    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    const result = await cleanup.sweepOrphanObjects({
      olderThan: new Date(OLD.getTime() + 1),
    });
    expect(result.deletedCount).toBe(0);
    expect(store.has(legacyKey), 'legacy-path reference must be honoured').toBe(
      true
    );
  });

  it('keeps sweeping after a storage delete fails and logs content-free warnings', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const staleA = 'communities/1/media/stale-a';
    const staleB = 'communities/1/media/stale-b';
    const uploaded = new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000);
    store.set(staleA, { bytes: Uint8Array.from([1]), uploaded });
    store.set(staleB, { bytes: Uint8Array.from([2]), uploaded });

    const logs: string[] = [];
    let failedOnce = false;
    const flaky: typeof storage = {
      ...storage,
      async delete(key) {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error(`r2 delete failed for ${key}`);
        }
        store.delete(key);
      },
    };
    const cleanup = new MediaCleanupCoordinator(db, flaky, {
      now: () => now,
      log: (line) => logs.push(line),
    });
    const result = await cleanup.sweepOrphanObjects();
    expect(result.deletedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(store.has(staleB)).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(staleA);
      expect(line).not.toContain('r2 delete failed');
    }
  });

  it('bounds a run by the subrequest budget and resumes after it on the next run', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const uploaded = new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000);
    for (let i = 0; i < 5; i++) {
      store.set(`communities/1/media/stale-${i}`, {
        bytes: Uint8Array.from([i]),
        uploaded,
      });
    }
    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    // One list page (1) + one reference query (1) + two deletes (2) = 4
    // subrequests: exactly two objects swept per run.
    const first = await cleanup.sweepOrphanObjects({ subrequestBudget: 4 });
    expect(first.scanned).toBe(2);
    expect(first.deletedCount).toBe(2);
    expect(first.subrequests).toBe(4);
    expect(store.size).toBe(4);

    // The cursor persisted inside the storage adapter resumes after the two
    // objects the first run already deleted.
    const second = await cleanup.sweepOrphanObjects({ subrequestBudget: 4 });
    expect(second.scanned).toBe(2);
    expect(second.deletedCount).toBe(2);
    expect(second.subrequests).toBe(4);
    expect(store.size).toBe(2);
  });

  it('traverses > 1000 live objects ahead of an orphan across a bounded number of runs, within the Workers subrequest budget', async () => {
    // Worst-case keyspace: more live (files-row-backed) objects ahead of the
    // orphan than one scheduled run can afford to scan. Live objects consume
    // only their share of reference-query subrequests, never a delete.
    const liveCount = 1400;
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const uploaded = new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000);

    for (let i = 0; i < liveCount; i += 1) {
      const key = `communities/1/media/live-${String(i).padStart(4, '0')}`;
      const id = crypto.randomUUID();
      await db.insert(tables.files).values({
        id,
        filename: id,
        originalName: `live-${i}.png`,
        path: key,
        storageKey: key,
        url: `/v2/media/${id}`,
        mimeType: 'image/png',
        size: 1,
        byteSize: 1,
        checksum: null,
        communityId: 1,
        uploadedBy: null,
        culturalRestrictions: null,
        isActive: true,
        createdAt: OLD,
        updatedAt: OLD,
      });
      store.set(key, { bytes: Uint8Array.from([i % 256]), uploaded });
    }
    // The orphan sorts after every live object.
    const orphanKey = 'communities/1/media/zz-orphan';
    store.set(orphanKey, { bytes: Uint8Array.from([9]), uploaded });

    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    let runs = 0;
    let orphanDeleted = false;
    for (let i = 0; i < 4 && !orphanDeleted; i += 1) {
      const result = await cleanup.sweepOrphanObjects({
        subrequestBudget: WORKER_SWEEP_SUBREQUEST_BUDGET,
      });
      runs += 1;
      expect(
        result.subrequests,
        `run ${runs} must stay within the Workers Free subrequest budget`
      ).toBeLessThanOrEqual(WORKER_SWEEP_SUBREQUEST_BUDGET);
      orphanDeleted = !store.has(orphanKey);
    }
    expect(orphanDeleted, `orphan reached within ${runs} bounded run(s)`).toBe(
      true
    );
    expect(runs).toBeGreaterThanOrEqual(2);
    // No live object was deleted by any run.
    for (let i = 0; i < liveCount; i += 1) {
      const key = `communities/1/media/live-${String(i).padStart(4, '0')}`;
      expect(store.has(key)).toBe(true);
    }
  });

  it('bounds one run to the subrequest budget on fresh-object pages and resumes the cursor on the next run', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    // Fresh objects spend no reference/delete budget, so only list-page
    // subrequests can bound a run walking a large keyspace of fresh bytes.
    const freshKey = (i: number) =>
      `communities/1/media/live-${String(i).padStart(3, '0')}`;
    const freshUntil = 450;
    for (let i = 0; i <= freshUntil; i += 1) {
      store.set(freshKey(i), { bytes: Uint8Array.from([1]), uploaded: now });
    }
    const orphanKey = 'communities/1/media/zz-orphan';
    store.set(orphanKey, {
      bytes: Uint8Array.from([9]),
      uploaded: new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000),
    });
    let listCalls = 0;
    const countingStorage: FoundationStorage = {
      ...storage,
      list: async (options) => {
        listCalls += 1;
        return storage.list!(options);
      },
    };
    const cleanup = new MediaCleanupCoordinator(db, countingStorage, {
      now: () => now,
      log: () => {},
      // Each full page costs 1 subrequest; budget 3 stops the run after
      // walking 3 pages instead of the whole prefix.
      subrequestBudget: 3,
    });
    const first = await cleanup.sweepOrphanObjects();
    expect(first.deletedCount).toBe(0);
    expect(first.subrequests).toBe(3);
    expect(
      listCalls,
      'stops after the budget is spent instead of walking the prefix'
    ).toBe(3);
    expect(
      store.has(orphanKey),
      'orphan still ahead after the bounded run'
    ).toBe(true);

    // The persisted cursor resumes after the page the first run stopped at.
    const second = await cleanup.sweepOrphanObjects();
    expect(second.deletedCount).toBe(1);
    expect(second.subrequests).toBe(3);
    expect(store.has(orphanKey), 'orphan reached by the resumed run').toBe(
      false
    );
  });

  it('sweeps an old orphan even when the files table is completely empty', async () => {
    // A fresh, empty database carries no restore signal by itself: the
    // restore hold is the explicit guard (ORPHAN_SWEEP_PAUSED / the
    // `system/orphan-sweep-hold` marker), not table state.
    const emptySqlite = new Sqlite(':memory:');
    emptySqlite.pragma('foreign_keys = ON');
    const emptyDb = drizzle(emptySqlite);
    migrate(emptyDb, { migrationsFolder: './src/db/migrations' });

    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const staleKey = 'communities/1/media/stale';
    store.set(staleKey, {
      bytes: Uint8Array.from([1]),
      uploaded: new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000),
    });

    const cleanup = new MediaCleanupCoordinator(emptyDb, storage, {
      now: () => now,
      log: () => {},
    });
    const result = await cleanup.sweepOrphanObjects();
    expect(result.deletedCount).toBe(1);
    expect(store.has(staleKey)).toBe(false);
    emptySqlite.close();
  });

  it('deletes nothing while ORPHAN_SWEEP_PAUSED pauses the sweep', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const staleKey = 'communities/1/media/stale';
    store.set(staleKey, {
      bytes: Uint8Array.from([1]),
      uploaded: new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000),
    });

    const logs: string[] = [];
    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: (line) => logs.push(line),
      sweepPaused: true,
    });
    const result = await cleanup.sweepOrphanObjects();
    expect(result).toEqual({
      deletedCount: 0,
      failedCount: 0,
      scanned: 0,
      subrequests: 0,
    });
    expect(store.has(staleKey)).toBe(true);
    expect(logs.some((line) => line.includes('hold'))).toBe(true);
  });

  it('deletes nothing while the storage restore hold marker is present', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const staleKey = 'communities/1/media/stale';
    store.set(staleKey, {
      bytes: Uint8Array.from([1]),
      uploaded: new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000),
    });
    // The hold marker lives outside the swept prefixes.
    store.set(ORPHAN_SWEEP_HOLD_KEY, {
      bytes: new TextEncoder().encode('hold\n'),
      uploaded: new Date(0),
    });

    const logs: string[] = [];
    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: (line) => logs.push(line),
    });
    const result = await cleanup.sweepOrphanObjects();
    expect(result).toEqual({
      deletedCount: 0,
      failedCount: 0,
      scanned: 0,
      subrequests: 0,
    });
    expect(store.has(staleKey)).toBe(true);
    // The marker is outside the swept prefixes and is never deleted itself.
    expect(store.has(ORPHAN_SWEEP_HOLD_KEY)).toBe(true);
    expect(logs.some((line) => line.includes('hold'))).toBe(true);

    // Lifting the hold resumes the normal sweep.
    store.delete(ORPHAN_SWEEP_HOLD_KEY);
    const lifted = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    const after = await lifted.sweepOrphanObjects();
    expect(after.deletedCount).toBe(1);
    expect(store.has(staleKey)).toBe(false);
  });

  it('walks into the users/ prefix and wraps the cursor back to communities/', async () => {
    await seedSentinelFileRow();
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { store, storage } = createListableStorage();
    const uploaded = new Date(now.getTime() - ORPHAN_SWEEP_GRACE_MS - 1000);
    const communityOrphan = 'communities/1/media/orphan';
    const userOrphan = 'users/2/media/orphan';
    store.set(communityOrphan, { bytes: Uint8Array.from([1]), uploaded });
    store.set(userOrphan, { bytes: Uint8Array.from([2]), uploaded });

    const cleanup = new MediaCleanupCoordinator(db, storage, {
      now: () => now,
      log: () => {},
    });
    // One delete per run: exactly list (1) + reference query (1) + delete (1)
    // subrequests each run. The first run clears communities/, the second
    // reaches users/ and then wraps the cursor back to the start.
    const first = await cleanup.sweepOrphanObjects({ subrequestBudget: 3 });
    expect(first.deletedCount).toBe(1);
    expect(first.subrequests).toBe(3);
    expect(store.has(communityOrphan)).toBe(false);
    expect(store.has(userOrphan), 'users/ prefix still pending').toBe(true);
    // communities/ is fully walked within the run; the budget ran out on
    // its last object, so the run resumes at users/ on the next run.
    const cursorAfterFirst = JSON.parse(
      new TextDecoder().decode(store.get(ORPHAN_SWEEP_CURSOR_KEY)!.bytes)
    ) as { prefix?: string; startAfter?: string };
    expect(cursorAfterFirst.prefix).toBe('users/');

    const second = await cleanup.sweepOrphanObjects({ subrequestBudget: 3 });
    expect(second.deletedCount).toBe(1);
    expect(second.subrequests).toBe(3);
    expect(store.has(userOrphan)).toBe(false);
    // Both prefixes are done: the cursor wraps to the start.
    const cursorAfterSecond = JSON.parse(
      new TextDecoder().decode(store.get(ORPHAN_SWEEP_CURSOR_KEY)!.bytes)
    ) as unknown;
    expect(cursorAfterSecond).toBeNull();
  });

  /**
   * D1-driver harness with a bound-parameter counter. Every prepared
   * statement in the sweep goes through this client, so the counter sees
   * both the batched reference checks and the direct deletes.
   */
  function createParamCountD1Db(): {
    db: ReturnType<typeof drizzleD1>;
    sqlite: Sqlite.Database;
    boundParams: number[];
  } {
    const d1Sqlite = new Sqlite(':memory:');
    d1Sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(d1Sqlite), { migrationsFolder: './src/db/migrations' });
    const boundParams: number[] = [];
    const client = {
      prepare(query: string) {
        let params: unknown[] = [];
        const stmt = {
          bind(...vals: unknown[]) {
            boundParams.push(vals.length);
            params = vals;
            return stmt;
          },
          all: async () => ({
            results: d1Sqlite.prepare(query).all(...params),
            success: true,
            meta: {},
          }),
          raw: async () =>
            d1Sqlite
              .prepare(query)
              .raw(true)
              .all(...params),
          first: async () => d1Sqlite.prepare(query).get(...params) ?? null,
          run: async () => {
            const info = d1Sqlite.prepare(query).run(...params);
            return { success: true, meta: { changes: info.changes } };
          },
          _exec() {
            const prepared = d1Sqlite.prepare(query);
            if (prepared.reader) {
              return { results: prepared.all(...params) };
            }
            const info = prepared.run(...params);
            return {
              results: [],
              success: true,
              meta: { changes: info.changes },
            };
          },
        };
        return stmt;
      },
      async batch(stmts: Array<{ _exec: () => unknown }>) {
        return d1Sqlite.transaction(() => stmts.map((s) => s._exec()))();
      },
    };
    return { db: drizzleD1(client as never), sqlite: d1Sqlite, boundParams };
  }

  it('sweeps a page with > 50 old unreferenced objects within D1 parameter limits', async () => {
    const { db: d1Db, sqlite: d1Sqlite, boundParams } = createParamCountD1Db();
    try {
      const seed = drizzle(d1Sqlite);
      const seedTables = tablesFor(seed);
      const now = new Date('2026-06-01T12:00:00.000Z');
      const [comm] = await seed
        .insert(seedTables.communities)
        .values({
          name: 'Param Bound Comm',
          slug: `param-bound-${crypto.randomUUID().slice(0, 8)}`,
          publicStories: true,
          isActive: true,
          createdAt: OLD,
          updatedAt: OLD,
        })
        .returning();
      // Seed one unrelated files row so the sweep exercises a non-empty table.
      const sentinelId = crypto.randomUUID();
      await seed.insert(seedTables.files).values({
        id: sentinelId,
        filename: sentinelId,
        originalName: 'sentinel.png',
        path: `sentinel/${sentinelId}/bytes`,
        storageKey: null,
        url: `/v2/media/${sentinelId}`,
        mimeType: 'image/png',
        size: 1,
        byteSize: 1,
        checksum: null,
        communityId: comm!.id,
        uploadedBy: null,
        culturalRestrictions: null,
        isActive: true,
        createdAt: OLD,
        updatedAt: OLD,
      });
      const { store, storage } = createListableStorage();
      for (let i = 0; i < 120; i += 1) {
        store.set(
          `communities/${comm!.id}/media/old-${String(i).padStart(3, '0')}`,
          {
            bytes: Uint8Array.from([i % 256]),
            uploaded: OLD,
          }
        );
      }
      const cleanup = new MediaCleanupCoordinator(d1Db as never, storage, {
        now: () => now,
        log: () => {},
      });
      const cutoff = new Date(OLD.getTime() + 1);
      const result = await cleanup.sweepOrphanObjects({
        olderThan: cutoff,
      });
      expect(result.deletedCount).toBe(120);
      expect(result.subrequests).toBeLessThanOrEqual(2000);
      // Only the system sweep-cursor object may remain in storage.
      expect([...store.keys()]).toEqual([ORPHAN_SWEEP_CURSOR_KEY]);
      expect(boundParams.length).toBeGreaterThan(0);
      expect(
        Math.max(...boundParams),
        `every prepared statement must bind <= 100 parameters, got ${Math.max(...boundParams)}`
      ).toBeLessThanOrEqual(100);
    } finally {
      d1Sqlite.close();
    }
  });
});
