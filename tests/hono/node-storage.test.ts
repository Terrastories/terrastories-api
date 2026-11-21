/**
 * Focused tests for the Node filesystem storage adapter's listing, which the
 * restart-safe orphan sweeper depends on (§6.7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalStorage } from '../../src/node-storage.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';

const KEY_A = 'communities/1/media/a.png';
const KEY_B = 'communities/1/media/b.png';
const KEY_C = 'users/2/media/c.png';

async function putBytes(storage: FoundationStorage, key: string) {
  await storage.put!(key, new Uint8Array([1, 2, 3]));
}

describe('createLocalStorage().list', () => {
  let root: string;
  let storage: FoundationStorage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tsapi-node-storage-'));
    storage = await createLocalStorage(root);
    await putBytes(storage, KEY_A);
    await putBytes(storage, KEY_B);
    await putBytes(storage, KEY_C);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists every stored key with its modification time when no prefix is given', async () => {
    const page = await storage.list!();
    expect(page.entries.map((entry) => entry.key)).toEqual([
      KEY_A,
      KEY_B,
      KEY_C,
    ]);
    expect(page.truncated).toBe(false);
    expect(page.nextStartAfter).toBeUndefined();
    for (const entry of page.entries) {
      expect(entry.uploaded).toBeInstanceOf(Date);
      expect(Number.isNaN(entry.uploaded.getTime())).toBe(false);
    }
  });

  it('filters by prefix', async () => {
    const page = await storage.list!({ prefix: 'communities/1/' });
    expect(page.entries.map((entry) => entry.key)).toEqual([KEY_A, KEY_B]);
  });

  it('pages with a stable startAfter and reports truncation', async () => {
    const first = await storage.list!({ prefix: 'communities/1/', limit: 1 });
    expect(first.entries.map((entry) => entry.key)).toEqual([KEY_A]);
    expect(first.truncated).toBe(true);
    expect(first.nextStartAfter).toBe(KEY_A);

    const second = await storage.list!({
      prefix: 'communities/1/',
      limit: 1,
      startAfter: first.nextStartAfter,
    });
    expect(second.entries.map((entry) => entry.key)).toEqual([KEY_B]);
    expect(second.truncated).toBe(false);
    expect(second.nextStartAfter).toBeUndefined();
  });

  it('omits deleted objects and still lists interrupted-upload temp files', async () => {
    // An interrupted upload leaves a `.tmp-*` file beside its target; the
    // orphan sweeper must be able to see those bytes.
    const tempKey = 'communities/1/media/.tmp-abc';
    await putBytes(storage, tempKey);
    expect(
      (await storage.list!({ prefix: 'communities/1/' })).entries.map(
        (entry) => entry.key
      )
    ).toEqual([tempKey, KEY_A, KEY_B]);

    await storage.delete!(tempKey);
    await storage.delete!(KEY_B);
    const afterDelete = await storage.list!({ prefix: 'communities/1/' });
    expect(afterDelete.entries.map((entry) => entry.key)).toEqual([KEY_A]);
  });

  it('returns an empty page for a prefix with no objects', async () => {
    const page = await storage.list!({ prefix: 'communities/9/' });
    expect(page.entries).toEqual([]);
    expect(page.truncated).toBe(false);
  });

  it('fences a paused writer before the empty listing and persists refusal across adapters', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          reading();
        },
      },
      { highWaterMark: 0 }
    );
    const writing = storage.put!('communities/99/media/paused', body).then(
      () => 'published',
      () => 'refused'
    );
    await started;
    expect(
      (await storage.list!({ prefix: 'communities/99/' })).entries.length
    ).toBeGreaterThan(0);
    await (
      await createLocalStorage(root)
    ).fenceCommunity!(99);
    const page = await storage.list!({ prefix: 'communities/99/' });
    expect(page.entries).toEqual([]);
    for (const entry of page.entries) await storage.delete!(entry.key);
    expect(
      (await storage.list!({ prefix: 'communities/99/' })).entries
    ).toEqual([]);
    expect(() => controller.enqueue(new Uint8Array([1]))).toThrow();
    expect(await writing).toBe('refused');
    expect(
      (await storage.list!({ prefix: 'communities/99/' })).entries
    ).toEqual([]);
    const restarted = await createLocalStorage(root);
    await expect(
      restarted.put!('communities/99/media/late', new Uint8Array([2]))
    ).rejects.toThrow('erasing');
  });

  it('ages objects by max(mtime, ctime) so a restored file is never treated as old', async () => {
    const restoreKey = 'communities/1/media/restore-me.png';
    await putBytes(storage, restoreKey);
    const absolute = path.join(root, restoreKey);
    // Pin mtime to the past; the filesystem stamps ctime=now, so mtime <
    // ctime — exactly what a filesystem restore produces.
    const ancientMtime = new Date('2020-01-01T00:00:00.000Z');
    await utimes(absolute, ancientMtime, ancientMtime);
    const listed = await storage.list!({ prefix: 'communities/1/' });
    const entry = listed.entries.find((item) => item.key === restoreKey);
    const st = await stat(absolute);
    expect(entry).toBeDefined();
    expect(entry!.uploaded.getTime()).toBe(
      Math.max(st.mtime.getTime(), st.ctime.getTime())
    );
    expect(
      entry!.uploaded.getTime(),
      'the restore clock (ctime) wins over the pinned mtime'
    ).toBeGreaterThan(ancientMtime.getTime());
  });
});
