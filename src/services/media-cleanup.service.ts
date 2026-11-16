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

import { and, eq, inArray, lte, notExists, or } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import {
  ORPHAN_SWEEP_CURSOR_KEY,
  type FoundationStorage,
} from './hono-foundation.service.js';

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
 * Named per-run bound so a sweep never enumerates an unbounded keyspace.
 * Sized for a long-lived Node process; Workers pass WORKER_ORPHAN_SWEEP_LIMIT.
 */
export const ORPHAN_SWEEP_LIMIT = 500;

/**
 * Workers Free allows 50 subrequests per invocation. One swept object costs at
 * most one reference SELECT plus one delete, and each prefix costs one list
 * page, so 20 objects keep a whole scheduled run at <= 42 subrequests.
 */
export const WORKER_ORPHAN_SWEEP_LIMIT = 20;

/** Storage prefixes that can hold community/system bytes. */
export const ORPHAN_SWEEP_PREFIXES = ['communities/', 'users/'] as const;

/** Named per-page bound for the batched reference check (D1 parameter limit). */
export const ORPHAN_SWEEP_REFERENCE_CHUNK = 90;

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
   *
   * The per-run cap counts only objects past the grace window, so a long run of
   * live objects never starves garbage collection. Progress is a small cursor
   * object in the storage adapter (`system/orphan-sweep-cursor.json`, outside
   * the swept prefixes): each run resumes after `{prefix, startAfter}`, walks
   * `communities/` then `users/`, and wraps to the start once both are done.
   *
   * One bad object, page, or prefix never aborts the run: each is logged
   * content-free and the sweep continues, so a single unreadable object cannot
   * stop garbage collection for the rest of the keyspace.
   */
  async sweepOrphanObjects(
    opts: { olderThan?: Date; limit?: number } = {}
  ): Promise<SweepResult> {
    if (!this.storage.list || !this.storage.delete) {
      return { deletedCount: 0, failedCount: 0, scanned: 0 };
    }
    if (!(await this.hasAnyFilesRow())) {
      // A filesystem/database restore can recreate storage bytes before the
      // files table knows them; with no file row anywhere, nothing here may
      // be trusted as garbage, so the sweep is skipped entirely.
      this.log('media cleanup: files table is empty; sweep skipped');
      return { deletedCount: 0, failedCount: 0, scanned: 0 };
    }
    const now = this.options.now ?? (() => new Date());
    const cutoff =
      opts.olderThan ?? new Date(now().getTime() - ORPHAN_SWEEP_GRACE_MS);
    const limit = opts.limit ?? ORPHAN_SWEEP_LIMIT;
    const resumable = Boolean(
      this.storage.getSystemObject && this.storage.putSystemObject
    );
    const cursor = resumable ? await this.readSweepCursor() : null;

    let scanned = 0;
    let deletedCount = 0;
    let failedCount = 0;
    const budget = { remaining: limit };

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
          budget.remaining--;
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

    if (stop) {
      await this.writeSweepCursor(stop);
      return { deletedCount, failedCount, scanned };
    }
    if (wrapped || next === null) {
      // Both prefixes were walked to the end: the cursor wraps to the start.
      await this.writeSweepCursor(null);
      return { deletedCount, failedCount, scanned };
    }
    await this.writeSweepCursor(next);

    return { deletedCount, failedCount, scanned };
  }

  /**
   * Walk one prefix from `startAfter` (exclusive) until the run budget is spent
   * or the prefix is exhausted. Returns `{kind:'done'}` when the prefix is
   * exhausted, `{kind:'budget', startAfter}` when the budget ran out after
   * `startAfter`, and `{kind:'list_failed'}` when the prefix could not be
   * listed.
   *
   * Pagination is key-based (`startAfter`), identical to the storage
   * adapter contract, so resumption works the same on R2 and filesystem.
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
    for (;;) {
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

      // Only objects past the grace window count toward the run budget.
      const candidates = page.entries.filter(
        (entry) => entry.uploaded.getTime() < input.cutoff.getTime()
      );
      for (
        let start = 0;
        start < candidates.length;
        start += ORPHAN_SWEEP_REFERENCE_CHUNK
      ) {
        const chunk = candidates.slice(
          start,
          start + ORPHAN_SWEEP_REFERENCE_CHUNK
        );
        let referenced: Set<string>;
        try {
          referenced = await this.findReferencedKeys(
            chunk.map((entry) => entry.key)
          );
        } catch {
          // Content-free: an unreadable candidate set is left for the next run.
          input.onFailed();
          continue;
        }
        for (const entry of chunk) {
          if (input.budget.remaining <= 0) {
            // Resume strictly after the last object actually walked: the
            // previous entry, or the incoming cursor for the first one.
            const index = page.entries.indexOf(entry);
            const resumeAfter =
              index > 0 ? page.entries[index - 1]!.key : startAfter;
            return { kind: 'budget', startAfter: resumeAfter };
          }
          input.onScanned();
          if (referenced.has(entry.key)) continue;
          const ok = await this.deleteStorageBestEffort(
            entry.key,
            'owner_deleted'
          );
          if (ok) input.onDeleted();
          else input.onFailed();
        }
      }

      // The page is fully walked. If the prefix is exhausted it is done —
      // even when the budget ran out on its last object — so the run moves on
      // (or wraps) instead of pinning the cursor on a gone prefix.
      if (!page.truncated || !page.nextStartAfter) return { kind: 'done' };
      if (input.budget.remaining <= 0) {
        const resumeAfter = page.entries[page.entries.length - 1]!.key;
        return { kind: 'budget', startAfter: resumeAfter };
      }
      // No budget was spent (every entry was inside the grace window); keep
      // walking, but never spin on a non-advancing startAfter.
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
   * True when the files table holds at least one row. An empty table is the
   * restore-in-progress state; sweeping then would delete bytes that are
   * about to become referenced again. An unreadable table is treated as
   * empty on purpose: keeping bytes is always safe.
   */
  private async hasAnyFilesRow(): Promise<boolean> {
    const tables = tablesFor(this.connection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = this.connection as any;
    try {
      const rows = await db
        .select({ id: tables.files.id })
        .from(tables.files)
        .limit(1);
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Keys of `files` rows that still point at any of `keys`, under either the
   * canonical `storage_key` or the legacy `path` spelling. One query per ≤90
   * keys keeps D1 bound parameters bounded.
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
