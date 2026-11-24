/**
 * Canonical V2 service layer for Slice 12 bounded CSV imports (`ImportManifest`,
 * SPEC-V2 §4, §5, §6.9, §7; #123, #197).
 *
 * Security & sovereignty invariants:
 * - Tenant scope comes strictly from the verified active community `actor`.
 * - Unknown audience values NEVER coerce to `'public'`.
 * - Cross-community, restricted, or unauthorized media/place/speaker IDs
 *   resolve uniformly as missing references (no existence oracle).
 * - Staged media and source CSV rows remain `is_active = false` until commit.
 * - CSV row content, descriptions, titles, filenames, and storage keys are
 *   never logged or leaked in error envelopes or audit entries.
 */
import { z } from 'zod';
import {
  ALLOWED_CSV_MIME_TYPES,
  AudienceMappingSchema,
  DuplicateStrategySchema,
  HeaderMappingsSchema,
  IMPORT_ALLOWED_FIELDS,
  IMPORT_HEADER_ALIASES,
  IMPORT_REQUIRED_FIELDS,
  ImportKindSchema,
  ImportManifestDetailResponseSchema,
  ImportManifestListResponseSchema,
  ListImportsQuerySchema,
  MAX_IMPORT_CSV_BYTES,
  MAX_IMPORT_EXTERNAL_LINKS_PER_ROW,
  MAX_IMPORT_MEDIA_FILES,
  MAX_IMPORT_MEDIA_REFS_PER_ROW,
  MAX_IMPORT_PREVIEW_DESCRIPTION_CHARS,
  MAX_IMPORT_PREVIEW_SAMPLE_ROWS,
  MAX_IMPORT_REQUEST_BYTES,
  MAX_IMPORT_ROW_ERRORS,
  MAX_IMPORT_STORY_EDGES_PER_ROW,
  MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY,
  type AudienceMapping,
  type DuplicateStrategy,
  type ImportManifestDetail,
  type ImportManifestSummary,
  type ImportPreviewAttachment,
  type ImportPreviewRelatedRef,
  type ImportPreviewRow,
  type ImportRowError,
  type ImportStoredMappings,
  type NormalizedPlaceRow,
  type NormalizedSpeakerRow,
  type NormalizedStoryRow,
  type RelatedPlaceToCreate,
  type RelatedSpeakerToCreate,
  type StoredNormalizedImportData,
  countNormalizedMediaRefs,
  summarizeNormalizedRelatedRecords,
} from '../shared/schemas/imports.js';
import type { ImportManifestKind } from '../db/schema/import_manifests.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type { FoundationStorage } from './hono-foundation.service.js';
import type { MediaCleanupCoordinator } from './media-cleanup.service.js';
import {
  ImportsRepository,
  type CommunityImportContext,
  type CreatePreviewOutcome,
  type ImportManifestRowRecord,
  type StagedFileInsertInput,
  type StagedFileVerificationRecord,
} from '../repositories/imports.repository.js';
import { MediaWritesRepository } from '../repositories/media-writes.repository.js';
import { authorizeCommunityWriteCaller } from './community-writes.service.js';
import {
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import {
  isValidCalendarDate,
  makeValidationErrorBody,
  zodErrorToValidationFields,
  type V2ValidationErrorResponse,
  type V2ValidationFieldError,
} from '../shared/schemas/community-writes.js';
import {
  NullableStoryDateInterviewedSchema,
  StoryLanguageSchema,
} from '../shared/schemas/story-writes.js';
import { isSafeExternalMediaUrl } from '../shared/schemas/public-content.js';
import { storySlugBase } from '../shared/utils/story-slug.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import {
  ATTACHMENT_ROLE_ALLOWED_CATEGORIES,
  MAGIC_SNIFF_BYTES,
  MEDIA_MIME_RULES,
  normalizeMediaMimeType,
  sanitizeUploadOriginalName,
  validateMediaHeaderBytes,
  type MediaCategory,
} from '../shared/schemas/media-v2.js';
import {
  MultipartStreamError,
  parseMultipartImportStream,
} from '../shared/utils/multipart-stream.js';
import { StreamingSha256 } from '../shared/utils/sha256-stream.js';
import {
  CsvParseError,
  decodeUtf8CsvStrict,
  hasCsvFormulaPrefix,
  parseCsvText,
  type ParsedCsvResult,
} from '../shared/utils/csv-parser.js';
import {
  D1_BUDGET_ALTERNATIVES_MESSAGE,
  D1_MAX_COMMITTED_IMPORTS_PER_UTC_DAY,
  planImportCommit,
  utcDayWindowMs,
  type D1BudgetViolation,
} from '../shared/utils/import-commit-plan.js';
import type { WorkersPlan } from '../config/v2-runtime.js';
import {
  deriveDescriptionForWrite,
  deriveTopicColumns,
} from '../shared/utils/derived-columns.js';
import { InvalidDescriptionError } from '../shared/utils/safe-description.js';
import { normalizeSearchText } from '../shared/utils/search-normalize.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import type { AttachmentRole } from '../db/schema/attachments.js';

const ALLOWED_IMPORT_FORM_FIELDS = new Set([
  'kind',
  'mappings',
  'audienceMapping',
  'duplicateStrategy',
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TOO_MANY_OPEN_PREVIEWS_BODY: V2ErrorResponse = {
  error: `Too many open import previews (maximum ${MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY} per community). Commit or discard an existing preview before starting another.`,
  code: 'too_many_open_previews',
};

const D1_DAILY_IMPORT_LIMIT_BODY: V2ErrorResponse = {
  error: `Daily D1 database import limit of 1 committed import per UTC day reached. ${D1_BUDGET_ALTERNATIVES_MESSAGE}`,
  code: 'd1_daily_import_limit',
};

/**
 * Workers Free D1 allows 100,000 rows written/day, so V2 caps committed imports
 * at 1 per UTC day across the D1 database (SPEC-V2 §4, §5). Although Workers
 * Paid replaces the daily D1 write quota with a 50M/month included allowance
 * (docs/WORKERS-PAID-PROFILE.md §2), SPEC-V2 §4 requires one import per hosted
 * database per UTC day, §5 defines Free as the hosted launch profile, §7 leaves
 * Paid backup retention open, and open-preview / per-batch limits alone would
 * not throttle repeated commits. Keep the 1/UTC-day precheck and atomic commit
 * guard on Paid until SPEC-V2 §4, §5, and §7 are amended with a Paid import
 * throttle policy.
 */
export const WORKER_FREE_DAILY_IMPORT_LIMIT =
  D1_MAX_COMMITTED_IMPORTS_PER_UTC_DAY;
export const WORKER_PAID_DAILY_IMPORT_LIMIT =
  D1_MAX_COMMITTED_IMPORTS_PER_UTC_DAY;

export function workerDailyImportLimit(plan: WorkersPlan = 'free'): number {
  return plan === 'paid'
    ? WORKER_PAID_DAILY_IMPORT_LIMIT
    : WORKER_FREE_DAILY_IMPORT_LIMIT;
}

export type ImportServiceResult<T> =
  | { status: 200 | 201; body: T }
  | {
      status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500;
      body:
        | V2ErrorResponse
        | V2ValidationErrorResponse
        | {
            error: string;
            code: 'd1_budget_exceeded';
            details: {
              commitPlan: ImportManifestDetail['commitPlan'];
              violations: D1BudgetViolation[];
              alternatives: string;
            };
          };
    };

class EarlyImportRejectionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 413 | 415,
    public readonly body: V2ErrorResponse | V2ValidationErrorResponse
  ) {
    super('Import rejected');
    this.name = 'EarlyImportRejectionError';
  }
}

class MediaCategoryLimitError extends Error {
  constructor() {
    super('Media file exceeds maximum allowed size for media type');
    this.name = 'MediaCategoryLimitError';
  }
}

interface StagedMediaUpload {
  fileId: string;
  storageKey: string;
  rawFilename: string;
  originalName: string;
  mimeType: string;
  category: MediaCategory;
  byteSize: number;
  checksum: string;
}

interface ParsedCsvUpload {
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  bytes: Uint8Array;
  parsed: ParsedCsvResult;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function buildUniqueStorySlug(title: string): string {
  const base = storySlugBase(title);
  const suffix = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return base.length > 0 ? `${base}-${suffix}` : `story-${suffix}`;
}

const PIPE_LIST_TOKEN_PATTERN = /[^|;\n]+/;
const ID_LIST_TOKEN_PATTERN = /[^,|;\n]+/;

function splitBoundedTokens(
  raw: string,
  tokenPattern: RegExp,
  maxTokens: number
): { tokens: string[]; exceeded: boolean } {
  const tokens: string[] = [];
  const pattern = new RegExp(tokenPattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const trimmed = match[0].trim();
    if (trimmed.length === 0) continue;
    tokens.push(trimmed);
    if (tokens.length > maxTokens) {
      return { tokens: [], exceeded: true };
    }
  }
  return { tokens, exceeded: false };
}

function parseFiniteCoordinate(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return null;
  return Object.is(num, -0) ? 0 : num;
}

function parseStoryDateInterviewed(raw: string): string | null {
  const trimmed = raw.trim();
  if (isValidCalendarDate(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  const isoParsed = NullableStoryDateInterviewedSchema.safeParse(trimmed);
  if (isoParsed.success && isoParsed.data !== null) {
    return new Date(isoParsed.data).toISOString();
  }
  return null;
}

function computeManifestPlan(
  manifest: ImportManifestRowRecord,
  d1Enforced = false
) {
  const normalizedData = manifest.normalizedRows;
  const manifestPayloadBytes = new TextEncoder().encode(
    JSON.stringify({
      mappings: manifest.mappings,
      normalizedRows: normalizedData,
      rowErrors: manifest.rowErrors,
      stagedFileIds: manifest.stagedFileIds,
    })
  ).byteLength;
  const sourceFilePayloadBytes =
    400 +
    new TextEncoder().encode(manifest.sourceFileName ?? 'import.csv')
      .byteLength;
  const plan = planImportCommit({
    normalizedData,
    stagedFileIds: manifest.stagedFileIds,
    sourceFileName: manifest.sourceFileName,
    manifestPayloadBytes,
    sourceFilePayloadBytes,
  });
  const totalErrorCount =
    normalizedData.totalErrorCount ?? manifest.rowErrors.length;
  const validRowCount =
    normalizedData.validRowCount ?? normalizedData.rows.length;
  const canCommit =
    manifest.status === 'previewed' &&
    totalErrorCount === 0 &&
    manifest.rowErrors.length === 0 &&
    validRowCount > 0 &&
    (!d1Enforced || plan.summary.withinD1Budget);

  return { normalizedData, plan, canCommit, totalErrorCount, validRowCount };
}

export function serializeImportManifestSummary(
  manifest: ImportManifestRowRecord,
  d1Enforced = false
): ImportManifestSummary {
  const { canCommit, totalErrorCount, validRowCount } = computeManifestPlan(
    manifest,
    d1Enforced
  );

  return {
    id: manifest.id,
    kind: manifest.kind,
    status: manifest.status,
    createdBy: manifest.createdBy,
    sourceFileName: manifest.sourceFileName,
    rowCount: manifest.rowCount,
    validRowCount,
    errorCount: totalErrorCount,
    stagedMediaCount: manifest.stagedFileIds.length,
    canCommit,
    resultSummary: manifest.resultSummary,
    committedAt:
      manifest.committedAt === null
        ? null
        : new Date(manifest.committedAt).toISOString(),
    createdAt: new Date(manifest.createdAt).toISOString(),
  };
}

function projectDescriptionExcerpt(
  descriptionPlain: string | null
): string | null {
  if (descriptionPlain === null) return null;
  if (descriptionPlain.length <= MAX_IMPORT_PREVIEW_DESCRIPTION_CHARS) {
    return descriptionPlain;
  }
  let end = MAX_IMPORT_PREVIEW_DESCRIPTION_CHARS;
  const code = descriptionPlain.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${descriptionPlain.slice(0, end)}…`;
}

function projectRelatedRef(
  ref:
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
): ImportPreviewRelatedRef {
  if (ref.kind === 'existing') {
    return { resolution: 'existing', id: ref.id };
  }
  return { resolution: 'create', name: ref.name };
}

function projectPreviewAttachment(att: {
  role: AttachmentRole;
  ordinal: number;
  stagedByManifest: boolean;
}): ImportPreviewAttachment {
  return {
    role: att.role,
    ordinal: att.ordinal,
    source: att.stagedByManifest ? 'staged' : 'existing',
  };
}

function projectPreviewRows(normalizedData: StoredNormalizedImportData): {
  previewRows: ImportPreviewRow[];
  previewRowsTruncated: boolean;
} {
  const previewRowsTruncated =
    normalizedData.rows.length > MAX_IMPORT_PREVIEW_SAMPLE_ROWS;
  if (normalizedData.kind === 'places') {
    return {
      previewRows: normalizedData.rows
        .slice(0, MAX_IMPORT_PREVIEW_SAMPLE_ROWS)
        .map((row) => ({
          kind: 'places',
          rowNumber: row.rowNumber,
          name: row.name,
          descriptionExcerpt: projectDescriptionExcerpt(row.descriptionPlain),
          typeOfPlace: row.typeOfPlace,
          region: row.region,
          latitude: row.latitude,
          longitude: row.longitude,
          attachments: row.attachments.map(projectPreviewAttachment),
        })),
      previewRowsTruncated,
    };
  }
  if (normalizedData.kind === 'speakers') {
    return {
      previewRows: normalizedData.rows
        .slice(0, MAX_IMPORT_PREVIEW_SAMPLE_ROWS)
        .map((row) => ({
          kind: 'speakers',
          rowNumber: row.rowNumber,
          name: row.name,
          birthDate: row.birthDate,
          birthplace: row.birthplaceRef
            ? projectRelatedRef(row.birthplaceRef)
            : null,
          affiliation: row.affiliation,
          attachments: row.attachments.map(projectPreviewAttachment),
        })),
      previewRowsTruncated,
    };
  }
  return {
    previewRows: normalizedData.rows
      .slice(0, MAX_IMPORT_PREVIEW_SAMPLE_ROWS)
      .map((row) => ({
        kind: 'stories',
        rowNumber: row.rowNumber,
        title: row.title,
        visibility: row.visibility,
        descriptionExcerpt: projectDescriptionExcerpt(row.descriptionPlain),
        topic: row.topic,
        language: row.language,
        dateInterviewed: row.dateInterviewed,
        interviewLocation: row.interviewLocationRef
          ? projectRelatedRef(row.interviewLocationRef)
          : null,
        interviewer: row.interviewerRef
          ? projectRelatedRef(row.interviewerRef)
          : null,
        places: row.placeRefs.map(projectRelatedRef),
        speakers: row.speakerRefs.map(projectRelatedRef),
        attachments: row.attachments.map(projectPreviewAttachment),
        externalMediaLinks: [...row.externalMediaLinks],
      })),
    previewRowsTruncated,
  };
}

export function serializeImportManifestDetail(
  manifest: ImportManifestRowRecord,
  d1Enforced = false
): ImportManifestDetail {
  const { normalizedData, plan, totalErrorCount } = computeManifestPlan(
    manifest,
    d1Enforced
  );
  const mediaCounts = countNormalizedMediaRefs(normalizedData);
  const { previewRows, previewRowsTruncated } =
    projectPreviewRows(normalizedData);
  const boundedRowErrors = manifest.rowErrors.slice(0, MAX_IMPORT_ROW_ERRORS);
  const rowErrorsTruncated =
    Boolean(normalizedData.rowErrorsTruncated) ||
    totalErrorCount > boundedRowErrors.length ||
    manifest.rowErrors.length > MAX_IMPORT_ROW_ERRORS;

  return {
    ...serializeImportManifestSummary(manifest, d1Enforced),
    mappings: manifest.mappings.headerMappings,
    unmappedHeaders: manifest.mappings.unmappedHeaders,
    audienceMapping:
      normalizedData.kind === 'stories'
        ? (manifest.mappings.audienceMapping ?? {})
        : null,
    duplicateStrategy: manifest.mappings.duplicateStrategy,
    skippedDuplicateCount: normalizedData.skippedDuplicates,
    rowErrors: boundedRowErrors,
    rowErrorsTruncated,
    mediaSummary: {
      stagedCount: manifest.stagedFileIds.length,
      existingReferencedCount: mediaCounts.existingCount,
      totalAttachmentRefs: mediaCounts.totalRefs,
    },
    audienceSummary:
      normalizedData.kind === 'stories' ? normalizedData.audienceCounts : null,
    relatedRecords: summarizeNormalizedRelatedRecords(normalizedData),
    previewRows,
    previewRowsTruncated,
    commitPlan: plan.summary,
  };
}

export interface ImportsServiceOptions {
  now?: () => Date;
  enforceD1Budget?: boolean;
  workersPlan?: WorkersPlan;
}

export class ImportsService {
  private readonly mediaRepository: MediaWritesRepository;
  private readonly now: () => Date;
  private readonly enforceD1Budget: boolean;
  private readonly workersPlan: WorkersPlan;

  constructor(
    private readonly repository: ImportsRepository,
    private readonly storage: FoundationStorage,
    private readonly cleanup: MediaCleanupCoordinator,
    options: ImportsServiceOptions = {}
  ) {
    this.mediaRepository = new MediaWritesRepository(repository.connection);
    this.now = options.now ?? (() => new Date());
    this.enforceD1Budget = options.enforceD1Budget ?? false;
    this.workersPlan = options.workersPlan ?? 'free';
  }

  private isD1Enforced(): boolean {
    return this.repository.hasD1Batch() || this.enforceD1Budget;
  }

  private dailyLimitWindow(
    now: Date
  ): { startMs: number; endMs: number } | null {
    if (!this.isD1Enforced()) return null;
    return workerDailyImportLimit(this.workersPlan) > 0
      ? utcDayWindowMs(now)
      : null;
  }

  private async cleanupUploadedStorageKeys(
    keys: ReadonlyArray<string>,
    reason: 'upload_rollback' | 'import_failed',
    activeUploadedKeys?: Set<string>
  ): Promise<void> {
    for (const key of keys) {
      await this.cleanup.deleteStorageBestEffort(key, reason);
      activeUploadedKeys?.delete(key);
    }
  }

  private resolveHeaderMappings(
    kind: ImportManifestKind,
    csvHeaders: string[],
    explicitMappings: Record<string, string> | undefined
  ):
    | {
        ok: true;
        headerMappings: Record<string, string>;
        unmappedHeaders: string[];
      }
    | { ok: false; fields: V2ValidationFieldError[] } {
    const allowedSet = new Set(IMPORT_ALLOWED_FIELDS[kind]);
    const requiredList = IMPORT_REQUIRED_FIELDS[kind];
    const csvHeaderSet = new Set(csvHeaders);
    const headerMappings: Record<string, string> = {};
    const usedHeaders = new Set<string>();
    const errors: V2ValidationFieldError[] = [];

    if (explicitMappings !== undefined) {
      for (const [canonicalField, rawHeader] of Object.entries(
        explicitMappings
      )) {
        if (!allowedSet.has(canonicalField)) {
          errors.push({
            path: `mappings.${canonicalField}`,
            message: 'Field is not allowed for this import kind',
          });
          continue;
        }
        const header = rawHeader.trim();
        if (!csvHeaderSet.has(header)) {
          errors.push({
            path: `mappings.${canonicalField}`,
            message: 'Mapped CSV column header was not found in uploaded file',
          });
          continue;
        }
        if (usedHeaders.has(header)) {
          errors.push({
            path: `mappings.${canonicalField}`,
            message: 'CSV column header cannot map to multiple fields',
          });
          continue;
        }
        usedHeaders.add(header);
        headerMappings[canonicalField] = header;
      }
    } else {
      const aliases = IMPORT_HEADER_ALIASES[kind];
      for (const header of csvHeaders) {
        const canonicalField = aliases[header];
        if (!canonicalField || !allowedSet.has(canonicalField)) {
          continue;
        }
        if (headerMappings[canonicalField] !== undefined) {
          errors.push({
            path: 'mappings',
            message: `Multiple CSV headers map to field "${canonicalField}"`,
          });
          continue;
        }
        usedHeaders.add(header);
        headerMappings[canonicalField] = header;
      }
    }

    for (const reqField of requiredList) {
      if (!headerMappings[reqField]) {
        errors.push({
          path: `mappings.${reqField}`,
          message: `Required field "${reqField}" must be mapped to a CSV column`,
        });
      }
    }

    if (errors.length > 0) {
      return { ok: false, fields: errors };
    }

    const unmappedHeaders = csvHeaders.filter((h) => !usedHeaders.has(h));
    return { ok: true, headerMappings, unmappedHeaders };
  }

  private async resolveAttachableExistingFiles(
    communityId: number,
    actor: FoundationUser,
    candidateIds: ReadonlyArray<string>
  ): Promise<
    Map<string, { id: string; mimeType: string; category: MediaCategory }>
  > {
    const validCandidates = Array.from(new Set(candidateIds)).filter((id) =>
      UUID_REGEX.test(id)
    );
    const dbFiles = await this.repository.findCommunityFilesByIds(
      communityId,
      validCandidates
    );
    const authorized = new Map<
      string,
      { id: string; mimeType: string; category: MediaCategory }
    >();

    for (const file of dbFiles.values()) {
      const rule = MEDIA_MIME_RULES[file.mimeType];
      if (!rule) continue;
      const reuse = await this.mediaRepository.authorizeAttachReuse({
        actor,
        communityId,
        file: { id: file.id, uploadedBy: file.uploadedBy },
      });
      if (reuse.ok) {
        authorized.set(file.id, {
          id: file.id,
          mimeType: file.mimeType,
          category: rule.category,
        });
      }
    }
    return authorized;
  }

  async previewImport(input: {
    actor: FoundationUser;
    contentTypeHeader: string | undefined;
    contentLengthHeader: string | undefined;
    body: ReadableStream<Uint8Array> | null;
  }): Promise<
    ImportServiceResult<z.infer<typeof ImportManifestDetailResponseSchema>>
  > {
    const caller = await authorizeCommunityWriteCaller(
      this.repository,
      input.actor,
      ['editor', 'admin']
    );
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!this.storage.put) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    if (input.contentLengthHeader !== undefined) {
      const contentLength = Number(input.contentLengthHeader);
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_IMPORT_REQUEST_BYTES
      ) {
        return { status: 413, body: { error: 'Request too large' } };
      }
    }

    const d1Enforced = this.isD1Enforced();
    const requestNow = this.now();
    const dailyWindow = this.dailyLimitWindow(requestNow);
    if (dailyWindow) {
      const hitDaily = await this.repository.hasCommittedImportInWindow(
        dailyWindow.startMs,
        dailyWindow.endMs
      );
      if (hitDaily) {
        return {
          status: 429,
          body: D1_DAILY_IMPORT_LIMIT_BODY,
        };
      }
    }

    const openPreviews = await this.repository.countOpenPreviews(
      caller.communityId
    );
    if (openPreviews >= MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY) {
      return { status: 429, body: TOO_MANY_OPEN_PREVIEWS_BODY };
    }

    const activeUploadedKeys = new Set<string>();
    const stagedMediaUploads: StagedMediaUpload[] = [];
    const seenMediaNames = new Set<string>();

    try {
      const parsedMultipart = await parseMultipartImportStream<
        ParsedCsvUpload,
        StagedMediaUpload
      >(input.body, input.contentTypeHeader, {
        maxRequestBytes: MAX_IMPORT_REQUEST_BYTES,
        maxMediaFiles: MAX_IMPORT_MEDIA_FILES,
        onCsvPart: async (part) => {
          for (const key of part.fieldsSoFar.keys()) {
            if (!ALLOWED_IMPORT_FORM_FIELDS.has(key)) {
              throw new EarlyImportRejectionError(
                400,
                makeValidationErrorBody([
                  { path: key, message: 'Unrecognized form field' },
                ])
              );
            }
          }

          if (!part.filename || part.filename.trim() === '') {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'file', message: 'CSV filename is required' },
              ])
            );
          }

          const cleanName = sanitizeUploadOriginalName(part.filename);
          if (!cleanName.toLowerCase().endsWith('.csv')) {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                {
                  path: 'file',
                  message: 'Uploaded file must have a .csv extension',
                },
              ])
            );
          }

          const declaredMime = normalizeMediaMimeType(part.contentType);
          if (
            declaredMime !== '' &&
            !ALLOWED_CSV_MIME_TYPES.has(declaredMime)
          ) {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'file', message: 'Unsupported CSV Content-Type' },
              ])
            );
          }

          const reader = part.stream.getReader();
          const chunks: Uint8Array[] = [];
          let byteSize = 0;
          const hasher = new StreamingSha256();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                byteSize += value.byteLength;
                if (byteSize > MAX_IMPORT_CSV_BYTES) {
                  await part.stream.cancel().catch(() => {});
                  throw new EarlyImportRejectionError(413, {
                    error: 'CSV file exceeds maximum allowed size',
                  });
                }
                hasher.update(value);
                chunks.push(value);
              }
            }
          } finally {
            reader.releaseLock();
          }

          if (byteSize === 0) {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                {
                  path: 'file',
                  message: 'Uploaded CSV file must not be empty',
                },
              ])
            );
          }

          const bytes = concatChunks(chunks, byteSize);
          let csvText: string;
          let parsed: ParsedCsvResult;
          try {
            csvText = decodeUtf8CsvStrict(bytes);
            parsed = parseCsvText(csvText);
          } catch (err) {
            if (err instanceof CsvParseError) {
              throw new EarlyImportRejectionError(
                400,
                makeValidationErrorBody([
                  { path: 'file', message: err.message },
                ])
              );
            }
            throw err;
          }

          part.finish({
            originalName: cleanName,
            mimeType: declaredMime === '' ? 'text/csv' : declaredMime,
            byteSize,
            checksum: hasher.digestHex(),
            bytes,
            parsed,
          });
        },
        onMediaPart: async (part) => {
          for (const key of part.fieldsSoFar.keys()) {
            if (!ALLOWED_IMPORT_FORM_FIELDS.has(key)) {
              throw new EarlyImportRejectionError(
                400,
                makeValidationErrorBody([
                  { path: key, message: 'Unrecognized form field' },
                ])
              );
            }
          }

          if (!part.filename || part.filename.trim() === '') {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'media', message: 'Media filename is required' },
              ])
            );
          }

          const rawBasename = part.filename.split(/[/\\]/).pop()?.trim() ?? '';
          const sanitizedName = sanitizeUploadOriginalName(part.filename);
          if (rawBasename === '' || sanitizedName === '') {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'media', message: 'Media filename is required' },
              ])
            );
          }
          if (
            seenMediaNames.has(rawBasename) ||
            seenMediaNames.has(sanitizedName)
          ) {
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'media', message: 'Duplicate staged media filename' },
              ])
            );
          }
          seenMediaNames.add(rawBasename);
          seenMediaNames.add(sanitizedName);

          const streamReader = part.stream.getReader();
          const initialChunks: Uint8Array[] = [];
          let initialLen = 0;

          try {
            while (initialLen < MAGIC_SNIFF_BYTES) {
              const { done, value } = await streamReader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                initialChunks.push(value);
                initialLen += value.byteLength;
              }
            }
          } catch (err) {
            streamReader.releaseLock();
            throw err;
          }

          if (initialLen === 0) {
            streamReader.releaseLock();
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                {
                  path: 'media',
                  message: 'Uploaded media file must not be empty',
                },
              ])
            );
          }

          const headerBytes = new Uint8Array(
            Math.min(initialLen, MAGIC_SNIFF_BYTES)
          );
          let copyPos = 0;
          for (const chunk of initialChunks) {
            if (copyPos >= headerBytes.byteLength) break;
            const take = Math.min(
              chunk.byteLength,
              headerBytes.byteLength - copyPos
            );
            headerBytes.set(chunk.subarray(0, take), copyPos);
            copyPos += take;
          }

          const headerCheck = await validateMediaHeaderBytes({
            headerBytes,
            declaredMime: part.contentType,
            filename: part.filename,
          });
          if (!headerCheck.ok) {
            streamReader.releaseLock();
            await part.stream.cancel().catch(() => {});
            throw new EarlyImportRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'media', message: headerCheck.message },
              ])
            );
          }

          if (initialLen > headerCheck.rule.maxBytes) {
            streamReader.releaseLock();
            await part.stream.cancel().catch(() => {});
            throw new EarlyImportRejectionError(413, {
              error: 'Media file exceeds maximum allowed size for media type',
            });
          }

          const fileId = crypto.randomUUID();
          const storageKey = `communities/${caller.communityId}/media/${fileId}`;
          activeUploadedKeys.add(storageKey);

          const hasher = new StreamingSha256();
          let byteSize = initialLen;
          for (const chunk of initialChunks) hasher.update(chunk);
          let initialIdx = 0;

          const hashedStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (initialIdx < initialChunks.length) {
                controller.enqueue(initialChunks[initialIdx]!);
                initialChunks[initialIdx] = new Uint8Array(0);
                initialIdx += 1;
                return;
              }
              try {
                const { done, value } = await streamReader.read();
                if (done) {
                  controller.close();
                  return;
                }
                if (value && value.byteLength > 0) {
                  byteSize += value.byteLength;
                  if (byteSize > headerCheck.rule.maxBytes) {
                    controller.error(new MediaCategoryLimitError());
                    return;
                  }
                  hasher.update(value);
                  controller.enqueue(value);
                }
              } catch (err) {
                controller.error(err);
              }
            },
            async cancel() {
              await streamReader.cancel().catch(() => {});
            },
          });

          try {
            await this.storage.put!(storageKey, hashedStream, {
              contentType: headerCheck.mimeType,
            });
          } finally {
            streamReader.releaseLock();
          }

          const uploaded: StagedMediaUpload = {
            fileId,
            storageKey,
            rawFilename: rawBasename,
            originalName: headerCheck.originalName,
            mimeType: headerCheck.mimeType,
            category: headerCheck.rule.category,
            byteSize,
            checksum: hasher.digestHex(),
          };
          stagedMediaUploads.push(uploaded);
          part.finish(uploaded);
        },
      });

      // Validate remaining form fields now that all multipart parts are read.
      const fieldErrors: V2ValidationFieldError[] = [];
      for (const key of parsedMultipart.fields.keys()) {
        if (!ALLOWED_IMPORT_FORM_FIELDS.has(key)) {
          fieldErrors.push({ path: key, message: 'Unrecognized form field' });
        }
      }

      const kindRaw = parsedMultipart.fields.get('kind');
      const parsedKind = ImportKindSchema.safeParse(kindRaw);
      if (!parsedKind.success) {
        fieldErrors.push({
          path: 'kind',
          message: 'kind must be one of places, speakers, or stories',
        });
      }

      const dupRaw = parsedMultipart.fields.get('duplicateStrategy');
      let duplicateStrategy: DuplicateStrategy = 'error';
      if (dupRaw !== undefined && dupRaw.trim() !== '') {
        const parsedDup = DuplicateStrategySchema.safeParse(dupRaw.trim());
        if (!parsedDup.success) {
          fieldErrors.push({
            path: 'duplicateStrategy',
            message: 'duplicateStrategy must be error or skip',
          });
        } else {
          duplicateStrategy = parsedDup.data;
        }
      }

      let explicitMappings: Record<string, string> | undefined;
      const mappingsRaw = parsedMultipart.fields.get('mappings');
      if (mappingsRaw !== undefined && mappingsRaw.trim() !== '') {
        try {
          const json: unknown = JSON.parse(mappingsRaw);
          const validated = HeaderMappingsSchema.safeParse(json);
          if (!validated.success) {
            fieldErrors.push({
              path: 'mappings',
              message:
                'mappings must be a JSON object of field-to-column pairs',
            });
          } else {
            explicitMappings = validated.data;
          }
        } catch {
          fieldErrors.push({
            path: 'mappings',
            message: 'mappings must be valid JSON',
          });
        }
      }

      let audienceMapping: AudienceMapping | undefined;
      const audienceRaw = parsedMultipart.fields.get('audienceMapping');
      if (audienceRaw !== undefined && audienceRaw.trim() !== '') {
        if (parsedKind.success && parsedKind.data !== 'stories') {
          fieldErrors.push({
            path: 'audienceMapping',
            message: 'audienceMapping is only valid for stories imports',
          });
        } else {
          try {
            const json: unknown = JSON.parse(audienceRaw);
            const validated = AudienceMappingSchema.safeParse(json);
            if (!validated.success) {
              fieldErrors.push({
                path: 'audienceMapping',
                message:
                  'audienceMapping must map raw values to public, community, or editors',
              });
            } else {
              audienceMapping = validated.data;
            }
          } catch {
            fieldErrors.push({
              path: 'audienceMapping',
              message: 'audienceMapping must be valid JSON',
            });
          }
        }
      }

      if (fieldErrors.length > 0 || !parsedKind.success) {
        await this.cleanupUploadedStorageKeys(
          [...activeUploadedKeys],
          'upload_rollback',
          activeUploadedKeys
        );
        return { status: 400, body: makeValidationErrorBody(fieldErrors) };
      }

      const kind = parsedKind.data;
      const csvUpload = parsedMultipart.csvResult;
      const mappingResult = this.resolveHeaderMappings(
        kind,
        csvUpload.parsed.headers,
        explicitMappings
      );
      if (!mappingResult.ok) {
        await this.cleanupUploadedStorageKeys(
          [...activeUploadedKeys],
          'upload_rollback',
          activeUploadedKeys
        );
        return {
          status: 400,
          body: makeValidationErrorBody(mappingResult.fields),
        };
      }

      const context = await this.repository.loadCommunityImportContext(
        caller.communityId
      );
      const stagedByName = new Map<string, StagedMediaUpload>();
      for (const upload of stagedMediaUploads) {
        stagedByName.set(upload.rawFilename, upload);
        stagedByName.set(upload.originalName, upload);
      }

      const headerIndex = new Map<string, number>();
      csvUpload.parsed.headers.forEach((h, i) => headerIndex.set(h, i));
      const readCell = (
        cells: string[],
        canonicalField: string
      ): string | undefined => {
        const header = mappingResult.headerMappings[canonicalField];
        if (!header) return undefined;
        const idx = headerIndex.get(header);
        return idx === undefined ? undefined : cells[idx];
      };

      const candidateUuids: string[] = [];
      for (const row of csvUpload.parsed.rows) {
        for (const [field, cap] of [
          ['photo', kind === 'places' ? MAX_IMPORT_MEDIA_REFS_PER_ROW : 1],
          ['nameAudio', 1],
          ['media', MAX_IMPORT_MEDIA_REFS_PER_ROW],
        ] as const) {
          const val = readCell(row.cells, field);
          if (!val) continue;
          const refs = splitBoundedTokens(val, PIPE_LIST_TOKEN_PATTERN, cap);
          if (refs.exceeded) continue;
          for (const ref of refs.tokens) {
            if (UUID_REGEX.test(ref)) candidateUuids.push(ref);
          }
        }
      }
      const authorizedExistingFiles = await this.resolveAttachableExistingFiles(
        caller.communityId,
        input.actor,
        candidateUuids
      );

      const { normalizedData, rowErrors, referencedStagedIds } =
        this.validateAndNormalizeRows({
          kind,
          rows: csvUpload.parsed.rows,
          readCell,
          duplicateStrategy,
          audienceMapping,
          context,
          stagedByName,
          authorizedExistingFiles,
        });

      // Immediately clean up any uploaded media part not referenced by accepted rows.
      const keptMediaFiles: StagedFileInsertInput[] = [];
      const keptStagedIds: string[] = [];
      const unusedMediaKeys: string[] = [];
      for (const upload of stagedMediaUploads) {
        if (referencedStagedIds.has(upload.fileId)) {
          keptStagedIds.push(upload.fileId);
          keptMediaFiles.push({
            id: upload.fileId,
            storageKey: upload.storageKey,
            originalName: upload.originalName,
            mimeType: upload.mimeType,
            byteSize: upload.byteSize,
            checksum: upload.checksum,
          });
        } else {
          unusedMediaKeys.push(upload.storageKey);
        }
      }
      if (unusedMediaKeys.length > 0) {
        await this.cleanupUploadedStorageKeys(
          unusedMediaKeys,
          'upload_rollback',
          activeUploadedKeys
        );
      }

      const storedMappings: ImportStoredMappings = {
        headerMappings: mappingResult.headerMappings,
        unmappedHeaders: mappingResult.unmappedHeaders,
        ...(audienceMapping ? { audienceMapping } : {}),
        duplicateStrategy,
      };
      const manifestPayloadBytes = new TextEncoder().encode(
        JSON.stringify({
          mappings: storedMappings,
          normalizedRows: normalizedData,
          rowErrors,
          stagedFileIds: keptStagedIds,
        })
      ).byteLength;
      const sourceFilePayloadBytes =
        400 + new TextEncoder().encode(csvUpload.originalName).byteLength;

      const plan = planImportCommit({
        normalizedData,
        stagedFileIds: keptStagedIds,
        sourceFileName: csvUpload.originalName,
        manifestPayloadBytes,
        sourceFilePayloadBytes,
      });

      if (d1Enforced && !plan.summary.withinD1Budget) {
        await this.cleanupUploadedStorageKeys(
          [...activeUploadedKeys],
          'upload_rollback',
          activeUploadedKeys
        );
        return {
          status: 422,
          body: {
            error: plan.violations[0]!.message,
            code: 'd1_budget_exceeded',
            details: {
              commitPlan: plan.summary,
              violations: plan.violations,
              alternatives: D1_BUDGET_ALTERNATIVES_MESSAGE,
            },
          },
        };
      }

      const sourceFileId = crypto.randomUUID();
      const sourceStorageKey = `communities/${caller.communityId}/imports/${sourceFileId}`;
      activeUploadedKeys.add(sourceStorageKey);
      await this.storage.put(
        sourceStorageKey,
        streamFromBytes(csvUpload.bytes),
        {
          contentType: csvUpload.mimeType,
        }
      );

      let outcome: CreatePreviewOutcome;
      try {
        outcome = await this.repository.createPreviewManifest({
          communityId: caller.communityId,
          actorId: caller.actorId,
          kind,
          sourceFileName: csvUpload.originalName,
          sourceFile: {
            id: sourceFileId,
            storageKey: sourceStorageKey,
            originalName: csvUpload.originalName,
            mimeType: csvUpload.mimeType,
            byteSize: csvUpload.byteSize,
            checksum: csvUpload.checksum,
          },
          stagedMediaFiles: keptMediaFiles,
          mappings: storedMappings,
          normalizedRows: normalizedData,
          rowCount: csvUpload.parsed.rows.length,
          rowErrors,
          stagedFileIds: keptStagedIds,
          now: requestNow,
          dailyLimitWindow: dailyWindow,
          maxOpenPreviews: MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY,
        });
      } catch {
        // Guard against lost D1/DB acks where the preview actually committed
        // before throwing: recover the persisted manifest rather than deleting
        // live storage bytes, and only delete bytes when absence is verified.
        let persistedManifest: ImportManifestRowRecord | null;
        try {
          persistedManifest = await this.repository.getManifestBySourceFileId(
            caller.communityId,
            sourceFileId
          );
        } catch {
          activeUploadedKeys.clear();
          return { status: 500, body: INTERNAL_ERROR_BODY };
        }

        if (persistedManifest) {
          activeUploadedKeys.clear();
          outcome = { status: 'created', manifest: persistedManifest };
        } else {
          let existingFiles: Map<string, StagedFileVerificationRecord>;
          try {
            existingFiles = await this.repository.findStagedFilesByIds(
              caller.communityId,
              [sourceFileId, ...keptStagedIds]
            );
          } catch {
            activeUploadedKeys.clear();
            return { status: 500, body: INTERNAL_ERROR_BODY };
          }

          if (existingFiles.size === 0) {
            await this.cleanupUploadedStorageKeys(
              [...activeUploadedKeys],
              'import_failed',
              activeUploadedKeys
            );
          } else {
            const persistedKeys = new Set(
              [...existingFiles.values()].map((row) => row.storageKey)
            );
            const unpersistedKeys = [...activeUploadedKeys].filter(
              (key) => !persistedKeys.has(key)
            );
            if (unpersistedKeys.length > 0) {
              await this.cleanupUploadedStorageKeys(
                unpersistedKeys,
                'import_failed',
                activeUploadedKeys
              );
            }
            activeUploadedKeys.clear();
          }
          return { status: 500, body: INTERNAL_ERROR_BODY };
        }
      }

      if (outcome.status === 'forbidden') {
        await this.cleanupUploadedStorageKeys(
          [...activeUploadedKeys],
          'import_failed',
          activeUploadedKeys
        );
        return { status: 403, body: FORBIDDEN_BODY };
      }
      if (outcome.status === 'daily_limit') {
        await this.cleanupUploadedStorageKeys(
          [...activeUploadedKeys],
          'import_failed',
          activeUploadedKeys
        );
        return {
          status: 429,
          body: D1_DAILY_IMPORT_LIMIT_BODY,
        };
      }
      if (outcome.status === 'too_many_open_previews') {
        await this.cleanupUploadedStorageKeys(
          [...activeUploadedKeys],
          'upload_rollback',
          activeUploadedKeys
        );
        return { status: 429, body: TOO_MANY_OPEN_PREVIEWS_BODY };
      }

      activeUploadedKeys.clear();
      const detail = serializeImportManifestDetail(
        outcome.manifest,
        d1Enforced
      );
      const checked = ImportManifestDetailResponseSchema.safeParse({
        data: detail,
      });
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 201, body: checked.data };
    } catch (error) {
      await this.cleanupUploadedStorageKeys(
        [...activeUploadedKeys],
        'upload_rollback',
        activeUploadedKeys
      );

      if (error instanceof EarlyImportRejectionError) {
        return { status: error.status, body: error.body };
      }
      if (error instanceof MediaCategoryLimitError) {
        return { status: 413, body: { error: 'Request too large' } };
      }
      if (error instanceof MultipartStreamError) {
        if (error.code === 'invalid_content_type') {
          return {
            status: 415,
            body: { error: 'Expected multipart/form-data' },
          };
        }
        if (error.code === 'payload_too_large') {
          return { status: 413, body: { error: 'Request too large' } };
        }
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'file', message: error.message },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async listImports(
    actor: FoundationUser,
    rawQueries: Record<string, string[] | undefined>
  ): Promise<
    ImportServiceResult<z.infer<typeof ImportManifestListResponseSchema>>
  > {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const flatQuery: Record<string, string> = {};
    const duplicateErrors: V2ValidationFieldError[] = [];
    for (const [key, values] of Object.entries(rawQueries)) {
      if (!values || values.length === 0) continue;
      if (values.length > 1) {
        duplicateErrors.push({
          path: key,
          message: 'Duplicate query parameter',
        });
        continue;
      }
      flatQuery[key] = values[0]!;
    }
    if (duplicateErrors.length > 0) {
      return { status: 400, body: makeValidationErrorBody(duplicateErrors) };
    }

    const parsed = ListImportsQuerySchema.safeParse(flatQuery);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const d1Enforced = this.isD1Enforced();
    const { rows, total } = await this.repository.listManifests(
      caller.communityId,
      parsed.data
    );
    const checked = ImportManifestListResponseSchema.safeParse({
      data: rows.map((row) => serializeImportManifestSummary(row, d1Enforced)),
      meta: {
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        hasNextPage: parsed.data.offset + rows.length < total,
      },
    });
    if (!checked.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 200, body: checked.data };
  }

  async getImport(
    actor: FoundationUser,
    rawId: string
  ): Promise<
    ImportServiceResult<z.infer<typeof ImportManifestDetailResponseSchema>>
  > {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawId)) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'id',
            message: 'Import manifest ID must be a positive integer',
          },
        ]),
      };
    }

    const manifest = await this.repository.getManifestById(
      caller.communityId,
      Number(rawId)
    );
    if (!manifest) {
      return { status: 404, body: NOT_FOUND_BODY };
    }

    const checked = ImportManifestDetailResponseSchema.safeParse({
      data: serializeImportManifestDetail(manifest, this.isD1Enforced()),
    });
    if (!checked.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 200, body: checked.data };
  }

  async discardImport(
    actor: FoundationUser,
    rawId: string
  ): Promise<
    ImportServiceResult<z.infer<typeof ImportManifestDetailResponseSchema>>
  > {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawId)) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'id',
            message: 'Import manifest ID must be a positive integer',
          },
        ]),
      };
    }

    const outcome = await this.repository.discardManifest({
      communityId: caller.communityId,
      actorId: caller.actorId,
      actorRole: caller.role as 'editor' | 'admin',
      manifestId: Number(rawId),
      now: this.now(),
    });

    if (outcome.status === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (outcome.status === 'forbidden') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (outcome.status === 'conflict') {
      return {
        status: 409,
        body: { error: 'Only previewed import manifests can be discarded' },
      };
    }

    await this.cleanup.deleteFilesBestEffort(
      outcome.removedFiles,
      'import_discarded'
    );
    const checked = ImportManifestDetailResponseSchema.safeParse({
      data: serializeImportManifestDetail(
        outcome.manifest,
        this.isD1Enforced()
      ),
    });
    if (!checked.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 200, body: checked.data };
  }

  private async verifyStagedMediaChecksum(
    storageKey: string,
    expectedByteSize: number,
    expectedChecksum: string
  ): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/i.test(expectedChecksum)) {
      return false;
    }
    let stored: Awaited<ReturnType<FoundationStorage['read']>>;
    try {
      stored = await this.storage.read(storageKey);
    } catch {
      return false;
    }
    if (!stored) return false;

    const hasher = new StreamingSha256();
    let totalBytes = 0;

    if (stored.body instanceof Uint8Array) {
      totalBytes = stored.body.byteLength;
      hasher.update(stored.body);
    } else {
      const reader = stored.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            totalBytes += value.byteLength;
            hasher.update(value);
          }
        }
      } catch {
        await reader.cancel().catch(() => {});
        return false;
      } finally {
        reader.releaseLock();
      }
    }

    return (
      totalBytes === expectedByteSize &&
      hasher.digestHex().toLowerCase() === expectedChecksum.toLowerCase()
    );
  }

  async commitImport(
    actor: FoundationUser,
    rawId: string
  ): Promise<
    ImportServiceResult<z.infer<typeof ImportManifestDetailResponseSchema>>
  > {
    const caller = await authorizeCommunityWriteCaller(this.repository, actor, [
      'editor',
      'admin',
    ]);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (!isDatabaseIdString(rawId)) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'id',
            message: 'Import manifest ID must be a positive integer',
          },
        ]),
      };
    }

    const manifestId = Number(rawId);
    const d1Enforced = this.isD1Enforced();
    const serializeManifest = (
      manifest: ImportManifestRowRecord
    ): ImportServiceResult<
      z.infer<typeof ImportManifestDetailResponseSchema>
    > => {
      const checked = ImportManifestDetailResponseSchema.safeParse({
        data: serializeImportManifestDetail(manifest, d1Enforced),
      });
      if (!checked.success) {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 200, body: checked.data };
    };

    const manifest = await this.repository.getManifestById(
      caller.communityId,
      manifestId
    );
    if (!manifest) {
      return { status: 404, body: NOT_FOUND_BODY };
    }

    if (manifest.status === 'committed') {
      return serializeManifest(manifest);
    }
    if (manifest.status === 'discarded') {
      return {
        status: 409,
        body: { error: 'Discarded import manifest cannot be committed' },
      };
    }
    if (manifest.status === 'failed') {
      return {
        status: 409,
        body: {
          error:
            'Failed import manifest cannot be committed; start a new preview',
        },
      };
    }

    const totalErrorCount =
      manifest.normalizedRows.totalErrorCount ?? manifest.rowErrors.length;
    if (totalErrorCount > 0 || manifest.rowErrors.length > 0) {
      return {
        status: 422,
        body: {
          error:
            'Import manifest has validation errors and cannot be committed',
          code: 'import_not_committable',
        },
      };
    }
    if (manifest.normalizedRows.rows.length === 0) {
      return {
        status: 422,
        body: {
          error: 'Import manifest contains no rows to commit',
          code: 'import_not_committable',
        },
      };
    }

    const { plan } = computeManifestPlan(manifest, d1Enforced);
    if (d1Enforced && !plan.summary.withinD1Budget) {
      return {
        status: 422,
        body: {
          error: plan.violations[0]!.message,
          code: 'd1_budget_exceeded',
          details: {
            commitPlan: plan.summary,
            violations: plan.violations,
            alternatives: D1_BUDGET_ALTERNATIVES_MESSAGE,
          },
        },
      };
    }

    const requestNow = this.now();
    const dailyWindow = this.dailyLimitWindow(requestNow);
    if (dailyWindow) {
      const hitDaily = await this.repository.hasCommittedImportInWindow(
        dailyWindow.startMs,
        dailyWindow.endMs
      );
      if (hitDaily) {
        const latest = await this.repository.getManifestById(
          caller.communityId,
          manifestId
        );
        if (latest?.status === 'committed') {
          return serializeManifest(latest);
        }
        return {
          status: 429,
          body: D1_DAILY_IMPORT_LIMIT_BODY,
        };
      }
    }

    const failAndCleanup = async (
      failureStatus: 409 | 500 = 409
    ): Promise<
      ImportServiceResult<z.infer<typeof ImportManifestDetailResponseSchema>>
    > => {
      let failOutcome;
      try {
        failOutcome = await this.repository.failManifest({
          communityId: caller.communityId,
          actorId: caller.actorId,
          manifestId,
          now: requestNow,
        });
      } catch {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      if (failOutcome.status === 'already_committed') {
        return serializeManifest(failOutcome.manifest);
      }
      if (failOutcome.status === 'not_found') {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (failOutcome.status === 'forbidden') {
        return { status: 403, body: FORBIDDEN_BODY };
      }
      if (failOutcome.status === 'failed') {
        await this.cleanup.deleteFilesBestEffort(
          failOutcome.removedFiles,
          'import_failed'
        );
        return {
          status: failureStatus,
          body: {
            error: 'Import commit failed; no records were applied',
            code: 'import_commit_failed',
          },
        };
      }
      return {
        status: 409,
        body: {
          error:
            failOutcome.manifest.status === 'discarded'
              ? 'Discarded import manifest cannot be committed'
              : 'Failed import manifest cannot be committed; start a new preview',
        },
      };
    };

    // Re-verify existing referenced media files before commit.
    const existingFileIds = Array.from(
      new Set(
        manifest.normalizedRows.rows.flatMap((row) =>
          row.attachments
            .filter((att) => !att.stagedByManifest)
            .map((att) => att.fileId)
        )
      )
    );
    if (existingFileIds.length > 0) {
      const foundExisting = await this.repository.findCommunityFilesByIds(
        caller.communityId,
        existingFileIds
      );
      for (const fileId of existingFileIds) {
        const dbFile = foundExisting.get(fileId);
        if (!dbFile) {
          const latest = await this.repository.getManifestById(
            caller.communityId,
            manifestId
          );
          if (latest?.status === 'committed') return serializeManifest(latest);
          if (latest?.status === 'discarded') {
            return {
              status: 409,
              body: { error: 'Discarded import manifest cannot be committed' },
            };
          }
          return failAndCleanup();
        }
        const reuse = await this.mediaRepository.authorizeAttachReuse({
          actor,
          communityId: caller.communityId,
          file: { id: dbFile.id, uploadedBy: dbFile.uploadedBy },
        });
        if (!reuse.ok) {
          if (
            caller.role !== 'admin' &&
            manifest.createdBy !== caller.actorId
          ) {
            return { status: 403, body: FORBIDDEN_BODY };
          }
          return failAndCleanup();
        }
      }
    }

    // Verify staged media rows and checksums against stored bytes before commit.
    const stagedMediaIds = Array.from(new Set(manifest.stagedFileIds))
      .filter((id) => id !== manifest.sourceFileId)
      .sort();
    if (stagedMediaIds.length > 0) {
      const stagedRows = await this.repository.findStagedFilesByIds(
        caller.communityId,
        stagedMediaIds
      );
      let stagedInvalid = false;
      for (const fileId of stagedMediaIds) {
        const row = stagedRows.get(fileId);
        if (
          !row ||
          row.isActive ||
          row.culturalRestrictions !== null ||
          row.checksum === null
        ) {
          stagedInvalid = true;
          break;
        }
        const bytesOk = await this.verifyStagedMediaChecksum(
          row.storageKey,
          row.byteSize,
          row.checksum
        );
        if (!bytesOk) {
          stagedInvalid = true;
          break;
        }
      }
      if (stagedInvalid) {
        const latest = await this.repository.getManifestById(
          caller.communityId,
          manifestId
        );
        if (latest?.status === 'committed') {
          return serializeManifest(latest);
        }
        if (latest?.status === 'discarded') {
          return {
            status: 409,
            body: { error: 'Discarded import manifest cannot be committed' },
          };
        }
        if (latest?.status === 'failed') {
          return {
            status: 409,
            body: {
              error:
                'Failed import manifest cannot be committed; start a new preview',
            },
          };
        }
        return failAndCleanup();
      }
    }

    let commitOutcome;
    try {
      commitOutcome = await this.repository.commitManifest({
        communityId: caller.communityId,
        actorId: caller.actorId,
        actor,
        manifest,
        now: requestNow,
        dailyLimitWindow: dailyWindow,
      });
    } catch {
      commitOutcome = { status: 'uncertain' } as const;
    }

    if (
      commitOutcome.status === 'committed' ||
      commitOutcome.status === 'already_committed'
    ) {
      return serializeManifest(commitOutcome.manifest);
    }
    if (commitOutcome.status === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (commitOutcome.status === 'forbidden') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (commitOutcome.status === 'daily_limit') {
      return {
        status: 429,
        body: D1_DAILY_IMPORT_LIMIT_BODY,
      };
    }
    if (commitOutcome.status === 'conflict') {
      return {
        status: 409,
        body: {
          error:
            commitOutcome.manifest.status === 'discarded'
              ? 'Discarded import manifest cannot be committed'
              : 'Failed import manifest cannot be committed; start a new preview',
        },
      };
    }
    if (commitOutcome.status === 'failed_rolled_back') {
      return failAndCleanup(500);
    }
    if (commitOutcome.status === 'uncertain') {
      let latest: ImportManifestRowRecord | null;
      try {
        latest = await this.repository.getManifestById(
          caller.communityId,
          manifestId
        );
      } catch {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      if (!latest) {
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (latest.status === 'committed') {
        return serializeManifest(latest);
      }
      if (latest.status === 'discarded') {
        return {
          status: 409,
          body: { error: 'Discarded import manifest cannot be committed' },
        };
      }
      if (latest.status === 'failed') {
        return {
          status: 409,
          body: {
            error:
              'Failed import manifest cannot be committed; start a new preview',
          },
        };
      }
      return failAndCleanup(500);
    }

    return failAndCleanup(409);
  }

  private validateAndNormalizeRows(input: {
    kind: ImportManifestKind;
    rows: ParsedCsvResult['rows'];
    readCell: (cells: string[], canonicalField: string) => string | undefined;
    duplicateStrategy: DuplicateStrategy;
    audienceMapping: AudienceMapping | undefined;
    context: CommunityImportContext;
    stagedByName: ReadonlyMap<string, StagedMediaUpload>;
    authorizedExistingFiles: ReadonlyMap<
      string,
      { id: string; mimeType: string; category: MediaCategory }
    >;
  }): {
    normalizedData: StoredNormalizedImportData;
    rowErrors: ImportRowError[];
    referencedStagedIds: Set<string>;
  } {
    const placesById = new Map<number, { id: number; name: string }>();
    const placesByNormName = new Map<
      string,
      Array<{ id: number; name: string }>
    >();
    for (const p of input.context.places) {
      placesById.set(p.id, p);
      const norm = normalizeSearchText(p.name);
      const bucket = placesByNormName.get(norm) ?? [];
      bucket.push(p);
      placesByNormName.set(norm, bucket);
    }

    const speakersById = new Map<number, { id: number; name: string }>();
    const speakersByNormName = new Map<
      string,
      Array<{ id: number; name: string }>
    >();
    for (const s of input.context.speakers) {
      speakersById.set(s.id, s);
      const norm = normalizeSearchText(s.name);
      const bucket = speakersByNormName.get(norm) ?? [];
      bucket.push(s);
      speakersByNormName.set(norm, bucket);
    }

    const existingStoryTitles = new Set(
      input.context.stories.map((st) => normalizeSearchText(st.title))
    );

    const seenPlaceNames = new Set(placesByNormName.keys());
    const seenSpeakerNames = new Set(speakersByNormName.keys());
    const seenStoryTitles = new Set(existingStoryTitles);

    const relatedPlacesMap = new Map<string, RelatedPlaceToCreate>();
    const relatedSpeakersMap = new Map<string, RelatedSpeakerToCreate>();
    const rowErrors: ImportRowError[] = [];
    let totalErrorCount = 0;
    let rowErrorsTruncated = false;
    const recordRowErrors = (errs: ReadonlyArray<ImportRowError>) => {
      if (errs.length === 0) return;
      totalErrorCount += errs.length;
      if (rowErrors.length >= MAX_IMPORT_ROW_ERRORS) {
        rowErrorsTruncated = true;
        return;
      }
      const remaining = MAX_IMPORT_ROW_ERRORS - rowErrors.length;
      if (errs.length > remaining) {
        rowErrors.push(...errs.slice(0, remaining));
        rowErrorsTruncated = true;
        return;
      }
      rowErrors.push(...errs);
    };
    const referencedStagedIds = new Set<string>();
    let skippedDuplicates = 0;

    const resolveMediaToken = (
      rowNumber: number,
      field: string,
      token: string,
      role: AttachmentRole,
      ordinal: number,
      errorsForRow: ImportRowError[]
    ): {
      fileId: string;
      role: AttachmentRole;
      ordinal: number;
      stagedByManifest: boolean;
    } | null => {
      const allowedCategories = ATTACHMENT_ROLE_ALLOWED_CATEGORIES[role];
      const staged = input.stagedByName.get(token);
      if (staged) {
        if (!allowedCategories.includes(staged.category)) {
          errorsForRow.push({
            row: rowNumber,
            field,
            code: 'media_type_mismatch',
            message: 'Staged media file type does not match field role',
          });
          return null;
        }
        return {
          fileId: staged.fileId,
          role,
          ordinal,
          stagedByManifest: true,
        };
      }
      if (UUID_REGEX.test(token)) {
        const existing = input.authorizedExistingFiles.get(token);
        if (!existing) {
          errorsForRow.push({
            row: rowNumber,
            field,
            code: 'missing_media',
            message: 'Referenced media file was not found',
          });
          return null;
        }
        if (!allowedCategories.includes(existing.category)) {
          errorsForRow.push({
            row: rowNumber,
            field,
            code: 'media_type_mismatch',
            message: 'Referenced media file type does not match field role',
          });
          return null;
        }
        return {
          fileId: existing.id,
          role,
          ordinal,
          stagedByManifest: false,
        };
      }
      errorsForRow.push({
        row: rowNumber,
        field,
        code: 'missing_media',
        message: 'Referenced media file was not staged or found',
      });
      return null;
    };

    const resolvePlaceById = (
      rowNumber: number,
      field: string,
      rawId: string,
      errorsForRow: ImportRowError[]
    ): { kind: 'existing'; id: number } | null => {
      if (!isDatabaseIdString(rawId) || !placesById.has(Number(rawId))) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'missing_place',
          message: 'Referenced place was not found in this community',
        });
        return null;
      }
      return { kind: 'existing', id: Number(rawId) };
    };

    const resolvePlaceByName = (
      rowNumber: number,
      field: string,
      rawName: string,
      errorsForRow: ImportRowError[]
    ):
      | { kind: 'existing'; id: number }
      | { kind: 'create'; name: string; normalizedName: string }
      | null => {
      const name = rawName.trim();
      if (name.length === 0 || name.length > 200) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'invalid_length',
          message: 'Place name must be between 1 and 200 characters',
        });
        return null;
      }
      if (hasCsvFormulaPrefix(name)) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'formula_injection',
          message: 'Field cannot begin with a spreadsheet formula prefix',
        });
        return null;
      }
      const norm = normalizeSearchText(name);
      const matches = placesByNormName.get(norm);
      if (matches && matches.length > 1) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'ambiguous_reference',
          message: 'Place name matches multiple existing community places',
        });
        return null;
      }
      if (matches && matches.length === 1) {
        return { kind: 'existing', id: matches[0]!.id };
      }
      return { kind: 'create', name, normalizedName: norm };
    };

    const resolveSpeakerById = (
      rowNumber: number,
      field: string,
      rawId: string,
      errorsForRow: ImportRowError[]
    ): { kind: 'existing'; id: number } | null => {
      if (!isDatabaseIdString(rawId) || !speakersById.has(Number(rawId))) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'missing_speaker',
          message: 'Referenced speaker was not found in this community',
        });
        return null;
      }
      return { kind: 'existing', id: Number(rawId) };
    };

    const resolveSpeakerByName = (
      rowNumber: number,
      field: string,
      rawName: string,
      errorsForRow: ImportRowError[]
    ):
      | { kind: 'existing'; id: number }
      | { kind: 'create'; name: string; normalizedName: string }
      | null => {
      const name = rawName.trim();
      if (name.length === 0 || name.length > 200) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'invalid_length',
          message: 'Speaker name must be between 1 and 200 characters',
        });
        return null;
      }
      if (hasCsvFormulaPrefix(name)) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'formula_injection',
          message: 'Field cannot begin with a spreadsheet formula prefix',
        });
        return null;
      }
      const norm = normalizeSearchText(name);
      const matches = speakersByNormName.get(norm);
      if (matches && matches.length > 1) {
        errorsForRow.push({
          row: rowNumber,
          field,
          code: 'ambiguous_reference',
          message: 'Speaker name matches multiple existing community speakers',
        });
        return null;
      }
      if (matches && matches.length === 1) {
        return { kind: 'existing', id: matches[0]!.id };
      }
      return { kind: 'create', name, normalizedName: norm };
    };

    if (input.kind === 'places') {
      const placeRows: NormalizedPlaceRow[] = [];
      for (const row of input.rows) {
        const errs: ImportRowError[] = [];
        const rawName = (input.readCell(row.cells, 'name') ?? '').trim();
        if (rawName.length === 0) {
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'missing_required',
            message: 'Place name is required',
          });
        } else if (rawName.length > 200) {
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'invalid_length',
            message: 'Place name must be at most 200 characters',
          });
        } else if (hasCsvFormulaPrefix(rawName)) {
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'formula_injection',
            message: 'Field cannot begin with a spreadsheet formula prefix',
          });
        }

        const normName = normalizeSearchText(rawName);
        if (errs.length === 0 && seenPlaceNames.has(normName)) {
          if (input.duplicateStrategy === 'skip') {
            skippedDuplicates += 1;
            continue;
          }
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'duplicate_record',
            message: 'Duplicate place name',
          });
        }

        const rawDesc = input.readCell(row.cells, 'description') ?? '';
        let description: string | null = null;
        let descriptionPlain: string | null = null;
        if (rawDesc.trim().length > 0) {
          if (hasCsvFormulaPrefix(rawDesc)) {
            errs.push({
              row: row.rowNumber,
              field: 'description',
              code: 'formula_injection',
              message: 'Field cannot begin with a spreadsheet formula prefix',
            });
          } else {
            try {
              const derived = deriveDescriptionForWrite(rawDesc);
              description = derived.description;
              descriptionPlain = derived.descriptionPlain;
            } catch (err) {
              if (err instanceof InvalidDescriptionError) {
                errs.push({
                  row: row.rowNumber,
                  field: 'description',
                  code: 'invalid_description',
                  message: err.message,
                });
              } else {
                throw err;
              }
            }
          }
        }

        const rawType = (input.readCell(row.cells, 'typeOfPlace') ?? '').trim();
        let typeOfPlace: string | null = null;
        if (rawType.length > 0) {
          if (rawType.length > 120) {
            errs.push({
              row: row.rowNumber,
              field: 'typeOfPlace',
              code: 'invalid_length',
              message: 'typeOfPlace must be at most 120 characters',
            });
          } else if (hasCsvFormulaPrefix(rawType)) {
            errs.push({
              row: row.rowNumber,
              field: 'typeOfPlace',
              code: 'formula_injection',
              message: 'Field cannot begin with a spreadsheet formula prefix',
            });
          } else {
            typeOfPlace = rawType;
          }
        }

        const rawRegion = (input.readCell(row.cells, 'region') ?? '').trim();
        let region: string | null = null;
        if (rawRegion.length > 0) {
          if (rawRegion.length > 120) {
            errs.push({
              row: row.rowNumber,
              field: 'region',
              code: 'invalid_length',
              message: 'region must be at most 120 characters',
            });
          } else if (hasCsvFormulaPrefix(rawRegion)) {
            errs.push({
              row: row.rowNumber,
              field: 'region',
              code: 'formula_injection',
              message: 'Field cannot begin with a spreadsheet formula prefix',
            });
          } else {
            region = rawRegion;
          }
        }

        const rawLat = (input.readCell(row.cells, 'latitude') ?? '').trim();
        const rawLng = (input.readCell(row.cells, 'longitude') ?? '').trim();
        let latitude: number | null = null;
        let longitude: number | null = null;
        if (rawLat.length > 0 !== rawLng.length > 0) {
          errs.push({
            row: row.rowNumber,
            field: rawLat.length > 0 ? 'longitude' : 'latitude',
            code: 'invalid_coordinates',
            message:
              'Latitude and longitude must both be provided or both omitted',
          });
        } else if (rawLat.length > 0 && rawLng.length > 0) {
          const lat = parseFiniteCoordinate(rawLat);
          const lng = parseFiniteCoordinate(rawLng);
          if (lat === null || lat < -90 || lat > 90) {
            errs.push({
              row: row.rowNumber,
              field: 'latitude',
              code: 'invalid_coordinates',
              message: 'Latitude must be a finite number between -90 and 90',
            });
          }
          if (lng === null || lng < -180 || lng > 180) {
            errs.push({
              row: row.rowNumber,
              field: 'longitude',
              code: 'invalid_coordinates',
              message: 'Longitude must be a finite number between -180 and 180',
            });
          }
          latitude = lat;
          longitude = lng;
        }

        const attachments: NormalizedPlaceRow['attachments'] = [];
        const rawPhotos = (input.readCell(row.cells, 'photo') ?? '').trim();
        if (rawPhotos.length > 0) {
          const photoSplit = splitBoundedTokens(
            rawPhotos,
            PIPE_LIST_TOKEN_PATTERN,
            MAX_IMPORT_MEDIA_REFS_PER_ROW
          );
          if (photoSplit.exceeded) {
            errs.push({
              row: row.rowNumber,
              field: 'photo',
              code: 'too_many_refs',
              message: `At most ${MAX_IMPORT_MEDIA_REFS_PER_ROW} media references allowed per row`,
            });
          } else {
            photoSplit.tokens.forEach((ref, ordinal) => {
              const resolved = resolveMediaToken(
                row.rowNumber,
                'photo',
                ref,
                'place_photo',
                ordinal,
                errs
              );
              if (resolved) {
                attachments.push({
                  fileId: resolved.fileId,
                  role: 'place_photo',
                  ordinal: resolved.ordinal,
                  stagedByManifest: resolved.stagedByManifest,
                });
              }
            });
          }
        }

        const rawAudio = (input.readCell(row.cells, 'nameAudio') ?? '').trim();
        if (rawAudio.length > 0) {
          const audioSplit = splitBoundedTokens(
            rawAudio,
            PIPE_LIST_TOKEN_PATTERN,
            1
          );
          if (audioSplit.exceeded) {
            errs.push({
              row: row.rowNumber,
              field: 'nameAudio',
              code: 'too_many_refs',
              message: 'At most 1 place name audio reference allowed per row',
            });
          } else if (audioSplit.tokens[0]) {
            const resolved = resolveMediaToken(
              row.rowNumber,
              'nameAudio',
              audioSplit.tokens[0],
              'place_name_audio',
              0,
              errs
            );
            if (resolved) {
              attachments.push({
                fileId: resolved.fileId,
                role: 'place_name_audio',
                ordinal: 0,
                stagedByManifest: resolved.stagedByManifest,
              });
            }
          }
        }

        if (errs.length > 0) {
          recordRowErrors(errs);
          continue;
        }

        seenPlaceNames.add(normName);
        for (const att of attachments) {
          if (att.stagedByManifest) referencedStagedIds.add(att.fileId);
        }
        placeRows.push({
          rowNumber: row.rowNumber,
          name: rawName,
          normalizedName: normName,
          description,
          descriptionPlain,
          typeOfPlace,
          region,
          latitude,
          longitude,
          attachments,
        });
      }

      return {
        normalizedData: {
          kind: 'places',
          rows: placeRows,
          relatedPlacesToCreate: [],
          relatedSpeakersToCreate: [],
          skippedDuplicates,
          audienceCounts: null,
          validRowCount: placeRows.length,
          totalErrorCount,
          rowErrorsTruncated,
        },
        rowErrors,
        referencedStagedIds,
      };
    }

    if (input.kind === 'speakers') {
      const speakerRows: NormalizedSpeakerRow[] = [];
      for (const row of input.rows) {
        const errs: ImportRowError[] = [];
        const rawName = (input.readCell(row.cells, 'name') ?? '').trim();
        if (rawName.length === 0) {
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'missing_required',
            message: 'Speaker name is required',
          });
        } else if (rawName.length > 200) {
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'invalid_length',
            message: 'Speaker name must be at most 200 characters',
          });
        } else if (hasCsvFormulaPrefix(rawName)) {
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'formula_injection',
            message: 'Field cannot begin with a spreadsheet formula prefix',
          });
        }

        const normName = normalizeSearchText(rawName);
        if (errs.length === 0 && seenSpeakerNames.has(normName)) {
          if (input.duplicateStrategy === 'skip') {
            skippedDuplicates += 1;
            continue;
          }
          errs.push({
            row: row.rowNumber,
            field: 'name',
            code: 'duplicate_record',
            message: 'Duplicate speaker name',
          });
        }

        const rawBirthDate = (
          input.readCell(row.cells, 'birthDate') ?? ''
        ).trim();
        let birthDate: string | null = null;
        if (rawBirthDate.length > 0) {
          if (!isValidCalendarDate(rawBirthDate)) {
            errs.push({
              row: row.rowNumber,
              field: 'birthDate',
              code: 'invalid_date',
              message: 'birthDate must be a valid YYYY-MM-DD calendar date',
            });
          } else {
            birthDate = rawBirthDate;
          }
        }

        const rawBirthplaceId = (
          input.readCell(row.cells, 'birthplaceId') ?? ''
        ).trim();
        const rawBirthplaceName = (
          input.readCell(row.cells, 'birthplaceName') ?? ''
        ).trim();
        let birthplaceRef: NormalizedSpeakerRow['birthplaceRef'] = null;
        if (rawBirthplaceId.length > 0 && rawBirthplaceName.length > 0) {
          errs.push({
            row: row.rowNumber,
            field: 'birthplaceName',
            code: 'conflicting_reference',
            message:
              'Provide either birthplaceId or birthplaceName per row, not both',
          });
        } else if (rawBirthplaceId.length > 0) {
          birthplaceRef = resolvePlaceById(
            row.rowNumber,
            'birthplaceId',
            rawBirthplaceId,
            errs
          );
        } else if (rawBirthplaceName.length > 0) {
          birthplaceRef = resolvePlaceByName(
            row.rowNumber,
            'birthplaceName',
            rawBirthplaceName,
            errs
          );
        }

        const rawAffiliation = (
          input.readCell(row.cells, 'affiliation') ?? ''
        ).trim();
        let affiliation: string | null = null;
        if (rawAffiliation.length > 0) {
          if (rawAffiliation.length > 200) {
            errs.push({
              row: row.rowNumber,
              field: 'affiliation',
              code: 'invalid_length',
              message: 'affiliation must be at most 200 characters',
            });
          } else if (hasCsvFormulaPrefix(rawAffiliation)) {
            errs.push({
              row: row.rowNumber,
              field: 'affiliation',
              code: 'formula_injection',
              message: 'Field cannot begin with a spreadsheet formula prefix',
            });
          } else {
            affiliation = rawAffiliation;
          }
        }

        const attachments: NormalizedSpeakerRow['attachments'] = [];
        const rawPhoto = (input.readCell(row.cells, 'photo') ?? '').trim();
        if (rawPhoto.length > 0) {
          const photoSplit = splitBoundedTokens(
            rawPhoto,
            PIPE_LIST_TOKEN_PATTERN,
            1
          );
          if (photoSplit.exceeded) {
            errs.push({
              row: row.rowNumber,
              field: 'photo',
              code: 'too_many_refs',
              message: 'At most 1 speaker photo reference allowed per row',
            });
          } else if (photoSplit.tokens[0]) {
            const resolved = resolveMediaToken(
              row.rowNumber,
              'photo',
              photoSplit.tokens[0],
              'speaker_photo',
              0,
              errs
            );
            if (resolved) {
              attachments.push({
                fileId: resolved.fileId,
                role: 'speaker_photo',
                ordinal: 0,
                stagedByManifest: resolved.stagedByManifest,
              });
            }
          }
        }

        if (errs.length > 0) {
          recordRowErrors(errs);
          continue;
        }

        seenSpeakerNames.add(normName);
        if (birthplaceRef?.kind === 'create') {
          relatedPlacesMap.set(birthplaceRef.normalizedName, {
            name: birthplaceRef.name,
            normalizedName: birthplaceRef.normalizedName,
          });
        }
        for (const att of attachments) {
          if (att.stagedByManifest) referencedStagedIds.add(att.fileId);
        }
        speakerRows.push({
          rowNumber: row.rowNumber,
          name: rawName,
          normalizedName: normName,
          birthDate,
          birthplaceRef,
          affiliation,
          attachments,
        });
      }

      return {
        normalizedData: {
          kind: 'speakers',
          rows: speakerRows,
          relatedPlacesToCreate: [...relatedPlacesMap.values()],
          relatedSpeakersToCreate: [],
          skippedDuplicates,
          audienceCounts: null,
          validRowCount: speakerRows.length,
          totalErrorCount,
          rowErrorsTruncated,
        },
        rowErrors,
        referencedStagedIds,
      };
    }

    // Stories import
    const storyRows: NormalizedStoryRow[] = [];
    const seenSlugs = new Set<string>();
    const allocateUniqueStorySlug = (title: string): string => {
      for (;;) {
        const candidate = buildUniqueStorySlug(title);
        if (!seenSlugs.has(candidate)) {
          seenSlugs.add(candidate);
          return candidate;
        }
      }
    };
    const audienceCounts = { public: 0, community: 0, editors: 0 };

    for (const row of input.rows) {
      const errs: ImportRowError[] = [];
      const rawTitle = (input.readCell(row.cells, 'title') ?? '').trim();
      if (rawTitle.length === 0) {
        errs.push({
          row: row.rowNumber,
          field: 'title',
          code: 'missing_required',
          message: 'Story title is required',
        });
      } else if (rawTitle.length > 255) {
        errs.push({
          row: row.rowNumber,
          field: 'title',
          code: 'invalid_length',
          message: 'Story title must be at most 255 characters',
        });
      } else if (hasCsvFormulaPrefix(rawTitle)) {
        errs.push({
          row: row.rowNumber,
          field: 'title',
          code: 'formula_injection',
          message: 'Field cannot begin with a spreadsheet formula prefix',
        });
      }

      const normTitle = normalizeSearchText(rawTitle);
      if (errs.length === 0 && seenStoryTitles.has(normTitle)) {
        if (input.duplicateStrategy === 'skip') {
          skippedDuplicates += 1;
          continue;
        }
        errs.push({
          row: row.rowNumber,
          field: 'title',
          code: 'duplicate_record',
          message: 'Duplicate story title',
        });
      }

      const rawVisibility = (
        input.readCell(row.cells, 'visibility') ?? ''
      ).trim();
      let visibility: 'public' | 'community' | 'editors' | null = null;
      if (rawVisibility.length === 0) {
        errs.push({
          row: row.rowNumber,
          field: 'visibility',
          code: 'missing_required',
          message:
            'Audience/visibility is required and never defaults to public',
        });
      } else {
        const mapped = input.audienceMapping?.[rawVisibility];
        const candidate = mapped ?? rawVisibility;
        if (
          candidate === 'public' ||
          candidate === 'community' ||
          candidate === 'editors'
        ) {
          visibility = candidate;
        } else {
          errs.push({
            row: row.rowNumber,
            field: 'visibility',
            code: 'unknown_audience',
            message:
              'Unknown story audience value; provide an explicit audienceMapping',
          });
        }
      }

      const rawDesc = input.readCell(row.cells, 'description') ?? '';
      let description: string | null = null;
      let descriptionPlain: string | null = null;
      if (rawDesc.trim().length > 0) {
        if (hasCsvFormulaPrefix(rawDesc)) {
          errs.push({
            row: row.rowNumber,
            field: 'description',
            code: 'formula_injection',
            message: 'Field cannot begin with a spreadsheet formula prefix',
          });
        } else {
          try {
            const derived = deriveDescriptionForWrite(rawDesc);
            description = derived.description;
            descriptionPlain = derived.descriptionPlain;
          } catch (err) {
            if (err instanceof InvalidDescriptionError) {
              errs.push({
                row: row.rowNumber,
                field: 'description',
                code: 'invalid_description',
                message: err.message,
              });
            } else {
              throw err;
            }
          }
        }
      }

      const rawTopic = (input.readCell(row.cells, 'topic') ?? '').trim();
      let topic: string | null = null;
      let topicNormalized: string | null = null;
      if (rawTopic.length > 0) {
        if (rawTopic.length > 200) {
          errs.push({
            row: row.rowNumber,
            field: 'topic',
            code: 'invalid_length',
            message: 'topic must be at most 200 characters',
          });
        } else if (hasCsvFormulaPrefix(rawTopic)) {
          errs.push({
            row: row.rowNumber,
            field: 'topic',
            code: 'formula_injection',
            message: 'Field cannot begin with a spreadsheet formula prefix',
          });
        } else {
          const derived = deriveTopicColumns(rawTopic);
          topic = derived.topic;
          topicNormalized = derived.topicNormalized;
        }
      }

      const rawLang = (input.readCell(row.cells, 'language') ?? '').trim();
      let language = 'en';
      if (rawLang.length > 0) {
        if (hasCsvFormulaPrefix(rawLang)) {
          errs.push({
            row: row.rowNumber,
            field: 'language',
            code: 'formula_injection',
            message: 'Field cannot begin with a spreadsheet formula prefix',
          });
        } else {
          const parsedLang = StoryLanguageSchema.safeParse(rawLang);
          if (!parsedLang.success) {
            errs.push({
              row: row.rowNumber,
              field: 'language',
              code: 'invalid_language',
              message: 'Invalid story language code',
            });
          } else {
            language = parsedLang.data;
          }
        }
      }

      const rawDate = (
        input.readCell(row.cells, 'dateInterviewed') ?? ''
      ).trim();
      let dateInterviewed: string | null = null;
      if (rawDate.length > 0) {
        const parsedDate = parseStoryDateInterviewed(rawDate);
        if (!parsedDate) {
          errs.push({
            row: row.rowNumber,
            field: 'dateInterviewed',
            code: 'invalid_date',
            message:
              'dateInterviewed must be YYYY-MM-DD or ISO-8601 datetime with timezone',
          });
        } else {
          dateInterviewed = parsedDate;
        }
      }

      const rawLocId = (
        input.readCell(row.cells, 'interviewLocationId') ?? ''
      ).trim();
      const rawLocName = (
        input.readCell(row.cells, 'interviewLocationName') ?? ''
      ).trim();
      let interviewLocationRef: NormalizedStoryRow['interviewLocationRef'] =
        null;
      if (rawLocId.length > 0 && rawLocName.length > 0) {
        errs.push({
          row: row.rowNumber,
          field: 'interviewLocationName',
          code: 'conflicting_reference',
          message:
            'Provide either interviewLocationId or interviewLocationName, not both',
        });
      } else if (rawLocId.length > 0) {
        interviewLocationRef = resolvePlaceById(
          row.rowNumber,
          'interviewLocationId',
          rawLocId,
          errs
        );
      } else if (rawLocName.length > 0) {
        interviewLocationRef = resolvePlaceByName(
          row.rowNumber,
          'interviewLocationName',
          rawLocName,
          errs
        );
      }

      const rawInterviewerId = (
        input.readCell(row.cells, 'interviewerId') ?? ''
      ).trim();
      const rawInterviewerName = (
        input.readCell(row.cells, 'interviewerName') ?? ''
      ).trim();
      let interviewerRef: NormalizedStoryRow['interviewerRef'] = null;
      if (rawInterviewerId.length > 0 && rawInterviewerName.length > 0) {
        errs.push({
          row: row.rowNumber,
          field: 'interviewerName',
          code: 'conflicting_reference',
          message: 'Provide either interviewerId or interviewerName, not both',
        });
      } else if (rawInterviewerId.length > 0) {
        interviewerRef = resolveSpeakerById(
          row.rowNumber,
          'interviewerId',
          rawInterviewerId,
          errs
        );
      } else if (rawInterviewerName.length > 0) {
        interviewerRef = resolveSpeakerByName(
          row.rowNumber,
          'interviewerName',
          rawInterviewerName,
          errs
        );
      }

      const placeRefs: NormalizedStoryRow['placeRefs'] = [];
      const rawPlaceIds = (input.readCell(row.cells, 'placeIds') ?? '').trim();
      const rawPlaceNames = (
        input.readCell(row.cells, 'placeNames') ?? ''
      ).trim();
      const placeIdSplit = splitBoundedTokens(
        rawPlaceIds,
        ID_LIST_TOKEN_PATTERN,
        MAX_IMPORT_STORY_EDGES_PER_ROW
      );
      const placeNameSplit = splitBoundedTokens(
        rawPlaceNames,
        PIPE_LIST_TOKEN_PATTERN,
        MAX_IMPORT_STORY_EDGES_PER_ROW
      );
      if (placeIdSplit.exceeded) {
        errs.push({
          row: row.rowNumber,
          field: 'placeIds',
          code: 'too_many_refs',
          message: `At most ${MAX_IMPORT_STORY_EDGES_PER_ROW} place associations allowed per story`,
        });
      }
      if (placeNameSplit.exceeded) {
        errs.push({
          row: row.rowNumber,
          field: 'placeNames',
          code: 'too_many_refs',
          message: `At most ${MAX_IMPORT_STORY_EDGES_PER_ROW} place associations allowed per story`,
        });
      }
      if (!placeIdSplit.exceeded && !placeNameSplit.exceeded) {
        if (
          placeIdSplit.tokens.length + placeNameSplit.tokens.length >
          MAX_IMPORT_STORY_EDGES_PER_ROW
        ) {
          errs.push({
            row: row.rowNumber,
            field: placeIdSplit.tokens.length > 0 ? 'placeIds' : 'placeNames',
            code: 'too_many_refs',
            message: `At most ${MAX_IMPORT_STORY_EDGES_PER_ROW} place associations allowed per story`,
          });
        } else {
          for (const idToken of placeIdSplit.tokens) {
            const ref = resolvePlaceById(
              row.rowNumber,
              'placeIds',
              idToken,
              errs
            );
            if (ref) placeRefs.push(ref);
          }
          for (const nameToken of placeNameSplit.tokens) {
            const ref = resolvePlaceByName(
              row.rowNumber,
              'placeNames',
              nameToken,
              errs
            );
            if (ref) placeRefs.push(ref);
          }
        }
      }

      const speakerRefs: NormalizedStoryRow['speakerRefs'] = [];
      const rawSpeakerIds = (
        input.readCell(row.cells, 'speakerIds') ?? ''
      ).trim();
      const rawSpeakerNames = (
        input.readCell(row.cells, 'speakerNames') ?? ''
      ).trim();
      const speakerIdSplit = splitBoundedTokens(
        rawSpeakerIds,
        ID_LIST_TOKEN_PATTERN,
        MAX_IMPORT_STORY_EDGES_PER_ROW
      );
      const speakerNameSplit = splitBoundedTokens(
        rawSpeakerNames,
        PIPE_LIST_TOKEN_PATTERN,
        MAX_IMPORT_STORY_EDGES_PER_ROW
      );
      if (speakerIdSplit.exceeded) {
        errs.push({
          row: row.rowNumber,
          field: 'speakerIds',
          code: 'too_many_refs',
          message: `At most ${MAX_IMPORT_STORY_EDGES_PER_ROW} speaker associations allowed per story`,
        });
      }
      if (speakerNameSplit.exceeded) {
        errs.push({
          row: row.rowNumber,
          field: 'speakerNames',
          code: 'too_many_refs',
          message: `At most ${MAX_IMPORT_STORY_EDGES_PER_ROW} speaker associations allowed per story`,
        });
      }
      if (!speakerIdSplit.exceeded && !speakerNameSplit.exceeded) {
        if (
          speakerIdSplit.tokens.length + speakerNameSplit.tokens.length >
          MAX_IMPORT_STORY_EDGES_PER_ROW
        ) {
          errs.push({
            row: row.rowNumber,
            field:
              speakerIdSplit.tokens.length > 0 ? 'speakerIds' : 'speakerNames',
            code: 'too_many_refs',
            message: `At most ${MAX_IMPORT_STORY_EDGES_PER_ROW} speaker associations allowed per story`,
          });
        } else {
          for (const idToken of speakerIdSplit.tokens) {
            const ref = resolveSpeakerById(
              row.rowNumber,
              'speakerIds',
              idToken,
              errs
            );
            if (ref) speakerRefs.push(ref);
          }
          for (const nameToken of speakerNameSplit.tokens) {
            const ref = resolveSpeakerByName(
              row.rowNumber,
              'speakerNames',
              nameToken,
              errs
            );
            if (ref) speakerRefs.push(ref);
          }
        }
      }

      const attachments: NormalizedStoryRow['attachments'] = [];
      const rawMedia = (input.readCell(row.cells, 'media') ?? '').trim();
      if (rawMedia.length > 0) {
        const mediaSplit = splitBoundedTokens(
          rawMedia,
          PIPE_LIST_TOKEN_PATTERN,
          MAX_IMPORT_MEDIA_REFS_PER_ROW
        );
        if (mediaSplit.exceeded) {
          errs.push({
            row: row.rowNumber,
            field: 'media',
            code: 'too_many_refs',
            message: `At most ${MAX_IMPORT_MEDIA_REFS_PER_ROW} media references allowed per story`,
          });
        } else {
          mediaSplit.tokens.forEach((ref, ordinal) => {
            const resolved = resolveMediaToken(
              row.rowNumber,
              'media',
              ref,
              'story_media',
              ordinal,
              errs
            );
            if (resolved) {
              attachments.push({
                fileId: resolved.fileId,
                role: 'story_media',
                ordinal: resolved.ordinal,
                stagedByManifest: resolved.stagedByManifest,
              });
            }
          });
        }
      }

      const externalMediaLinks: string[] = [];
      const rawLinks = (
        input.readCell(row.cells, 'externalMediaLinks') ?? ''
      ).trim();
      if (rawLinks.length > 0) {
        const linksSplit = splitBoundedTokens(
          rawLinks,
          PIPE_LIST_TOKEN_PATTERN,
          MAX_IMPORT_EXTERNAL_LINKS_PER_ROW
        );
        if (linksSplit.exceeded) {
          errs.push({
            row: row.rowNumber,
            field: 'externalMediaLinks',
            code: 'too_many_refs',
            message: `At most ${MAX_IMPORT_EXTERNAL_LINKS_PER_ROW} external media links allowed per story`,
          });
        } else {
          for (const link of linksSplit.tokens) {
            if (hasCsvFormulaPrefix(link)) {
              errs.push({
                row: row.rowNumber,
                field: 'externalMediaLinks',
                code: 'formula_injection',
                message: 'Field cannot begin with a spreadsheet formula prefix',
              });
            } else if (link.length > 2048 || !isSafeExternalMediaUrl(link)) {
              errs.push({
                row: row.rowNumber,
                field: 'externalMediaLinks',
                code: 'invalid_url',
                message:
                  'External media link must be an absolute http: or https: URL',
              });
            } else {
              externalMediaLinks.push(link);
            }
          }
        }
      }

      if (errs.length > 0 || visibility === null) {
        recordRowErrors(errs);
        continue;
      }

      seenStoryTitles.add(normTitle);
      audienceCounts[visibility] += 1;

      if (interviewLocationRef?.kind === 'create') {
        relatedPlacesMap.set(interviewLocationRef.normalizedName, {
          name: interviewLocationRef.name,
          normalizedName: interviewLocationRef.normalizedName,
        });
      }
      if (interviewerRef?.kind === 'create') {
        relatedSpeakersMap.set(interviewerRef.normalizedName, {
          name: interviewerRef.name,
          normalizedName: interviewerRef.normalizedName,
        });
      }
      for (const ref of placeRefs) {
        if (ref.kind === 'create') {
          relatedPlacesMap.set(ref.normalizedName, {
            name: ref.name,
            normalizedName: ref.normalizedName,
          });
        }
      }
      for (const ref of speakerRefs) {
        if (ref.kind === 'create') {
          relatedSpeakersMap.set(ref.normalizedName, {
            name: ref.name,
            normalizedName: ref.normalizedName,
          });
        }
      }
      for (const att of attachments) {
        if (att.stagedByManifest) referencedStagedIds.add(att.fileId);
      }

      storyRows.push({
        rowNumber: row.rowNumber,
        title: rawTitle,
        slug: allocateUniqueStorySlug(rawTitle),
        description,
        descriptionPlain,
        visibility,
        topic,
        topicNormalized,
        language,
        dateInterviewed,
        interviewLocationRef,
        interviewerRef,
        placeRefs,
        speakerRefs,
        attachments,
        externalMediaLinks,
      });
    }

    return {
      normalizedData: {
        kind: 'stories',
        rows: storyRows,
        relatedPlacesToCreate: [...relatedPlacesMap.values()],
        relatedSpeakersToCreate: [...relatedSpeakersMap.values()],
        skippedDuplicates,
        audienceCounts,
        validRowCount: storyRows.length,
        totalErrorCount,
        rowErrorsTruncated,
      },
      rowErrors,
      referencedStagedIds,
    };
  }
}
