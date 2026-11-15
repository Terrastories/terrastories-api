/**
 * Focused tests for the Node filesystem storage adapter's listing, which the
 * restart-safe orphan sweeper depends on (§6.7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
    expect(page.cursor).toBeUndefined();
    for (const entry of page.entries) {
      expect(entry.uploaded).toBeInstanceOf(Date);
      expect(Number.isNaN(entry.uploaded.getTime())).toBe(false);
    }
  });

  it('filters by prefix', async () => {
    const page = await storage.list!({ prefix: 'communities/1/' });
    expect(page.entries.map((entry) => entry.key)).toEqual([KEY_A, KEY_B]);
  });

  it('pages with a stable cursor and reports truncation', async () => {
    const first = await storage.list!({ prefix: 'communities/1/', limit: 1 });
    expect(first.entries.map((entry) => entry.key)).toEqual([KEY_A]);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe(KEY_A);

    const second = await storage.list!({
      prefix: 'communities/1/',
      limit: 1,
      cursor: first.cursor,
    });
    expect(second.entries.map((entry) => entry.key)).toEqual([KEY_B]);
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeUndefined();
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
});
