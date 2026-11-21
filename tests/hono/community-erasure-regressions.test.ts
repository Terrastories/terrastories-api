import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalStorage } from '../../src/node-storage.js';
import { expect, it, vi } from 'vitest';
import {
  CommunityErasureService,
  WORKER_ERASURE_STORAGE_BUDGET,
} from '../../src/services/community-erasure.service.js';
import type { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import {
  verifyErasureRestorePoint,
  type ErasureRecord,
} from '../../src/services/erasure-record-store.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';

function fixture(count = 1) {
  const records: ErasureRecord[] = Array.from({ length: count }, (_, i) => ({
    communityId: i + 1,
    requestId: crypto.randomUUID(),
    requestingActorId: null,
    requestedAt: new Date(0).toISOString(),
    completedAt: null,
    outcome: 'pending',
  }));
  let clock = new Date(1000);
  const erased: number[] = [];
  const repository = {
    activateDueErasures: async () => true,
    erasureWork: async () => [],
    erasureUploads: async () => [],
    erasureArchiveCustody: async () => null,
    erasureLegacyFiles: async () => [],
    eraseRows: async (id: number) => {
      erased.push(id);
      clock = new Date(9000);
    },
  } as unknown as CommunitySovereigntyRepository;
  const store = {
    list: async () => records,
    write: async (record: ErasureRecord) => {
      records[records.findIndex((r) => r.communityId === record.communityId)] =
        record;
    },
  };
  return { records, erased, repository, store, clock: () => clock };
}

it('records completion after DB deletion and refuses adapters without durable writer fencing', async () => {
  const f = fixture();
  let fenced = false;
  const storage: FoundationStorage = {
    read: async () => null,
    delete: async () => {},
    list: async () => {
      expect(fenced).toBe(true);
      return { entries: [], truncated: false };
    },
  };
  const service = new CommunityErasureService(
    f.repository,
    storage,
    f.store,
    f.clock
  );
  await expect(service.sweep(new Date(1000))).rejects.toThrow(
    'fencing unavailable'
  );
  expect(f.erased).toEqual([]);
  storage.fenceCommunity = async () => {
    fenced = true;
  };
  await service.sweep(new Date(1000));
  expect(f.records[0]!.completedAt).toBe(new Date(9000).toISOString());
  await expect(
    verifyErasureRestorePoint(f.store, new Date(8999))
  ).rejects.toThrow('Restore point');
  await verifyErasureRestorePoint(f.store, new Date(9000));
});

it('batches 6,000 objects in six minute passes and completes only after a post-fence empty listing', async () => {
  const f = fixture();
  const keys = Array.from(
    { length: 6000 },
    (_, i) => `communities/1/media/${i}`
  );
  let operations = 0;
  const storage: FoundationStorage = {
    read: async () => null,
    delete: async () => {
      throw new Error('unbatched');
    },
    fenceCommunity: async () => {
      operations++;
    },
    list: async ({ limit } = {}) => {
      operations++;
      return {
        entries: keys
          .slice(0, limit)
          .map((key) => ({ key, uploaded: new Date(0) })),
        truncated: keys.length > limit!,
      };
    },
    deleteMany: async (batch) => {
      operations++;
      expect(batch.length).toBeLessThanOrEqual(1000);
      keys.splice(0, batch.length);
    },
  };
  const service = new CommunityErasureService(
    f.repository,
    storage,
    f.store,
    f.clock
  );
  for (let minute = 0; minute < 6; minute++) {
    operations = 0;
    await service.sweep(
      new Date(minute * 60000),
      WORKER_ERASURE_STORAGE_BUDGET
    );
    expect(operations).toBeLessThanOrEqual(WORKER_ERASURE_STORAGE_BUDGET);
    expect(f.records[0]!.completedAt).toBeNull();
  }
  expect(keys).toHaveLength(0);
  await service.sweep(new Date(6 * 60000), WORKER_ERASURE_STORAGE_BUDGET);
  expect(f.records[0]!.outcome).toBe('completed');
});

it('rotates the first community across restarted minute passes', async () => {
  const f = fixture(3);
  const visits: number[] = [];
  const storage: FoundationStorage = {
    read: async () => null,
    delete: async () => {},
    fenceCommunity: async (id) => {
      visits.push(id);
    },
    list: async ({ prefix } = {}) => ({
      entries: [{ key: `${prefix}media/x`, uploaded: new Date(0) }],
      truncated: true,
    }),
  };
  for (let minute = 0; minute < 3; minute++)
    await new CommunityErasureService(f.repository, storage, f.store).sweep(
      new Date(minute * 60000),
      3
    );
  expect(visits).toEqual([1, 2, 3]);
});

it('bounds completion work per tick to reserve D1 and out-of-band subrequests', async () => {
  const f = fixture(3);
  const storage: FoundationStorage = {
    read: async () => null,
    delete: async () => {},
    fenceCommunity: async () => {},
    list: async () => ({ entries: [], truncated: false }),
  };
  await new CommunityErasureService(
    f.repository,
    storage,
    f.store,
    f.clock
  ).sweep(new Date(0), WORKER_ERASURE_STORAGE_BUDGET);
  expect(f.erased).toEqual([1, 2]);
  expect(f.records[2]!.outcome).toBe('pending');
});

it('redacts and persists expired actors through the erasure service', async () => {
  const f = fixture();
  f.records[0] = {
    ...f.records[0]!,
    requestingActorId: 42,
    completedAt: new Date(0).toISOString(),
    outcome: 'completed',
  };
  const write = vi.spyOn(f.store, 'write');
  const service = new CommunityErasureService(
    f.repository,
    { read: async () => null },
    f.store
  );
  expect(
    (await service.listRecords(new Date(29 * 86400000)))[0]!.requestingActorId
  ).toBe(42);
  expect(write).not.toHaveBeenCalled();
  expect(
    (await service.listRecords(new Date(30 * 86400000)))[0]!.requestingActorId
  ).toBeNull();
  expect(f.records[0]!.requestingActorId).toBeNull();
  expect(write).toHaveBeenCalledOnce();
});

it('retains DB rows if custody evidence cannot be persisted before deletion', async () => {
  const f = fixture();
  vi.spyOn(f.repository, 'erasureArchiveCustody').mockResolvedValue({
    communityId: 1,
    custodianType: 'steward',
    custodianUserId: 42,
    status: 'destroyed',
    retentionUntil: new Date(1000),
    destroyedAt: new Date(500),
    destructionAttestationRef: 'attestation-ref',
  });
  const write = vi
    .spyOn(f.store, 'write')
    .mockRejectedValueOnce(new Error('unavailable'));
  const service = new CommunityErasureService(
    f.repository,
    {
      read: async () => null,
      fenceCommunity: async () => {},
      delete: async () => {},
      list: async () => ({ entries: [], truncated: false }),
    },
    f.store
  );
  await expect(service.sweep(new Date(1000))).rejects.toThrow('unavailable');
  expect(f.erased).toEqual([]);
  write.mockRestore();
  await service.sweep(new Date(1000));
  expect(f.erased).toEqual([1]);
  expect(f.records[0]!.archiveCustody).toEqual({
    custodianType: 'steward',
    custodianUserId: 42,
    retentionUntil: new Date(1000).toISOString(),
    destructionAttestationRef: 'attestation-ref',
  });
});

it('keeps legacy storage pointers on deletion failure and retries them before community rows', async () => {
  const f = fixture();
  const files = [
    { id: crypto.randomUUID(), storageKey: null, path: 'legacy/file' },
  ];
  vi.spyOn(f.repository, 'erasureLegacyFiles').mockImplementation(async () => [
    ...files,
  ]);
  const clear = vi.fn(async () => {
    files.splice(0);
  });
  f.repository.clearErasureLegacyFile = clear;
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(undefined);
  const service = new CommunityErasureService(
    f.repository,
    {
      read: async () => null,
      fenceCommunity: async () => {},
      delete: remove,
      list: async () => ({ entries: [], truncated: false }),
    },
    f.store
  );
  await expect(service.sweep(new Date(0))).rejects.toThrow('unavailable');
  expect(clear).not.toHaveBeenCalled();
  expect(f.erased).toEqual([]);
  await service.sweep(new Date(60000));
  expect(remove).toHaveBeenNthCalledWith(2, 'legacy/file');
  expect(clear).toHaveBeenCalledOnce();
  expect(f.erased).toEqual([1]);
});

it('verifies real local legacy bytes before releasing retry pointers and completion', async () => {
  const f = fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'erasure-legacy-'));
  await mkdir(path.join(root, 'legacy'));
  await writeFile(
    path.join(root, 'legacy/community-file'),
    new Uint8Array([1])
  );
  await writeFile(path.join(root, 'legacy/foreign-file'), new Uint8Array([2]));
  const storage = await createLocalStorage(root);
  const files = [
    {
      id: crypto.randomUUID(),
      storageKey: null,
      path: 'legacy/community-file',
    },
  ];
  vi.spyOn(f.repository, 'erasureLegacyFiles').mockImplementation(async () => [
    ...files,
  ]);
  f.repository.clearErasureLegacyFile = vi.fn(async () => {
    files.splice(0);
  });
  const remove = vi.spyOn(storage, 'delete');
  // A successful but ineffective delete must never discard the retry pointer.
  remove.mockResolvedValueOnce(undefined);
  const service = new CommunityErasureService(
    f.repository,
    storage,
    f.store,
    f.clock
  );
  await expect(service.sweep(new Date(0))).rejects.toThrow(
    'Legacy erasure incomplete'
  );
  expect(files).toHaveLength(1);
  expect(f.erased).toEqual([]);
  expect(f.records[0]!.completedAt).toBeNull();
  await service.sweep(new Date(60000));
  expect(files).toEqual([]);
  expect(
    (await storage.list!({ prefix: 'legacy/' })).entries.map((e) => e.key)
  ).toEqual(['legacy/foreign-file']);
  expect(f.erased).toEqual([1]);
  expect(f.records[0]!.outcome).toBe('completed');
});

it('refuses legacy traversal and symlink escapes without removing bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'erasure-legacy-safety-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'erasure-legacy-outside-'));
  await mkdir(path.join(root, 'legacy'));
  await writeFile(path.join(outside, 'file'), new Uint8Array([1]));
  await symlink(outside, path.join(root, 'legacy', 'escape'));
  const storage = await createLocalStorage(root);
  await expect(storage.delete!('legacy/escape/file')).rejects.toThrow(
    'Invalid deletion path'
  );
  await storage.delete!('legacy/../system/orphan-sweep-hold');
  expect(await readFile(path.join(outside, 'file'))).toEqual(Buffer.from([1]));
  await expect(
    storage.put!('legacy/file', new Uint8Array([1]))
  ).rejects.toThrow('Invalid storage key');
  expect(await storage.read('legacy/escape/file')).toBeNull();
});
