/**
 * Focused restart-safe orphan sweeper tests for Slice 9 media cleanup (#140).
 *
 * The durable record of garbage bytes is the `files` table; the sweeper removes
 * stored objects whose row is gone and that are older than the grace window.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  MediaCleanupCoordinator,
  ORPHAN_SWEEP_GRACE_MS,
} from '../../src/services/media-cleanup.service.js';
import type {
  FoundationStorage,
  StorageListEntry,
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
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => (options?.cursor ? key > options.cursor! : true));
      const page = matched.slice(0, limit);
      const entries: StorageListEntry[] = page.map(([key, value]) => ({
        key,
        uploaded: value.uploaded,
      }));
      const truncated = matched.length > page.length;
      return {
        entries,
        truncated,
        cursor: truncated ? page[page.length - 1]![0] : undefined,
      };
    },
  };
  return { store, storage };
}

const OLD = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-06-01T12:00:00.000Z');

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
});
