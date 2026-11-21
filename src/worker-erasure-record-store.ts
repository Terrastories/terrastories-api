import type { R2Bucket } from '@cloudflare/workers-types';
import {
  ErasureRecordSchema,
  type ErasureRecord,
  type ErasureRecordStore,
} from './services/erasure-record-store.js';

/** Dedicated bucket, never restored together with D1 or MEDIA. */
export function createWorkerErasureRecordStore(
  bucket: R2Bucket
): ErasureRecordStore {
  return {
    async list() {
      const records = new Map<number, ErasureRecord>();
      let cursor: string | undefined;
      do {
        const page = await bucket.list({
          prefix: 'erasures/',
          limit: 1000,
          include: ['customMetadata'],
          ...(cursor ? { cursor } : {}),
        });
        for (const object of page.objects) {
          const serialized = object.customMetadata?.record;
          if (!serialized)
            throw new Error('Erasure record metadata unavailable');
          const record = ErasureRecordSchema.parse(JSON.parse(serialized));
          if (!records.has(record.communityId) || record.completedAt !== null)
            records.set(record.communityId, record);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return [...records.values()].sort(
        (a, b) => a.communityId - b.communityId
      );
    },
    async write(raw) {
      const record = ErasureRecordSchema.parse(raw);
      const key = `erasures/${record.communityId}-${record.completedAt ? 'completed' : 'pending'}.json`;
      await bucket.put(key, JSON.stringify(record), {
        customMetadata: { record: JSON.stringify(record) },
      });
      if (record.completedAt !== null)
        await bucket.put(
          `erasures/${record.communityId}-pending.json`,
          JSON.stringify({
            ...record,
            requestingActorId: null,
            completedAt: null,
            outcome: 'pending',
          }),
          {
            customMetadata: {
              record: JSON.stringify({
                ...record,
                requestingActorId: null,
                completedAt: null,
                outcome: 'pending',
              }),
            },
          }
        );
    },
  };
}
