import { CommunitySovereigntyRepository } from '../repositories/community-sovereignty.repository.js';
import {
  validStorageKey,
  validLegacyStorageKey,
  type FoundationStorage,
} from './hono-foundation.service.js';
import {
  redactErasureActor,
  verifyErasureRestorePoint,
  type ErasureRecord,
  type ErasureRecordStore,
} from './erasure-record-store.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import { SOVEREIGNTY_AUDIT_ACTIONS } from '../shared/sovereignty-policy.js';
import type { WorkersPlan } from '../config/v2-runtime.js';

export const ERASURE_BATCH_SIZE = 1000;
export const WORKER_ERASURE_STORAGE_BUDGET = 15;
/**
 * Workers Paid raises subrequests per invocation to 10,000, D1 queries per
 * invocation to 1,000, and cron CPU to 30 s default (docs/WORKERS-PAID-PROFILE.md §2).
 * A storage budget of 500 keeps even D1-paired operations (1 D1 query per
 * multipart abort or 2 per legacy file check) comfortably below the 1,000 D1
 * query cap and 10,000 subrequest cap per minute cron tick.
 * TODO(SPEC-V2 §5, §7 Backups #187): inert unless WORKERS_PLAN=paid after SPEC-V2 §5 and §7 (31-day Time Travel bound) are amended.
 */
export const WORKER_PAID_ERASURE_STORAGE_BUDGET = 500;
export const ERASURE_COMMUNITIES_PER_PASS = 2;

export function workerErasureStorageBudget(plan: WorkersPlan = 'free'): number {
  return plan === 'paid'
    ? WORKER_PAID_ERASURE_STORAGE_BUDGET
    : WORKER_ERASURE_STORAGE_BUDGET;
}

/** Idempotent passes. No database ownership/byte pointers are lost before byte deletion. */
export class CommunityErasureService {
  constructor(
    private readonly repository: CommunitySovereigntyRepository,
    private readonly storage: FoundationStorage,
    private readonly store: ErasureRecordStore,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async listRecords(now: Date): Promise<ErasureRecord[]> {
    const records: ErasureRecord[] = [];
    for (const record of await this.store.list()) {
      const redacted = redactErasureActor(record, now);
      if (redacted.requestingActorId !== record.requestingActorId)
        await this.store.write(redacted);
      records.push(redacted);
    }
    return records;
  }

  private async preserveCustody(record: ErasureRecord): Promise<ErasureRecord> {
    // An allowed restore must not overwrite surviving completed evidence with
    // an older database snapshot's custody designation or attestation.
    if (record.completedAt !== null && record.archiveCustody !== undefined)
      return record;
    const custody = await this.repository.erasureArchiveCustody(
      record.communityId
    );
    if (!custody) return record;
    const updated: ErasureRecord = {
      ...record,
      archiveCustody: {
        custodianType: custody.custodianType,
        custodianUserId: custody.custodianUserId,
        retentionUntil: custody.retentionUntil.toISOString(),
        destructionAttestationRef: custody.destructionAttestationRef,
      },
    };
    // Must succeed before any account/community cascade removes this evidence.
    await this.store.write(updated);
    return updated;
  }

  private async deleteLegacyFiles(
    communityId: number,
    budget: number
  ): Promise<number> {
    let unaddressable = 0;
    try {
      return await this.deleteLegacyFilesBatch(
        communityId,
        budget,
        () => unaddressable++
      );
    } finally {
      if (unaddressable > 0)
        // eslint-disable-next-line no-console
        console.warn(
          `Community erasure cleared ${unaddressable} legacy file row(s) with unaddressable storage keys`
        );
    }
  }

  private async deleteLegacyFilesBatch(
    communityId: number,
    budget: number,
    unaddressableSeen: () => void
  ): Promise<number> {
    for (const file of await this.repository.erasureLegacyFiles(communityId)) {
      const cost = (this.storage.erasureDeleteCost ?? 1) + 1;
      if (budget < cost) return 0;
      const key = file.storageKey ?? file.path;
      if (!validStorageKey(key) && !validLegacyStorageKey(key)) {
        // Cannot address bytes through any adapter: drop the pointer only.
        unaddressableSeen();
        await this.repository.clearErasureLegacyFile(communityId, file.id);
        budget -= 1;
        continue;
      }
      // Never delete bytes another tenant/row still references, nor keys
      // outside legacy/, this community's prefix or its users' prefixes.
      if (!(await this.repository.erasureMayDeleteKey(communityId, key))) {
        await this.repository.clearErasureLegacyFile(communityId, file.id);
        budget -= 1;
        continue;
      }
      await this.storage.delete!(key);
      // Do not use read(): runtime serving intentionally rejects legacy keys.
      // An exact key sorts before every longer key sharing this prefix.
      const remaining = await this.storage.list!({ prefix: key, limit: 1 });
      if (remaining.entries.some((entry) => entry.key === key))
        throw new Error('Legacy erasure incomplete');
      budget -= cost;
      await this.repository.clearErasureLegacyFile(communityId, file.id);
    }
    return budget;
  }

  async sweep(now: Date, storageBudget = 25): Promise<void> {
    await this.repository.activateDueErasures(now);
    const records = await this.store.list();
    for (const row of await this.repository.erasureWork(5, now)) {
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
    // Wall-clock round robin survives isolate/process restarts and keeps a
    // large community from starving every community behind it.
    const pending = records
      .filter((record) => record.completedAt === null)
      .sort((a, b) => a.communityId - b.communityId);
    const start = pending.length
      ? Math.floor(now.getTime() / 60000) % pending.length
      : 0;
    const ordered = [
      ...[...pending.slice(start), ...pending.slice(0, start)].slice(
        0,
        ERASURE_COMMUNITIES_PER_PASS
      ),
      ...records.filter((record) => record.completedAt !== null),
    ];
    for (let record of ordered) {
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
      if (!this.storage.fenceCommunity)
        throw new Error('Erasure writer fencing unavailable');
      if (storageBudget < 2) return;
      await this.storage.fenceCommunity(record.communityId);
      storageBudget--;
      record = await this.preserveCustody(record);
      storageBudget = await this.deleteLegacyFiles(
        record.communityId,
        storageBudget
      );
      if (
        storageBudget < 2 ||
        (await this.repository.erasureLegacyFiles(record.communityId)).length
      )
        return;
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
      if (storageBudget < 2) return;
      const page = await this.storage.list({
        prefix,
        limit: this.storage.deleteMany
          ? ERASURE_BATCH_SIZE
          : Math.min(Math.floor((storageBudget - 1) / deleteCost), 20),
      });
      storageBudget--;
      for (const object of page.entries) {
        if (!object.key.startsWith(prefix))
          throw new Error('Invalid erasure listing');
      }
      if (this.storage.deleteMany) {
        const keys: string[] = [];
        for (const object of page.entries) {
          const next = [...keys, object.key];
          if (
            (this.storage.erasureBatchDeleteCost?.(next) ?? 1) > storageBudget
          )
            break;
          keys.push(object.key);
        }
        if (keys.length) {
          await this.storage.deleteMany(keys);
          storageBudget -= this.storage.erasureBatchDeleteCost?.(keys) ?? 1;
        }
      } else {
        for (const object of page.entries) {
          if (storageBudget < deleteCost) break;
          await this.storage.delete(object.key);
          storageBudget -= deleteCost;
        }
      }
      // A fresh empty listing verifies absence, and also catches interrupted uploads.
      if (page.entries.length || page.truncated) continue;
      await this.repository.eraseRows(record.communityId, now);
      await this.store.write({
        ...record,
        outcome: 'completed',
        completedAt: this.clock().toISOString(),
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
      await this.preserveCustody(record);
      if (!this.storage.fenceCommunity)
        throw new Error('Erasure writer fencing unavailable');
      await this.storage.fenceCommunity(record.communityId);
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
      while (
        (await this.repository.erasureLegacyFiles(record.communityId)).length
      )
        await this.deleteLegacyFiles(
          record.communityId,
          Number.POSITIVE_INFINITY
        );
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
