/**
 * Deterministic D1 commit-plan and budget validator (SPEC-V2 §4, §5, §6.9;
 * `docs/spikes/WORKERS-FREE-2026-11.md` §3).
 *
 * Counts every statement, bound parameter, UTF-8 statement byte size, and
 * estimated D1 row write (table row + index entries) across preview and commit,
 * including `ImportManifest`, staged `File` writes/activations, entity/edge
 * inserts, and `AuditEntry` bookkeeping rows.
 *
 * Pure TypeScript with zero Node-only or DB imports.
 */
import type {
  ImportCommitPlanSummary,
  ImportResultSummary,
  StoredNormalizedImportData,
} from '../schemas/imports.js';

export const D1_MAX_BATCH_STATEMENTS = 1_000;
export const D1_MAX_BOUND_PARAMS_PER_STATEMENT = 100;
export const D1_MAX_STATEMENT_BYTES = 100 * 1024; // 100 KB
export const D1_MAX_ESTIMATED_ROWS_WRITTEN = 50_000; // Half of Workers Free 100k/day quota
export const D1_MAX_COMMITTED_IMPORTS_PER_UTC_DAY = 1;

export const D1_BUDGET_ALTERNATIVES_MESSAGE =
  'Use the offline field kit or a self-hosted Node.js deployment (SQLite or PostgreSQL).';

/**
 * Exact SQLite/D1 row-write costs per operation (1 table row + every active
 * index entry written on that table, matching `src/db/migrations/*`).
 */
export const D1_ROW_WRITE_COSTS = {
  filesInsert: 10, // 1 table + 1 text PK autoindex + 8 indexes
  filesActivateUpdate: 3, // 1 table + files_active_idx update (old + new)
  importManifestInsert: 6, // 1 table + 5 indexes
  importManifestCommitUpdate: 5, // 1 table + 2 status index updates (4)
  auditEntryInsert: 3, // 1 table + 2 unconditional indexes
  placeInsert: 4, // 1 table + 3 indexes
  speakerInsert: 7, // 1 table + 6 indexes
  storyInsert: 7, // 1 table + 6 indexes
  storyPlaceInsert: 2, // 1 table + 1 index
  storySpeakerInsert: 2, // 1 table + 1 index
  attachmentInsert: 3, // 1 table + 2 indexes
  externalMediaLinkInsert: 2, // 1 table + 1 index
} as const;

export interface PlannedStatementMetric {
  label: string;
  boundParams: number;
  statementBytes: number;
  estimatedRowsWritten: number;
}

export interface D1BudgetViolation {
  limit:
    | 'max_statements'
    | 'max_bound_params'
    | 'max_statement_bytes'
    | 'max_rows_written';
  actual: number;
  max: number;
  message: string;
}

export interface ImportCommitPlanResult {
  summary: ImportCommitPlanSummary;
  previewStatements: PlannedStatementMetric[];
  commitStatements: PlannedStatementMetric[];
  violations: D1BudgetViolation[];
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

function serializedParamBytes(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).length;
  }
  if (typeof value === 'string') {
    return utf8ByteLength(value);
  }
  return utf8ByteLength(JSON.stringify(value));
}

function estimateInsertStatementBytes(
  sqlSkeletonBytes: number,
  values: ReadonlyArray<unknown>
): number {
  let total = sqlSkeletonBytes;
  for (const val of values) {
    total += serializedParamBytes(val) + 2;
  }
  return total;
}

const FILE_INSERT_SQL_BYTES = 340;
const FILE_INSERT_PARAMS_PER_ROW = 17;
const MANIFEST_INSERT_SQL_BYTES = 360;
const MANIFEST_COMMIT_SQL_BYTES = 260;
const AUDIT_INSERT_SQL_BYTES = 220;
export const PLACE_INSERT_SQL_BYTES = 240;
export const SPEAKER_INSERT_SQL_BYTES = 220;
const STORY_INSERT_SQL_BYTES = 340;
const STORY_EDGE_SQL_BYTES = 220;
const ATTACHMENT_INSERT_SQL_BYTES = 240;
const EXTERNAL_LINK_INSERT_SQL_BYTES = 200;
const ACTIVATE_FILES_SQL_BYTES = 180;

/** Staged file inserts run 1 row per preview batch statement (19 params <= 100). */
export const PREVIEW_FILES_INSERT_CHUNK = 1;
/** Max file IDs per activation UPDATE statement (80 + 10 = 90 <= 100). */
export const COMMIT_FILE_ACTIVATE_CHUNK = 80;
/** Max places per multi-row INSERT statement (9 * 10 = 90 <= 100). */
export const COMMIT_PLACE_INSERT_CHUNK = 9;
/** Max speakers per multi-row INSERT statement (12 * 8 = 96 <= 100). */
export const COMMIT_SPEAKER_INSERT_CHUNK = 12;
/** Max child edge/link rows per multi-row INSERT statement (<= 96 params). */
export const COMMIT_CHILD_ROW_CHUNK = 15;

export function utcDayWindowMs(now: Date): { startMs: number; endMs: number } {
  const startMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0
  );
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

export function estimateRelatedRecordBytes(item: { name: string }): number {
  return serializedParamBytes(item.name) + 64;
}

export function estimatePlaceRowBytes(row: {
  name: string;
  description: string | null;
  descriptionPlain: string | null;
  typeOfPlace: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
}): number {
  return estimateInsertStatementBytes(64, [
    row.name,
    row.description,
    row.descriptionPlain,
    row.typeOfPlace,
    row.region,
    row.latitude,
    row.longitude,
  ]);
}

export function estimateSpeakerRowBytes(row: {
  name: string;
  birthDate: string | null;
  affiliation: string | null;
  birthplaceRef:
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
    | null;
}): number {
  return estimateInsertStatementBytes(64, [
    row.name,
    row.birthDate,
    row.affiliation,
    row.birthplaceRef?.kind === 'existing'
      ? row.birthplaceRef.id
      : (row.birthplaceRef?.name ?? null),
  ]);
}

export function computeImportResultSummary(
  normalizedData: StoredNormalizedImportData
): ImportResultSummary {
  let createdAttachments = 0;
  for (const row of normalizedData.rows) {
    createdAttachments += row.attachments.length;
  }

  let createdStoryPlaces = 0;
  let createdStorySpeakers = 0;
  let createdExternalLinks = 0;
  if (normalizedData.kind === 'stories') {
    for (const row of normalizedData.rows) {
      createdStoryPlaces += row.placeRefs.length;
      createdStorySpeakers += row.speakerRefs.length;
      createdExternalLinks += row.externalMediaLinks.length;
    }
  }

  return {
    createdPlaces:
      normalizedData.relatedPlacesToCreate.length +
      (normalizedData.kind === 'places' ? normalizedData.rows.length : 0),
    createdSpeakers:
      normalizedData.relatedSpeakersToCreate.length +
      (normalizedData.kind === 'speakers' ? normalizedData.rows.length : 0),
    createdStories:
      normalizedData.kind === 'stories' ? normalizedData.rows.length : 0,
    createdStoryPlaces,
    createdStorySpeakers,
    createdAttachments,
    createdExternalLinks,
    skippedDuplicates: normalizedData.skippedDuplicates,
  };
}

export function chunkImportItemsByBudget<T>(
  items: ReadonlyArray<T>,
  maxRowsPerStmt: number,
  maxParamsPerStmt: number,
  paramsPerRow: number,
  sqlOverheadBytes: number,
  rowBytesFn: (item: T) => number
): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  let current: T[] = [];
  let batchParams = 0;
  let batchBytes = sqlOverheadBytes;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    batchParams = 0;
    batchBytes = sqlOverheadBytes;
  };

  for (const item of items) {
    const itemBytes = rowBytesFn(item);
    const exceedsCount = current.length >= maxRowsPerStmt;
    const exceedsParams = batchParams + paramsPerRow > maxParamsPerStmt;
    const exceedsBytes =
      current.length > 0 && batchBytes + itemBytes > D1_MAX_STATEMENT_BYTES;

    if (exceedsCount || exceedsParams || exceedsBytes) {
      flush();
    }
    current.push(item);
    batchParams += paramsPerRow;
    batchBytes += itemBytes;
  }
  flush();
  return chunks;
}

function chunkIntoMultiRowStatements<T>(
  items: ReadonlyArray<T>,
  maxRowsPerStmt: number,
  maxParamsPerStmt: number,
  paramsPerRow: number,
  sqlOverheadBytes: number,
  rowBytesFn: (item: T) => number,
  label: string,
  rowsWrittenPerItem: number
): PlannedStatementMetric[] {
  return chunkImportItemsByBudget(
    items,
    maxRowsPerStmt,
    maxParamsPerStmt,
    paramsPerRow,
    sqlOverheadBytes,
    rowBytesFn
  ).map((chunk) => {
    let statementBytes = sqlOverheadBytes;
    for (const item of chunk) {
      statementBytes += rowBytesFn(item);
    }
    return {
      label,
      boundParams: chunk.length * paramsPerRow,
      statementBytes,
      estimatedRowsWritten: chunk.length * rowsWrittenPerItem,
    };
  });
}

/**
 * Compute the deterministic D1 commit plan and validate every statement/batch
 * bound against SPEC-V2 §4 and `docs/spikes/WORKERS-FREE-2026-11.md` §3.
 */
export function planImportCommit(input: {
  normalizedData: StoredNormalizedImportData;
  stagedFileIds: ReadonlyArray<string>;
  manifestPayloadBytes: number;
  sourceFilePayloadBytes: number;
}): ImportCommitPlanResult {
  const previewStatements: PlannedStatementMetric[] = [];
  const commitStatements: PlannedStatementMetric[] = [];

  // 1. Preview writes: source CSV File row, staged media File rows,
  // ImportManifest row, and import.preview AuditEntry row.
  previewStatements.push({
    label: 'preview.source_file',
    boundParams: FILE_INSERT_PARAMS_PER_ROW + 2,
    statementBytes: input.sourceFilePayloadBytes,
    estimatedRowsWritten: D1_ROW_WRITE_COSTS.filesInsert,
  });

  for (
    let i = 0;
    i < input.stagedFileIds.length;
    i += PREVIEW_FILES_INSERT_CHUNK
  ) {
    const chunk = input.stagedFileIds.slice(i, i + PREVIEW_FILES_INSERT_CHUNK);
    previewStatements.push({
      label: 'preview.staged_files',
      boundParams: chunk.length * FILE_INSERT_PARAMS_PER_ROW + 2,
      statementBytes: FILE_INSERT_SQL_BYTES + chunk.length * 420,
      estimatedRowsWritten: chunk.length * D1_ROW_WRITE_COSTS.filesInsert,
    });
  }

  previewStatements.push({
    label: 'preview.import_manifest',
    boundParams: 16,
    statementBytes: MANIFEST_INSERT_SQL_BYTES + input.manifestPayloadBytes,
    estimatedRowsWritten: D1_ROW_WRITE_COSTS.importManifestInsert,
  });

  previewStatements.push({
    label: 'preview.audit_entry',
    boundParams: 10,
    statementBytes: AUDIT_INSERT_SQL_BYTES,
    estimatedRowsWritten: D1_ROW_WRITE_COSTS.auditEntryInsert,
  });

  // 2. Commit writes: related records first, then primary rows & children,
  // staged File activations, ImportManifest result update, and commit audit.
  const { normalizedData } = input;

  if (normalizedData.relatedPlacesToCreate.length > 0) {
    commitStatements.push(
      ...chunkIntoMultiRowStatements(
        normalizedData.relatedPlacesToCreate,
        COMMIT_PLACE_INSERT_CHUNK,
        D1_MAX_BOUND_PARAMS_PER_STATEMENT,
        10,
        PLACE_INSERT_SQL_BYTES,
        estimateRelatedRecordBytes,
        'commit.related_places',
        D1_ROW_WRITE_COSTS.placeInsert
      )
    );
  }

  if (normalizedData.relatedSpeakersToCreate.length > 0) {
    commitStatements.push(
      ...chunkIntoMultiRowStatements(
        normalizedData.relatedSpeakersToCreate,
        COMMIT_SPEAKER_INSERT_CHUNK,
        D1_MAX_BOUND_PARAMS_PER_STATEMENT,
        8,
        SPEAKER_INSERT_SQL_BYTES,
        estimateRelatedRecordBytes,
        'commit.related_speakers',
        D1_ROW_WRITE_COSTS.speakerInsert
      )
    );
  }

  if (normalizedData.kind === 'places') {
    const plainPlaces = normalizedData.rows.filter(
      (r) => r.attachments.length === 0
    );
    const attachedPlaces = normalizedData.rows.filter(
      (r) => r.attachments.length > 0
    );

    commitStatements.push(
      ...chunkIntoMultiRowStatements(
        plainPlaces,
        COMMIT_PLACE_INSERT_CHUNK,
        D1_MAX_BOUND_PARAMS_PER_STATEMENT,
        10,
        PLACE_INSERT_SQL_BYTES,
        estimatePlaceRowBytes,
        'commit.places',
        D1_ROW_WRITE_COSTS.placeInsert
      )
    );

    for (const row of attachedPlaces) {
      commitStatements.push({
        label: 'commit.place_with_attachments',
        boundParams: 16,
        statementBytes: estimateInsertStatementBytes(PLACE_INSERT_SQL_BYTES, [
          row.name,
          row.description,
          row.descriptionPlain,
          row.typeOfPlace,
          row.region,
          row.latitude,
          row.longitude,
        ]),
        estimatedRowsWritten: D1_ROW_WRITE_COSTS.placeInsert,
      });
      for (let i = 0; i < row.attachments.length; i += COMMIT_CHILD_ROW_CHUNK) {
        const chunk = row.attachments.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
        commitStatements.push({
          label: 'commit.place_attachments',
          boundParams: chunk.length * 6 + 4,
          statementBytes: ATTACHMENT_INSERT_SQL_BYTES + chunk.length * 140,
          estimatedRowsWritten:
            chunk.length * D1_ROW_WRITE_COSTS.attachmentInsert,
        });
      }
    }
  } else if (normalizedData.kind === 'speakers') {
    const plainSpeakers = normalizedData.rows.filter(
      (r) => r.attachments.length === 0
    );
    const attachedSpeakers = normalizedData.rows.filter(
      (r) => r.attachments.length > 0
    );

    commitStatements.push(
      ...chunkIntoMultiRowStatements(
        plainSpeakers,
        COMMIT_SPEAKER_INSERT_CHUNK,
        D1_MAX_BOUND_PARAMS_PER_STATEMENT,
        8,
        SPEAKER_INSERT_SQL_BYTES,
        estimateSpeakerRowBytes,
        'commit.speakers',
        D1_ROW_WRITE_COSTS.speakerInsert
      )
    );

    for (const row of attachedSpeakers) {
      commitStatements.push({
        label: 'commit.speaker_with_attachments',
        boundParams: 16,
        statementBytes: estimateInsertStatementBytes(SPEAKER_INSERT_SQL_BYTES, [
          row.name,
          row.birthDate,
          row.affiliation,
          row.birthplaceRef?.kind === 'existing'
            ? row.birthplaceRef.id
            : (row.birthplaceRef?.name ?? null),
        ]),
        estimatedRowsWritten: D1_ROW_WRITE_COSTS.speakerInsert,
      });
      for (let i = 0; i < row.attachments.length; i += COMMIT_CHILD_ROW_CHUNK) {
        const chunk = row.attachments.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
        commitStatements.push({
          label: 'commit.speaker_attachments',
          boundParams: chunk.length * 6 + 4,
          statementBytes: ATTACHMENT_INSERT_SQL_BYTES + chunk.length * 140,
          estimatedRowsWritten:
            chunk.length * D1_ROW_WRITE_COSTS.attachmentInsert,
        });
      }
    }
  } else {
    for (const row of normalizedData.rows) {
      commitStatements.push({
        label: 'commit.story',
        boundParams: 28,
        statementBytes: estimateInsertStatementBytes(STORY_INSERT_SQL_BYTES, [
          row.title,
          row.slug,
          row.description,
          row.descriptionPlain,
          row.visibility,
          row.topic,
          row.topicNormalized,
          row.language,
          row.dateInterviewed,
        ]),
        estimatedRowsWritten: D1_ROW_WRITE_COSTS.storyInsert,
      });

      for (let i = 0; i < row.placeRefs.length; i += COMMIT_CHILD_ROW_CHUNK) {
        const chunk = row.placeRefs.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
        commitStatements.push({
          label: 'commit.story_places',
          boundParams: chunk.length * 5 + 3,
          statementBytes: STORY_EDGE_SQL_BYTES + chunk.length * 90,
          estimatedRowsWritten:
            chunk.length * D1_ROW_WRITE_COSTS.storyPlaceInsert,
        });
      }

      for (let i = 0; i < row.speakerRefs.length; i += COMMIT_CHILD_ROW_CHUNK) {
        const chunk = row.speakerRefs.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
        commitStatements.push({
          label: 'commit.story_speakers',
          boundParams: chunk.length * 5 + 3,
          statementBytes: STORY_EDGE_SQL_BYTES + chunk.length * 90,
          estimatedRowsWritten:
            chunk.length * D1_ROW_WRITE_COSTS.storySpeakerInsert,
        });
      }

      for (let i = 0; i < row.attachments.length; i += COMMIT_CHILD_ROW_CHUNK) {
        const chunk = row.attachments.slice(i, i + COMMIT_CHILD_ROW_CHUNK);
        commitStatements.push({
          label: 'commit.story_attachments',
          boundParams: chunk.length * 6 + 3,
          statementBytes: ATTACHMENT_INSERT_SQL_BYTES + chunk.length * 140,
          estimatedRowsWritten:
            chunk.length * D1_ROW_WRITE_COSTS.attachmentInsert,
        });
      }

      for (
        let i = 0;
        i < row.externalMediaLinks.length;
        i += COMMIT_CHILD_ROW_CHUNK
      ) {
        const chunk = row.externalMediaLinks.slice(
          i,
          i + COMMIT_CHILD_ROW_CHUNK
        );
        commitStatements.push({
          label: 'commit.story_external_links',
          boundParams: chunk.length * 4 + 3,
          statementBytes: estimateInsertStatementBytes(
            EXTERNAL_LINK_INSERT_SQL_BYTES,
            chunk
          ),
          estimatedRowsWritten:
            chunk.length * D1_ROW_WRITE_COSTS.externalMediaLinkInsert,
        });
      }
    }
  }

  for (
    let i = 0;
    i < input.stagedFileIds.length;
    i += COMMIT_FILE_ACTIVATE_CHUNK
  ) {
    const chunk = input.stagedFileIds.slice(i, i + COMMIT_FILE_ACTIVATE_CHUNK);
    commitStatements.push({
      label: 'commit.activate_staged_files',
      boundParams: chunk.length + 10,
      statementBytes: ACTIVATE_FILES_SQL_BYTES + chunk.length * 40,
      estimatedRowsWritten:
        chunk.length * D1_ROW_WRITE_COSTS.filesActivateUpdate,
    });
  }

  commitStatements.push({
    label: 'commit.import_manifest_status',
    boundParams: 12,
    statementBytes: MANIFEST_COMMIT_SQL_BYTES + 256,
    estimatedRowsWritten: D1_ROW_WRITE_COSTS.importManifestCommitUpdate,
  });

  commitStatements.push({
    label: 'commit.audit_entry',
    boundParams: 14,
    statementBytes: AUDIT_INSERT_SQL_BYTES,
    estimatedRowsWritten: D1_ROW_WRITE_COSTS.auditEntryInsert,
  });

  const allStatements = [...previewStatements, ...commitStatements];
  const statementCount = allStatements.length;
  let maxBoundParams = 0;
  let maxStatementBytes = 0;
  let estimatedRowsWritten = 0;

  for (const stmt of allStatements) {
    if (stmt.boundParams > maxBoundParams) maxBoundParams = stmt.boundParams;
    if (stmt.statementBytes > maxStatementBytes) {
      maxStatementBytes = stmt.statementBytes;
    }
    estimatedRowsWritten += stmt.estimatedRowsWritten;
  }

  const violations: D1BudgetViolation[] = [];
  if (statementCount > D1_MAX_BATCH_STATEMENTS) {
    violations.push({
      limit: 'max_statements',
      actual: statementCount,
      max: D1_MAX_BATCH_STATEMENTS,
      message: `Import commit plan requires ${statementCount} statements, exceeding the D1 batch limit of ${D1_MAX_BATCH_STATEMENTS} statements. ${D1_BUDGET_ALTERNATIVES_MESSAGE}`,
    });
  }
  if (maxBoundParams > D1_MAX_BOUND_PARAMS_PER_STATEMENT) {
    violations.push({
      limit: 'max_bound_params',
      actual: maxBoundParams,
      max: D1_MAX_BOUND_PARAMS_PER_STATEMENT,
      message: `Import commit plan statement uses ${maxBoundParams} bound parameters, exceeding the D1 limit of ${D1_MAX_BOUND_PARAMS_PER_STATEMENT} parameters per statement. ${D1_BUDGET_ALTERNATIVES_MESSAGE}`,
    });
  }
  if (maxStatementBytes > D1_MAX_STATEMENT_BYTES) {
    violations.push({
      limit: 'max_statement_bytes',
      actual: maxStatementBytes,
      max: D1_MAX_STATEMENT_BYTES,
      message: `Import commit plan statement size is ${maxStatementBytes} bytes, exceeding the D1 limit of ${D1_MAX_STATEMENT_BYTES} bytes per statement. ${D1_BUDGET_ALTERNATIVES_MESSAGE}`,
    });
  }
  if (estimatedRowsWritten > D1_MAX_ESTIMATED_ROWS_WRITTEN) {
    violations.push({
      limit: 'max_rows_written',
      actual: estimatedRowsWritten,
      max: D1_MAX_ESTIMATED_ROWS_WRITTEN,
      message: `Import commit plan writes an estimated ${estimatedRowsWritten} D1 rows (including index entries), exceeding the limit of ${D1_MAX_ESTIMATED_ROWS_WRITTEN} rows written. ${D1_BUDGET_ALTERNATIVES_MESSAGE}`,
    });
  }

  return {
    summary: {
      statementCount,
      maxBoundParams,
      maxStatementBytes,
      estimatedRowsWritten,
      withinD1Budget: violations.length === 0,
    },
    previewStatements,
    commitStatements,
    violations,
  };
}
