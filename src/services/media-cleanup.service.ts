/**
 * Unreferenced media cleanup (§6.7).
 *
 * The durable record of "these bytes are now garbage" is the database, not
 * process memory:
 *
 * - When an attachment (or an owner's attachments) is deleted and a `File`
 *   becomes unreferenced, the `files` row is removed inside the same
 *   transaction / D1 batch as the relation delete, guarded by `NOT EXISTS`
 *   inside the `DELETE` itself so a concurrently added relation keeps the row.
 * - After the commit, the storage object is deleted best-effort. If that
 *   storage delete fails (or the process dies between commit and delete), the
 *   object is left with no `files` row and is removed later by the
 *   restart-safe orphan sweeper (`sweepOrphanObjects`).
 * - `sweepOrphanObjects` lists stored objects, ignores any whose bytes are
 *   still referenced by a `files` row, and only deletes objects older than a
 *   grace window so in-flight uploads that stage bytes before their row are
 *   never swept.
 *
 * Upload rollbacks (no `files` row is created) also rely on the orphan sweeper:
 * their bytes have no row, so a later sweep removes them once they age past the
 * grace window.
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

/** A `files` row that was removed and whose bytes must now be deleted. */
export interface FileByteCleanup {
  fileId: string;
  storageKey: string;
}

/**
 * Build `DELETE FROM files ... RETURNING` statements that remove only rows with
 * zero references, guarded by `NOT EXISTS` inside each statement so a
 * concurrently added relation keeps the row. One statement per ≤80 ids keeps D1
 * bound parameters well under the 100 limit. Executors must run these AFTER the
 * relation rows are removed in the same transaction/batch.
 */
export function buildUnreferencedFilesDelete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any,
  connection: Database | DrizzleD1Database,
  fileIds: ReadonlyArray<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const tables = tablesFor(connection);
  const communityMedia =
    dialectOf(connection) === 'postgresql'
      ? communityMediaPg
      : communityMediaSqlite;
  const unique = Array.from(new Set(fileIds)).filter(Boolean);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [];
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    statements.push(
      executor
        .delete(tables.files)
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
                  eq(
                    tables.communityMapConfigs.staticMapFileId,
                    tables.files.id
                  )
                )
            ),
            notExists(
              executor
                .select({ fileId: communityMedia.fileId })
                .from(communityMedia)
                .where(eq(communityMedia.fileId, tables.files.id))
            )
          )
        )
        .returning({
          id: tables.files.id,
          storageKey: tables.files.storageKey,
          path: tables.files.path,
        })
    );
  }
  return statements;
}

/** Normalize deleted-file rows into byte-cleanup descriptors. */
export function toFileByteCleanups(
  rows: ReadonlyArray<{ id: string; storageKey: string | null; path: string }>
): FileByteCleanup[] {
  return rows.map((row) => ({
    fileId: row.id,
    storageKey: row.storageKey ?? row.path,
  }));
}

/** Named grace window: bytes are never swept before they are this old. */
export const ORPHAN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Named per-run bound so a sweep never enumerates an unbounded keyspace. */
export const ORPHAN_SWEEP_LIMIT = 500;

/** Storage prefixes that can hold community/system bytes. */
export const ORPHAN_SWEEP_PREFIXES = ['communities/', 'users/'] as const;

export interface SweepResult {
  deletedCount: number;
  failedCount: number;
  scanned: number;
}

export interface MediaCleanupCoordinatorOptions {
  /** Content-free operator channel; never receives content or URLs. */
  log?: (line: string) => void;
  now?: () => Date;
}

export class MediaCleanupCoordinator {
  constructor(
    private readonly connection: Database | DrizzleD1Database,
    private readonly storage: FoundationStorage,
    private readonly options: MediaCleanupCoordinatorOptions = {}
  ) {}

  private log(line: string): void {
    if (this.options.log) {
      this.options.log(line);
      return;
    }
    // eslint-disable-next-line no-console -- operator channel; content-free
    console.warn(line);
  }

  /**
   * Best-effort storage-object deletion after the DB row is already gone. A
   * failure is logged content-free and left to the orphan sweeper.
   */
  async deleteStorageBestEffort(
    storageKey: string,
    reason: MediaCleanupReason
  ): Promise<boolean> {
    if (!this.storage.delete) return false;
    try {
      await this.storage.delete(storageKey);
      return true;
    } catch {
      // Content-free: no key, no content, no URL.
      this.log(`media cleanup: storage delete failed (${reason})`);
      return false;
    }
  }

  /** Delete bytes for files whose `files` rows were removed in a commit. */
  async deleteFilesBestEffort(
    files: ReadonlyArray<FileByteCleanup>
  ): Promise<{ deletedCount: number; failedCount: number }> {
    let deletedCount = 0;
    let failedCount = 0;
    for (const file of files) {
      const ok = await this.deleteStorageBestEffort(
        file.storageKey,
        'file_deleted'
      );
      if (ok) deletedCount++;
      else failedCount++;
    }
    return { deletedCount, failedCount };
  }

  /**
   * Restart-safe DB backstop: removes `files` rows that currently hold zero
   * references and deletes their bytes. The inline path normally removes the
   * row in the same transaction as the relation delete; this covers a row left
   * unreferenced by a crash or out-of-band mutation.
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

      const ok = await this.deleteStorageBestEffort(storageKey, 'file_deleted');
      if (ok) deletedCount++;
      else failedCount++;
    }

    return { deletedCount, failedCount };
  }

  /**
   * Restart-safe orphan sweeper for objects whose `files` row is gone but whose
   * bytes remain (storage delete failed, or the process died between commit and
   * delete). Only objects older than the grace window are considered; a
   * referenced object or a fresh in-flight upload is always kept.
   */
  async sweepOrphanObjects(
    opts: { olderThan?: Date; limit?: number } = {}
  ): Promise<SweepResult> {
    if (!this.storage.list || !this.storage.delete) {
      return { deletedCount: 0, failedCount: 0, scanned: 0 };
    }
    const now = this.options.now ?? (() => new Date());
    const cutoff =
      opts.olderThan ?? new Date(now().getTime() - ORPHAN_SWEEP_GRACE_MS);
    const limit = opts.limit ?? ORPHAN_SWEEP_LIMIT;
    let scanned = 0;
    let deletedCount = 0;
    let failedCount = 0;

    for (const prefix of ORPHAN_SWEEP_PREFIXES) {
      let cursor: string | undefined;
      do {
        if (scanned >= limit) break;
        const page = await this.storage.list({
          prefix,
          cursor,
          limit: Math.min(200, limit - scanned),
        });
        for (const entry of page.entries) {
          if (scanned >= limit) break;
          scanned++;
          if (entry.uploaded.getTime() >= cutoff.getTime()) continue;
          if (await this.isStorageKeyReferenced(entry.key)) continue;
          const ok = await this.deleteStorageBestEffort(
            entry.key,
            'owner_deleted'
          );
          if (ok) deletedCount++;
          else failedCount++;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && scanned < limit);
      if (scanned >= limit) break;
    }

    return { deletedCount, failedCount, scanned };
  }

  private async isStorageKeyReferenced(key: string): Promise<boolean> {
    const tables = tablesFor(this.connection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = this.connection as any;
    const rows = await db
      .select({ id: tables.files.id })
      .from(tables.files)
      .where(eq(tables.files.storageKey, key))
      .limit(1);
    if (Array.isArray(rows) && rows.length > 0) return true;
    const pathRows = await db
      .select({ id: tables.files.id })
      .from(tables.files)
      .where(eq(tables.files.path, key))
      .limit(1);
    return Array.isArray(pathRows) && pathRows.length > 0;
  }
}

/**
 * Shared query helper returning `File` metadata for any `fileIds` that currently
 * hold zero references across `attachments`, `community_map_configs`, or `community_media`.
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

/**
 * Returns `File` rows for `fileIds` that currently hold zero references across
 * `attachments`, `community_map_configs`, and `community_media`.
 */
export async function findUnreferencedFiles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any,
  connection: Database | DrizzleD1Database,
  fileIds: ReadonlyArray<string>,
  reason: MediaCleanupReason
): Promise<FileByteCleanup[]> {
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
    reason: MediaCleanupReason;
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
