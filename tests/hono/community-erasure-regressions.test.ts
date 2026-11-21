import { expect, it } from 'vitest';
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
