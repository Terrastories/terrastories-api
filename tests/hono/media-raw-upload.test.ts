/**
 * Raw-body media upload contract (#249): no TypeScript per-byte hashing or
 * parsing on the upload path; integrity is verified by the storage adapter
 * (R2 `sha256` option on Workers, native node:crypto on Node).
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaWritesService } from '../../src/services/media-writes.service.js';
import {
  StorageChecksumMismatchError,
  type FoundationStorage,
  type StoragePutOptions,
} from '../../src/services/hono-foundation.service.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { MAGIC_SNIFF_BYTES } from '../../src/shared/schemas/media-v2.js';
import { sha256Hex } from '../helpers/raw-upload.js';

// Smallest valid PNG; padded after the signature so the body spans many chunks.
const PNG_HEAD = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

const actor = {
  id: 7,
  email: 'ed@example.test',
  username: null,
  displayName: null,
  passwordHash: 'x',
  role: 'editor',
  communityId: 1,
} as const;

function stubRepository() {
  const rows: Array<{ checksum: string; byteSize: number }> = [];
  const repository = {
    isCommunityActive: async () => true,
    insertAuditEntry: async () => {},
    authorizeAttachReuse: async () => ({ ok: true }),
    createUploadedMedia: async (input: {
      fileId: string;
      originalName: string;
      mimeType: string;
      byteSize: number;
      checksum: string;
    }) => {
      rows.push({ checksum: input.checksum, byteSize: input.byteSize });
      return {
        status: 'created',
        record: {
          file: {
            id: input.fileId,
            originalName: input.originalName,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            checksum: input.checksum,
            metadata: null,
            createdAt: new Date('2026-06-01T00:00:00Z'),
          },
          attachment: null,
        },
      };
    },
  };
  return { repository, rows };
}

function chunked(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= parts.length) controller.close();
      else controller.enqueue(parts[i++]!);
    },
  });
}

describe('raw-body upload pass-through (#249)', () => {
  it('reads only chunk lengths beyond the 8 KiB sniff window and delegates hashing to storage', async () => {
    const tail = 64 * 1024;
    const chunkSize = 16 * 1024;
    const bodyChunks: Uint8Array[] = [];
    const head = new Uint8Array(MAGIC_SNIFF_BYTES);
    head.set(PNG_HEAD, 0);
    bodyChunks.push(head);
    const touched = new Set<string | symbol>();
    let total = head.byteLength;
    for (let off = 0; off < tail; off += chunkSize) {
      const real = new Uint8Array(chunkSize).fill(0xab);
      // Any property read other than byteLength means the service looked at bytes.
      bodyChunks.push(
        new Proxy(real, {
          get(target, prop) {
            touched.add(prop);
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      );
      total += chunkSize;
    }
    const expectedSha = sha256Hex(
      Uint8Array.from(
        bodyChunks.flatMap((c) =>
          c === head ? [...c] : [...new Uint8Array(chunkSize).fill(0xab)]
        )
      )
    );

    const received: { options?: StoragePutOptions; size: number } = { size: 0 };
    const storage: FoundationStorage = {
      read: async () => null,
      async put(_key, body, options) {
        received.options = options;
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received.size += value!.byteLength;
        }
        return { size: received.size };
      },
    };
    const { repository, rows } = stubRepository();
    const service = new MediaWritesService(repository as never, storage, {
      deleteStorageBestEffort: async () => true,
    } as never);
    const result = await service.uploadMedia({
      actor,
      contentTypeHeader: 'image/png',
      contentLengthHeader: String(total),
      checksumHeader: expectedSha,
      params: new URLSearchParams({ filename: 'big.png' }),
      body: chunked(bodyChunks),
      origin: 'https://api.test',
    });
    expect(result.status).toBe(201);
    expect(received.size).toBe(total);
    // The service handed the digest to storage; it never hashed bytes itself.
    expect(received.options?.sha256).toBe(expectedSha);
    expect(received.options?.contentLength).toBe(total);
    expect(rows[0]).toEqual({ checksum: expectedSha, byteSize: total });
    // Chunks past the sniff window were only measured (byteLength), never read.
    expect([...touched]).toEqual(['byteLength']);
  });

  it('maps a storage checksum mismatch to 422, creates no row, and removes staged bytes', async () => {
    const storage: FoundationStorage = {
      read: async () => null,
      async put(_key, body) {
        await (body as ReadableStream<Uint8Array>).cancel();
        throw new StorageChecksumMismatchError();
      },
    };
    const deleted: string[] = [];
    const { repository, rows } = stubRepository();
    const service = new MediaWritesService(repository as never, storage, {
      deleteStorageBestEffort: async (key: string) => {
        deleted.push(key);
        return true;
      },
    } as never);
    const result = await service.uploadMedia({
      actor,
      contentTypeHeader: 'image/png',
      contentLengthHeader: String(PNG_HEAD.byteLength),
      checksumHeader: 'cd'.repeat(32),
      params: new URLSearchParams({ filename: 'x.png' }),
      body: chunked([PNG_HEAD]),
      origin: 'https://api.test',
    });
    expect(result.status).toBe(422);
    expect(rows).toHaveLength(0);
    expect(deleted).toHaveLength(1);
  });

  it('rejects an oversize stored object after put and a missing/invalid digest header', async () => {
    const storage: FoundationStorage = {
      read: async () => null,
      put: async (_key, body) => {
        await (body as ReadableStream<Uint8Array>).cancel();
        return { size: 1024 * 1024 * 1024 };
      },
    };
    const { repository, rows } = stubRepository();
    const service = new MediaWritesService(repository as never, storage, {
      deleteStorageBestEffort: async () => true,
    } as never);
    const base = {
      actor,
      contentTypeHeader: 'image/png',
      params: new URLSearchParams({ filename: 'x.png' }),
      origin: 'https://api.test',
    };
    const over = await service.uploadMedia({
      ...base,
      contentLengthHeader: undefined,
      checksumHeader: sha256Hex(PNG_HEAD),
      body: chunked([PNG_HEAD]),
    });
    expect(over.status).toBe(413);
    const noDigest = await service.uploadMedia({
      ...base,
      contentLengthHeader: String(PNG_HEAD.byteLength),
      checksumHeader: undefined,
      body: chunked([PNG_HEAD]),
    });
    expect(noDigest.status).toBe(400);
    const badDigest = await service.uploadMedia({
      ...base,
      contentLengthHeader: String(PNG_HEAD.byteLength),
      checksumHeader: 'not-hex',
      body: chunked([PNG_HEAD]),
    });
    expect(badDigest.status).toBe(400);
    expect(rows).toHaveLength(0);
  });
});

describe('local (Node) storage verifies sha256 with node:crypto (#249)', () => {
  it('stores matching bytes and leaves nothing behind on mismatch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tsapi-249-'));
    const storage = await createLocalStorage(dir);
    const bytes = new Uint8Array(40_000).fill(7);
    const key = 'communities/1/media/11111111-1111-4111-8111-111111111111';
    const ok = await storage.put!(
      key,
      chunked([bytes.subarray(0, 100), bytes.subarray(100)]),
      {
        sha256: sha256Hex(bytes),
      }
    );
    expect(ok.size).toBe(bytes.byteLength);

    const badKey = 'communities/1/media/22222222-2222-4222-8222-222222222222';
    await expect(
      storage.put!(badKey, chunked([bytes]), { sha256: 'ef'.repeat(32) })
    ).rejects.toBeInstanceOf(StorageChecksumMismatchError);
    expect(await storage.read(badKey)).toBeNull();
    const leftovers = await readdir(path.join(dir, 'communities/1/media'));
    expect(leftovers).toEqual(['11111111-1111-4111-8111-111111111111']);
  });
});
