/**
 * Repository for Slice 12 bounded CSV imports (`ImportManifest`, SPEC-V2 §4,
 * §6.9, §7, §8; #123, #197).
 *
 * Equal dual-backend support across PostgreSQL, Node SQLite, and Cloudflare
 * Workers D1:
 * - PostgreSQL uses `db.transaction` with `communities (FOR SHARE) ->
 *   users (FOR SHARE)` lock order before writing `files`, `import_manifests`,
 *   and `audit_entries`.
 * - SQLite uses synchronous `db.transaction`.
 * - Workers D1 uses one atomic `db.batch()` with `INSERT ... SELECT ... WHERE`
 *   guards and <= 100 bound parameters per statement.
 */
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  gte,
  lt,
  notExists,
  sql,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import type {
  ImportManifestKind,
  ImportManifestStatus,
} from '../db/schema/import_manifests.js';
import type {
  AttachmentOwnerType,
  AttachmentRole,
} from '../db/schema/attachments.js';
import type { FoundationUser } from './hono-foundation.repository.js';
import { MediaWritesRepository } from './media-writes.repository.js';
import type {
  ImportResultSummary,
  ImportRowError,
  ImportStoredMappings,
  NormalizedPlaceRow,
  NormalizedSpeakerRow,
  NormalizedStoryRow,
  StoredNormalizedImportData,
} from '../shared/schemas/imports.js';
import { storyVisibilityToPhysical } from '../policy/canonical-state.js';
import {
  isForeignKeyConstraintError,
  isNotNullConstraintError,
} from './community-writes.repository.js';
import {
  COMMIT_CHILD_ROW_CHUNK,
  COMMIT_FILE_ACTIVATE_CHUNK,
  COMMIT_PLACE_INSERT_CHUNK,
  COMMIT_SPEAKER_INSERT_CHUNK,
  D1_MAX_BOUND_PARAMS_PER_STATEMENT,
  NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
  PLACE_INSERT_SQL_BYTES,
  SPEAKER_INSERT_SQL_BYTES,
  chunkImportItemsByBudget,
  chunkRowsByBoundParamBudget,
  computeImportResultSummary,
  estimatePlaceRowBytes,
  estimateRelatedRecordBytes,
  estimateSpeakerRowBytes,
} from '../shared/utils/import-commit-plan.js';
import {
  lockFileRowsForCleanup,
  toFileByteCleanups,
  type FileByteCleanup,
} from '../services/media-cleanup.service.js';
import { validateContentFreeAuditEntry } from '../shared/utils/audit-entry.js';

const D1_FILE_LOOKUP_CHUNK = 80;
const D1_ENTITY_LOOKUP_CHUNK = 80;
const READABLE_PRIVACY_LEVELS = ['public', 'members_only', 'editors'] as const;

function isUniqueConstraintError(
  err: unknown,
  seen: Set<unknown> = new Set()
): boolean {
  if (!err || typeof err !== 'object' || seen.has(err)) return false;
  seen.add(err);
  const { code, message, cause } = err as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return true;
  }
  if (
    typeof message === 'string' &&
    message.includes('UNIQUE constraint failed')
  ) {
    return true;
  }
  return cause ? isUniqueConstraintError(cause, seen) : false;
}

function isCheckConstraintError(
  err: unknown,
  seen: Set<unknown> = new Set()
): boolean {
  if (!err || typeof err !== 'object' || seen.has(err)) return false;
  seen.add(err);
  const { code, message, cause } = err as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (code === '23514' || code === 'SQLITE_CONSTRAINT_CHECK') {
    return true;
  }
  if (
    typeof message === 'string' &&
    message.includes('CHECK constraint failed')
  ) {
    return true;
  }
  return cause ? isCheckConstraintError(cause, seen) : false;
}

class RollbackReferenceError extends Error {
  constructor() {
    super('Import reference invalid during commit');
    this.name = 'RollbackReferenceError';
  }
}

export interface StagedFileVerificationRecord {
  id: string;
  storageKey: string;
  checksum: string | null;
  byteSize: number;
  isActive: boolean;
  culturalRestrictions: unknown;
}

export interface StagedFileInsertInput {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
}

export interface CreatePreviewManifestInput {
  communityId: number;
  actorId: number;
  kind: ImportManifestKind;
  sourceFileName: string;
  sourceFile: StagedFileInsertInput;
  stagedMediaFiles: StagedFileInsertInput[];
  mappings: ImportStoredMappings;
  normalizedRows: StoredNormalizedImportData;
  rowCount: number;
  rowErrors: ImportRowError[];
  stagedFileIds: string[];
  now: Date;
  dailyLimitWindow: { startMs: number; endMs: number } | null;
}

export interface ImportManifestRowRecord {
  id: number;
  communityId: number;
  kind: ImportManifestKind;
  status: ImportManifestStatus;
  createdBy: number | null;
  sourceFileName: string | null;
  sourceFileId: string;
  mappings: ImportStoredMappings;
  normalizedRows: StoredNormalizedImportData;
  rowCount: number;
  rowErrors: ImportRowError[];
  stagedFileIds: string[];
  resultSummary: ImportResultSummary | null;
  committedAt: number | null;
  createdAt: number;
}

export type CreatePreviewOutcome =
  | { status: 'created'; manifest: ImportManifestRowRecord }
  | { status: 'forbidden' }
  | { status: 'daily_limit' };

export type DiscardManifestOutcome =
  | {
      status: 'discarded';
      manifest: ImportManifestRowRecord;
      removedFiles: FileByteCleanup[];
    }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'conflict' };

export type CommitManifestOutcome =
  | { status: 'committed'; manifest: ImportManifestRowRecord }
  | { status: 'already_committed'; manifest: ImportManifestRowRecord }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'conflict'; manifest: ImportManifestRowRecord }
  | { status: 'daily_limit' }
  | { status: 'failed_reference' }
  | { status: 'failed_rolled_back' }
  | { status: 'uncertain' };

export type FailManifestOutcome =
  | {
      status: 'failed';
      manifest: ImportManifestRowRecord;
      removedFiles: FileByteCleanup[];
    }
  | { status: 'already_committed'; manifest: ImportManifestRowRecord }
  | { status: 'already_terminal'; manifest: ImportManifestRowRecord }
  | { status: 'not_found' }
  | { status: 'forbidden' };

export interface CommunityImportContext {
  places: Array<{ id: number; name: string }>;
  speakers: Array<{ id: number; name: string }>;
  stories: Array<{ id: number; title: string }>;
}

function parseJsonColumn<T>(raw: unknown): T {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw as T;
}

function mapManifestRow(row: {
  id: number;
  communityId: number;
  kind: string;
  status: string;
  createdBy: number | null;
  sourceFileName: string | null;
  sourceFileId: string;
  mappings: unknown;
  normalizedRows: unknown;
  rowCount: number;
  rowErrors: unknown;
  stagedFileIds: unknown;
  resultSummary: unknown;
  committedAt: number | null;
  createdAt: number;
}): ImportManifestRowRecord {
  return {
    id: Number(row.id),
    communityId: Number(row.communityId),
    kind: row.kind as ImportManifestKind,
    status: row.status as ImportManifestStatus,
    createdBy: row.createdBy === null ? null : Number(row.createdBy),
    sourceFileName: row.sourceFileName ?? null,
    sourceFileId: row.sourceFileId,
    mappings: parseJsonColumn<ImportStoredMappings>(row.mappings),
    normalizedRows: parseJsonColumn<StoredNormalizedImportData>(
      row.normalizedRows
    ),
    rowCount: Number(row.rowCount),
    rowErrors: parseJsonColumn<ImportRowError[]>(row.rowErrors),
    stagedFileIds: parseJsonColumn<string[]>(row.stagedFileIds),
    resultSummary:
      row.resultSummary === null || row.resultSummary === undefined
        ? null
        : parseJsonColumn<ImportResultSummary>(row.resultSummary),
    committedAt: row.committedAt === null ? null : Number(row.committedAt),
    createdAt: Number(row.createdAt),
  };
}

function buildImportAuditEntry(input: {
  communityId: number;
  actorId: number;
  action: 'import.preview' | 'import.discard' | 'import.commit';
  manifestId: number;
  outcome: 'success' | 'denied' | 'failed';
}) {
  return validateContentFreeAuditEntry({
    communityId: input.communityId,
    actorId: input.actorId,
    action: input.action,
    resourceType: 'import_manifest',
    resourceIds: [input.manifestId],
    outcome: input.outcome,
    ipAddress: null,
    userAgent: null,
  });
}

export class ImportsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;
  private readonly mediaRepository: MediaWritesRepository;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
    this.mediaRepository = new MediaWritesRepository(connection);
  }

  private tableColumnBound(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: any
  ): number {
    return Math.max(1, Object.keys(getTableColumns(table)).length);
  }

  hasD1Batch(): boolean {
    return typeof this.db?.batch === 'function';
  }

  async activeCommunityExists(
    communityId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db
  ): Promise<boolean> {
    const rows = await executor
      .select({ id: this.tables.communities.id })
      .from(this.tables.communities)
      .where(
        and(
          eq(this.tables.communities.id, communityId),
          eq(this.tables.communities.isActive, true)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  async hasCommittedImportInWindow(
    startMs: number,
    endMs: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db
  ): Promise<boolean> {
    const rows = await executor
      .select({ id: this.tables.importManifests.id })
      .from(this.tables.importManifests)
      .where(
        and(
          eq(this.tables.importManifests.status, 'committed'),
          gte(this.tables.importManifests.committedAt, startMs),
          lt(this.tables.importManifests.committedAt, endMs)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  async loadCommunityImportContext(
    communityId: number
  ): Promise<CommunityImportContext> {
    const [places, speakers, stories] = await Promise.all([
      this.db
        .select({ id: this.tables.places.id, name: this.tables.places.name })
        .from(this.tables.places)
        .where(
          and(
            eq(this.tables.places.communityId, communityId),
            eq(this.tables.places.isRestricted, false)
          )
        ),
      this.db
        .select({
          id: this.tables.speakers.id,
          name: this.tables.speakers.name,
        })
        .from(this.tables.speakers)
        .where(eq(this.tables.speakers.communityId, communityId)),
      this.db
        .select({
          id: this.tables.stories.id,
          title: this.tables.stories.title,
        })
        .from(this.tables.stories)
        .where(
          and(
            eq(this.tables.stories.communityId, communityId),
            eq(this.tables.stories.isRestricted, false),
            inArray(this.tables.stories.privacyLevel, [
              ...READABLE_PRIVACY_LEVELS,
            ])
          )
        ),
    ]);
    return {
      places: places.map((p: { id: number; name: string }) => ({
        id: Number(p.id),
        name: p.name,
      })),
      speakers: speakers.map((s: { id: number; name: string }) => ({
        id: Number(s.id),
        name: s.name,
      })),
      stories: stories.map((st: { id: number; title: string }) => ({
        id: Number(st.id),
        title: st.title,
      })),
    };
  }

  async findCommunityFilesByIds(
    communityId: number,
    fileIds: ReadonlyArray<string>
  ): Promise<
    Map<
      string,
      {
        id: string;
        mimeType: string;
        originalName: string;
        uploadedBy: number | null;
      }
    >
  > {
    const unique = Array.from(new Set(fileIds));
    const map = new Map<
      string,
      {
        id: string;
        mimeType: string;
        originalName: string;
        uploadedBy: number | null;
      }
    >();
    for (let i = 0; i < unique.length; i += D1_FILE_LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + D1_FILE_LOOKUP_CHUNK);
      const rows = await this.db
        .select({
          id: this.tables.files.id,
          mimeType: this.tables.files.mimeType,
          originalName: this.tables.files.originalName,
          uploadedBy: this.tables.files.uploadedBy,
        })
        .from(this.tables.files)
        .where(
          and(
            inArray(this.tables.files.id, chunk),
            eq(this.tables.files.communityId, communityId),
            eq(this.tables.files.isActive, true),
            isNull(this.tables.files.culturalRestrictions)
          )
        );
      for (const row of rows as Array<{
        id: string;
        mimeType: string;
        originalName: string;
        uploadedBy: number | null;
      }>) {
        map.set(row.id, {
          id: row.id,
          mimeType: row.mimeType,
          originalName: row.originalName,
          uploadedBy: row.uploadedBy === null ? null : Number(row.uploadedBy),
        });
      }
    }
    return map;
  }

  async findStagedFilesByIds(
    communityId: number,
    fileIds: ReadonlyArray<string>
  ): Promise<Map<string, StagedFileVerificationRecord>> {
    const unique = Array.from(new Set(fileIds)).sort();
    const map = new Map<string, StagedFileVerificationRecord>();
    for (let i = 0; i < unique.length; i += D1_FILE_LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + D1_FILE_LOOKUP_CHUNK);
      const rows = await this.db
        .select({
          id: this.tables.files.id,
          storageKey: this.tables.files.storageKey,
          path: this.tables.files.path,
          checksum: this.tables.files.checksum,
          byteSize: this.tables.files.byteSize,
          size: this.tables.files.size,
          isActive: this.tables.files.isActive,
          culturalRestrictions: this.tables.files.culturalRestrictions,
        })
        .from(this.tables.files)
        .where(
          and(
            inArray(this.tables.files.id, chunk),
            eq(this.tables.files.communityId, communityId)
          )
        );
      for (const row of rows as Array<{
        id: string;
        storageKey: string | null;
        path: string;
        checksum: string | null;
        byteSize: number | null;
        size: number;
        isActive: boolean | number;
        culturalRestrictions: unknown;
      }>) {
        map.set(row.id, {
          id: row.id,
          storageKey: row.storageKey ?? row.path,
          checksum: row.checksum ?? null,
          byteSize: Number(row.byteSize ?? row.size),
          isActive: row.isActive === true || row.isActive === 1,
          culturalRestrictions: row.culturalRestrictions ?? null,
        });
      }
    }
    return map;
  }

  private manifestSelectColumns() {
    return {
      id: this.tables.importManifests.id,
      communityId: this.tables.importManifests.communityId,
      kind: this.tables.importManifests.kind,
      status: this.tables.importManifests.status,
      createdBy: this.tables.importManifests.createdBy,
      sourceFileName: this.tables.importManifests.sourceFileName,
      sourceFileId: this.tables.importManifests.sourceFileId,
      mappings: this.tables.importManifests.mappings,
      normalizedRows: this.tables.importManifests.normalizedRows,
      rowCount: this.tables.importManifests.rowCount,
      rowErrors: this.tables.importManifests.rowErrors,
      stagedFileIds: this.tables.importManifests.stagedFileIds,
      resultSummary: this.tables.importManifests.resultSummary,
      committedAt: this.tables.importManifests.committedAt,
      createdAt: this.tables.importManifests.createdAt,
    };
  }

  async createPreviewManifest(
    input: CreatePreviewManifestInput
  ): Promise<CreatePreviewOutcome> {
    const now = input.now;
    const nowMs = now.getTime();
    const isPg = dialectOf(this.connection) === 'postgresql';
    const allFiles: StagedFileInsertInput[] = [
      input.sourceFile,
      ...input.stagedMediaFiles,
    ];

    if (this.hasD1Batch()) {
      const guards = [
        eq(this.tables.communities.id, input.communityId),
        eq(this.tables.communities.isActive, true),
        sql`EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = ${input.actorId}
            AND u.community_id = ${input.communityId}
            AND u.is_active = 1
            AND u.role IN ('editor', 'admin')
        )`,
      ];
      if (input.dailyLimitWindow) {
        guards.push(
          sql`NOT EXISTS (
            SELECT 1 FROM import_manifests im
            WHERE im.status = 'committed'
              AND im.committed_at >= ${input.dailyLimitWindow.startMs}
              AND im.committed_at < ${input.dailyLimitWindow.endMs}
          )`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statements: any[] = allFiles.map((file) => {
        const fileUrl = `/v2/media/${file.id}`;
        return this.db.insert(this.tables.files).select(
          this.db
            .select({
              id: sql`${file.id}`.as('id'),
              filename: sql`${file.id}`.as('filename'),
              originalName: sql`${file.originalName}`.as('original_name'),
              path: sql`${file.storageKey}`.as('path'),
              storageKey: sql`${file.storageKey}`.as('storage_key'),
              url: sql`${fileUrl}`.as('url'),
              mimeType: sql`${file.mimeType}`.as('mime_type'),
              size: sql`${file.byteSize}`.as('size'),
              byteSize: sql`${file.byteSize}`.as('byte_size'),
              checksum: sql`${file.checksum}`.as('checksum'),
              communityId: this.tables.communities.id,
              uploadedBy: sql`${input.actorId}`.as('uploaded_by'),
              metadata: sql`NULL`.as('metadata'),
              culturalRestrictions: sql`NULL`.as('cultural_restrictions'),
              isActive: sql`0`.as('is_active'),
              createdAt: sql`${nowMs}`.as('created_at'),
              updatedAt: sql`${nowMs}`.as('updated_at'),
            })
            .from(this.tables.communities)
            .where(and(...guards))
        );
      });

      const mappingsJson = JSON.stringify(input.mappings);
      const normalizedJson = JSON.stringify(input.normalizedRows);
      const rowErrorsJson = JSON.stringify(input.rowErrors);
      const stagedIdsJson = JSON.stringify(input.stagedFileIds);

      const manifestInsertIdx = statements.length;
      statements.push(
        this.db
          .insert(this.tables.importManifests)
          .select(
            this.db
              .select({
                id: sql`NULL`.as('id'),
                communityId: this.tables.files.communityId,
                kind: sql`${input.kind}`.as('kind'),
                status: sql`${'previewed'}`.as('status'),
                createdBy: sql`${input.actorId}`.as('created_by'),
                sourceFileName: sql`${input.sourceFileName}`.as(
                  'source_file_name'
                ),
                sourceFileId: this.tables.files.id,
                mappings: sql`${mappingsJson}`.as('mappings'),
                normalizedRows: sql`${normalizedJson}`.as('normalized_rows'),
                rowCount: sql`${input.rowCount}`.as('row_count'),
                rowErrors: sql`${rowErrorsJson}`.as('row_errors'),
                stagedFileIds: sql`${stagedIdsJson}`.as('staged_file_ids'),
                resultSummary: sql`NULL`.as('result_summary'),
                committedAt: sql`NULL`.as('committed_at'),
                createdAt: sql`${nowMs}`.as('created_at'),
              })
              .from(this.tables.files)
              .where(
                and(
                  eq(this.tables.files.id, input.sourceFile.id),
                  eq(this.tables.files.communityId, input.communityId)
                )
              )
          )
          .returning(this.manifestSelectColumns())
      );

      statements.push(
        this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: this.tables.importManifests.communityId,
              actorId: sql`${input.actorId}`.as('actor_id'),
              action: sql`${'import.preview'}`.as('action'),
              resourceType: sql`${'import_manifest'}`.as('resource_type'),
              resourceIds:
                sql`json_array(${this.tables.importManifests.id})`.as(
                  'resource_ids'
                ),
              outcome: sql`${'success'}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.importManifests)
            .where(
              and(
                eq(
                  this.tables.importManifests.sourceFileId,
                  input.sourceFile.id
                ),
                eq(this.tables.importManifests.communityId, input.communityId)
              )
            )
        )
      );

      const batchResults = await this.db.batch(statements);
      const insertedManifestRows = batchResults[manifestInsertIdx];
      const inserted = Array.isArray(insertedManifestRows)
        ? insertedManifestRows[0]
        : undefined;
      if (!inserted) {
        if (input.dailyLimitWindow) {
          const hitDaily = await this.hasCommittedImportInWindow(
            input.dailyLimitWindow.startMs,
            input.dailyLimitWindow.endMs
          );
          if (hitDaily) {
            return { status: 'daily_limit' };
          }
        }
        return { status: 'forbidden' };
      }
      return {
        status: 'created',
        manifest: mapManifestRow(inserted),
      };
    }

    const insertFilesValues = allFiles.map((file) => ({
      id: file.id,
      filename: file.id,
      originalName: file.originalName,
      path: file.storageKey,
      storageKey: file.storageKey,
      url: `/v2/media/${file.id}`,
      mimeType: file.mimeType,
      size: file.byteSize,
      byteSize: file.byteSize,
      checksum: file.checksum,
      communityId: input.communityId,
      uploadedBy: input.actorId,
      metadata: null,
      culturalRestrictions: null,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    }));

    if (isPg) {
      return this.db.transaction(async (tx: typeof this.db) => {
        // Canonical PG lock order: communities -> users -> files -> import_manifests -> audit_entries
        const [comm] = await tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, input.communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .for('share');
        if (!comm) return { status: 'forbidden' };

        const [actorRow] = await tx
          .select({ id: this.tables.users.id })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actorId),
              eq(this.tables.users.communityId, input.communityId),
              eq(this.tables.users.isActive, true),
              inArray(this.tables.users.role, ['editor', 'admin'])
            )
          )
          .for('share');
        if (!actorRow) return { status: 'forbidden' };

        if (input.dailyLimitWindow) {
          const hitDaily = await this.hasCommittedImportInWindow(
            input.dailyLimitWindow.startMs,
            input.dailyLimitWindow.endMs,
            tx
          );
          if (hitDaily) return { status: 'daily_limit' };
        }

        if (insertFilesValues.length > 0) {
          const sortedFiles = [...insertFilesValues].sort((a, b) =>
            a.id.localeCompare(b.id)
          );
          for (const chunk of chunkRowsByBoundParamBudget(
            sortedFiles,
            NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
            this.tableColumnBound(this.tables.files)
          )) {
            await tx.insert(this.tables.files).values(chunk);
          }
        }

        const [inserted] = await tx
          .insert(this.tables.importManifests)
          .values({
            communityId: input.communityId,
            kind: input.kind,
            status: 'previewed',
            createdBy: input.actorId,
            sourceFileName: input.sourceFileName,
            sourceFileId: input.sourceFile.id,
            mappings: input.mappings as unknown as Record<string, unknown>,
            normalizedRows: input.normalizedRows as unknown as Record<
              string,
              unknown
            >,
            rowCount: input.rowCount,
            rowErrors: input.rowErrors as unknown as Array<
              Record<string, unknown>
            >,
            stagedFileIds: input.stagedFileIds,
            resultSummary: null,
            committedAt: null,
            createdAt: nowMs,
          })
          .returning(this.manifestSelectColumns());

        const audit = buildImportAuditEntry({
          communityId: input.communityId,
          actorId: input.actorId,
          action: 'import.preview',
          manifestId: Number(inserted.id),
          outcome: 'success',
        });
        await tx.insert(this.tables.auditEntries).values({
          ...audit,
          createdAt: now,
        });

        return { status: 'created', manifest: mapManifestRow(inserted) };
      });
    }

    return this.db.transaction((tx: typeof this.db) => {
      const comm = tx
        .select({ id: this.tables.communities.id })
        .from(this.tables.communities)
        .where(
          and(
            eq(this.tables.communities.id, input.communityId),
            eq(this.tables.communities.isActive, true)
          )
        )
        .limit(1)
        .all()[0];
      if (!comm) return { status: 'forbidden' };

      const actorRow = tx
        .select({ id: this.tables.users.id })
        .from(this.tables.users)
        .where(
          and(
            eq(this.tables.users.id, input.actorId),
            eq(this.tables.users.communityId, input.communityId),
            eq(this.tables.users.isActive, true),
            inArray(this.tables.users.role, ['editor', 'admin'])
          )
        )
        .limit(1)
        .all()[0];
      if (!actorRow) return { status: 'forbidden' };

      if (input.dailyLimitWindow) {
        const hitDaily = tx
          .select({ id: this.tables.importManifests.id })
          .from(this.tables.importManifests)
          .where(
            and(
              eq(this.tables.importManifests.status, 'committed'),
              gte(
                this.tables.importManifests.committedAt,
                input.dailyLimitWindow.startMs
              ),
              lt(
                this.tables.importManifests.committedAt,
                input.dailyLimitWindow.endMs
              )
            )
          )
          .limit(1)
          .all();
        if (hitDaily.length > 0) return { status: 'daily_limit' };
      }

      if (insertFilesValues.length > 0) {
        for (const chunk of chunkRowsByBoundParamBudget(
          insertFilesValues,
          NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
          this.tableColumnBound(this.tables.files)
        )) {
          tx.insert(this.tables.files).values(chunk).run();
        }
      }

      const inserted = tx
        .insert(this.tables.importManifests)
        .values({
          communityId: input.communityId,
          kind: input.kind,
          status: 'previewed',
          createdBy: input.actorId,
          sourceFileName: input.sourceFileName,
          sourceFileId: input.sourceFile.id,
          mappings: input.mappings as unknown as Record<string, unknown>,
          normalizedRows: input.normalizedRows as unknown as Record<
            string,
            unknown
          >,
          rowCount: input.rowCount,
          rowErrors: input.rowErrors as unknown as Array<
            Record<string, unknown>
          >,
          stagedFileIds: input.stagedFileIds,
          resultSummary: null,
          committedAt: null,
          createdAt: nowMs,
        })
        .returning(this.manifestSelectColumns())
        .all()[0];

      const audit = buildImportAuditEntry({
        communityId: input.communityId,
        actorId: input.actorId,
        action: 'import.preview',
        manifestId: Number(inserted.id),
        outcome: 'success',
      });
      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();

      return { status: 'created', manifest: mapManifestRow(inserted) };
    });
  }

  async listManifests(
    communityId: number,
    options: {
      limit: number;
      offset: number;
      status?: ImportManifestStatus;
      kind?: ImportManifestKind;
    }
  ): Promise<{ rows: ImportManifestRowRecord[]; total: number }> {
    const conditions = [
      eq(this.tables.importManifests.communityId, communityId),
    ];
    if (options.status) {
      conditions.push(eq(this.tables.importManifests.status, options.status));
    }
    if (options.kind) {
      conditions.push(eq(this.tables.importManifests.kind, options.kind));
    }
    const whereClause = and(...conditions);

    const [countRow] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.tables.importManifests)
      .where(whereClause);
    const total = Number(countRow?.count ?? 0);

    const rows = await this.db
      .select(this.manifestSelectColumns())
      .from(this.tables.importManifests)
      .where(whereClause)
      .orderBy(
        desc(this.tables.importManifests.createdAt),
        desc(this.tables.importManifests.id)
      )
      .limit(options.limit)
      .offset(options.offset);

    return {
      rows: rows.map(mapManifestRow),
      total,
    };
  }

  async getManifestById(
    communityId: number,
    manifestId: number
  ): Promise<ImportManifestRowRecord | null> {
    const rows = await this.db
      .select(this.manifestSelectColumns())
      .from(this.tables.importManifests)
      .where(
        and(
          eq(this.tables.importManifests.id, manifestId),
          eq(this.tables.importManifests.communityId, communityId)
        )
      )
      .limit(1);
    return rows[0] ? mapManifestRow(rows[0]) : null;
  }

  async discardManifest(input: {
    communityId: number;
    actorId: number;
    actorRole: 'editor' | 'admin';
    manifestId: number;
    now: Date;
  }): Promise<DiscardManifestOutcome> {
    const now = input.now;
    const nowMs = now.getTime();
    const isPg = dialectOf(this.connection) === 'postgresql';
    const audit = buildImportAuditEntry({
      communityId: input.communityId,
      actorId: input.actorId,
      action: 'import.discard',
      manifestId: input.manifestId,
      outcome: 'success',
    });

    if (this.hasD1Batch()) {
      const existing = await this.getManifestById(
        input.communityId,
        input.manifestId
      );
      if (!existing) return { status: 'not_found' };
      if (input.actorRole !== 'admin' && existing.createdBy !== input.actorId) {
        return { status: 'forbidden' };
      }
      if (existing.status !== 'previewed') {
        return { status: 'conflict' };
      }

      const activeCommunityGuard = sql`EXISTS (
        SELECT 1 FROM communities c
        WHERE c.id = ${input.communityId} AND c.is_active = 1
      )`;
      const activeActorGuard = sql`EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = ${input.actorId}
          AND u.community_id = ${input.communityId}
          AND u.is_active = 1
          AND u.role IN ('editor', 'admin')
      )`;
      const ownerOrAdminGuard = sql`EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = ${input.actorId}
          AND u.community_id = ${input.communityId}
          AND u.is_active = 1
          AND (
            u.role = 'admin'
            OR (u.role = 'editor' AND ${this.tables.importManifests.createdBy} = ${input.actorId})
          )
      )`;
      const previewedManifestGuard = sql`EXISTS (
        SELECT 1 FROM import_manifests im
        WHERE im.id = ${input.manifestId}
          AND im.community_id = ${input.communityId}
          AND im.status = 'previewed'
          AND EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = ${input.actorId}
              AND u.community_id = ${input.communityId}
              AND u.is_active = 1
              AND (
                u.role = 'admin'
                OR (u.role = 'editor' AND im.created_by = ${input.actorId})
              )
          )
          AND ${activeCommunityGuard}
      )`;

      // Run guarded staged-file deletes + guarded audit insert BEFORE flipping
      // status='discarded' inside the single atomic D1 batch, so a losing
      // concurrent discard sees status!='previewed' in the outer WHERE or fails
      // the final conditional UPDATE cleanly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statements: any[] = [];
      const stagedIds = Array.from(new Set(existing.stagedFileIds)).filter(
        (id) => id !== existing.sourceFileId
      );
      const deleteBatchIndexes: number[] = [];
      for (let i = 0; i < stagedIds.length; i += 70) {
        const chunk = stagedIds.slice(i, i + 70);
        deleteBatchIndexes.push(statements.length);
        statements.push(
          this.db
            .delete(this.tables.files)
            .where(
              and(
                inArray(this.tables.files.id, chunk),
                eq(this.tables.files.communityId, input.communityId),
                eq(this.tables.files.isActive, false),
                previewedManifestGuard,
                notExists(
                  this.db
                    .select({ id: this.tables.attachments.id })
                    .from(this.tables.attachments)
                    .where(
                      eq(this.tables.attachments.fileId, this.tables.files.id)
                    )
                ),
                notExists(
                  this.db
                    .select({ id: this.tables.importManifests.id })
                    .from(this.tables.importManifests)
                    .where(
                      eq(
                        this.tables.importManifests.sourceFileId,
                        this.tables.files.id
                      )
                    )
                )
              )
            )
            .returning({
              id: this.tables.files.id,
              storageKey: this.tables.files.storageKey,
              path: this.tables.files.path,
            })
        );
      }

      statements.push(
        this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: this.tables.importManifests.communityId,
              actorId: sql`${audit.actorId}`.as('actor_id'),
              action: sql`${audit.action}`.as('action'),
              resourceType: sql`${audit.resourceType}`.as('resource_type'),
              resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
                'resource_ids'
              ),
              outcome: sql`${audit.outcome}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.importManifests)
            .where(
              and(
                eq(this.tables.importManifests.id, input.manifestId),
                eq(this.tables.importManifests.communityId, input.communityId),
                eq(this.tables.importManifests.status, 'previewed'),
                ownerOrAdminGuard,
                activeActorGuard,
                activeCommunityGuard
              )
            )
        )
      );

      const updateIdx = statements.length;
      statements.push(
        this.db
          .update(this.tables.importManifests)
          .set({ status: 'discarded' })
          .where(
            and(
              eq(this.tables.importManifests.id, input.manifestId),
              eq(this.tables.importManifests.communityId, input.communityId),
              eq(this.tables.importManifests.status, 'previewed'),
              ownerOrAdminGuard,
              activeActorGuard,
              activeCommunityGuard
            )
          )
          .returning(this.manifestSelectColumns())
      );

      const results = await this.db.batch(statements);
      const updatedRows = results[updateIdx];
      const updated = Array.isArray(updatedRows) ? updatedRows[0] : undefined;
      if (!updated) {
        const commActive = await this.activeCommunityExists(input.communityId);
        if (!commActive) return { status: 'forbidden' };
        const actorRows = await this.db
          .select({ role: this.tables.users.role })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actorId),
              eq(this.tables.users.communityId, input.communityId),
              eq(this.tables.users.isActive, true),
              inArray(this.tables.users.role, ['editor', 'admin'])
            )
          )
          .limit(1);
        const liveActor = actorRows[0] as { role: string } | undefined;
        if (!liveActor) return { status: 'forbidden' };
        const after = await this.getManifestById(
          input.communityId,
          input.manifestId
        );
        if (!after) return { status: 'not_found' };
        if (liveActor.role !== 'admin' && after.createdBy !== input.actorId) {
          return { status: 'forbidden' };
        }
        return { status: 'conflict' };
      }

      const deletedFileRows: Array<{
        id: string;
        storageKey?: string | null;
        storage_key?: string | null;
        path: string;
      }> = [];
      for (const idx of deleteBatchIndexes) {
        if (Array.isArray(results[idx])) {
          deletedFileRows.push(...results[idx]);
        }
      }

      return {
        status: 'discarded',
        manifest: mapManifestRow(updated),
        removedFiles: toFileByteCleanups(deletedFileRows),
      };
    }

    if (isPg) {
      return this.db.transaction(async (tx: typeof this.db) => {
        // Canonical PG lock order: communities (FOR SHARE) -> users (FOR SHARE) -> import_manifests (FOR UPDATE) -> files (FOR UPDATE sorted)
        const [comm] = await tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, input.communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .for('share');
        if (!comm) return { status: 'forbidden' };

        const [actorRow] = await tx
          .select({ role: this.tables.users.role })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actorId),
              eq(this.tables.users.communityId, input.communityId),
              eq(this.tables.users.isActive, true),
              inArray(this.tables.users.role, ['editor', 'admin'])
            )
          )
          .for('share');
        if (!actorRow) return { status: 'forbidden' };

        const [manifestRow] = await tx
          .select(this.manifestSelectColumns())
          .from(this.tables.importManifests)
          .where(
            and(
              eq(this.tables.importManifests.id, input.manifestId),
              eq(this.tables.importManifests.communityId, input.communityId)
            )
          )
          .for('update');
        if (!manifestRow) return { status: 'not_found' };

        if (
          actorRow.role !== 'admin' &&
          manifestRow.createdBy !== input.actorId
        ) {
          return { status: 'forbidden' };
        }
        if (manifestRow.status !== 'previewed') {
          return { status: 'conflict' };
        }

        const [updated] = await tx
          .update(this.tables.importManifests)
          .set({ status: 'discarded' })
          .where(
            and(
              eq(this.tables.importManifests.id, input.manifestId),
              eq(this.tables.importManifests.communityId, input.communityId),
              eq(this.tables.importManifests.status, 'previewed')
            )
          )
          .returning(this.manifestSelectColumns());
        if (!updated) return { status: 'conflict' };

        const stagedIds = Array.from(
          new Set(parseJsonColumn<string[]>(manifestRow.stagedFileIds))
        ).filter((id) => id !== manifestRow.sourceFileId);
        const lockedIds = await lockFileRowsForCleanup(
          tx,
          this.connection,
          [...stagedIds].sort()
        );
        const removedRows: Array<{
          id: string;
          storageKey: string | null;
          path: string;
        }> = [];
        for (let i = 0; i < lockedIds.length; i += 80) {
          const chunk = lockedIds.slice(i, i + 80);
          const deleted = await tx
            .delete(this.tables.files)
            .where(
              and(
                inArray(this.tables.files.id, chunk),
                eq(this.tables.files.communityId, input.communityId),
                eq(this.tables.files.isActive, false),
                notExists(
                  tx
                    .select({ id: this.tables.attachments.id })
                    .from(this.tables.attachments)
                    .where(
                      eq(this.tables.attachments.fileId, this.tables.files.id)
                    )
                ),
                notExists(
                  tx
                    .select({ id: this.tables.importManifests.id })
                    .from(this.tables.importManifests)
                    .where(
                      eq(
                        this.tables.importManifests.sourceFileId,
                        this.tables.files.id
                      )
                    )
                )
              )
            )
            .returning({
              id: this.tables.files.id,
              storageKey: this.tables.files.storageKey,
              path: this.tables.files.path,
            });
          removedRows.push(...deleted);
        }

        await tx.insert(this.tables.auditEntries).values({
          ...audit,
          createdAt: now,
        });

        return {
          status: 'discarded',
          manifest: mapManifestRow(updated),
          removedFiles: toFileByteCleanups(removedRows),
        };
      });
    }

    return this.db.transaction((tx: typeof this.db) => {
      const comm = tx
        .select({ id: this.tables.communities.id })
        .from(this.tables.communities)
        .where(
          and(
            eq(this.tables.communities.id, input.communityId),
            eq(this.tables.communities.isActive, true)
          )
        )
        .limit(1)
        .all()[0];
      if (!comm) return { status: 'forbidden' };

      const actorRow = tx
        .select({ role: this.tables.users.role })
        .from(this.tables.users)
        .where(
          and(
            eq(this.tables.users.id, input.actorId),
            eq(this.tables.users.communityId, input.communityId),
            eq(this.tables.users.isActive, true),
            inArray(this.tables.users.role, ['editor', 'admin'])
          )
        )
        .limit(1)
        .all()[0];
      if (!actorRow) return { status: 'forbidden' };

      const manifestRow = tx
        .select(this.manifestSelectColumns())
        .from(this.tables.importManifests)
        .where(
          and(
            eq(this.tables.importManifests.id, input.manifestId),
            eq(this.tables.importManifests.communityId, input.communityId)
          )
        )
        .limit(1)
        .all()[0];
      if (!manifestRow) return { status: 'not_found' };

      if (
        actorRow.role !== 'admin' &&
        manifestRow.createdBy !== input.actorId
      ) {
        return { status: 'forbidden' };
      }
      if (manifestRow.status !== 'previewed') {
        return { status: 'conflict' };
      }

      const updated = tx
        .update(this.tables.importManifests)
        .set({ status: 'discarded' })
        .where(
          and(
            eq(this.tables.importManifests.id, input.manifestId),
            eq(this.tables.importManifests.communityId, input.communityId),
            eq(this.tables.importManifests.status, 'previewed')
          )
        )
        .returning(this.manifestSelectColumns())
        .all()[0];
      if (!updated) return { status: 'conflict' };

      const stagedIds = Array.from(
        new Set(parseJsonColumn<string[]>(manifestRow.stagedFileIds))
      ).filter((id) => id !== manifestRow.sourceFileId);
      const removedRows: Array<{
        id: string;
        storageKey: string | null;
        path: string;
      }> = [];
      for (let i = 0; i < stagedIds.length; i += 80) {
        const chunk = stagedIds.slice(i, i + 80);
        const deleted = tx
          .delete(this.tables.files)
          .where(
            and(
              inArray(this.tables.files.id, chunk),
              eq(this.tables.files.communityId, input.communityId),
              eq(this.tables.files.isActive, false),
              notExists(
                tx
                  .select({ id: this.tables.attachments.id })
                  .from(this.tables.attachments)
                  .where(
                    eq(this.tables.attachments.fileId, this.tables.files.id)
                  )
              ),
              notExists(
                tx
                  .select({ id: this.tables.importManifests.id })
                  .from(this.tables.importManifests)
                  .where(
                    eq(
                      this.tables.importManifests.sourceFileId,
                      this.tables.files.id
                    )
                  )
              )
            )
          )
          .returning({
            id: this.tables.files.id,
            storageKey: this.tables.files.storageKey,
            path: this.tables.files.path,
          })
          .all();
        removedRows.push(...deleted);
      }

      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();

      return {
        status: 'discarded',
        manifest: mapManifestRow(updated),
        removedFiles: toFileByteCleanups(removedRows),
      };
    });
  }

  private collectCommitReferences(normalizedData: StoredNormalizedImportData): {
    existingPlaceIds: number[];
    existingSpeakerIds: number[];
    existingFileIds: string[];
    stagedAttachmentFileIds: string[];
    relatedPlaceNameByNorm: Map<string, string>;
    relatedSpeakerNameByNorm: Map<string, string>;
  } {
    const placeIds = new Set<number>();
    const speakerIds = new Set<number>();
    const existingFiles = new Set<string>();
    const stagedFiles = new Set<string>();

    const relatedPlaceNameByNorm = new Map(
      normalizedData.relatedPlacesToCreate.map((p) => [
        p.normalizedName,
        p.name,
      ])
    );
    const relatedSpeakerNameByNorm = new Map(
      normalizedData.relatedSpeakersToCreate.map((s) => [
        s.normalizedName,
        s.name,
      ])
    );

    const recordAttachmentFiles = (
      attachments: ReadonlyArray<{
        fileId: string;
        stagedByManifest: boolean;
      }>
    ) => {
      for (const att of attachments) {
        if (att.stagedByManifest) {
          stagedFiles.add(att.fileId);
        } else {
          existingFiles.add(att.fileId);
        }
      }
    };

    if (normalizedData.kind === 'places') {
      for (const row of normalizedData.rows) {
        recordAttachmentFiles(row.attachments);
      }
    } else if (normalizedData.kind === 'speakers') {
      for (const row of normalizedData.rows) {
        if (row.birthplaceRef?.kind === 'existing') {
          placeIds.add(row.birthplaceRef.id);
        }
        recordAttachmentFiles(row.attachments);
      }
    } else {
      for (const row of normalizedData.rows) {
        if (row.interviewLocationRef?.kind === 'existing') {
          placeIds.add(row.interviewLocationRef.id);
        }
        if (row.interviewerRef?.kind === 'existing') {
          speakerIds.add(row.interviewerRef.id);
        }
        for (const ref of row.placeRefs) {
          if (ref.kind === 'existing') placeIds.add(ref.id);
        }
        for (const ref of row.speakerRefs) {
          if (ref.kind === 'existing') speakerIds.add(ref.id);
        }
        recordAttachmentFiles(row.attachments);
      }
    }

    return {
      existingPlaceIds: [...placeIds].sort((a, b) => a - b),
      existingSpeakerIds: [...speakerIds].sort((a, b) => a - b),
      existingFileIds: [...existingFiles].sort(),
      stagedAttachmentFileIds: [...stagedFiles].sort(),
      relatedPlaceNameByNorm,
      relatedSpeakerNameByNorm,
    };
  }

  private buildCommitEntityPayloads(input: {
    communityId: number;
    actorId: number;
    normalizedData: StoredNormalizedImportData;
    now: Date;
  }) {
    const { communityId, actorId, normalizedData, now } = input;
    return {
      relatedPlaces: normalizedData.relatedPlacesToCreate.map((p) => ({
        communityId,
        name: p.name,
        description: null,
        descriptionPlain: null,
        typeOfPlace: null,
        region: null,
        latitude: null,
        longitude: null,
        isRestricted: false,
        createdAt: now,
        updatedAt: now,
      })),
      relatedSpeakers: normalizedData.relatedSpeakersToCreate.map((sp) => ({
        communityId,
        name: sp.name,
        birthDate: null,
        birthplaceId: null,
        affiliation: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })),
      buildPlaces: () =>
        (normalizedData.kind === 'places' ? normalizedData.rows : []).map(
          (row: NormalizedPlaceRow) => ({
            communityId,
            name: row.name,
            description: row.description,
            descriptionPlain: row.descriptionPlain,
            typeOfPlace: row.typeOfPlace,
            region: row.region,
            latitude: row.latitude,
            longitude: row.longitude,
            isRestricted: false,
            createdAt: now,
            updatedAt: now,
          })
        ),
      buildSpeakers: (
        resolvePlaceRef: (
          ref:
            | { kind: 'existing'; id: number }
            | { kind: 'create'; name: string; normalizedName: string }
            | null
        ) => number | null
      ) =>
        (normalizedData.kind === 'speakers' ? normalizedData.rows : []).map(
          (row: NormalizedSpeakerRow) => ({
            communityId,
            name: row.name,
            birthDate: row.birthDate,
            birthplaceId: resolvePlaceRef(row.birthplaceRef),
            affiliation: row.affiliation,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })
        ),
      buildStories: (
        resolvePlaceRef: (
          ref:
            | { kind: 'existing'; id: number }
            | { kind: 'create'; name: string; normalizedName: string }
            | null
        ) => number | null,
        resolveSpeakerRef: (
          ref:
            | { kind: 'existing'; id: number }
            | { kind: 'create'; name: string; normalizedName: string }
            | null
        ) => number | null
      ) =>
        (normalizedData.kind === 'stories' ? normalizedData.rows : []).map(
          (row: NormalizedStoryRow) => {
            const physical = storyVisibilityToPhysical(row.visibility);
            return {
              title: row.title,
              description: row.description,
              descriptionPlain: row.descriptionPlain,
              slug: row.slug,
              communityId,
              createdBy: actorId,
              isRestricted: physical.isRestricted,
              privacyLevel: physical.privacyLevel,
              topic: row.topic,
              topicNormalized: row.topicNormalized,
              language: row.language,
              dateInterviewed: row.dateInterviewed
                ? new Date(row.dateInterviewed)
                : null,
              interviewLocationId: resolvePlaceRef(row.interviewLocationRef),
              interviewerId: resolveSpeakerRef(row.interviewerRef),
              createdAt: now,
              updatedAt: now,
            };
          }
        ),
      collectEntityAttachments: (
        ownerType: 'place' | 'speaker',
        ownerIds: ReadonlyArray<number>
      ) => {
        const out: Array<{
          communityId: number;
          fileId: string;
          ownerType: 'place' | 'speaker' | 'story';
          ownerId: number;
          role: string;
          ordinal: number;
          createdAt: Date;
        }> = [];
        normalizedData.rows.forEach((row, idx) => {
          const ownerId = ownerIds[idx]!;
          for (const att of row.attachments) {
            out.push({
              communityId,
              fileId: att.fileId,
              ownerType,
              ownerId,
              role: att.role,
              ordinal: att.ordinal,
              createdAt: now,
            });
          }
        });
        return out;
      },
      collectStoryChildren: (
        storyIds: ReadonlyArray<number>,
        resolvePlaceRef: (
          ref:
            | { kind: 'existing'; id: number }
            | { kind: 'create'; name: string; normalizedName: string }
            | null
        ) => number | null,
        resolveSpeakerRef: (
          ref:
            | { kind: 'existing'; id: number }
            | { kind: 'create'; name: string; normalizedName: string }
            | null
        ) => number | null
      ) => {
        const storyPlacesToInsert: Array<{
          communityId: number;
          storyId: number;
          placeId: number;
          sortOrder: number;
          createdAt: Date;
          updatedAt: Date;
        }> = [];
        const storySpeakersToInsert: Array<{
          communityId: number;
          storyId: number;
          speakerId: number;
          sortOrder: number;
          createdAt: Date;
          updatedAt: Date;
        }> = [];
        const attachmentsToInsert: Array<{
          communityId: number;
          fileId: string;
          ownerType: 'place' | 'speaker' | 'story';
          ownerId: number;
          role: string;
          ordinal: number;
          createdAt: Date;
        }> = [];
        const externalLinksToInsert: Array<{
          communityId: number;
          storyId: number;
          url: string;
          ordinal: number;
          createdAt: Date;
        }> = [];

        if (normalizedData.kind === 'stories') {
          normalizedData.rows.forEach((row, idx) => {
            const storyId = storyIds[idx]!;
            row.placeRefs.forEach((ref, sortOrder) => {
              storyPlacesToInsert.push({
                communityId,
                storyId,
                placeId: resolvePlaceRef(ref)!,
                sortOrder,
                createdAt: now,
                updatedAt: now,
              });
            });
            row.speakerRefs.forEach((ref, sortOrder) => {
              storySpeakersToInsert.push({
                communityId,
                storyId,
                speakerId: resolveSpeakerRef(ref)!,
                sortOrder,
                createdAt: now,
                updatedAt: now,
              });
            });
            for (const att of row.attachments) {
              attachmentsToInsert.push({
                communityId,
                fileId: att.fileId,
                ownerType: 'story',
                ownerId: storyId,
                role: att.role,
                ordinal: att.ordinal,
                createdAt: now,
              });
            }
            row.externalMediaLinks.forEach((url, ordinal) => {
              externalLinksToInsert.push({
                communityId,
                storyId,
                url,
                ordinal,
                createdAt: now,
              });
            });
          });
        }

        return {
          storyPlacesToInsert,
          storySpeakersToInsert,
          attachmentsToInsert,
          externalLinksToInsert,
        };
      },
    };
  }

  private resolveCanonicalPlaceCreateName(
    ref: { kind: 'create'; name: string; normalizedName: string },
    map: ReadonlyMap<string, string>
  ): string {
    return map.get(ref.normalizedName) ?? ref.name;
  }

  private resolveCanonicalSpeakerCreateName(
    ref: { kind: 'create'; name: string; normalizedName: string },
    map: ReadonlyMap<string, string>
  ): string {
    return map.get(ref.normalizedName) ?? ref.name;
  }

  private authorizeExistingFileReuseSqlite(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    input: {
      communityId: number;
      actorId: number;
      actorRole: 'editor' | 'admin';
      fileId: string;
      uploadedBy: number | null;
    }
  ): boolean {
    const existingRows = tx
      .select({
        ownerType: this.tables.attachments.ownerType,
        ownerId: this.tables.attachments.ownerId,
        role: this.tables.attachments.role,
      })
      .from(this.tables.attachments)
      .where(
        and(
          eq(this.tables.attachments.fileId, input.fileId),
          eq(this.tables.attachments.communityId, input.communityId)
        )
      )
      .all() as Array<{
      ownerType: AttachmentOwnerType | null;
      ownerId: number | null;
      role: AttachmentRole | null;
    }>;

    if (existingRows.length === 0) {
      if (input.uploadedBy !== null && input.uploadedBy === input.actorId) {
        return true;
      }
      return input.actorRole === 'admin';
    }

    for (const row of existingRows) {
      if (!row.ownerType || row.ownerId === null || !row.role) {
        return false;
      }
      if (row.ownerType === 'story') {
        if (row.role !== 'story_media') return false;
        const found = tx
          .select({ id: this.tables.stories.id })
          .from(this.tables.stories)
          .where(
            and(
              eq(this.tables.stories.id, row.ownerId),
              eq(this.tables.stories.communityId, input.communityId),
              eq(this.tables.stories.isRestricted, false),
              inArray(this.tables.stories.privacyLevel, [
                ...READABLE_PRIVACY_LEVELS,
              ])
            )
          )
          .limit(1)
          .all();
        if (found.length === 0) return false;
        continue;
      }
      if (row.ownerType === 'place') {
        if (row.role !== 'place_photo' && row.role !== 'place_name_audio') {
          return false;
        }
        const found = tx
          .select({ id: this.tables.places.id })
          .from(this.tables.places)
          .where(
            and(
              eq(this.tables.places.id, row.ownerId),
              eq(this.tables.places.communityId, input.communityId),
              eq(this.tables.places.isRestricted, false)
            )
          )
          .limit(1)
          .all();
        if (found.length === 0) return false;
        continue;
      }
      if (row.ownerType === 'speaker') {
        if (row.role !== 'speaker_photo') return false;
        const found = tx
          .select({ id: this.tables.speakers.id })
          .from(this.tables.speakers)
          .where(
            and(
              eq(this.tables.speakers.id, row.ownerId),
              eq(this.tables.speakers.communityId, input.communityId)
            )
          )
          .limit(1)
          .all();
        if (found.length === 0) return false;
        continue;
      }
      if (row.ownerType === 'user') {
        if (row.role !== 'user_photo') return false;
        if (input.actorRole !== 'admin' && input.actorId !== row.ownerId) {
          return false;
        }
        const found = tx
          .select({ id: this.tables.users.id })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, row.ownerId),
              eq(this.tables.users.communityId, input.communityId),
              eq(this.tables.users.isActive, true)
            )
          )
          .limit(1)
          .all();
        if (found.length === 0) return false;
        continue;
      }
      if (row.ownerType === 'community') {
        if (input.actorRole !== 'admin') return false;
        if (row.ownerId !== input.communityId) return false;
        if (
          row.role !== 'community_display_image' &&
          row.role !== 'community_background_image' &&
          row.role !== 'sponsor_logo'
        ) {
          return false;
        }
        continue;
      }
      if (row.ownerType === 'map_config') {
        if (input.actorRole !== 'admin') return false;
        if (row.ownerId !== input.communityId || row.role !== 'static_map') {
          return false;
        }
        const found = tx
          .select({ communityId: this.tables.communityMapConfigs.communityId })
          .from(this.tables.communityMapConfigs)
          .where(
            eq(this.tables.communityMapConfigs.communityId, input.communityId)
          )
          .limit(1)
          .all();
        if (found.length === 0) return false;
        continue;
      }
      return false;
    }

    return true;
  }

  async commitManifest(input: {
    communityId: number;
    actorId: number;
    actor: FoundationUser;
    manifest: ImportManifestRowRecord;
    now: Date;
    dailyLimitWindow: { startMs: number; endMs: number } | null;
  }): Promise<CommitManifestOutcome> {
    const { manifest, now } = input;
    const nowMs = now.getTime();
    const isPg = dialectOf(this.connection) === 'postgresql';
    const normalizedData = manifest.normalizedRows;
    const resultSummary = computeImportResultSummary(normalizedData);
    const refs = this.collectCommitReferences(normalizedData);
    const stagedMediaIds = Array.from(new Set(manifest.stagedFileIds))
      .filter((id) => id !== manifest.sourceFileId)
      .sort();

    for (const attStagedId of refs.stagedAttachmentFileIds) {
      if (!stagedMediaIds.includes(attStagedId)) {
        return { status: 'failed_reference' };
      }
    }

    const audit = buildImportAuditEntry({
      communityId: input.communityId,
      actorId: input.actorId,
      action: 'import.commit',
      manifestId: manifest.id,
      outcome: 'success',
    });

    if (this.hasD1Batch()) {
      const guardSql = input.dailyLimitWindow
        ? sql`im.id = ${manifest.id}
              AND im.community_id = ${input.communityId}
              AND im.status = 'previewed'
              AND EXISTS (
                SELECT 1 FROM communities c
                WHERE c.id = im.community_id AND c.is_active = 1
              )
              AND EXISTS (
                SELECT 1 FROM users u
                WHERE u.id = ${input.actorId}
                  AND u.community_id = im.community_id
                  AND u.is_active = 1
                  AND u.role IN ('editor', 'admin')
              )
              AND NOT EXISTS (
                SELECT 1 FROM import_manifests im2
                WHERE im2.status = 'committed'
                  AND im2.committed_at >= ${input.dailyLimitWindow.startMs}
                  AND im2.committed_at < ${input.dailyLimitWindow.endMs}
              )`
        : sql`im.id = ${manifest.id}
              AND im.community_id = ${input.communityId}
              AND im.status = 'previewed'
              AND EXISTS (
                SELECT 1 FROM communities c
                WHERE c.id = im.community_id AND c.is_active = 1
              )
              AND EXISTS (
                SELECT 1 FROM users u
                WHERE u.id = ${input.actorId}
                  AND u.community_id = im.community_id
                  AND u.is_active = 1
                  AND u.role IN ('editor', 'admin')
              )`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statements: any[] = [];

      // 1. Related places
      const relatedPlaceChunks = chunkImportItemsByBudget(
        normalizedData.relatedPlacesToCreate,
        COMMIT_PLACE_INSERT_CHUNK,
        D1_MAX_BOUND_PARAMS_PER_STATEMENT,
        10,
        PLACE_INSERT_SQL_BYTES,
        estimateRelatedRecordBytes
      );
      for (const chunk of relatedPlaceChunks) {
        const unionValues = sql.join(
          chunk.map((p) => sql`SELECT ${p.name} AS name`),
          sql` UNION ALL `
        );
        statements.push(
          this.db.insert(this.tables.places).select(sql`
            SELECT NULL, v.name, NULL, NULL, im.community_id, NULL, NULL, NULL, NULL, '[]', NULL, NULL, 0, ${nowMs}, ${nowMs}
            FROM (${unionValues}) AS v
            JOIN import_manifests im ON ${guardSql}
          `)
        );
      }

      // 2. Related speakers
      const relatedSpeakerChunks = chunkImportItemsByBudget(
        normalizedData.relatedSpeakersToCreate,
        COMMIT_SPEAKER_INSERT_CHUNK,
        D1_MAX_BOUND_PARAMS_PER_STATEMENT,
        8,
        SPEAKER_INSERT_SQL_BYTES,
        estimateRelatedRecordBytes
      );
      for (const chunk of relatedSpeakerChunks) {
        const unionValues = sql.join(
          chunk.map((sp) => sql`SELECT ${sp.name} AS name`),
          sql` UNION ALL `
        );
        statements.push(
          this.db.insert(this.tables.speakers).select(sql`
            SELECT NULL, v.name, NULL, im.community_id, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 1, ${nowMs}, ${nowMs}
            FROM (${unionValues}) AS v
            JOIN import_manifests im ON ${guardSql}
          `)
        );
      }

      const pushD1OwnerAttachments = (
        ownerType: 'place' | 'speaker' | 'story',
        ownerSubquerySql: ReturnType<typeof sql>,
        attachments: ReadonlyArray<{
          fileId: string;
          role: string;
          ordinal: number;
          stagedByManifest: boolean;
        }>
      ) => {
        for (let i = 0; i < attachments.length; i += COMMIT_CHILD_ROW_CHUNK) {
          const chunk = attachments.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
          const unionValues = sql.join(
            chunk.map(
              (att) =>
                sql`SELECT ${att.fileId} AS file_id, ${att.role} AS role, ${att.ordinal} AS ordinal, ${att.stagedByManifest ? 1 : 0} AS staged`
            ),
            sql` UNION ALL `
          );
          statements.push(
            this.db.insert(this.tables.attachments).select(sql`
              SELECT NULL, im.community_id, f.id, ${ownerType}, owner.id, v.role, v.ordinal, NULL, NULL, NULL, NULL, NULL, NULL,
                CASE WHEN f.id IS NOT NULL AND owner.id IS NOT NULL THEN ${nowMs} ELSE NULL END
              FROM (${unionValues}) AS v
              JOIN import_manifests im ON ${guardSql}
              JOIN users actor_u
                ON actor_u.id = ${input.actorId}
               AND actor_u.community_id = im.community_id
               AND actor_u.is_active = 1
               AND actor_u.role IN ('editor', 'admin')
              LEFT JOIN (${ownerSubquerySql}) owner ON 1 = 1
              LEFT JOIN files f
                ON f.id = v.file_id
               AND f.community_id = im.community_id
               AND f.cultural_restrictions IS NULL
               AND (
                 (v.staged = 1 AND f.is_active = 0)
                 OR (
                   v.staged = 0
                   AND f.is_active = 1
                   AND (
                     (
                       NOT EXISTS (
                         SELECT 1 FROM attachments ea
                         WHERE ea.file_id = f.id
                           AND ea.community_id = im.community_id
                       )
                       AND (f.uploaded_by = actor_u.id OR actor_u.role = 'admin')
                     )
                     OR (
                       EXISTS (
                         SELECT 1 FROM attachments ea
                         WHERE ea.file_id = f.id
                           AND ea.community_id = im.community_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM attachments ea
                         WHERE ea.file_id = f.id
                           AND ea.community_id = im.community_id
                           AND (
                             ea.owner_type IS NULL
                             OR ea.owner_id IS NULL
                             OR ea.role IS NULL
                             OR NOT (
                               (
                                 ea.owner_type = 'story'
                                 AND ea.role = 'story_media'
                                 AND EXISTS (
                                   SELECT 1 FROM stories st
                                   WHERE st.id = ea.owner_id
                                     AND st.community_id = im.community_id
                                     AND st.is_restricted = 0
                                     AND st.privacy_level IN ('public', 'members_only', 'editors')
                                 )
                               )
                               OR (
                                 ea.owner_type = 'place'
                                 AND ea.role IN ('place_photo', 'place_name_audio')
                                 AND EXISTS (
                                   SELECT 1 FROM places pl
                                   WHERE pl.id = ea.owner_id
                                     AND pl.community_id = im.community_id
                                     AND pl.is_restricted = 0
                                 )
                               )
                               OR (
                                 ea.owner_type = 'speaker'
                                 AND ea.role = 'speaker_photo'
                                 AND EXISTS (
                                   SELECT 1 FROM speakers sp
                                   WHERE sp.id = ea.owner_id
                                     AND sp.community_id = im.community_id
                                 )
                               )
                               OR (
                                 ea.owner_type = 'user'
                                 AND ea.role = 'user_photo'
                                 AND (actor_u.role = 'admin' OR actor_u.id = ea.owner_id)
                                 AND EXISTS (
                                   SELECT 1 FROM users u2
                                   WHERE u2.id = ea.owner_id
                                     AND u2.community_id = im.community_id
                                     AND u2.is_active = 1
                                 )
                               )
                               OR (
                                 ea.owner_type = 'community'
                                 AND actor_u.role = 'admin'
                                 AND ea.owner_id = im.community_id
                                 AND ea.role IN ('community_display_image', 'community_background_image', 'sponsor_logo')
                               )
                               OR (
                                 ea.owner_type = 'map_config'
                                 AND actor_u.role = 'admin'
                                 AND ea.owner_id = im.community_id
                                 AND ea.role = 'static_map'
                                 AND EXISTS (
                                   SELECT 1 FROM community_map_configs mc
                                   WHERE mc.community_id = im.community_id
                                 )
                               )
                             )
                           )
                       )
                     )
                   )
                 )
               )
            `)
          );
        }
      };

      // 3. Primary rows and child records
      if (normalizedData.kind === 'places') {
        const plainPlaces = normalizedData.rows.filter(
          (r) => r.attachments.length === 0
        );
        const attachedPlaces = normalizedData.rows.filter(
          (r) => r.attachments.length > 0
        );
        const plainPlaceChunks = chunkImportItemsByBudget(
          plainPlaces,
          COMMIT_PLACE_INSERT_CHUNK,
          D1_MAX_BOUND_PARAMS_PER_STATEMENT,
          10,
          PLACE_INSERT_SQL_BYTES,
          estimatePlaceRowBytes
        );
        for (const chunk of plainPlaceChunks) {
          const unionValues = sql.join(
            chunk.map(
              (row) =>
                sql`SELECT ${row.name} AS name, ${row.description} AS description, ${row.descriptionPlain} AS description_plain, ${row.latitude} AS latitude, ${row.longitude} AS longitude, ${row.typeOfPlace} AS type_of_place, ${row.region} AS region`
            ),
            sql` UNION ALL `
          );
          statements.push(
            this.db.insert(this.tables.places).select(sql`
              SELECT NULL, v.name, v.description, v.description_plain, im.community_id, v.latitude, v.longitude, v.type_of_place, v.region, '[]', NULL, NULL, 0, ${nowMs}, ${nowMs}
              FROM (${unionValues}) AS v
              JOIN import_manifests im ON ${guardSql}
            `)
          );
        }

        for (const row of attachedPlaces) {
          statements.push(
            this.db.insert(this.tables.places).select(sql`
              SELECT NULL, ${row.name}, ${row.description}, ${row.descriptionPlain}, im.community_id, ${row.latitude}, ${row.longitude}, ${row.typeOfPlace}, ${row.region}, '[]', NULL, NULL, 0, ${nowMs}, ${nowMs}
              FROM import_manifests im
              WHERE ${guardSql}
            `)
          );
          pushD1OwnerAttachments(
            'place',
            sql`SELECT MAX(id) AS id FROM places WHERE community_id = ${input.communityId} AND name = ${row.name} AND created_at = ${nowMs} AND is_restricted = 0`,
            row.attachments
          );
        }
      } else if (normalizedData.kind === 'speakers') {
        const plainSpeakers = normalizedData.rows.filter(
          (r) => r.attachments.length === 0
        );
        const attachedSpeakers = normalizedData.rows.filter(
          (r) => r.attachments.length > 0
        );
        const plainSpeakerChunks = chunkImportItemsByBudget(
          plainSpeakers,
          COMMIT_SPEAKER_INSERT_CHUNK,
          D1_MAX_BOUND_PARAMS_PER_STATEMENT,
          8,
          SPEAKER_INSERT_SQL_BYTES,
          estimateSpeakerRowBytes
        );
        for (const chunk of plainSpeakerChunks) {
          const unionValues = sql.join(
            chunk.map((row) => {
              const bpExistingId =
                row.birthplaceRef?.kind === 'existing'
                  ? row.birthplaceRef.id
                  : null;
              const bpCreateName =
                row.birthplaceRef?.kind === 'create'
                  ? this.resolveCanonicalPlaceCreateName(
                      row.birthplaceRef,
                      refs.relatedPlaceNameByNorm
                    )
                  : null;
              return sql`SELECT ${row.name} AS name, ${row.birthDate} AS birth_date, ${row.affiliation} AS affiliation, ${bpExistingId} AS bp_existing_id, ${bpCreateName} AS bp_create_name`;
            }),
            sql` UNION ALL `
          );
          statements.push(
            this.db.insert(this.tables.speakers).select(sql`
              SELECT NULL, v.name, NULL,
                CASE
                  WHEN v.bp_existing_id IS NOT NULL AND bp_e.id IS NULL THEN NULL
                  WHEN v.bp_create_name IS NOT NULL AND bp_c.id IS NULL THEN NULL
                  ELSE im.community_id
                END,
                NULL, NULL, NULL, v.birth_date,
                COALESCE(bp_e.id, bp_c.id),
                v.affiliation, 0, NULL, 1, ${nowMs}, ${nowMs}
              FROM (${unionValues}) AS v
              JOIN import_manifests im ON ${guardSql}
              LEFT JOIN places bp_e
                ON bp_e.community_id = im.community_id
               AND bp_e.id = v.bp_existing_id
               AND bp_e.is_restricted = 0
              LEFT JOIN (
                SELECT name, MAX(id) AS id
                FROM places
                WHERE community_id = ${input.communityId}
                  AND created_at = ${nowMs}
                  AND is_restricted = 0
                GROUP BY name
              ) bp_c
                ON bp_c.name = v.bp_create_name
            `)
          );
        }

        for (const row of attachedSpeakers) {
          const bpExistingId =
            row.birthplaceRef?.kind === 'existing'
              ? row.birthplaceRef.id
              : null;
          const bpCreateName =
            row.birthplaceRef?.kind === 'create'
              ? this.resolveCanonicalPlaceCreateName(
                  row.birthplaceRef,
                  refs.relatedPlaceNameByNorm
                )
              : null;
          statements.push(
            this.db.insert(this.tables.speakers).select(sql`
              SELECT NULL, ${row.name}, NULL,
                CASE
                  WHEN ${bpExistingId} IS NOT NULL AND bp_e.id IS NULL THEN NULL
                  WHEN ${bpCreateName} IS NOT NULL AND bp_c.id IS NULL THEN NULL
                  ELSE im.community_id
                END,
                NULL, NULL, NULL, ${row.birthDate},
                COALESCE(bp_e.id, bp_c.id),
                ${row.affiliation}, 0, NULL, 1, ${nowMs}, ${nowMs}
              FROM import_manifests im
              LEFT JOIN places bp_e
                ON bp_e.community_id = im.community_id
               AND bp_e.id = ${bpExistingId}
               AND bp_e.is_restricted = 0
              LEFT JOIN (
                SELECT name, MAX(id) AS id
                FROM places
                WHERE community_id = ${input.communityId}
                  AND created_at = ${nowMs}
                  AND is_restricted = 0
                GROUP BY name
              ) bp_c
                ON bp_c.name = ${bpCreateName}
              WHERE ${guardSql}
            `)
          );
          pushD1OwnerAttachments(
            'speaker',
            sql`SELECT MAX(id) AS id FROM speakers WHERE community_id = ${input.communityId} AND name = ${row.name} AND created_at = ${nowMs}`,
            row.attachments
          );
        }
      } else {
        for (const row of normalizedData.rows) {
          const physical = storyVisibilityToPhysical(row.visibility);
          const dateInterviewedMs = row.dateInterviewed
            ? new Date(row.dateInterviewed).getTime()
            : null;

          const extraJoins: Array<ReturnType<typeof sql>> = [];
          const communityChecks: Array<ReturnType<typeof sql>> = [];
          let locExpr = sql`NULL`;
          let spkExpr = sql`NULL`;

          if (row.interviewLocationRef?.kind === 'existing') {
            const locId = row.interviewLocationRef.id;
            extraJoins.push(
              sql`LEFT JOIN places loc_e ON loc_e.community_id = im.community_id AND loc_e.id = ${locId} AND loc_e.is_restricted = 0`
            );
            communityChecks.push(sql`WHEN loc_e.id IS NULL THEN NULL`);
            locExpr = sql`loc_e.id`;
          } else if (row.interviewLocationRef?.kind === 'create') {
            const locName = this.resolveCanonicalPlaceCreateName(
              row.interviewLocationRef,
              refs.relatedPlaceNameByNorm
            );
            extraJoins.push(
              sql`LEFT JOIN (SELECT MAX(id) AS id FROM places WHERE community_id = ${input.communityId} AND name = ${locName} AND created_at = ${nowMs} AND is_restricted = 0) loc_c ON 1 = 1`
            );
            communityChecks.push(sql`WHEN loc_c.id IS NULL THEN NULL`);
            locExpr = sql`loc_c.id`;
          }

          if (row.interviewerRef?.kind === 'existing') {
            const spkId = row.interviewerRef.id;
            extraJoins.push(
              sql`LEFT JOIN speakers spk_e ON spk_e.community_id = im.community_id AND spk_e.id = ${spkId}`
            );
            communityChecks.push(sql`WHEN spk_e.id IS NULL THEN NULL`);
            spkExpr = sql`spk_e.id`;
          } else if (row.interviewerRef?.kind === 'create') {
            const spkName = this.resolveCanonicalSpeakerCreateName(
              row.interviewerRef,
              refs.relatedSpeakerNameByNorm
            );
            extraJoins.push(
              sql`LEFT JOIN (SELECT MAX(id) AS id FROM speakers WHERE community_id = ${input.communityId} AND name = ${spkName} AND created_at = ${nowMs}) spk_c ON 1 = 1`
            );
            communityChecks.push(sql`WHEN spk_c.id IS NULL THEN NULL`);
            spkExpr = sql`spk_c.id`;
          }

          const guardedCommunityExpr =
            communityChecks.length === 0
              ? sql`im.community_id`
              : sql`CASE ${sql.join(communityChecks, sql` `)} ELSE im.community_id END`;
          const joinsSql =
            extraJoins.length === 0 ? sql`` : sql.join(extraJoins, sql` `);

          statements.push(
            this.db.insert(this.tables.stories).select(sql`
              SELECT NULL, ${row.title}, ${row.description}, ${row.descriptionPlain}, ${row.slug},
                ${guardedCommunityExpr},
                ${input.actorId}, 0, ${physical.privacyLevel}, ${row.topic}, ${row.topicNormalized},
                '[]', NULL, NULL, ${row.language}, '[]', ${dateInterviewedMs},
                ${locExpr}, ${spkExpr}, ${nowMs}, ${nowMs}
              FROM import_manifests im
              ${joinsSql}
              WHERE ${guardSql}
            `)
          );

          const storyOwnerSubquery = sql`SELECT MAX(id) AS id FROM stories WHERE community_id = ${input.communityId} AND slug = ${row.slug} AND created_at = ${nowMs}`;

          for (
            let i = 0;
            i < row.placeRefs.length;
            i += COMMIT_CHILD_ROW_CHUNK
          ) {
            const chunk = row.placeRefs.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
            const unionValues = sql.join(
              chunk.map((ref, idx) => {
                const sortOrder = i + idx;
                const existingId = ref.kind === 'existing' ? ref.id : null;
                const createName =
                  ref.kind === 'create'
                    ? this.resolveCanonicalPlaceCreateName(
                        ref,
                        refs.relatedPlaceNameByNorm
                      )
                    : null;
                return sql`SELECT ${sortOrder} AS sort_order, ${existingId} AS existing_id, ${createName} AS create_name`;
              }),
              sql` UNION ALL `
            );
            statements.push(
              this.db.insert(this.tables.storyPlaces).select(sql`
                SELECT NULL, im.community_id, owner.id, COALESCE(pe.id, pc.id), NULL, v.sort_order, ${nowMs}, ${nowMs}
                FROM (${unionValues}) AS v
                JOIN import_manifests im ON ${guardSql}
                LEFT JOIN (${storyOwnerSubquery}) owner ON 1 = 1
                LEFT JOIN places pe
                  ON pe.community_id = im.community_id
                 AND pe.id = v.existing_id
                 AND pe.is_restricted = 0
                LEFT JOIN (
                  SELECT name, MAX(id) AS id
                  FROM places
                  WHERE community_id = ${input.communityId}
                    AND created_at = ${nowMs}
                    AND is_restricted = 0
                  GROUP BY name
                ) pc
                  ON pc.name = v.create_name
              `)
            );
          }

          for (
            let i = 0;
            i < row.speakerRefs.length;
            i += COMMIT_CHILD_ROW_CHUNK
          ) {
            const chunk = row.speakerRefs.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
            const unionValues = sql.join(
              chunk.map((ref, idx) => {
                const sortOrder = i + idx;
                const existingId = ref.kind === 'existing' ? ref.id : null;
                const createName =
                  ref.kind === 'create'
                    ? this.resolveCanonicalSpeakerCreateName(
                        ref,
                        refs.relatedSpeakerNameByNorm
                      )
                    : null;
                return sql`SELECT ${sortOrder} AS sort_order, ${existingId} AS existing_id, ${createName} AS create_name`;
              }),
              sql` UNION ALL `
            );
            statements.push(
              this.db.insert(this.tables.storySpeakers).select(sql`
                SELECT NULL, im.community_id, owner.id, COALESCE(spe.id, spc.id), NULL, v.sort_order, ${nowMs}, ${nowMs}
                FROM (${unionValues}) AS v
                JOIN import_manifests im ON ${guardSql}
                LEFT JOIN (${storyOwnerSubquery}) owner ON 1 = 1
                LEFT JOIN speakers spe
                  ON spe.community_id = im.community_id
                 AND spe.id = v.existing_id
                LEFT JOIN (
                  SELECT name, MAX(id) AS id
                  FROM speakers
                  WHERE community_id = ${input.communityId}
                    AND created_at = ${nowMs}
                  GROUP BY name
                ) spc
                  ON spc.name = v.create_name
              `)
            );
          }

          pushD1OwnerAttachments('story', storyOwnerSubquery, row.attachments);

          for (
            let i = 0;
            i < row.externalMediaLinks.length;
            i += COMMIT_CHILD_ROW_CHUNK
          ) {
            const chunk = row.externalMediaLinks.slice(
              i,
              i + COMMIT_CHILD_ROW_CHUNK
            );
            const unionValues = sql.join(
              chunk.map(
                (url, idx) => sql`SELECT ${url} AS url, ${i + idx} AS ordinal`
              ),
              sql` UNION ALL `
            );
            statements.push(
              this.db.insert(this.tables.externalMediaLinks).select(sql`
                SELECT NULL, im.community_id, owner.id, v.url, v.ordinal, ${nowMs}
                FROM (${unionValues}) AS v
                JOIN import_manifests im ON ${guardSql}
                LEFT JOIN (${storyOwnerSubquery}) owner ON 1 = 1
              `)
            );
          }
        }
      }

      // 4. Activate staged media files
      for (
        let i = 0;
        i < stagedMediaIds.length;
        i += COMMIT_FILE_ACTIVATE_CHUNK
      ) {
        const chunk = stagedMediaIds.slice(i, i + COMMIT_FILE_ACTIVATE_CHUNK);
        statements.push(
          this.db
            .update(this.tables.files)
            .set({ isActive: true, updatedAt: now })
            .where(
              and(
                inArray(this.tables.files.id, chunk),
                eq(this.tables.files.communityId, input.communityId),
                eq(this.tables.files.isActive, false),
                sql`EXISTS (SELECT 1 FROM import_manifests im WHERE ${guardSql})`
              )
            )
        );
      }

      // 5. Content-free audit entry (before manifest status flips)
      statements.push(
        this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: this.tables.importManifests.communityId,
              actorId: sql`${audit.actorId}`.as('actor_id'),
              action: sql`${audit.action}`.as('action'),
              resourceType: sql`${audit.resourceType}`.as('resource_type'),
              resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
                'resource_ids'
              ),
              outcome: sql`${audit.outcome}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.importManifests)
            .where(
              sql`${this.tables.importManifests.id} = ${manifest.id}
                  AND ${this.tables.importManifests.communityId} = ${input.communityId}
                  AND ${this.tables.importManifests.status} = 'previewed'
                  AND EXISTS (SELECT 1 FROM communities c WHERE c.id = ${this.tables.importManifests.communityId} AND c.is_active = 1)
                  AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${input.actorId} AND u.community_id = ${this.tables.importManifests.communityId} AND u.is_active = 1 AND u.role IN ('editor', 'admin'))
                  ${
                    input.dailyLimitWindow
                      ? sql`AND NOT EXISTS (SELECT 1 FROM import_manifests im2 WHERE im2.status = 'committed' AND im2.committed_at >= ${input.dailyLimitWindow.startMs} AND im2.committed_at < ${input.dailyLimitWindow.endMs})`
                      : sql``
                  }`
            )
        )
      );

      // 6. Conditional manifest status flip (last statement in batch)
      const updateManifestIdx = statements.length;
      statements.push(
        this.db
          .update(this.tables.importManifests)
          .set({
            status: 'committed',
            resultSummary: resultSummary as unknown as Record<string, unknown>,
            committedAt: nowMs,
          })
          .where(
            and(
              eq(this.tables.importManifests.id, manifest.id),
              eq(this.tables.importManifests.communityId, input.communityId),
              eq(this.tables.importManifests.status, 'previewed'),
              sql`EXISTS (SELECT 1 FROM communities c WHERE c.id = ${input.communityId} AND c.is_active = 1)`,
              sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${input.actorId} AND u.community_id = ${input.communityId} AND u.is_active = 1 AND u.role IN ('editor', 'admin'))`,
              ...(input.dailyLimitWindow
                ? [
                    sql`NOT EXISTS (
                      SELECT 1 FROM import_manifests im2
                      WHERE im2.status = 'committed'
                        AND im2.committed_at >= ${input.dailyLimitWindow.startMs}
                        AND im2.committed_at < ${input.dailyLimitWindow.endMs}
                    )`,
                  ]
                : [])
            )
          )
          .returning(this.manifestSelectColumns())
      );

      let results: unknown[];
      try {
        results = await this.db.batch(statements);
      } catch (err) {
        if (
          isNotNullConstraintError(err) ||
          isForeignKeyConstraintError(err) ||
          isUniqueConstraintError(err) ||
          isCheckConstraintError(err)
        ) {
          if (
            isNotNullConstraintError(err) &&
            refs.existingFileIds.length > 0 &&
            manifest.createdBy !== input.actorId
          ) {
            const actorRows = await this.db
              .select({ role: this.tables.users.role })
              .from(this.tables.users)
              .where(
                and(
                  eq(this.tables.users.id, input.actorId),
                  eq(this.tables.users.communityId, input.communityId),
                  eq(this.tables.users.isActive, true),
                  inArray(this.tables.users.role, ['editor', 'admin'])
                )
              )
              .limit(1);
            const liveActorRow = actorRows[0] as { role: string } | undefined;
            if (!liveActorRow) {
              return { status: 'forbidden' };
            }
            if (liveActorRow.role !== 'admin') {
              const liveActor: FoundationUser = {
                ...input.actor,
                id: input.actorId,
                role: liveActorRow.role as FoundationUser['role'],
                communityId: input.communityId,
              };
              const dbFiles = await this.findCommunityFilesByIds(
                input.communityId,
                refs.existingFileIds
              );
              for (const fileId of refs.existingFileIds) {
                const f = dbFiles.get(fileId);
                if (!f) continue;
                const reuse = await this.mediaRepository.authorizeAttachReuse({
                  actor: liveActor,
                  communityId: input.communityId,
                  file: { id: fileId, uploadedBy: f.uploadedBy },
                });
                if (!reuse.ok) {
                  return { status: 'forbidden' };
                }
              }
            }
          }
          return { status: 'failed_reference' };
        }
        return { status: 'uncertain' };
      }

      const updatedRows = results[updateManifestIdx];
      const updated = Array.isArray(updatedRows) ? updatedRows[0] : undefined;
      if (updated) {
        return {
          status: 'committed',
          manifest: mapManifestRow(updated),
        };
      }

      const commActive = await this.activeCommunityExists(input.communityId);
      if (!commActive) return { status: 'forbidden' };
      const actorRows = await this.db
        .select({ role: this.tables.users.role })
        .from(this.tables.users)
        .where(
          and(
            eq(this.tables.users.id, input.actorId),
            eq(this.tables.users.communityId, input.communityId),
            eq(this.tables.users.isActive, true),
            inArray(this.tables.users.role, ['editor', 'admin'])
          )
        )
        .limit(1);
      if (actorRows.length === 0) return { status: 'forbidden' };

      const after = await this.getManifestById(input.communityId, manifest.id);
      if (!after) return { status: 'not_found' };
      if (after.status === 'committed') {
        return { status: 'already_committed', manifest: after };
      }
      if (after.status === 'discarded' || after.status === 'failed') {
        return { status: 'conflict', manifest: after };
      }
      if (input.dailyLimitWindow) {
        const hitDaily = await this.hasCommittedImportInWindow(
          input.dailyLimitWindow.startMs,
          input.dailyLimitWindow.endMs
        );
        if (hitDaily) return { status: 'daily_limit' };
      }
      return { status: 'conflict', manifest: after };
    }

    if (isPg) {
      let reachedCommit = false;
      try {
        return await this.db.transaction(async (tx: typeof this.db) => {
          // Canonical PG lock order: communities (FOR SHARE) -> advisory -> users (FOR SHARE)
          // -> import_manifests (FOR UPDATE) -> places (FOR SHARE sorted) -> speakers (FOR SHARE sorted) -> files (FOR UPDATE sorted)
          const [comm] = await tx
            .select({ id: this.tables.communities.id })
            .from(this.tables.communities)
            .where(
              and(
                eq(this.tables.communities.id, input.communityId),
                eq(this.tables.communities.isActive, true)
              )
            )
            .for('share');
          if (!comm) return { status: 'forbidden' };

          if (input.dailyLimitWindow) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext('import:daily:' || ${String(input.dailyLimitWindow.startMs)}))`
            );
          }

          const [actorRow] = await tx
            .select({ role: this.tables.users.role })
            .from(this.tables.users)
            .where(
              and(
                eq(this.tables.users.id, input.actorId),
                eq(this.tables.users.communityId, input.communityId),
                eq(this.tables.users.isActive, true),
                inArray(this.tables.users.role, ['editor', 'admin'])
              )
            )
            .for('share');
          if (!actorRow) return { status: 'forbidden' };

          const [manifestRow] = await tx
            .select(this.manifestSelectColumns())
            .from(this.tables.importManifests)
            .where(
              and(
                eq(this.tables.importManifests.id, manifest.id),
                eq(this.tables.importManifests.communityId, input.communityId)
              )
            )
            .for('update');
          if (!manifestRow) return { status: 'not_found' };

          const currentManifest = mapManifestRow(manifestRow);
          if (currentManifest.status === 'committed') {
            return { status: 'already_committed', manifest: currentManifest };
          }
          if (currentManifest.status !== 'previewed') {
            return { status: 'conflict', manifest: currentManifest };
          }
          if (input.dailyLimitWindow) {
            const hitDaily = await this.hasCommittedImportInWindow(
              input.dailyLimitWindow.startMs,
              input.dailyLimitWindow.endMs,
              tx
            );
            if (hitDaily) return { status: 'daily_limit' };
          }

          // Validate & lock referenced existing places
          if (refs.existingPlaceIds.length > 0) {
            const foundPlaces = new Set<number>();
            for (
              let i = 0;
              i < refs.existingPlaceIds.length;
              i += D1_ENTITY_LOOKUP_CHUNK
            ) {
              const chunk = refs.existingPlaceIds.slice(
                i,
                i + D1_ENTITY_LOOKUP_CHUNK
              );
              const rows = await tx
                .select({ id: this.tables.places.id })
                .from(this.tables.places)
                .where(
                  and(
                    eq(this.tables.places.communityId, input.communityId),
                    eq(this.tables.places.isRestricted, false),
                    inArray(this.tables.places.id, chunk)
                  )
                )
                .orderBy(asc(this.tables.places.id))
                .for('share');
              for (const r of rows as Array<{ id: number }>) {
                foundPlaces.add(Number(r.id));
              }
            }
            if (refs.existingPlaceIds.some((id) => !foundPlaces.has(id))) {
              return { status: 'failed_reference' };
            }
          }

          // Validate & lock referenced existing speakers
          if (refs.existingSpeakerIds.length > 0) {
            const foundSpeakers = new Set<number>();
            for (
              let i = 0;
              i < refs.existingSpeakerIds.length;
              i += D1_ENTITY_LOOKUP_CHUNK
            ) {
              const chunk = refs.existingSpeakerIds.slice(
                i,
                i + D1_ENTITY_LOOKUP_CHUNK
              );
              const rows = await tx
                .select({ id: this.tables.speakers.id })
                .from(this.tables.speakers)
                .where(
                  and(
                    eq(this.tables.speakers.communityId, input.communityId),
                    inArray(this.tables.speakers.id, chunk)
                  )
                )
                .orderBy(asc(this.tables.speakers.id))
                .for('share');
              for (const r of rows as Array<{ id: number }>) {
                foundSpeakers.add(Number(r.id));
              }
            }
            if (refs.existingSpeakerIds.some((id) => !foundSpeakers.has(id))) {
              return { status: 'failed_reference' };
            }
          }

          // Validate & lock all referenced files (staged + existing) sorted
          const allFileIds = Array.from(
            new Set([...stagedMediaIds, ...refs.existingFileIds])
          ).sort();
          const lockedFiles = new Map<
            string,
            {
              isActive: boolean;
              culturalRestrictions: unknown;
              uploadedBy: number | null;
            }
          >();
          for (let i = 0; i < allFileIds.length; i += D1_FILE_LOOKUP_CHUNK) {
            const chunk = allFileIds.slice(i, i + D1_FILE_LOOKUP_CHUNK);
            const rows = await tx
              .select({
                id: this.tables.files.id,
                isActive: this.tables.files.isActive,
                culturalRestrictions: this.tables.files.culturalRestrictions,
                uploadedBy: this.tables.files.uploadedBy,
              })
              .from(this.tables.files)
              .where(
                and(
                  eq(this.tables.files.communityId, input.communityId),
                  inArray(this.tables.files.id, chunk)
                )
              )
              .orderBy(asc(this.tables.files.id))
              .for('update');
            for (const r of rows as Array<{
              id: string;
              isActive: boolean;
              culturalRestrictions: unknown;
              uploadedBy: number | null;
            }>) {
              lockedFiles.set(r.id, {
                isActive: Boolean(r.isActive),
                culturalRestrictions: r.culturalRestrictions ?? null,
                uploadedBy: r.uploadedBy === null ? null : Number(r.uploadedBy),
              });
            }
          }
          for (const id of stagedMediaIds) {
            const f = lockedFiles.get(id);
            if (!f || f.isActive || f.culturalRestrictions !== null) {
              return { status: 'failed_reference' };
            }
          }
          const liveActor: FoundationUser = {
            ...input.actor,
            id: input.actorId,
            role: actorRow.role as FoundationUser['role'],
            communityId: input.communityId,
          };
          for (const id of refs.existingFileIds) {
            const f = lockedFiles.get(id);
            if (!f || !f.isActive || f.culturalRestrictions !== null) {
              return { status: 'failed_reference' };
            }
            // Revalidate reuse inside the atomic write unit under files FOR
            // UPDATE (without acquiring owner locks that could invert lock order).
            const reuse = await this.mediaRepository.authorizeAttachReuse({
              actor: liveActor,
              communityId: input.communityId,
              file: { id, uploadedBy: f.uploadedBy },
              executor: tx,
            });
            if (!reuse.ok) {
              if (
                actorRow.role !== 'admin' &&
                currentManifest.createdBy !== input.actorId
              ) {
                return { status: 'forbidden' };
              }
              return { status: 'failed_reference' };
            }
          }

          // Insert related places and speakers first
          const payloads = this.buildCommitEntityPayloads({
            communityId: input.communityId,
            actorId: input.actorId,
            normalizedData,
            now,
          });

          const createdPlaceByNorm = new Map<string, number>();
          if (payloads.relatedPlaces.length > 0) {
            const insertedPlaces: Array<{ id: number }> = [];
            for (const chunk of chunkRowsByBoundParamBudget(
              payloads.relatedPlaces,
              NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
              this.tableColumnBound(this.tables.places)
            )) {
              const rows = await tx
                .insert(this.tables.places)
                .values(chunk)
                .returning({ id: this.tables.places.id });
              insertedPlaces.push(...rows);
            }
            normalizedData.relatedPlacesToCreate.forEach((p, idx) => {
              createdPlaceByNorm.set(
                p.normalizedName,
                Number(insertedPlaces[idx]!.id)
              );
            });
          }

          const createdSpeakerByNorm = new Map<string, number>();
          if (payloads.relatedSpeakers.length > 0) {
            const insertedSpeakers: Array<{ id: number }> = [];
            for (const chunk of chunkRowsByBoundParamBudget(
              payloads.relatedSpeakers,
              NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
              this.tableColumnBound(this.tables.speakers)
            )) {
              const rows = await tx
                .insert(this.tables.speakers)
                .values(chunk)
                .returning({ id: this.tables.speakers.id });
              insertedSpeakers.push(...rows);
            }
            normalizedData.relatedSpeakersToCreate.forEach((sp, idx) => {
              createdSpeakerByNorm.set(
                sp.normalizedName,
                Number(insertedSpeakers[idx]!.id)
              );
            });
          }

          const resolvePlaceRef = (
            ref:
              | { kind: 'existing'; id: number }
              | { kind: 'create'; name: string; normalizedName: string }
              | null
          ): number | null => {
            if (!ref) return null;
            if (ref.kind === 'existing') return ref.id;
            const id = createdPlaceByNorm.get(ref.normalizedName);
            if (id === undefined) throw new RollbackReferenceError();
            return id;
          };

          const resolveSpeakerRef = (
            ref:
              | { kind: 'existing'; id: number }
              | { kind: 'create'; name: string; normalizedName: string }
              | null
          ): number | null => {
            if (!ref) return null;
            if (ref.kind === 'existing') return ref.id;
            const id = createdSpeakerByNorm.get(ref.normalizedName);
            if (id === undefined) throw new RollbackReferenceError();
            return id;
          };

          let attachmentsToInsert: Array<{
            communityId: number;
            fileId: string;
            ownerType: 'place' | 'speaker' | 'story';
            ownerId: number;
            role: string;
            ordinal: number;
            createdAt: Date;
          }> = [];

          if (normalizedData.kind === 'places') {
            const placeValues = payloads.buildPlaces();
            if (placeValues.length > 0) {
              const inserted: Array<{ id: number }> = [];
              for (const chunk of chunkRowsByBoundParamBudget(
                placeValues,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.places)
              )) {
                const rows = await tx
                  .insert(this.tables.places)
                  .values(chunk)
                  .returning({ id: this.tables.places.id });
                inserted.push(...rows);
              }
              attachmentsToInsert = payloads.collectEntityAttachments(
                'place',
                inserted.map((r: { id: number }) => Number(r.id))
              );
            }
          } else if (normalizedData.kind === 'speakers') {
            const speakerValues = payloads.buildSpeakers(resolvePlaceRef);
            if (speakerValues.length > 0) {
              const inserted: Array<{ id: number }> = [];
              for (const chunk of chunkRowsByBoundParamBudget(
                speakerValues,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.speakers)
              )) {
                const rows = await tx
                  .insert(this.tables.speakers)
                  .values(chunk)
                  .returning({ id: this.tables.speakers.id });
                inserted.push(...rows);
              }
              attachmentsToInsert = payloads.collectEntityAttachments(
                'speaker',
                inserted.map((r: { id: number }) => Number(r.id))
              );
            }
          } else {
            const storyValues = payloads.buildStories(
              resolvePlaceRef,
              resolveSpeakerRef
            );
            if (storyValues.length > 0) {
              const insertedStories: Array<{ id: number }> = [];
              for (const chunk of chunkRowsByBoundParamBudget(
                storyValues,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.stories)
              )) {
                const rows = await tx
                  .insert(this.tables.stories)
                  .values(chunk)
                  .returning({ id: this.tables.stories.id });
                insertedStories.push(...rows);
              }
              const children = payloads.collectStoryChildren(
                insertedStories.map((r: { id: number }) => Number(r.id)),
                resolvePlaceRef,
                resolveSpeakerRef
              );
              attachmentsToInsert = children.attachmentsToInsert;
              for (const chunk of chunkRowsByBoundParamBudget(
                children.storyPlacesToInsert,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.storyPlaces)
              )) {
                await tx.insert(this.tables.storyPlaces).values(chunk);
              }
              for (const chunk of chunkRowsByBoundParamBudget(
                children.storySpeakersToInsert,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.storySpeakers)
              )) {
                await tx.insert(this.tables.storySpeakers).values(chunk);
              }
              for (const chunk of chunkRowsByBoundParamBudget(
                children.externalLinksToInsert,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.externalMediaLinks)
              )) {
                await tx.insert(this.tables.externalMediaLinks).values(chunk);
              }
            }
          }

          for (const chunk of chunkRowsByBoundParamBudget(
            attachmentsToInsert,
            NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
            this.tableColumnBound(this.tables.attachments)
          )) {
            await tx.insert(this.tables.attachments).values(chunk);
          }

          if (stagedMediaIds.length > 0) {
            let activatedCount = 0;
            for (
              let i = 0;
              i < stagedMediaIds.length;
              i += COMMIT_FILE_ACTIVATE_CHUNK
            ) {
              const chunk = stagedMediaIds.slice(
                i,
                i + COMMIT_FILE_ACTIVATE_CHUNK
              );
              const activated = await tx
                .update(this.tables.files)
                .set({ isActive: true, updatedAt: now })
                .where(
                  and(
                    inArray(this.tables.files.id, chunk),
                    eq(this.tables.files.communityId, input.communityId),
                    eq(this.tables.files.isActive, false)
                  )
                )
                .returning({ id: this.tables.files.id });
              activatedCount += activated.length;
            }
            if (activatedCount !== stagedMediaIds.length) {
              throw new RollbackReferenceError();
            }
          }

          const [updated] = await tx
            .update(this.tables.importManifests)
            .set({
              status: 'committed',
              resultSummary: resultSummary as unknown as Record<
                string,
                unknown
              >,
              committedAt: nowMs,
            })
            .where(
              and(
                eq(this.tables.importManifests.id, manifest.id),
                eq(this.tables.importManifests.communityId, input.communityId),
                eq(this.tables.importManifests.status, 'previewed')
              )
            )
            .returning(this.manifestSelectColumns());
          if (!updated) throw new RollbackReferenceError();

          await tx.insert(this.tables.auditEntries).values({
            ...audit,
            createdAt: now,
          });

          reachedCommit = true;
          return {
            status: 'committed',
            manifest: mapManifestRow(updated),
          };
        });
      } catch (err) {
        if (
          err instanceof RollbackReferenceError ||
          isNotNullConstraintError(err) ||
          isForeignKeyConstraintError(err) ||
          isUniqueConstraintError(err) ||
          isCheckConstraintError(err)
        ) {
          return { status: 'failed_reference' };
        }
        return reachedCommit
          ? { status: 'uncertain' }
          : { status: 'failed_rolled_back' };
      }
    }

    // better-sqlite3 synchronous transaction
    let reachedCommit = false;
    try {
      return this.db.transaction(
        (tx: typeof this.db): CommitManifestOutcome => {
          const comm = tx
            .select({ id: this.tables.communities.id })
            .from(this.tables.communities)
            .where(
              and(
                eq(this.tables.communities.id, input.communityId),
                eq(this.tables.communities.isActive, true)
              )
            )
            .limit(1)
            .all()[0];
          if (!comm) return { status: 'forbidden' };

          const actorRow = tx
            .select({ role: this.tables.users.role })
            .from(this.tables.users)
            .where(
              and(
                eq(this.tables.users.id, input.actorId),
                eq(this.tables.users.communityId, input.communityId),
                eq(this.tables.users.isActive, true),
                inArray(this.tables.users.role, ['editor', 'admin'])
              )
            )
            .limit(1)
            .all()[0];
          if (!actorRow) return { status: 'forbidden' };

          const manifestRow = tx
            .select(this.manifestSelectColumns())
            .from(this.tables.importManifests)
            .where(
              and(
                eq(this.tables.importManifests.id, manifest.id),
                eq(this.tables.importManifests.communityId, input.communityId)
              )
            )
            .limit(1)
            .all()[0];
          if (!manifestRow) return { status: 'not_found' };

          const currentManifest = mapManifestRow(manifestRow);
          if (currentManifest.status === 'committed') {
            return { status: 'already_committed', manifest: currentManifest };
          }
          if (currentManifest.status !== 'previewed') {
            return { status: 'conflict', manifest: currentManifest };
          }
          if (input.dailyLimitWindow) {
            const hitDaily = tx
              .select({ id: this.tables.importManifests.id })
              .from(this.tables.importManifests)
              .where(
                and(
                  eq(this.tables.importManifests.status, 'committed'),
                  gte(
                    this.tables.importManifests.committedAt,
                    input.dailyLimitWindow.startMs
                  ),
                  lt(
                    this.tables.importManifests.committedAt,
                    input.dailyLimitWindow.endMs
                  )
                )
              )
              .limit(1)
              .all();
            if (hitDaily.length > 0) return { status: 'daily_limit' };
          }

          // Validate referenced places, speakers, and files synchronously
          if (refs.existingPlaceIds.length > 0) {
            const foundPlaces = new Set<number>();
            for (
              let i = 0;
              i < refs.existingPlaceIds.length;
              i += D1_ENTITY_LOOKUP_CHUNK
            ) {
              const chunk = refs.existingPlaceIds.slice(
                i,
                i + D1_ENTITY_LOOKUP_CHUNK
              );
              const rows = tx
                .select({ id: this.tables.places.id })
                .from(this.tables.places)
                .where(
                  and(
                    eq(this.tables.places.communityId, input.communityId),
                    eq(this.tables.places.isRestricted, false),
                    inArray(this.tables.places.id, chunk)
                  )
                )
                .all() as Array<{ id: number }>;
              for (const r of rows) foundPlaces.add(Number(r.id));
            }
            if (refs.existingPlaceIds.some((id) => !foundPlaces.has(id))) {
              return { status: 'failed_reference' };
            }
          }

          if (refs.existingSpeakerIds.length > 0) {
            const foundSpeakers = new Set<number>();
            for (
              let i = 0;
              i < refs.existingSpeakerIds.length;
              i += D1_ENTITY_LOOKUP_CHUNK
            ) {
              const chunk = refs.existingSpeakerIds.slice(
                i,
                i + D1_ENTITY_LOOKUP_CHUNK
              );
              const rows = tx
                .select({ id: this.tables.speakers.id })
                .from(this.tables.speakers)
                .where(
                  and(
                    eq(this.tables.speakers.communityId, input.communityId),
                    inArray(this.tables.speakers.id, chunk)
                  )
                )
                .all() as Array<{ id: number }>;
              for (const r of rows) foundSpeakers.add(Number(r.id));
            }
            if (refs.existingSpeakerIds.some((id) => !foundSpeakers.has(id))) {
              return { status: 'failed_reference' };
            }
          }

          const allFileIds = Array.from(
            new Set([...stagedMediaIds, ...refs.existingFileIds])
          ).sort();
          const foundFiles = new Map<
            string,
            {
              isActive: boolean;
              culturalRestrictions: unknown;
              uploadedBy: number | null;
            }
          >();
          for (let i = 0; i < allFileIds.length; i += D1_FILE_LOOKUP_CHUNK) {
            const chunk = allFileIds.slice(i, i + D1_FILE_LOOKUP_CHUNK);
            const rows = tx
              .select({
                id: this.tables.files.id,
                isActive: this.tables.files.isActive,
                culturalRestrictions: this.tables.files.culturalRestrictions,
                uploadedBy: this.tables.files.uploadedBy,
              })
              .from(this.tables.files)
              .where(
                and(
                  eq(this.tables.files.communityId, input.communityId),
                  inArray(this.tables.files.id, chunk)
                )
              )
              .all() as Array<{
              id: string;
              isActive: boolean | number;
              culturalRestrictions: unknown;
              uploadedBy: number | null;
            }>;
            for (const r of rows) {
              foundFiles.set(r.id, {
                isActive: r.isActive === true || r.isActive === 1,
                culturalRestrictions: r.culturalRestrictions ?? null,
                uploadedBy: r.uploadedBy === null ? null : Number(r.uploadedBy),
              });
            }
          }
          for (const id of stagedMediaIds) {
            const f = foundFiles.get(id);
            if (!f || f.isActive || f.culturalRestrictions !== null) {
              return { status: 'failed_reference' };
            }
          }
          for (const id of refs.existingFileIds) {
            const f = foundFiles.get(id);
            if (!f || !f.isActive || f.culturalRestrictions !== null) {
              return { status: 'failed_reference' };
            }
            const reuseOk = this.authorizeExistingFileReuseSqlite(tx, {
              communityId: input.communityId,
              actorId: input.actorId,
              actorRole: actorRow.role as 'editor' | 'admin',
              fileId: id,
              uploadedBy: f.uploadedBy,
            });
            if (!reuseOk) {
              if (
                actorRow.role !== 'admin' &&
                currentManifest.createdBy !== input.actorId
              ) {
                return { status: 'forbidden' };
              }
              return { status: 'failed_reference' };
            }
          }

          const payloads = this.buildCommitEntityPayloads({
            communityId: input.communityId,
            actorId: input.actorId,
            normalizedData,
            now,
          });

          const createdPlaceByNorm = new Map<string, number>();
          if (payloads.relatedPlaces.length > 0) {
            const insertedPlaces: Array<{ id: number }> = [];
            for (const chunk of chunkRowsByBoundParamBudget(
              payloads.relatedPlaces,
              NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
              this.tableColumnBound(this.tables.places)
            )) {
              const rows = tx
                .insert(this.tables.places)
                .values(chunk)
                .returning({ id: this.tables.places.id })
                .all() as Array<{ id: number }>;
              insertedPlaces.push(...rows);
            }
            normalizedData.relatedPlacesToCreate.forEach((p, idx) => {
              createdPlaceByNorm.set(
                p.normalizedName,
                Number(insertedPlaces[idx]!.id)
              );
            });
          }

          const createdSpeakerByNorm = new Map<string, number>();
          if (payloads.relatedSpeakers.length > 0) {
            const insertedSpeakers: Array<{ id: number }> = [];
            for (const chunk of chunkRowsByBoundParamBudget(
              payloads.relatedSpeakers,
              NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
              this.tableColumnBound(this.tables.speakers)
            )) {
              const rows = tx
                .insert(this.tables.speakers)
                .values(chunk)
                .returning({ id: this.tables.speakers.id })
                .all() as Array<{ id: number }>;
              insertedSpeakers.push(...rows);
            }
            normalizedData.relatedSpeakersToCreate.forEach((sp, idx) => {
              createdSpeakerByNorm.set(
                sp.normalizedName,
                Number(insertedSpeakers[idx]!.id)
              );
            });
          }

          const resolvePlaceRef = (
            ref:
              | { kind: 'existing'; id: number }
              | { kind: 'create'; name: string; normalizedName: string }
              | null
          ): number | null => {
            if (!ref) return null;
            if (ref.kind === 'existing') return ref.id;
            const id = createdPlaceByNorm.get(ref.normalizedName);
            if (id === undefined) throw new RollbackReferenceError();
            return id;
          };

          const resolveSpeakerRef = (
            ref:
              | { kind: 'existing'; id: number }
              | { kind: 'create'; name: string; normalizedName: string }
              | null
          ): number | null => {
            if (!ref) return null;
            if (ref.kind === 'existing') return ref.id;
            const id = createdSpeakerByNorm.get(ref.normalizedName);
            if (id === undefined) throw new RollbackReferenceError();
            return id;
          };

          let attachmentsToInsert: Array<{
            communityId: number;
            fileId: string;
            ownerType: 'place' | 'speaker' | 'story';
            ownerId: number;
            role: string;
            ordinal: number;
            createdAt: Date;
          }> = [];

          if (normalizedData.kind === 'places') {
            const placeValues = payloads.buildPlaces();
            if (placeValues.length > 0) {
              const inserted: Array<{ id: number }> = [];
              for (const chunk of chunkRowsByBoundParamBudget(
                placeValues,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.places)
              )) {
                const rows = tx
                  .insert(this.tables.places)
                  .values(chunk)
                  .returning({ id: this.tables.places.id })
                  .all() as Array<{ id: number }>;
                inserted.push(...rows);
              }
              attachmentsToInsert = payloads.collectEntityAttachments(
                'place',
                inserted.map((r) => Number(r.id))
              );
            }
          } else if (normalizedData.kind === 'speakers') {
            const speakerValues = payloads.buildSpeakers(resolvePlaceRef);
            if (speakerValues.length > 0) {
              const inserted: Array<{ id: number }> = [];
              for (const chunk of chunkRowsByBoundParamBudget(
                speakerValues,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.speakers)
              )) {
                const rows = tx
                  .insert(this.tables.speakers)
                  .values(chunk)
                  .returning({ id: this.tables.speakers.id })
                  .all() as Array<{ id: number }>;
                inserted.push(...rows);
              }
              attachmentsToInsert = payloads.collectEntityAttachments(
                'speaker',
                inserted.map((r) => Number(r.id))
              );
            }
          } else {
            const storyValues = payloads.buildStories(
              resolvePlaceRef,
              resolveSpeakerRef
            );
            if (storyValues.length > 0) {
              const insertedStories: Array<{ id: number }> = [];
              for (const chunk of chunkRowsByBoundParamBudget(
                storyValues,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.stories)
              )) {
                const rows = tx
                  .insert(this.tables.stories)
                  .values(chunk)
                  .returning({ id: this.tables.stories.id })
                  .all() as Array<{ id: number }>;
                insertedStories.push(...rows);
              }
              const children = payloads.collectStoryChildren(
                insertedStories.map((r) => Number(r.id)),
                resolvePlaceRef,
                resolveSpeakerRef
              );
              attachmentsToInsert = children.attachmentsToInsert;
              for (const chunk of chunkRowsByBoundParamBudget(
                children.storyPlacesToInsert,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.storyPlaces)
              )) {
                tx.insert(this.tables.storyPlaces).values(chunk).run();
              }
              for (const chunk of chunkRowsByBoundParamBudget(
                children.storySpeakersToInsert,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.storySpeakers)
              )) {
                tx.insert(this.tables.storySpeakers).values(chunk).run();
              }
              for (const chunk of chunkRowsByBoundParamBudget(
                children.externalLinksToInsert,
                NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
                this.tableColumnBound(this.tables.externalMediaLinks)
              )) {
                tx.insert(this.tables.externalMediaLinks).values(chunk).run();
              }
            }
          }

          for (const chunk of chunkRowsByBoundParamBudget(
            attachmentsToInsert,
            NODE_MAX_BOUND_PARAMS_PER_STATEMENT,
            this.tableColumnBound(this.tables.attachments)
          )) {
            tx.insert(this.tables.attachments).values(chunk).run();
          }

          if (stagedMediaIds.length > 0) {
            let activatedCount = 0;
            for (
              let i = 0;
              i < stagedMediaIds.length;
              i += COMMIT_FILE_ACTIVATE_CHUNK
            ) {
              const chunk = stagedMediaIds.slice(
                i,
                i + COMMIT_FILE_ACTIVATE_CHUNK
              );
              const activated = tx
                .update(this.tables.files)
                .set({ isActive: true, updatedAt: now })
                .where(
                  and(
                    inArray(this.tables.files.id, chunk),
                    eq(this.tables.files.communityId, input.communityId),
                    eq(this.tables.files.isActive, false)
                  )
                )
                .returning({ id: this.tables.files.id })
                .all() as Array<{ id: string }>;
              activatedCount += activated.length;
            }
            if (activatedCount !== stagedMediaIds.length) {
              throw new RollbackReferenceError();
            }
          }

          const updated = tx
            .update(this.tables.importManifests)
            .set({
              status: 'committed',
              resultSummary: resultSummary as unknown as Record<
                string,
                unknown
              >,
              committedAt: nowMs,
            })
            .where(
              and(
                eq(this.tables.importManifests.id, manifest.id),
                eq(this.tables.importManifests.communityId, input.communityId),
                eq(this.tables.importManifests.status, 'previewed')
              )
            )
            .returning(this.manifestSelectColumns())
            .all()[0];
          if (!updated) throw new RollbackReferenceError();

          tx.insert(this.tables.auditEntries)
            .values({
              ...audit,
              createdAt: now,
            })
            .run();

          reachedCommit = true;
          return {
            status: 'committed',
            manifest: mapManifestRow(updated),
          };
        }
      );
    } catch (err) {
      if (
        err instanceof RollbackReferenceError ||
        isNotNullConstraintError(err) ||
        isForeignKeyConstraintError(err) ||
        isUniqueConstraintError(err) ||
        isCheckConstraintError(err)
      ) {
        return { status: 'failed_reference' };
      }
      return reachedCommit
        ? { status: 'uncertain' }
        : { status: 'failed_rolled_back' };
    }
  }

  async failManifest(input: {
    communityId: number;
    actorId: number;
    manifestId: number;
    now: Date;
  }): Promise<FailManifestOutcome> {
    const now = input.now;
    const nowMs = now.getTime();
    const isPg = dialectOf(this.connection) === 'postgresql';
    const audit = buildImportAuditEntry({
      communityId: input.communityId,
      actorId: input.actorId,
      action: 'import.commit',
      manifestId: input.manifestId,
      outcome: 'failed',
    });

    if (this.hasD1Batch()) {
      const existing = await this.getManifestById(
        input.communityId,
        input.manifestId
      );
      if (!existing) return { status: 'not_found' };
      if (existing.status === 'committed') {
        return { status: 'already_committed', manifest: existing };
      }
      if (existing.status !== 'previewed') {
        return { status: 'already_terminal', manifest: existing };
      }

      const activeCommunityGuard = sql`EXISTS (
        SELECT 1 FROM communities c
        WHERE c.id = ${input.communityId} AND c.is_active = 1
      )`;
      const activeActorGuard = sql`EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = ${input.actorId}
          AND u.community_id = ${input.communityId}
          AND u.is_active = 1
          AND u.role IN ('editor', 'admin')
      )`;
      const previewedManifestGuard = sql`EXISTS (
        SELECT 1 FROM import_manifests im
        WHERE im.id = ${input.manifestId}
          AND im.community_id = ${input.communityId}
          AND im.status = 'previewed'
          AND ${activeActorGuard}
          AND ${activeCommunityGuard}
      )`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statements: any[] = [];
      const stagedIds = Array.from(new Set(existing.stagedFileIds))
        .filter((id) => id !== existing.sourceFileId)
        .sort();
      const deleteBatchIndexes: number[] = [];
      for (let i = 0; i < stagedIds.length; i += 70) {
        const chunk = stagedIds.slice(i, i + 70);
        deleteBatchIndexes.push(statements.length);
        statements.push(
          this.db
            .delete(this.tables.files)
            .where(
              and(
                inArray(this.tables.files.id, chunk),
                eq(this.tables.files.communityId, input.communityId),
                eq(this.tables.files.isActive, false),
                previewedManifestGuard,
                notExists(
                  this.db
                    .select({ id: this.tables.attachments.id })
                    .from(this.tables.attachments)
                    .where(
                      eq(this.tables.attachments.fileId, this.tables.files.id)
                    )
                ),
                notExists(
                  this.db
                    .select({ id: this.tables.importManifests.id })
                    .from(this.tables.importManifests)
                    .where(
                      eq(
                        this.tables.importManifests.sourceFileId,
                        this.tables.files.id
                      )
                    )
                )
              )
            )
            .returning({
              id: this.tables.files.id,
              storageKey: this.tables.files.storageKey,
              path: this.tables.files.path,
            })
        );
      }

      statements.push(
        this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: this.tables.importManifests.communityId,
              actorId: sql`${audit.actorId}`.as('actor_id'),
              action: sql`${audit.action}`.as('action'),
              resourceType: sql`${audit.resourceType}`.as('resource_type'),
              resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
                'resource_ids'
              ),
              outcome: sql`${audit.outcome}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.importManifests)
            .where(
              and(
                eq(this.tables.importManifests.id, input.manifestId),
                eq(this.tables.importManifests.communityId, input.communityId),
                eq(this.tables.importManifests.status, 'previewed'),
                activeActorGuard,
                activeCommunityGuard
              )
            )
        )
      );

      const updateIdx = statements.length;
      statements.push(
        this.db
          .update(this.tables.importManifests)
          .set({ status: 'failed' })
          .where(
            and(
              eq(this.tables.importManifests.id, input.manifestId),
              eq(this.tables.importManifests.communityId, input.communityId),
              eq(this.tables.importManifests.status, 'previewed'),
              activeActorGuard,
              activeCommunityGuard
            )
          )
          .returning(this.manifestSelectColumns())
      );

      const results = await this.db.batch(statements);
      const updatedRows = results[updateIdx];
      const updated = Array.isArray(updatedRows) ? updatedRows[0] : undefined;
      if (!updated) {
        const commActive = await this.activeCommunityExists(input.communityId);
        if (!commActive) return { status: 'forbidden' };
        const actorRows = await this.db
          .select({ role: this.tables.users.role })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actorId),
              eq(this.tables.users.communityId, input.communityId),
              eq(this.tables.users.isActive, true),
              inArray(this.tables.users.role, ['editor', 'admin'])
            )
          )
          .limit(1);
        if (actorRows.length === 0) return { status: 'forbidden' };
        const after = await this.getManifestById(
          input.communityId,
          input.manifestId
        );
        if (!after) return { status: 'not_found' };
        if (after.status === 'committed') {
          return { status: 'already_committed', manifest: after };
        }
        return { status: 'already_terminal', manifest: after };
      }

      const deletedFileRows: Array<{
        id: string;
        storageKey?: string | null;
        storage_key?: string | null;
        path: string;
      }> = [];
      for (const idx of deleteBatchIndexes) {
        if (Array.isArray(results[idx])) {
          deletedFileRows.push(...results[idx]);
        }
      }

      return {
        status: 'failed',
        manifest: mapManifestRow(updated),
        removedFiles: toFileByteCleanups(deletedFileRows),
      };
    }

    if (isPg) {
      return this.db.transaction(async (tx: typeof this.db) => {
        const [comm] = await tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, input.communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .for('share');
        if (!comm) return { status: 'forbidden' };

        const [actorRow] = await tx
          .select({ role: this.tables.users.role })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actorId),
              eq(this.tables.users.communityId, input.communityId),
              eq(this.tables.users.isActive, true),
              inArray(this.tables.users.role, ['editor', 'admin'])
            )
          )
          .for('share');
        if (!actorRow) return { status: 'forbidden' };

        const [manifestRow] = await tx
          .select(this.manifestSelectColumns())
          .from(this.tables.importManifests)
          .where(
            and(
              eq(this.tables.importManifests.id, input.manifestId),
              eq(this.tables.importManifests.communityId, input.communityId)
            )
          )
          .for('update');
        if (!manifestRow) return { status: 'not_found' };

        const current = mapManifestRow(manifestRow);
        if (current.status === 'committed') {
          return { status: 'already_committed', manifest: current };
        }
        if (current.status !== 'previewed') {
          return { status: 'already_terminal', manifest: current };
        }

        const [updated] = await tx
          .update(this.tables.importManifests)
          .set({ status: 'failed' })
          .where(
            and(
              eq(this.tables.importManifests.id, input.manifestId),
              eq(this.tables.importManifests.communityId, input.communityId),
              eq(this.tables.importManifests.status, 'previewed')
            )
          )
          .returning(this.manifestSelectColumns());
        if (!updated) {
          return { status: 'already_terminal', manifest: current };
        }

        const stagedIds = Array.from(
          new Set(parseJsonColumn<string[]>(manifestRow.stagedFileIds))
        )
          .filter((id) => id !== manifestRow.sourceFileId)
          .sort();
        const lockedIds = await lockFileRowsForCleanup(
          tx,
          this.connection,
          stagedIds
        );
        const removedRows: Array<{
          id: string;
          storageKey: string | null;
          path: string;
        }> = [];
        for (let i = 0; i < lockedIds.length; i += 80) {
          const chunk = lockedIds.slice(i, i + 80);
          const deleted = await tx
            .delete(this.tables.files)
            .where(
              and(
                inArray(this.tables.files.id, chunk),
                eq(this.tables.files.communityId, input.communityId),
                eq(this.tables.files.isActive, false),
                notExists(
                  tx
                    .select({ id: this.tables.attachments.id })
                    .from(this.tables.attachments)
                    .where(
                      eq(this.tables.attachments.fileId, this.tables.files.id)
                    )
                ),
                notExists(
                  tx
                    .select({ id: this.tables.importManifests.id })
                    .from(this.tables.importManifests)
                    .where(
                      eq(
                        this.tables.importManifests.sourceFileId,
                        this.tables.files.id
                      )
                    )
                )
              )
            )
            .returning({
              id: this.tables.files.id,
              storageKey: this.tables.files.storageKey,
              path: this.tables.files.path,
            });
          removedRows.push(...deleted);
        }

        await tx.insert(this.tables.auditEntries).values({
          ...audit,
          createdAt: now,
        });

        return {
          status: 'failed',
          manifest: mapManifestRow(updated),
          removedFiles: toFileByteCleanups(removedRows),
        };
      });
    }

    return this.db.transaction((tx: typeof this.db) => {
      const comm = tx
        .select({ id: this.tables.communities.id })
        .from(this.tables.communities)
        .where(
          and(
            eq(this.tables.communities.id, input.communityId),
            eq(this.tables.communities.isActive, true)
          )
        )
        .limit(1)
        .all()[0];
      if (!comm) return { status: 'forbidden' };

      const actorRow = tx
        .select({ role: this.tables.users.role })
        .from(this.tables.users)
        .where(
          and(
            eq(this.tables.users.id, input.actorId),
            eq(this.tables.users.communityId, input.communityId),
            eq(this.tables.users.isActive, true),
            inArray(this.tables.users.role, ['editor', 'admin'])
          )
        )
        .limit(1)
        .all()[0];
      if (!actorRow) return { status: 'forbidden' };

      const manifestRow = tx
        .select(this.manifestSelectColumns())
        .from(this.tables.importManifests)
        .where(
          and(
            eq(this.tables.importManifests.id, input.manifestId),
            eq(this.tables.importManifests.communityId, input.communityId)
          )
        )
        .limit(1)
        .all()[0];
      if (!manifestRow) return { status: 'not_found' };

      const current = mapManifestRow(manifestRow);
      if (current.status === 'committed') {
        return { status: 'already_committed', manifest: current };
      }
      if (current.status !== 'previewed') {
        return { status: 'already_terminal', manifest: current };
      }

      const updated = tx
        .update(this.tables.importManifests)
        .set({ status: 'failed' })
        .where(
          and(
            eq(this.tables.importManifests.id, input.manifestId),
            eq(this.tables.importManifests.communityId, input.communityId),
            eq(this.tables.importManifests.status, 'previewed')
          )
        )
        .returning(this.manifestSelectColumns())
        .all()[0];
      if (!updated) {
        return { status: 'already_terminal', manifest: current };
      }

      const stagedIds = Array.from(
        new Set(parseJsonColumn<string[]>(manifestRow.stagedFileIds))
      )
        .filter((id) => id !== manifestRow.sourceFileId)
        .sort();
      const removedRows: Array<{
        id: string;
        storageKey: string | null;
        path: string;
      }> = [];
      for (let i = 0; i < stagedIds.length; i += 80) {
        const chunk = stagedIds.slice(i, i + 80);
        const deleted = tx
          .delete(this.tables.files)
          .where(
            and(
              inArray(this.tables.files.id, chunk),
              eq(this.tables.files.communityId, input.communityId),
              eq(this.tables.files.isActive, false),
              notExists(
                tx
                  .select({ id: this.tables.attachments.id })
                  .from(this.tables.attachments)
                  .where(
                    eq(this.tables.attachments.fileId, this.tables.files.id)
                  )
              ),
              notExists(
                tx
                  .select({ id: this.tables.importManifests.id })
                  .from(this.tables.importManifests)
                  .where(
                    eq(
                      this.tables.importManifests.sourceFileId,
                      this.tables.files.id
                    )
                  )
              )
            )
          )
          .returning({
            id: this.tables.files.id,
            storageKey: this.tables.files.storageKey,
            path: this.tables.files.path,
          })
          .all();
        removedRows.push(...deleted);
      }

      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();

      return {
        status: 'failed',
        manifest: mapManifestRow(updated),
        removedFiles: toFileByteCleanups(removedRows),
      };
    });
  }
}
