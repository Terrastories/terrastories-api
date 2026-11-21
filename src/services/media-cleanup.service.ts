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

import {
  and,
  eq,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import {
  ORPHAN_SWEEP_CURSOR_KEY,
  ORPHAN_SWEEP_HOLD_KEY,
  type FoundationStorage,
} from './hono-foundation.service.js';

export type MediaCleanupReason =
  | 'upload_rollback'
  | 'file_deleted'
  | 'last_attachment_deleted'
  | 'owner_deleted'
  | 'import_discarded'
  | 'import_failed';

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
            eq(tables.files.isActive, true),
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
            ),
            notExists(
              executor
                .select({ id: tables.importManifests.id })
                .from(tables.importManifests)
                .where(eq(tables.importManifests.sourceFileId, tables.files.id))
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

/**
 * Files purge keyed to an owning relation scope, for single-batch owner
 * deletes on D1. The purge runs *inside* the owner-delete batch, before the
 * relation rows are removed: the still-present attachments are the evidence,
 * and the target is the file set this delete orphans — i.e. files referenced
 * exclusively by the owner's own attachments.
 *
 * `ownerDeleteGuard` must reproduce the owner DELETE's own gating exactly
 * (`EXISTS owner WHERE <the delete's WHERE>`), so the purge never frees
 * files in a batch whose owner delete will match nothing. The caller must
 * place this statement FIRST in the batch: it reads attachments rows that
 * are gone afterward.
 *
 * Files attached to any other owner are kept: an `NOT EXISTS` clause with a
 * NULL-safe owner-key comparison (coalesce ids against -1; owner ids start
 * at 1) covers attachments in every community and of every owner type.
 */
export function buildOwnerUnreferencedFilesDelete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any,
  connection: Database | DrizzleD1Database,
  owner: {
    communityId: number | null;
    ownerType:
      | 'story'
      | 'place'
      | 'speaker'
      | 'user'
      | 'community'
      | 'map_config';
    ownerId: number;
  },
  /** `EXISTS (owner row where the owner delete's WHERE holds)` as a condition. */
  ownerDeleteGuard: SQL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const tables = tablesFor(connection);
  const communityMedia =
    dialectOf(connection) === 'postgresql'
      ? communityMediaPg
      : communityMediaSqlite;
  const ownerScope = and(
    owner.communityId === null
      ? isNull(tables.attachments.communityId)
      : eq(tables.attachments.communityId, owner.communityId),
    eq(tables.attachments.ownerType, owner.ownerType),
    eq(tables.attachments.ownerId, owner.ownerId)
  );
  const ownerKey = (alias: typeof tables.attachments) => sql`(
    coalesce(${alias.communityId}, -1) = ${owner.communityId ?? -1}
    and ${alias.ownerType} = ${owner.ownerType}
    and ${alias.ownerId} = ${owner.ownerId}
  )`;
  return [
    executor
      .delete(tables.files)
      .where(
        and(
          ownerDeleteGuard,
          sql`${tables.files.id} in (
            select ${tables.attachments.fileId} from ${tables.attachments}
            where ${ownerScope}
          )`,
          notExists(
            executor
              .select({ id: tables.attachments.id })
              .from(tables.attachments)
              .where(
                and(
                  eq(tables.attachments.fileId, tables.files.id),
                  // NULL owner columns make the key NULL; coalesce so such a
                  // row still counts as another reference and keeps the file.
                  sql`not coalesce(${ownerKey(tables.attachments)}, false)`
                )
              )
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
          ),
          notExists(
            executor
              .select({ id: tables.importManifests.id })
              .from(tables.importManifests)
              .where(eq(tables.importManifests.sourceFileId, tables.files.id))
          )
        )
      )
      .returning({
        id: tables.files.id,
        storageKey: tables.files.storageKey,
        path: tables.files.path,
      }),
  ];
}

/** Normalize deleted-file rows into byte-cleanup descriptors. */
export function toFileByteCleanups(
  rows: ReadonlyArray<{
    id: string;
    storageKey?: string | null;
    /** Raw-column spelling returned by batch harnesses that skip mapping. */
    storage_key?: string | null;
    path: string;
  }>
): FileByteCleanup[] {
  return rows.map((row) => ({
    fileId: row.id,
    storageKey: row.storageKey ?? row.storage_key ?? row.path,
  }));
}

/** Maximum ids per lock/DELETE statement: keeps bound parameters bounded. */
const FILE_ID_CHUNK = 80;

/**
 * Lock candidate `files` rows immediately before a guarded unreferenced-file
 * delete (PostgreSQL only).
 *
 * The lock is `FOR UPDATE`, the only row-lock strength that conflicts with the
 * `FOR KEY SHARE` an attachment insert takes on the referenced row. Without it a
 * READ COMMITTED delete can run its `NOT EXISTS` check against a snapshot taken
 * while such an insert is still uncommitted, then block on that insert's row
 * lock and cascade the brand-new relation away once the insert commits. With the
 * lock, the racing insert either commits first — and the delete, running as its
 * own statement after the wait, then sees it and keeps the row — or waits until
 * this transaction ends and fails its foreign-key check cleanly. Holding
 * `FOR UPDATE` also means no relation can be added while the delete runs, so
 * that statement cannot go stale again. D1 and SQLite serialize writers, so
 * callers skip this there.
 *
 * Returns the subset of `fileIds` that exist and are now locked; ids whose row
 * is already gone are dropped because no delete can match them.
 */
export async function lockFileRowsForCleanup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: any,
  connection: Database | DrizzleD1Database,
  fileIds: ReadonlyArray<string>
): Promise<string[]> {
  const tables = tablesFor(connection);
  const unique = Array.from(new Set(fileIds)).filter(Boolean);
  if (unique.length === 0) return [];
  const locked = new Set<string>();
  for (let i = 0; i < unique.length; i += FILE_ID_CHUNK) {
    const chunk = unique.slice(i, i + FILE_ID_CHUNK);
    const rows = (await executor
      .select({ id: tables.files.id })
      .from(tables.files)
      .where(inArray(tables.files.id, chunk))
      .for('update')) as Array<{ id: string }>;
    for (const row of rows) locked.add(row.id);
  }
  return unique.filter((id) => locked.has(id));
}

/** Named grace window: bytes are never swept before they are this old. */
export const ORPHAN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Named per-run bound for the Node sweeper, sized for a long-lived process:
 * subrequests, not objects — each list page costs 1, each batched reference
 * query (<= ORPHAN_SWEEP_REFERENCE_CHUNK keys) costs 1, each delete costs 1,
 * so a run bounded by this budget still encounters no platform subrequest
 * limit while remaining bounded against a pathological keyspace.
 */
export const ORPHAN_SWEEP_SUBREQUEST_BUDGET = 2000;

/**
 * Workers Free allows 50 subrequests per invocation. The sweeper budgets 40:
 * one list page (<= 200 keys) = 1, one reference query (<= 45 keys, the D1
 * parameter bound) = 1, one delete = 1. Referenced and fresh objects consume
 * no delete subrequests, so they burn only their reference-share (~1 per 45
 * keys) and list pages — a pure live-object scan walks ~6 pages (~1,200
 * keys) per hourly run, ~28,800 keys/day, cycling even a 100k-key keyspace
 * inside 4 days; an all-orphan backlog clears at ~34 deletes/run (~800/day).
 * Both are far inside the 30-day §6.7 bound (an erased object's bytes may
 * not linger past the profile's backup window). The fixed per-run overhead
 * outside this budget is at most one hold check plus one cursor read and
 * write (system objects), keeping the whole invocation at <= 43, under the
 * Free 50.
 */
export const WORKER_SWEEP_SUBREQUEST_BUDGET = 40;

/** Storage prefixes that can hold community/system bytes. */
export const ORPHAN_SWEEP_PREFIXES = ['communities/', 'users/'] as const;

/**
 * Named per-page bound for the batched reference check (D1's 100-parameter
 * limit). Each candidate key is bound *twice* — once for `storage_key` and
 * once for `path` — so the chunk is sized at 45 keys (90 bound parameters),
 * not at the limit itself.
 */
export const ORPHAN_SWEEP_REFERENCE_CHUNK = 45;

export interface SweepResult {
  deletedCount: number;
  failedCount: number;
  scanned: number;
  /**
   * Subrequests this run spent on list pages, reference queries and deletes.
   * Held objects (hold, cursor) are not counted; the Workers scheduled path
   * keeps the total invocation under the Workers Free 50.
   */
  subrequests: number;
}

export interface MediaCleanupCoordinatorOptions {
  /** Content-free operator channel; never receives content or URLs. */
  log?: (line: string) => void;
  now?: () => Date;
  /**
   * Named cap on subrequests per run (1 per list page, 1 per reference
   * query, 1 per delete). Defaults to ORPHAN_SWEEP_SUBREQUEST_BUDGET; the
   * Workers scheduled path passes WORKER_SWEEP_SUBREQUEST_BUDGET.
   */
  subrequestBudget?: number;
  /**
   * Explicit restore hold (`ORPHAN_SWEEP_PAUSED=true` in the Node/Worker
   * environment). While set, the orphan sweep deletes nothing; entrypoints
   * wire this from their environment so an operator can pause garbage
   * collection around a restore instead of relying on any table state.
   */
  sweepPaused?: boolean;
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
        eq(tables.files.isActive, true),
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
        ),
        notExists(
          executor
            .select({ id: tables.importManifests.id })
            .from(tables.importManifests)
            .where(eq(tables.importManifests.sourceFileId, tables.files.id))
        )
      );

    const conditions = [
      eq(tables.files.isActive, true),
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
      notExists(
        db
          .select({ id: tables.importManifests.id })
          .from(tables.importManifests)
          .where(eq(tables.importManifests.sourceFileId, tables.files.id))
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
   *
   * The sweep is skipped entirely while an explicit restore hold is in effect:
   * either `ORPHAN_SWEEP_PAUSED=true` in the environment, or a storage marker
   * object `system/orphan-sweep-hold` (outside the swept prefixes, so the sweep
   * never deletes it). Operators set the hold before a filesystem/database
   * restore and clear it once the restored state is verified.
   *
   * The run is bounded by subrequests, not objects: each list page (<= 200
   * keys) costs 1, each batched reference query (<= 45 keys, the D1
   * parameter bound) costs 1, and each delete costs 1. Referenced and fresh
   * objects consume no delete budget, so a keyspace full of live objects
   * never starves garbage collection and never burns a delete it does not
   * need. Progress is a small cursor
   * object in the storage adapter (`system/orphan-sweep-cursor.json`, outside
   * the swept prefixes): each run resumes after `{prefix, startAfter}`, walks
   * `communities/` then `users/`, and wraps to the start once both are done.
   *
   * One bad object, page, or prefix never aborts the run: each is logged
   * content-free and the sweep continues, so a single unreadable object cannot
   * stop garbage collection for the rest of the keyspace.
   */
  async sweepOrphanObjects(
    opts: { olderThan?: Date; subrequestBudget?: number } = {}
  ): Promise<SweepResult> {
    if (!this.storage.list || !this.storage.delete) {
      return { deletedCount: 0, failedCount: 0, scanned: 0, subrequests: 0 };
    }
    if (await this.orphanSweepPaused()) {
      // Explicit restore hold: ORPHAN_SWEEP_PAUSED=true or a storage
      // `system/orphan-sweep-hold` marker. A restore can recreate storage
      // bytes before the `files` table knows them; sweeping then would delete
      // bytes that are about to become referenced again.
      this.log('media cleanup: orphan sweep hold; sweep skipped');
      return { deletedCount: 0, failedCount: 0, scanned: 0, subrequests: 0 };
    }
    const now = this.options.now ?? (() => new Date());
    const cutoff =
      opts.olderThan ?? new Date(now().getTime() - ORPHAN_SWEEP_GRACE_MS);
    const initialBudget =
      opts.subrequestBudget ??
      this.options.subrequestBudget ??
      ORPHAN_SWEEP_SUBREQUEST_BUDGET;
    const budget = { remaining: initialBudget };
    const resumable = Boolean(
      this.storage.getSystemObject && this.storage.putSystemObject
    );
    const cursor = resumable ? await this.readSweepCursor() : null;

    let scanned = 0;
    let deletedCount = 0;
    let failedCount = 0;

    // Resume prefix order: the cursor's prefix, then the rest, wrapping to the
    // start once every prefix is done.
    const prefixes: readonly string[] = cursor
      ? [
          ...ORPHAN_SWEEP_PREFIXES.filter((prefix) => prefix === cursor.prefix),
          ...ORPHAN_SWEEP_PREFIXES.filter((prefix) => prefix !== cursor.prefix),
        ]
      : [...ORPHAN_SWEEP_PREFIXES];

    let wrapped = false;
    let next: { prefix: string; startAfter?: string } | null = cursor;
    let stop: { prefix: string; startAfter?: string } | null = null;

    while (budget.remaining > 0) {
      const prefix = next?.prefix ?? prefixes[0]!;
      const startAfter = next?.startAfter;
      const outcome = await this.sweepPrefix({
        prefix,
        startAfter,
        cutoff,
        budget,
        onScanned: () => {
          scanned++;
        },
        onDeleted: () => {
          deletedCount++;
        },
        onFailed: () => {
          failedCount++;
        },
      });
      if (outcome.kind === 'list_failed') {
        // The adapter could not list this prefix; the run ends where it stands
        // and the stored cursor resumes at the failed prefix next time.
        stop = { prefix, startAfter };
        break;
      }
      if (outcome.kind === 'budget') {
        stop = { prefix, startAfter: outcome.startAfter };
        break;
      }
      // Prefix exhausted: move to the next one, wrapping to the start.
      const index = prefixes.indexOf(prefix);
      if (index + 1 < prefixes.length) {
        next = { prefix: prefixes[index + 1]! };
        continue;
      }
      next = null;
      wrapped = true;
      break;
    }

    // Both prefixes are done: the cursor wraps to the start (the absence of
    // a cursor), whether it got there by finishing this run or by the
    // users/ → communities/ rotation.
    if (next && next.prefix === 'communities/' && !next.startAfter) {
      wrapped = true;
      next = null;
    }

    const subrequests = () => initialBudget - budget.remaining;
    if (stop) {
      await this.writeSweepCursor(stop);
      return { deletedCount, failedCount, scanned, subrequests: subrequests() };
    }
    if (wrapped || next === null) {
      // Both prefixes were walked to the end: the cursor wraps to the start.
      await this.writeSweepCursor(null);
      return { deletedCount, failedCount, scanned, subrequests: subrequests() };
    }
    await this.writeSweepCursor(next);

    return { deletedCount, failedCount, scanned, subrequests: subrequests() };
  }

  /**
   * Walk one prefix from `startAfter` (exclusive) until the run's subrequest
   * budget is spent or the prefix is exhausted. Returns `{kind:'done'}` when
   * the prefix is exhausted, `{kind:'budget', startAfter}` when the budget
   * ran out, and `{kind:'list_failed'}` when the prefix could not be
   * listed.
   *
   * One subrequest is charged per list page, per reference query (<= 45
   * keys, so 2 * ORPHAN_SWEEP_REFERENCE_CHUNK <= 90 bound parameters), and
   * per storage delete. Referenced and fresh objects consume no delete
   * budget, and a fresh-only page costs only its list-page subrequest.
   * Resume is always strictly after the last object the run fully processed
   * (the incoming cursor when nothing was), never before it and never
   * skipping an unscanned object.
   */
  private async sweepPrefix(input: {
    prefix: string;
    startAfter: string | undefined;
    cutoff: Date;
    budget: { remaining: number };
    onScanned: () => void;
    onDeleted: () => void;
    onFailed: () => void;
  }): Promise<
    | { kind: 'done' }
    | { kind: 'budget'; startAfter?: string }
    | { kind: 'list_failed' }
  > {
    let startAfter = input.startAfter;
    // Key after which the run resumes when the budget runs out: the last
    // object the run fully processed. When nothing was processed, the
    // incoming cursor leaves the page for a fresh-budget retry next run.
    let lastProcessed: string | undefined;
    for (;;) {
      if (input.budget.remaining <= 0) {
        return { kind: 'budget', startAfter: lastProcessed ?? startAfter };
      }
      input.budget.remaining -= 1; // one list page = one subrequest
      let page;
      try {
        page = await this.storage.list!({
          prefix: input.prefix,
          startAfter,
          limit: 200,
        });
      } catch {
        // Content-free: no key, no URL, no error text.
        this.log('media cleanup: storage list failed; prefix skipped');
        return { kind: 'list_failed' };
      }

      const candidates = page.entries.filter(
        (entry) => entry.uploaded.getTime() < input.cutoff.getTime()
      );
      let walkIndex = 0;
      while (walkIndex < candidates.length) {
        if (input.budget.remaining <= 0) {
          // Unscanned past-grace objects remain on this page; resume
          // strictly after the last object fully processed.
          return { kind: 'budget', startAfter: lastProcessed ?? startAfter };
        }
        const chunk = candidates.slice(
          walkIndex,
          walkIndex + ORPHAN_SWEEP_REFERENCE_CHUNK
        );
        walkIndex += chunk.length;
        // One reference query per <= 45 keys (D1 binds each key twice).
        input.budget.remaining -= 1;
        let referenced: Set<string>;
        try {
          referenced = await this.findReferencedKeys(
            chunk.map((entry) => entry.key)
          );
        } catch {
          // Content-free: an unreadable candidate set is left for the next
          // run; the failed query was still sent, so it stays charged.
          input.onFailed();
          continue;
        }
        for (const entry of chunk) {
          if (referenced.has(entry.key)) {
            input.onScanned();
            lastProcessed = entry.key;
            continue;
          }
          if (input.budget.remaining <= 0) {
            return {
              kind: 'budget',
              startAfter: lastProcessed ?? startAfter,
            };
          }
          input.budget.remaining -= 1; // one storage delete
          input.onScanned();
          const ok = await this.deleteStorageBestEffort(
            entry.key,
            'owner_deleted'
          );
          if (ok) input.onDeleted();
          else input.onFailed();
          lastProcessed = entry.key;
        }
      }
      // The page is fully walked. If the prefix is exhausted it is done —
      // even when the budget ran out on its last object — so the run moves on
      // (or wraps) instead of pinning the cursor on a gone prefix. Nothing
      // was skipped here: every past-grace object on this page was processed.
      if (!page.truncated || !page.nextStartAfter) return { kind: 'done' };
      // Every past-grace object on this fully walked page was processed (or
      // left on a failed reference query until the cursor wraps), so the
      // resume point is the page's last key, never an earlier page's object:
      // fresh-only pages walked after it must not be repeated next run.
      lastProcessed = page.nextStartAfter;
      // Budget spent on this page: resume exactly after the last object
      // processed (the incoming cursor if none), never before it.
      if (input.budget.remaining <= 0) {
        return { kind: 'budget', startAfter: lastProcessed ?? startAfter };
      }
      // Never spin on a non-advancing startAfter.
      if (page.nextStartAfter === startAfter) return { kind: 'done' };
      startAfter = page.nextStartAfter;
    }
  }

  private async readSweepCursor(): Promise<{
    prefix: string;
    startAfter?: string;
  } | null> {
    const get = this.storage.getSystemObject;
    if (!get) return null;
    try {
      const raw = await get(ORPHAN_SWEEP_CURSOR_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const { prefix, startAfter } = parsed as {
        prefix?: unknown;
        startAfter?: unknown;
      };
      if (typeof prefix !== 'string') return null;
      if (
        !ORPHAN_SWEEP_PREFIXES.includes(prefix as 'communities/' | 'users/')
      ) {
        return null;
      }
      return typeof startAfter === 'string'
        ? { prefix, startAfter }
        : { prefix };
    } catch {
      // Content-free: an unreadable cursor restarts the sweep at the beginning.
      return null;
    }
  }

  private async writeSweepCursor(
    cursor: { prefix: string; startAfter?: string } | null
  ): Promise<void> {
    const put = this.storage.putSystemObject;
    if (!put) return;
    try {
      await put(
        ORPHAN_SWEEP_CURSOR_KEY,
        new TextEncoder().encode(JSON.stringify(cursor))
      );
    } catch {
      // Content-free: the next run simply resumes from the previous position.
      this.log('media cleanup: sweep cursor write failed');
    }
  }

  /**
   * Explicit restore hold for the orphan sweeper. True when either the
   * env/config flag (`sweepPaused`, wired from `ORPHAN_SWEEP_PAUSED=true`)
   * is set, or the storage marker object `system/orphan-sweep-hold` exists.
   * The marker lives outside the swept prefixes, so the sweep never deletes
   * it; the hold can only be lifted by the operator who set it.
   *
   * An unreadable marker is treated as set on purpose: keeping bytes is
   * always safe, deleting possibly-referenced bytes never is. An adapter
   * without `getSystemObject` cannot carry a marker and sweeps normally.
   */
  private async orphanSweepPaused(): Promise<boolean> {
    if (this.options.sweepPaused) return true;
    const get = this.storage.getSystemObject;
    if (!get) return false;
    try {
      return (await get(ORPHAN_SWEEP_HOLD_KEY)) !== null;
    } catch {
      return true;
    }
  }

  /**
   * Keys of `files` rows that still point at any of `keys`, under either the
   * canonical `storage_key` or the legacy `path` spelling. One query per ≤45
   * keys keeps D1 bound parameters bounded (each key binds twice).
   */
  private async findReferencedKeys(
    keys: ReadonlyArray<string>
  ): Promise<Set<string>> {
    const tables = tablesFor(this.connection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = this.connection as any;
    const referenced = new Set<string>();
    for (let i = 0; i < keys.length; i += ORPHAN_SWEEP_REFERENCE_CHUNK) {
      const chunk = keys.slice(i, i + ORPHAN_SWEEP_REFERENCE_CHUNK);
      const rows = (await db
        .select({
          storageKey: tables.files.storageKey,
          path: tables.files.path,
        })
        .from(tables.files)
        .where(
          or(
            inArray(tables.files.storageKey, chunk),
            inArray(tables.files.path, chunk)
          )
        )) as Array<{ storageKey: string | null; path: string }>;
      for (const row of rows) {
        if (row.storageKey) referenced.add(row.storageKey);
        referenced.add(row.path);
      }
    }
    return referenced;
  }
}
