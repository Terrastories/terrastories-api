import { CommunitySovereigntyRepository } from '../repositories/community-sovereignty.repository.js';
import type { FoundationStorage } from './hono-foundation.service.js';
import {
  redactErasureActor,
  verifyErasureRestorePoint,
  type ErasureRecord,
  type ErasureRecordStore,
} from './erasure-record-store.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import { SOVEREIGNTY_AUDIT_ACTIONS } from '../shared/sovereignty-policy.js';

/** Idempotent passes. No database ownership/byte pointers are lost before byte deletion. */
export class CommunityErasureService {
  constructor(
    private readonly repository: CommunitySovereigntyRepository,
    private readonly storage: FoundationStorage,
    private readonly store: ErasureRecordStore
  ) {}

  async sweep(now: Date, storageBudget = 25): Promise<void> {
    await this.repository.activateDueErasures(now);
    const records = await this.store.list();
    for (const row of await this.repository.erasureWork()) {
      if (!records.some((r) => r.communityId === row.communityId)) {
        const record: ErasureRecord = {
          communityId: row.communityId,
          requestId: row.id,
          requestingActorId: row.initiatedBy,
          requestedAt: (row.effectiveAt ?? row.requestedAt).toISOString(),
          completedAt: null,
          outcome: 'pending',
        };
        await this.store.write(record);
        records.push(record);
      }
    }
    for (const record of records) {
      if (record.completedAt !== null) {
        const redacted = redactErasureActor(record, now);
        if (
          redacted.requestingActorId !== record.requestingActorId &&
          storageBudget >= 2
        ) {
          await this.store.write(redacted);
          storageBudget -= 2;
        }
        continue;
      }
      if (!this.storage.list || !this.storage.delete)
        throw new Error('Erasure storage unavailable');
      const prefix = `communities/${record.communityId}/`;
      for (const upload of await this.repository.erasureUploads(
        record.communityId
      )) {
        if (
          !upload.key?.startsWith(prefix) ||
          !upload.uploadId ||
          !this.storage.abortMultipartUpload
        )
          throw new Error('Erasure multipart abort unavailable');
        if (--storageBudget < 0) return;
        await this.storage.abortMultipartUpload(upload.key, upload.uploadId);
        await this.repository.clearErasureUpload(upload.id, upload.uploadId);
      }
      if ((await this.repository.erasureUploads(record.communityId)).length)
        return;
      const deleteCost = this.storage.erasureDeleteCost ?? 1;
      if (storageBudget < deleteCost + 1) return;
      const page = await this.storage.list({
        prefix,
        limit: Math.min(Math.floor((storageBudget - 1) / deleteCost), 20),
      });
      storageBudget--;
      for (const object of page.entries) {
        if (!object.key.startsWith(prefix))
          throw new Error('Invalid erasure listing');
        await this.storage.delete(object.key);
        storageBudget -= deleteCost;
      }
      // A fresh empty listing verifies absence, and also catches interrupted uploads.
      if (page.entries.length || page.truncated) return;
      await this.repository.eraseRows(record.communityId, now);
      await this.store.write({
        ...record,
        outcome: 'completed',
        completedAt: now.toISOString(),
      });
    }
  }

  /** Run with the deployment quiesced, BEFORE touching any restored bytes.
   * The authoritative source DB closes the request/out-of-band-write crash gap.
   * If it cannot be read, restore is refused, never inferred safe from an empty store.
   */
  async verifyRestorePoint(point: Date, now: Date): Promise<void> {
    if (await this.repository.erasureRestoreBlocked(now))
      throw new Error('Restore blocked by pending community erasure');
    await verifyErasureRestorePoint(this.store, point);
  }

  /** Call AFTER an allowed restore and BEFORE opening the listener. */
  async reconcileRestore(point: Date, now: Date): Promise<void> {
    await verifyErasureRestorePoint(this.store, point);
    for (const record of await this.store.list()) {
      const prefix = `communities/${record.communityId}/`;
      if (!this.storage.list || !this.storage.delete)
        throw new Error('Erasure storage unavailable');
      for (const upload of await this.repository.erasureUploads(
        record.communityId
      )) {
        if (
          !upload.key?.startsWith(prefix) ||
          !upload.uploadId ||
          !this.storage.abortMultipartUpload
        )
          throw new Error('Erasure multipart abort unavailable');
        await this.storage.abortMultipartUpload(upload.key, upload.uploadId);
        await this.repository.clearErasureUpload(upload.id, upload.uploadId);
      }
      for (;;) {
        const page = await this.storage.list({ prefix, limit: 20 });
        if (!page.entries.length) {
          if (page.truncated) throw new Error('Invalid storage listing');
          break;
        }
        for (const object of page.entries) {
          if (!object.key.startsWith(prefix))
            throw new Error('Invalid erasure listing');
          await this.storage.delete(object.key);
        }
      }
      await this.repository.eraseRows(record.communityId, now);
      await writeAuditEntry(
        this.repository.connection,
        {
          communityId: null,
          actorId: null,
          action: SOVEREIGNTY_AUDIT_ACTIONS.RESTORE_RECONCILE,
          resourceType: 'system',
          resourceIds: [record.communityId],
          outcome: 'success',
        },
        now
      );
    }
  }
}
