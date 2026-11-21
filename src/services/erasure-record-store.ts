import { z } from 'zod';
import { ErasureRecordSummarySchema } from '../shared/schemas/community-sovereignty.js';
import { ERASURE_DISPUTE_WINDOW_MS } from '../shared/sovereignty-policy.js';

export const ErasureRecordSchema = ErasureRecordSummarySchema.extend({
  requestingActorId: z.number().int().positive().nullable(),
}).strict();
export type ErasureRecord = z.infer<typeof ErasureRecordSchema>;

/** Must reside outside EVERY restorable DB/media/whole-state backup set. */
export interface ErasureRecordStore {
  list(): Promise<ErasureRecord[]>;
  write(record: ErasureRecord): Promise<void>;
}

export function redactErasureActor(
  record: ErasureRecord,
  now: Date
): ErasureRecord {
  return record.completedAt !== null &&
    now.getTime() >= Date.parse(record.completedAt) + ERASURE_DISPUTE_WINDOW_MS
    ? { ...record, requestingActorId: null }
    : record;
}

/** Refuse before restoring any bytes, including while deletion is incomplete. */
export async function verifyErasureRestorePoint(
  store: ErasureRecordStore,
  point: Date
): Promise<void> {
  if (!Number.isFinite(point.getTime()))
    throw new Error('Invalid restore point');
  for (const record of await store.list()) {
    if (
      record.completedAt === null ||
      point.getTime() < Date.parse(record.completedAt)
    ) {
      throw new Error('Restore point violates community erasure');
    }
  }
}
