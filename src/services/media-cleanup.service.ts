/**
 * Unreferenced media cleanup coordinator & restart-safe database sweeper (§6.7).
 *
 * - Upload rollbacks and explicit `DELETE /v2/media/:id` delete bytes immediately
 *   and fall back to the pending cleanup queue if storage removal fails.
 * - Deleting a resource (`DELETE /v2/attachments/:id`, `DELETE /v2/stories/:id`,
 *   `DELETE /v2/places/:id`, `DELETE /v2/speakers/:id`) schedules unreferenced
 *   byte cleanup for any `File` with zero remaining relations in `attachments`,
 *   `community_map_configs`, or `community_media`.
 * - Because unreferenced `files` rows persist until swept (or explicitly deleted),
 *   `sweepUnreferencedFiles` is restart-safe and re-checks `NOT EXISTS` atomically
 *   before deleting DB metadata and storage bytes.
 */

import { and, eq, inArray, lte, notExists } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import type { FoundationStorage } from './hono-foundation.service.js';

export type MediaCleanupReason =
  | 'upload_rollback'
  | 'file_deleted'
  | 'last_attachment_deleted'
  | 'owner_deleted';

export interface ScheduledMediaCleanup {
  fileId: string;
  storageKey: string;
  communityId: number | null;
  reason: MediaCleanupReason;
}

export type MediaCleanupObserver = (
  items: ReadonlyArray<ScheduledMediaCleanup>
) => void | Promise<void>;

export interface MediaCleanupCoordinatorOptions {
  onScheduled?: MediaCleanupObserver;
}

export class MediaCleanupCoordinator {
  private readonly pendingMap = new Map<string, ScheduledMediaCleanup>();

  constructor(
    private readonly connection: Database | DrizzleD1Database,
    private readonly storage: FoundationStorage,
    private readonly options: MediaCleanupCoordinatorOptions = {}
  ) {}

  pending(): ScheduledMediaCleanup[] {
    return Array.from(this.pendingMap.values());
  }

  async schedule(items: ReadonlyArray<ScheduledMediaCleanup>): Promise<void> {
    if (items.length === 0) return;
    const added: ScheduledMediaCleanup[] = [];
    for (const item of items) {
      if (!this.pendingMap.has(item.storageKey)) {
        this.pendingMap.set(item.storageKey, item);
        added.push(item);
      }
    }
    if (added.length > 0 && this.options.onScheduled) {
      await this.options.onScheduled(added);
    }
  }

  async deleteImmediatelyOrSchedule(
    item: ScheduledMediaCleanup
  ): Promise<void> {
    if (!this.storage.delete) {
      await this.schedule([item]);
      return;
    }
    try {
      await this.storage.delete(item.storageKey);
      this.pendingMap.delete(item.storageKey);
    } catch {
      await this.schedule([item]);
    }
  }

  /**
   * Finds `File` rows that currently have zero references across `attachments`,
   * `community_map_configs`, and `community_media`, and atomically removes both
   * their `files` row and storage object. Restart-safe across process restarts.
   */
  async sweepUnreferencedFiles(
    opts: {
      fileIds?: ReadonlyArray<string>;
      olderThan?: Date;
      limit?: number;
    } = {}
  ): Promise<{ deletedCount: number; failedCount: number }> {
    const tables = tablesFor(this.connection);
    const communityMedia =
      dialectOf(this.connection) === 'postgresql'
        ? communityMediaPg
        : communityMediaSqlite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = this.connection as any;
    const isD1 = typeof db?.batch === 'function';

    const noReferences = (executor: typeof db, fileId: string) =>
      and(
        eq(tables.files.id, fileId),
        notExists(
          executor
            .select({ id: tables.attachments.id })
            .from(tables.attachments)
            .where(eq(tables.attachments.fileId, tables.files.id))
        ),
        notExists(
          executor
            .select({ communityId: tables.communityMapConfigs.communityId })
            .from(tables.communityMapConfigs)
            .where(
              eq(tables.communityMapConfigs.staticMapFileId, tables.files.id)
            )
        ),
        notExists(
          executor
            .select({ fileId: communityMedia.fileId })
            .from(communityMedia)
            .where(eq(communityMedia.fileId, tables.files.id))
        )
      );

    const conditions = [
      notExists(
        db
          .select({ id: tables.attachments.id })
          .from(tables.attachments)
          .where(eq(tables.attachments.fileId, tables.files.id))
      ),
      notExists(
        db
          .select({ communityId: tables.communityMapConfigs.communityId })
          .from(tables.communityMapConfigs)
          .where(
            eq(tables.communityMapConfigs.staticMapFileId, tables.files.id)
          )
      ),
      notExists(
        db
          .select({ fileId: communityMedia.fileId })
          .from(communityMedia)
          .where(eq(communityMedia.fileId, tables.files.id))
      ),
    ];

    if (opts.fileIds && opts.fileIds.length > 0) {
      conditions.push(inArray(tables.files.id, [...opts.fileIds]));
    }
    if (opts.olderThan) {
      conditions.push(lte(tables.files.createdAt, opts.olderThan));
    }

    const candidates: Array<{
      id: string;
      storageKey: string | null;
      path: string;
    }> = await db
      .select({
        id: tables.files.id,
        storageKey: tables.files.storageKey,
        path: tables.files.path,
      })
      .from(tables.files)
      .where(and(...conditions))
      .limit(opts.limit ?? 50);

    let deletedCount = 0;
    let failedCount = 0;

    for (const candidate of candidates) {
      const storageKey = candidate.storageKey ?? candidate.path;
      let removedFromDb = false;

      if (isD1) {
        const rows = await db
          .delete(tables.files)
          .where(noReferences(db, candidate.id))
          .returning({ id: tables.files.id });
        removedFromDb = Array.isArray(rows) && rows.length > 0;
      } else if (dialectOf(this.connection) === 'postgresql') {
        removedFromDb = await db.transaction(async (tx: typeof db) => {
          const locked = await tx
            .select({ id: tables.files.id })
            .from(tables.files)
            .where(eq(tables.files.id, candidate.id))
            .for('update');
          if (locked.length === 0) return false;
          const rows = await tx
            .delete(tables.files)
            .where(noReferences(tx, candidate.id))
            .returning({ id: tables.files.id });
          return Array.isArray(rows) && rows.length > 0;
        });
      } else {
        removedFromDb = db.transaction((tx: typeof db) => {
          const rows = tx
            .delete(tables.files)
            .where(noReferences(tx, candidate.id))
            .returning({ id: tables.files.id })
            .all();
          return rows.length > 0;
        });
      }

      if (!removedFromDb) continue;

      try {
        await this.storage.delete?.(storageKey);
        this.pendingMap.delete(storageKey);
        deletedCount++;
      } catch {
        failedCount++;
      }
    }

    return { deletedCount, failedCount };
  }
}

/**
 * Shared query helper returning `File` metadata for any `fileIds` that currently
 * hold zero references across `attachments`, `community_map_configs`, and `community_media`.
 */
export async function findOwnerAttachmentFileIds(
  connection: Database | DrizzleD1Database,
  communityId: number,
  ownerType: 'story' | 'place' | 'speaker',
  ownerId: number
): Promise<string[]> {
  const tables = tablesFor(connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = connection as any;
  const rows = (await db
    .select({ fileId: tables.attachments.fileId })
    .from(tables.attachments)
    .where(
      and(
        eq(tables.attachments.communityId, communityId),
        eq(tables.attachments.ownerType, ownerType),
        eq(tables.attachments.ownerId, ownerId)
      )
    )) as Array<{ fileId: string | null }>;
  return rows
    .map((row) => row.fileId)
    .filter((id): id is string => typeof id === 'string');
}

export async function findUnreferencedFiles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any,
  connection: Database | DrizzleD1Database,
  fileIds: ReadonlyArray<string>,
  reason: MediaCleanupReason
): Promise<ScheduledMediaCleanup[]> {
  const uniqueIds = Array.from(new Set(fileIds)).filter(Boolean);
  if (uniqueIds.length === 0) return [];

  const tables = tablesFor(connection);
  const communityMedia =
    dialectOf(connection) === 'postgresql'
      ? communityMediaPg
      : communityMediaSqlite;

  const rows: Array<{
    id: string;
    storageKey: string | null;
    path: string;
    communityId: number | null;
  }> = [];

  for (let i = 0; i < uniqueIds.length; i += 80) {
    const chunk = uniqueIds.slice(i, i + 80);
    const chunkRows = await executor
      .select({
        id: tables.files.id,
        storageKey: tables.files.storageKey,
        path: tables.files.path,
        communityId: tables.files.communityId,
      })
      .from(tables.files)
      .where(
        and(
          inArray(tables.files.id, chunk),
          notExists(
            executor
              .select({ id: tables.attachments.id })
              .from(tables.attachments)
              .where(eq(tables.attachments.fileId, tables.files.id))
          ),
          notExists(
            executor
              .select({ communityId: tables.communityMapConfigs.communityId })
              .from(tables.communityMapConfigs)
              .where(
                eq(tables.communityMapConfigs.staticMapFileId, tables.files.id)
              )
          ),
          notExists(
            executor
              .select({ fileId: communityMedia.fileId })
              .from(communityMedia)
              .where(eq(communityMedia.fileId, tables.files.id))
          )
        )
      );
    rows.push(...chunkRows);
  }

  return rows.map((row) => ({
    fileId: row.id,
    storageKey: row.storageKey ?? row.path,
    communityId: row.communityId,
    reason,
  }));
}
