/**
 * Canonical V2 bounded CSV import contracts and Zod schemas (SPEC-V2 §4, §5,
 * §6.9, §9; Slice 12, #123, #197).
 */
import { z } from 'zod';
import {
  ATTACHMENT_ROLES,
  type AttachmentRole,
} from '../../db/schema/attachments.js';
import {
  IMPORT_MANIFEST_KINDS,
  IMPORT_MANIFEST_STATUSES,
  type ImportManifestKind,
} from '../../db/schema/import_manifests.js';
import { MAX_DATABASE_ID } from '../types/public.js';
import { CommunityStoryVisibilitySchema } from './community-reads.js';
import {
  MAX_EXTERNAL_LINKS_PER_STORY,
  MAX_STORY_EDGE_IDS,
} from './story-writes.js';

export const MAX_IMPORT_REQUEST_BYTES = 100 * 1024 * 1024; // 100 MiB (Workers Free cap)
export const MAX_IMPORT_CSV_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_IMPORT_MEDIA_FILES = 100;
export const MAX_IMPORT_MEDIA_REFS_PER_ROW = 50;
export const MAX_IMPORT_EXTERNAL_LINKS_PER_ROW = MAX_EXTERNAL_LINKS_PER_STORY;
export const MAX_IMPORT_STORY_EDGES_PER_ROW = MAX_STORY_EDGE_IDS;
export const DEFAULT_IMPORT_PAGE_LIMIT = 20;
export const MAX_IMPORT_PAGE_LIMIT = 100;
export const MAX_IMPORT_PREVIEW_SAMPLE_ROWS = 25;
export const MAX_IMPORT_PREVIEW_DESCRIPTION_CHARS = 240;
export const MAX_IMPORT_ROW_ERRORS = 1_000;
export const MAX_OPEN_IMPORT_PREVIEWS_PER_COMMUNITY = 5;
export const IMPORT_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const ALLOWED_CSV_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
]);

/**
 * Preview form field listing media already staged through `POST /v2/media`
 * (or the direct-upload flow) by file id (#282). The CSV's media columns
 * reference a declared file by that id or by its original filename. Workers
 * never parses or hashes multipart media on the preview route.
 */
export const IMPORT_STAGED_MEDIA_FIELD = 'mediaFileIds';
export const ImportStagedMediaIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_IMPORT_MEDIA_FILES)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Duplicate staged media file id',
  });
export type ImportStagedMediaIds = z.infer<typeof ImportStagedMediaIdsSchema>;

export const ImportKindSchema = z.enum(IMPORT_MANIFEST_KINDS);
export const ImportStatusSchema = z.enum(IMPORT_MANIFEST_STATUSES);
export const DuplicateStrategySchema = z.enum(['error', 'skip']);
export type DuplicateStrategy = z.infer<typeof DuplicateStrategySchema>;

export const IMPORT_REQUIRED_FIELDS: Record<
  ImportManifestKind,
  readonly string[]
> = {
  places: ['name'],
  speakers: ['name'],
  stories: ['title', 'visibility'],
};

export const IMPORT_ALLOWED_FIELDS: Record<
  ImportManifestKind,
  readonly string[]
> = {
  places: [
    'name',
    'description',
    'typeOfPlace',
    'region',
    'latitude',
    'longitude',
    'photo',
    'nameAudio',
  ],
  speakers: [
    'name',
    'birthDate',
    'birthplaceId',
    'birthplaceName',
    'affiliation',
    'photo',
  ],
  stories: [
    'title',
    'visibility',
    'description',
    'topic',
    'language',
    'dateInterviewed',
    'interviewLocationId',
    'interviewLocationName',
    'interviewerId',
    'interviewerName',
    'placeIds',
    'placeNames',
    'speakerIds',
    'speakerNames',
    'media',
    'externalMediaLinks',
  ],
};

/**
 * Canonical auto-mapping header lookup per import kind (camelCase and
 * snake_case variants only — never removed V1 cultural/elder fields or
 * tenant-overriding `communityId`).
 */
export const IMPORT_HEADER_ALIASES: Record<
  ImportManifestKind,
  Readonly<Record<string, string>>
> = {
  places: {
    name: 'name',
    description: 'description',
    typeOfPlace: 'typeOfPlace',
    type_of_place: 'typeOfPlace',
    region: 'region',
    latitude: 'latitude',
    longitude: 'longitude',
    photo: 'photo',
    place_photo: 'photo',
    nameAudio: 'nameAudio',
    name_audio: 'nameAudio',
    place_name_audio: 'nameAudio',
  },
  speakers: {
    name: 'name',
    birthDate: 'birthDate',
    birth_date: 'birthDate',
    birthplaceId: 'birthplaceId',
    birthplace_id: 'birthplaceId',
    birthplaceName: 'birthplaceName',
    birthplace_name: 'birthplaceName',
    birthplace: 'birthplaceName',
    affiliation: 'affiliation',
    photo: 'photo',
    speaker_photo: 'photo',
  },
  stories: {
    title: 'title',
    visibility: 'visibility',
    audience: 'visibility',
    description: 'description',
    topic: 'topic',
    language: 'language',
    dateInterviewed: 'dateInterviewed',
    date_interviewed: 'dateInterviewed',
    interviewLocationId: 'interviewLocationId',
    interview_location_id: 'interviewLocationId',
    interviewLocationName: 'interviewLocationName',
    interview_location_name: 'interviewLocationName',
    interviewerId: 'interviewerId',
    interviewer_id: 'interviewerId',
    interviewerName: 'interviewerName',
    interviewer_name: 'interviewerName',
    placeIds: 'placeIds',
    place_ids: 'placeIds',
    placeNames: 'placeNames',
    place_names: 'placeNames',
    speakerIds: 'speakerIds',
    speaker_ids: 'speakerIds',
    speakerNames: 'speakerNames',
    speaker_names: 'speakerNames',
    media: 'media',
    externalMediaLinks: 'externalMediaLinks',
    external_media_links: 'externalMediaLinks',
  },
};

export const AudienceMappingSchema = z.record(
  z.string().min(1).max(120),
  CommunityStoryVisibilitySchema
);
export type AudienceMapping = z.infer<typeof AudienceMappingSchema>;

export const HeaderMappingsSchema = z.record(
  z.string().min(1).max(64),
  z.string().trim().min(1).max(200)
);
export type HeaderMappings = z.infer<typeof HeaderMappingsSchema>;

export const ImportRowErrorSchema = z
  .object({
    row: z.number().int().positive(),
    field: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(255),
  })
  .strict();
export type ImportRowError = z.infer<typeof ImportRowErrorSchema>;

export const NormalizedAttachmentRefSchema = z
  .object({
    fileId: z.string().uuid(),
    role: z.enum(ATTACHMENT_ROLES),
    ordinal: z.number().int().min(0),
    stagedByManifest: z.boolean(),
  })
  .strict();
export type NormalizedAttachmentRef = z.infer<
  typeof NormalizedAttachmentRefSchema
>;

export interface RelatedPlaceToCreate {
  name: string;
  normalizedName: string;
}

export interface RelatedSpeakerToCreate {
  name: string;
  normalizedName: string;
}

export interface NormalizedPlaceRow {
  rowNumber: number;
  name: string;
  normalizedName: string;
  description: string | null;
  descriptionPlain: string | null;
  typeOfPlace: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  attachments: Array<{
    fileId: string;
    role: Extract<AttachmentRole, 'place_photo' | 'place_name_audio'>;
    ordinal: number;
    stagedByManifest: boolean;
  }>;
}

export interface NormalizedSpeakerRow {
  rowNumber: number;
  name: string;
  normalizedName: string;
  birthDate: string | null;
  birthplaceRef:
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
    | null;
  affiliation: string | null;
  attachments: Array<{
    fileId: string;
    role: Extract<AttachmentRole, 'speaker_photo'>;
    ordinal: number;
    stagedByManifest: boolean;
  }>;
}

export interface NormalizedStoryRow {
  rowNumber: number;
  title: string;
  slug: string;
  description: string | null;
  descriptionPlain: string | null;
  visibility: 'public' | 'community' | 'editors';
  topic: string | null;
  topicNormalized: string | null;
  language: string;
  dateInterviewed: string | null;
  interviewLocationRef:
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
    | null;
  interviewerRef:
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
    | null;
  placeRefs: Array<
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
  >;
  speakerRefs: Array<
    | { kind: 'existing'; id: number }
    | { kind: 'create'; name: string; normalizedName: string }
  >;
  attachments: Array<{
    fileId: string;
    role: Extract<AttachmentRole, 'story_media'>;
    ordinal: number;
    stagedByManifest: boolean;
  }>;
  externalMediaLinks: string[];
}

export interface NormalizedMediaCounts {
  stagedCount: number;
  existingCount: number;
  totalRefs: number;
}

export interface NormalizedRelatedCounts {
  resolvedPlacesCount: number;
  placesToCreateCount: number;
  resolvedSpeakersCount: number;
  speakersToCreateCount: number;
}

interface StoredNormalizedImportMetadata {
  validRowCount?: number;
  totalErrorCount?: number;
  rowErrorsTruncated?: boolean;
  cleared?: boolean;
  mediaCounts?: NormalizedMediaCounts;
  relatedCounts?: NormalizedRelatedCounts;
}

export type StoredNormalizedImportData =
  | ({
      kind: 'places';
      rows: NormalizedPlaceRow[];
      relatedPlacesToCreate: RelatedPlaceToCreate[];
      relatedSpeakersToCreate: RelatedSpeakerToCreate[];
      skippedDuplicates: number;
      audienceCounts: null;
    } & StoredNormalizedImportMetadata)
  | ({
      kind: 'speakers';
      rows: NormalizedSpeakerRow[];
      relatedPlacesToCreate: RelatedPlaceToCreate[];
      relatedSpeakersToCreate: RelatedSpeakerToCreate[];
      skippedDuplicates: number;
      audienceCounts: null;
    } & StoredNormalizedImportMetadata)
  | ({
      kind: 'stories';
      rows: NormalizedStoryRow[];
      relatedPlacesToCreate: RelatedPlaceToCreate[];
      relatedSpeakersToCreate: RelatedSpeakerToCreate[];
      skippedDuplicates: number;
      audienceCounts: { public: number; community: number; editors: number };
    } & StoredNormalizedImportMetadata);

export function countNormalizedMediaRefs(
  data: StoredNormalizedImportData
): NormalizedMediaCounts {
  if (data.mediaCounts) {
    return data.mediaCounts;
  }
  const stagedIds = new Set<string>();
  const existingIds = new Set<string>();
  let totalRefs = 0;

  for (const row of data.rows) {
    for (const att of row.attachments) {
      totalRefs += 1;
      if (att.stagedByManifest) {
        stagedIds.add(att.fileId);
      } else {
        existingIds.add(att.fileId);
      }
    }
  }
  return {
    stagedCount: stagedIds.size,
    existingCount: existingIds.size,
    totalRefs,
  };
}

export function summarizeNormalizedRelatedRecords(
  data: StoredNormalizedImportData
): NormalizedRelatedCounts {
  if (data.relatedCounts) {
    return data.relatedCounts;
  }
  const resolvedPlaceIds = new Set<number>();
  const resolvedSpeakerIds = new Set<number>();

  if (data.kind === 'speakers') {
    for (const row of data.rows) {
      if (row.birthplaceRef?.kind === 'existing') {
        resolvedPlaceIds.add(row.birthplaceRef.id);
      }
    }
  } else if (data.kind === 'stories') {
    for (const row of data.rows) {
      if (row.interviewLocationRef?.kind === 'existing') {
        resolvedPlaceIds.add(row.interviewLocationRef.id);
      }
      for (const ref of row.placeRefs) {
        if (ref.kind === 'existing') resolvedPlaceIds.add(ref.id);
      }
      if (row.interviewerRef?.kind === 'existing') {
        resolvedSpeakerIds.add(row.interviewerRef.id);
      }
      for (const ref of row.speakerRefs) {
        if (ref.kind === 'existing') resolvedSpeakerIds.add(ref.id);
      }
    }
  }

  return {
    resolvedPlacesCount: resolvedPlaceIds.size,
    placesToCreateCount: data.relatedPlacesToCreate.length,
    resolvedSpeakersCount: resolvedSpeakerIds.size,
    speakersToCreateCount: data.relatedSpeakersToCreate.length,
  };
}

/**
 * Strip row payloads from `normalized_rows` when an import manifest is
 * discarded or fails while keeping aggregate counts and summary metadata.
 */
export function clearNormalizedImportData(
  data: StoredNormalizedImportData
): StoredNormalizedImportData {
  const validRowCount = data.validRowCount ?? data.rows.length;
  const mediaCounts = countNormalizedMediaRefs(data);
  const relatedCounts = summarizeNormalizedRelatedRecords(data);
  const shared = {
    relatedPlacesToCreate: [] as RelatedPlaceToCreate[],
    relatedSpeakersToCreate: [] as RelatedSpeakerToCreate[],
    skippedDuplicates: data.skippedDuplicates,
    validRowCount,
    ...(data.totalErrorCount !== undefined
      ? { totalErrorCount: data.totalErrorCount }
      : {}),
    ...(data.rowErrorsTruncated !== undefined
      ? { rowErrorsTruncated: data.rowErrorsTruncated }
      : {}),
    cleared: true,
    mediaCounts,
    relatedCounts,
  };
  if (data.kind === 'stories') {
    return {
      ...shared,
      kind: 'stories',
      rows: [],
      audienceCounts: data.audienceCounts,
    };
  }
  if (data.kind === 'speakers') {
    return {
      ...shared,
      kind: 'speakers',
      rows: [],
      audienceCounts: null,
    };
  }
  return {
    ...shared,
    kind: 'places',
    rows: [],
    audienceCounts: null,
  };
}

export const ImportCommitPlanSummarySchema = z
  .object({
    statementCount: z.number().int().min(0),
    maxBoundParams: z.number().int().min(0),
    maxStatementBytes: z.number().int().min(0),
    estimatedRowsWritten: z.number().int().min(0),
    withinD1Budget: z.boolean(),
  })
  .strict();
export type ImportCommitPlanSummary = z.infer<
  typeof ImportCommitPlanSummarySchema
>;

export const ImportMediaSummarySchema = z
  .object({
    stagedCount: z.number().int().min(0),
    existingReferencedCount: z.number().int().min(0),
    totalAttachmentRefs: z.number().int().min(0),
  })
  .strict();

export const ImportAudienceSummarySchema = z
  .object({
    public: z.number().int().min(0),
    community: z.number().int().min(0),
    editors: z.number().int().min(0),
  })
  .strict();

export const ImportRelatedRecordsSummarySchema = z
  .object({
    resolvedPlacesCount: z.number().int().min(0),
    placesToCreateCount: z.number().int().min(0),
    resolvedSpeakersCount: z.number().int().min(0),
    speakersToCreateCount: z.number().int().min(0),
  })
  .strict();

export const ImportPreviewRelatedRefSchema = z.discriminatedUnion(
  'resolution',
  [
    z
      .object({
        resolution: z.literal('existing'),
        id: z.number().int().positive().max(MAX_DATABASE_ID),
      })
      .strict(),
    z
      .object({
        resolution: z.literal('create'),
        name: z.string().min(1).max(200),
      })
      .strict(),
  ]
);
export type ImportPreviewRelatedRef = z.infer<
  typeof ImportPreviewRelatedRefSchema
>;

export const ImportPreviewAttachmentSchema = z
  .object({
    role: z.enum(ATTACHMENT_ROLES),
    ordinal: z.number().int().min(0),
    source: z.enum(['staged', 'existing']),
  })
  .strict();
export type ImportPreviewAttachment = z.infer<
  typeof ImportPreviewAttachmentSchema
>;

export const ImportPreviewPlaceRowSchema = z
  .object({
    kind: z.literal('places'),
    rowNumber: z.number().int().positive(),
    name: z.string().min(1).max(200),
    descriptionExcerpt: z
      .string()
      .max(MAX_IMPORT_PREVIEW_DESCRIPTION_CHARS + 1)
      .nullable(),
    typeOfPlace: z.string().max(120).nullable(),
    region: z.string().max(120).nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    attachments: z.array(ImportPreviewAttachmentSchema),
  })
  .strict();

export const ImportPreviewSpeakerRowSchema = z
  .object({
    kind: z.literal('speakers'),
    rowNumber: z.number().int().positive(),
    name: z.string().min(1).max(200),
    birthDate: z.string().max(32).nullable(),
    birthplace: ImportPreviewRelatedRefSchema.nullable(),
    affiliation: z.string().max(200).nullable(),
    attachments: z.array(ImportPreviewAttachmentSchema),
  })
  .strict();

export const ImportPreviewStoryRowSchema = z
  .object({
    kind: z.literal('stories'),
    rowNumber: z.number().int().positive(),
    title: z.string().min(1).max(255),
    visibility: CommunityStoryVisibilitySchema,
    descriptionExcerpt: z
      .string()
      .max(MAX_IMPORT_PREVIEW_DESCRIPTION_CHARS + 1)
      .nullable(),
    topic: z.string().max(200).nullable(),
    language: z.string().min(1).max(35),
    dateInterviewed: z.string().datetime().nullable(),
    interviewLocation: ImportPreviewRelatedRefSchema.nullable(),
    interviewer: ImportPreviewRelatedRefSchema.nullable(),
    places: z.array(ImportPreviewRelatedRefSchema),
    speakers: z.array(ImportPreviewRelatedRefSchema),
    attachments: z.array(ImportPreviewAttachmentSchema),
    externalMediaLinks: z.array(z.string().max(2048)),
  })
  .strict();

export const ImportPreviewRowSchema = z.discriminatedUnion('kind', [
  ImportPreviewPlaceRowSchema,
  ImportPreviewSpeakerRowSchema,
  ImportPreviewStoryRowSchema,
]);
export type ImportPreviewRow = z.infer<typeof ImportPreviewRowSchema>;

export const ImportResultSummarySchema = z
  .object({
    createdPlaces: z.number().int().min(0),
    createdSpeakers: z.number().int().min(0),
    createdStories: z.number().int().min(0),
    createdStoryPlaces: z.number().int().min(0),
    createdStorySpeakers: z.number().int().min(0),
    createdAttachments: z.number().int().min(0),
    createdExternalLinks: z.number().int().min(0),
    skippedDuplicates: z.number().int().min(0),
  })
  .strict();
export type ImportResultSummary = z.infer<typeof ImportResultSummarySchema>;

export const ImportStoredMappingsSchema = z
  .object({
    headerMappings: z.record(z.string(), z.string()),
    unmappedHeaders: z.array(z.string()),
    audienceMapping: AudienceMappingSchema.optional(),
    duplicateStrategy: DuplicateStrategySchema,
  })
  .strict();
export type ImportStoredMappings = z.infer<typeof ImportStoredMappingsSchema>;

export const ImportManifestSummarySchema = z
  .object({
    id: z.number().int().positive().max(MAX_DATABASE_ID),
    kind: ImportKindSchema,
    status: ImportStatusSchema,
    createdBy: z.number().int().positive().max(MAX_DATABASE_ID).nullable(),
    sourceFileName: z.string().nullable(),
    rowCount: z.number().int().min(0),
    validRowCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
    stagedMediaCount: z.number().int().min(0),
    canCommit: z.boolean(),
    resultSummary: ImportResultSummarySchema.nullable(),
    committedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ImportManifestSummary = z.infer<typeof ImportManifestSummarySchema>;

export const ImportManifestDetailSchema = ImportManifestSummarySchema.extend({
  mappings: z.record(z.string(), z.string()),
  unmappedHeaders: z.array(z.string()),
  audienceMapping: AudienceMappingSchema.nullable(),
  duplicateStrategy: DuplicateStrategySchema,
  skippedDuplicateCount: z.number().int().min(0),
  rowErrors: z.array(ImportRowErrorSchema).max(MAX_IMPORT_ROW_ERRORS),
  rowErrorsTruncated: z.boolean(),
  mediaSummary: ImportMediaSummarySchema,
  audienceSummary: ImportAudienceSummarySchema.nullable(),
  relatedRecords: ImportRelatedRecordsSummarySchema,
  previewRows: z
    .array(ImportPreviewRowSchema)
    .max(MAX_IMPORT_PREVIEW_SAMPLE_ROWS),
  previewRowsTruncated: z.boolean(),
  commitPlan: ImportCommitPlanSummarySchema,
}).strict();
export type ImportManifestDetail = z.infer<typeof ImportManifestDetailSchema>;

export const ImportManifestDetailResponseSchema = z
  .object({
    data: ImportManifestDetailSchema,
  })
  .strict();

export const ImportManifestListMetaSchema = z
  .object({
    total: z.number().int().min(0),
    limit: z.number().int().min(1).max(MAX_IMPORT_PAGE_LIMIT),
    offset: z.number().int().min(0),
    hasNextPage: z.boolean(),
  })
  .strict();

export const ImportManifestListResponseSchema = z
  .object({
    data: z.array(ImportManifestSummarySchema),
    meta: ImportManifestListMetaSchema,
  })
  .strict();

export const ListImportsQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => val >= 1 && val <= MAX_IMPORT_PAGE_LIMIT)
      .optional()
      .default(DEFAULT_IMPORT_PAGE_LIMIT),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => Number.isSafeInteger(val) && val >= 0)
      .optional()
      .default(0),
    status: ImportStatusSchema.optional(),
    kind: ImportKindSchema.optional(),
  })
  .strict();
export type ListImportsQuery = z.infer<typeof ListImportsQuerySchema>;
