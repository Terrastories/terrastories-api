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
  desc,
  eq,
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
  ImportResultSummary,
  ImportRowError,
  ImportStoredMappings,
  StoredNormalizedImportData,
} from '../shared/schemas/imports.js';
import {
  lockFileRowsForCleanup,
  toFileByteCleanups,
  type FileByteCleanup,
} from '../services/media-cleanup.service.js';
import { validateContentFreeAuditEntry } from '../shared/utils/audit-entry.js';

const D1_FILE_LOOKUP_CHUNK = 80;
const READABLE_PRIVACY_LEVELS = ['public', 'members_only', 'editors'] as const;

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
  action: 'import.preview' | 'import.discard';
  manifestId: number;
  outcome: 'success' | 'denied';
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

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
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
          await tx.insert(this.tables.files).values(sortedFiles);
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
        tx.insert(this.tables.files).values(insertFilesValues).run();
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
}
