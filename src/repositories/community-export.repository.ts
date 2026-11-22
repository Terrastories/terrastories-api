/**
 * Data access for Slice 13a community export (SPEC-V2 §7, #187):
 * - Consistent point-in-time snapshot across all community-owned tables
 *   (single D1 batch on Workers, REPEATABLE READ READ ONLY on PostgreSQL,
 *   synchronous transaction on SQLite).
 * - Atomic export job reservation with per-community concurrency lock +
 *   per-community / per-account sliding-window rate limits + audit write.
 * - Atomic job completion + dual token storage + audit write.
 * - Restart-safe expired/failed/stale-job lookup and cleanup tracking.
 */

import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import type {
  ExportJobStatus,
  ExportTokenArtifact,
} from '../db/schema/community_exports.js';
import type { ImportManifest } from '../db/schema/import_manifests.js';
import type { AuditResourceId } from '../db/schema/audit_entries.js';
import {
  EXPORT_LIFECYCLE_AUDIT_ACTIONS,
  EXPORT_PG_ADVISORY_LOCK_NS,
} from '../shared/export-policy.js';
import {
  validateContentFreeAuditEntry,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { ExportLimitExceededError } from '../shared/utils/deterministic-zip.js';
import { parseJsonColumn } from '../shared/utils/canonical-json.js';
import {
  buildAuditEntryInsert,
  writeAuditEntry,
} from './audit-entry.repository.js';
import { isUniqueConstraintError } from './user-management.repository.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

export interface ExportCommunityRow {
  id: number;
  name: string;
  description: string | null;
  descriptionPlain: string | null;
  slug: string;
  locale: string;
  country: string | null;
  publicStories: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportMapConfigRow {
  communityId: number;
  styleUrl: string | null;
  basemapStyle: string | null;
  mapboxStyleUrl: string | null;
  mapboxAccessToken: string | null;
  exposeMapboxCredentials: boolean;
  mapbox3d: boolean;
  protomapsApiKey: string | null;
  protomapsBasemapStyle: string | null;
  centerLatitude: number | null;
  centerLongitude: number | null;
  southWestLatitude: number | null;
  southWestLongitude: number | null;
  northEastLatitude: number | null;
  northEastLongitude: number | null;
  zoom: number | null;
  pitch: number | null;
  bearing: number | null;
  threeDimensional: boolean | null;
  projection: string | null;
  staticMapFileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportUserRow {
  id: number;
  communityId: number;
  email: string;
  username: string | null;
  displayName: string | null;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPlaceRow {
  id: number;
  communityId: number;
  name: string;
  description: string | null;
  descriptionPlain: string | null;
  typeOfPlace: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  isRestricted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportSpeakerRow {
  id: number;
  communityId: number;
  name: string;
  birthDate: string | null;
  birthplaceId: number | null;
  affiliation: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportStoryRow {
  id: number;
  communityId: number;
  title: string;
  description: string | null;
  descriptionPlain: string | null;
  slug: string;
  privacyLevel: string;
  isRestricted: boolean;
  topic: string | null;
  topicNormalized: string | null;
  language: string;
  dateInterviewed: Date | null;
  interviewLocationId: number | null;
  interviewerId: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportStoryPlaceRow {
  id: number;
  communityId: number;
  storyId: number;
  placeId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportStorySpeakerRow {
  id: number;
  communityId: number;
  storyId: number;
  speakerId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportFileRow {
  id: string;
  communityId: number;
  storageKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksum: string | null;
  uploadedBy: number | null;
  metadata: unknown;
  culturalRestrictions: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportAttachmentRow {
  id: number;
  communityId: number;
  fileId: string;
  ownerType: string | null;
  ownerId: number | null;
  role: string | null;
  ordinal: number;
  createdAt: Date;
}

export interface ExportExternalMediaLinkRow {
  id: number;
  communityId: number;
  storyId: number;
  url: string;
  ordinal: number;
  createdAt: Date;
}

export interface ExportLegacyCommunityMediaRow {
  fileId: string;
  communityId: number;
  kind: string;
}

export interface ExportAuditEntryRow {
  id: number;
  communityId: number;
  actorId: number | null;
  action: string;
  resourceType: string | null;
  resourceIds: AuditResourceId[];
  outcome: string;
  createdAt: Date;
}

export interface CommunityExportSnapshot {
  community: ExportCommunityRow;
  mapConfig: ExportMapConfigRow | null;
  users: ExportUserRow[];
  places: ExportPlaceRow[];
  speakers: ExportSpeakerRow[];
  stories: ExportStoryRow[];
  storyPlaces: ExportStoryPlaceRow[];
  storySpeakers: ExportStorySpeakerRow[];
  files: ExportFileRow[];
  attachments: ExportAttachmentRow[];
  externalMediaLinks: ExportExternalMediaLinkRow[];
  legacyCommunityMedia: ExportLegacyCommunityMediaRow[];
  importManifests: ImportManifest[];
  auditEntries: ExportAuditEntryRow[];
}

export interface ExportJobRecord {
  id: string;
  communityId: number;
  requestedBy: number | null;
  status: ExportJobStatus;
  manifestStorageKey: string | null;
  manifestByteSize: number | null;
  manifestChecksum: string | null;
  zipStorageKey: string | null;
  zipByteSize: number | null;
  zipChecksum: string | null;
  zipUploadId: string | null;
  createdAt: number;
  completedAt: number | null;
  expiresAt: number;
  cleanedUpAt: number | null;
}

export interface ExportCleanupClaim {
  status: 'expired' | 'failed';
  manifestStorageKey: string | null;
  zipStorageKey: string | null;
  zipUploadId: string | null;
  completedAt: number | null;
}

export interface MarkJobCleanedUpResult {
  updated: boolean;
  markedCleaned: boolean;
}

export interface ExportTokenWithJobRecord {
  tokenId: number;
  jobId: string;
  communityId: number;
  requestedBy: number;
  artifact: ExportTokenArtifact;
  tokenHash: string;
  tokenCreatedAt: number;
  tokenExpiresAt: number;
  downloadedAt: number | null;
  jobStatus: ExportJobStatus;
  manifestStorageKey: string | null;
  manifestByteSize: number | null;
  manifestChecksum: string | null;
  zipStorageKey: string | null;
  zipByteSize: number | null;
  zipChecksum: string | null;
  zipUploadId: string | null;
  jobExpiresAt: number;
  cleanedUpAt: number | null;
}

export type ReserveExportJobOutcome =
  | { status: 'reserved'; jobId: string }
  | { status: 'not_found' }
  | { status: 'in_progress' }
  | { status: 'rate_limited'; retryAfterSeconds: number };

const toBool = (value: unknown): boolean => value === true || value === 1;

const toOptionalBool = (value: unknown): boolean | null => {
  if (value === null || value === undefined) return null;
  return toBool(value);
};

const toDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(Number(value));

const toOptionalDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  return toDate(value);
};

const toOptionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return Number(value);
};

function normalizeResourceIds(value: unknown): AuditResourceId[] {
  const parsed = parseJsonColumn(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is AuditResourceId =>
      typeof item === 'number' || typeof item === 'string'
  );
}

export class CommunityExportRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;
  private readonly communityMedia;
  private readonly dialect;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
    this.dialect = dialectOf(connection);
    this.communityMedia = (
      this.dialect === 'postgresql' ? communityMediaPg : communityMediaSqlite
    ) as typeof communityMediaSqlite;
  }

  private d1AuditInsert(
    database: Executor,
    record: ValidatedAuditEntryRecord,
    createdAtMs: number,
    gate: ReturnType<typeof sql>
  ) {
    const { auditEntries } = tablesFor(database);
    return database.insert(auditEntries).select(
      sql`select
        ${null}, ${record.communityId}, ${record.actorId}, ${record.action},
        ${record.resourceType}, ${JSON.stringify(record.resourceIds)},
        ${record.outcome}, ${record.ipAddress}, ${record.userAgent},
        ${createdAtMs}
      where ${gate}`
    );
  }

  private buildSnapshotQueries(
    executor: Executor,
    communityId: number,
    maxRows?: number,
    maxBytes?: number
  ) {
    const {
      communities,
      communityMapConfigs,
      users,
      places,
      speakers,
      stories,
      storyPlaces,
      storySpeakers,
      files,
      attachments,
      externalMediaLinks,
      importManifests,
      auditEntries,
    } = this.tables;
    const communityMedia = this.communityMedia;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bounded = (query: any) =>
      maxRows !== undefined ? query.limit(maxRows + 1) : query;

    const queries = [
      executor
        .select({
          id: communities.id,
          name: communities.name,
          description: communities.description,
          descriptionPlain: communities.descriptionPlain,
          slug: communities.slug,
          locale: communities.locale,
          country: communities.country,
          publicStories: communities.publicStories,
          isActive: communities.isActive,
          createdAt: communities.createdAt,
          updatedAt: communities.updatedAt,
        })
        .from(communities)
        .where(eq(communities.id, communityId))
        .limit(1),
      executor
        .select({
          communityId: communityMapConfigs.communityId,
          styleUrl: communityMapConfigs.styleUrl,
          basemapStyle: communityMapConfigs.basemapStyle,
          mapboxStyleUrl: communityMapConfigs.mapboxStyleUrl,
          mapboxAccessToken: communityMapConfigs.mapboxAccessToken,
          exposeMapboxCredentials: communityMapConfigs.exposeMapboxCredentials,
          mapbox3d: communityMapConfigs.mapbox3d,
          protomapsApiKey: communityMapConfigs.protomapsApiKey,
          protomapsBasemapStyle: communityMapConfigs.protomapsBasemapStyle,
          centerLatitude: communityMapConfigs.centerLatitude,
          centerLongitude: communityMapConfigs.centerLongitude,
          southWestLatitude: communityMapConfigs.southWestLatitude,
          southWestLongitude: communityMapConfigs.southWestLongitude,
          northEastLatitude: communityMapConfigs.northEastLatitude,
          northEastLongitude: communityMapConfigs.northEastLongitude,
          zoom: communityMapConfigs.zoom,
          pitch: communityMapConfigs.pitch,
          bearing: communityMapConfigs.bearing,
          threeDimensional: communityMapConfigs.threeDimensional,
          projection: communityMapConfigs.projection,
          staticMapFileId: communityMapConfigs.staticMapFileId,
          createdAt: communityMapConfigs.createdAt,
          updatedAt: communityMapConfigs.updatedAt,
        })
        .from(communityMapConfigs)
        .where(eq(communityMapConfigs.communityId, communityId))
        .limit(1),
      // Explicit safe projection: never select credential or login-tracking columns.
      bounded(
        executor
          .select({
            id: users.id,
            communityId: users.communityId,
            email: users.email,
            username: users.username,
            displayName: users.displayName,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            isActive: users.isActive,
            createdAt: users.createdAt,
            updatedAt: users.updatedAt,
          })
          .from(users)
          .where(eq(users.communityId, communityId))
          .orderBy(asc(users.id))
      ),
      bounded(
        executor
          .select({
            id: places.id,
            communityId: places.communityId,
            name: places.name,
            description: places.description,
            descriptionPlain: places.descriptionPlain,
            typeOfPlace: places.typeOfPlace,
            region: places.region,
            latitude: places.latitude,
            longitude: places.longitude,
            isRestricted: places.isRestricted,
            createdAt: places.createdAt,
            updatedAt: places.updatedAt,
          })
          .from(places)
          .where(eq(places.communityId, communityId))
          .orderBy(asc(places.id))
      ),
      bounded(
        executor
          .select({
            id: speakers.id,
            communityId: speakers.communityId,
            name: speakers.name,
            birthDate: speakers.birthDate,
            birthplaceId: speakers.birthplaceId,
            affiliation: speakers.affiliation,
            isActive: speakers.isActive,
            createdAt: speakers.createdAt,
            updatedAt: speakers.updatedAt,
          })
          .from(speakers)
          .where(eq(speakers.communityId, communityId))
          .orderBy(asc(speakers.id))
      ),
      bounded(
        executor
          .select({
            id: stories.id,
            communityId: stories.communityId,
            title: stories.title,
            description: stories.description,
            descriptionPlain: stories.descriptionPlain,
            slug: stories.slug,
            privacyLevel: stories.privacyLevel,
            isRestricted: stories.isRestricted,
            topic: stories.topic,
            topicNormalized: stories.topicNormalized,
            language: stories.language,
            dateInterviewed: stories.dateInterviewed,
            interviewLocationId: stories.interviewLocationId,
            interviewerId: stories.interviewerId,
            createdBy: stories.createdBy,
            createdAt: stories.createdAt,
            updatedAt: stories.updatedAt,
          })
          .from(stories)
          .where(eq(stories.communityId, communityId))
          .orderBy(asc(stories.id))
      ),
      bounded(
        executor
          .select({
            id: storyPlaces.id,
            communityId: storyPlaces.communityId,
            storyId: storyPlaces.storyId,
            placeId: storyPlaces.placeId,
            createdAt: storyPlaces.createdAt,
            updatedAt: storyPlaces.updatedAt,
          })
          .from(storyPlaces)
          .where(eq(storyPlaces.communityId, communityId))
          .orderBy(asc(storyPlaces.id))
      ),
      bounded(
        executor
          .select({
            id: storySpeakers.id,
            communityId: storySpeakers.communityId,
            storyId: storySpeakers.storyId,
            speakerId: storySpeakers.speakerId,
            createdAt: storySpeakers.createdAt,
            updatedAt: storySpeakers.updatedAt,
          })
          .from(storySpeakers)
          .where(eq(storySpeakers.communityId, communityId))
          .orderBy(asc(storySpeakers.id))
      ),
      bounded(
        executor
          .select({
            id: files.id,
            communityId: files.communityId,
            storageKey: files.storageKey,
            path: files.path,
            originalName: files.originalName,
            mimeType: files.mimeType,
            byteSize: files.byteSize,
            size: files.size,
            checksum: files.checksum,
            uploadedBy: files.uploadedBy,
            metadata: files.metadata,
            culturalRestrictions: files.culturalRestrictions,
            isActive: files.isActive,
            createdAt: files.createdAt,
            updatedAt: files.updatedAt,
          })
          .from(files)
          .where(eq(files.communityId, communityId))
          .orderBy(asc(files.id))
      ),
      bounded(
        executor
          .select({
            id: attachments.id,
            communityId: attachments.communityId,
            fileId: attachments.fileId,
            ownerType: attachments.ownerType,
            ownerId: attachments.ownerId,
            role: attachments.role,
            ordinal: attachments.ordinal,
            createdAt: attachments.createdAt,
          })
          .from(attachments)
          .where(eq(attachments.communityId, communityId))
          .orderBy(asc(attachments.id))
      ),
      bounded(
        executor
          .select({
            id: externalMediaLinks.id,
            communityId: externalMediaLinks.communityId,
            storyId: externalMediaLinks.storyId,
            url: externalMediaLinks.url,
            ordinal: externalMediaLinks.ordinal,
            createdAt: externalMediaLinks.createdAt,
          })
          .from(externalMediaLinks)
          .where(eq(externalMediaLinks.communityId, communityId))
          .orderBy(asc(externalMediaLinks.id))
      ),
      bounded(
        executor
          .select({
            fileId: communityMedia.fileId,
            communityId: communityMedia.communityId,
            kind: communityMedia.kind,
          })
          .from(communityMedia)
          .where(eq(communityMedia.communityId, communityId))
          .orderBy(asc(communityMedia.fileId))
      ),
      bounded(
        executor
          .select()
          .from(importManifests)
          .where(eq(importManifests.communityId, communityId))
          .orderBy(asc(importManifests.id))
      ),
      bounded(
        executor
          .select({
            id: auditEntries.id,
            communityId: auditEntries.communityId,
            actorId: auditEntries.actorId,
            action: auditEntries.action,
            resourceType: auditEntries.resourceType,
            resourceIds: auditEntries.resourceIds,
            outcome: auditEntries.outcome,
            createdAt: auditEntries.createdAt,
          })
          .from(auditEntries)
          .where(
            and(
              eq(auditEntries.communityId, communityId),
              notInArray(auditEntries.action, [
                ...EXPORT_LIFECYCLE_AUDIT_ACTIONS,
              ])
            )
          )
          .orderBy(asc(auditEntries.id))
      ),
    ] as const;
    if (maxBytes === undefined) return queries;

    // Keep the size guard and reads in the SAME transaction / D1 batch.
    // SQL measures UTF-8 bytes without fetching text into the isolate. A
    // concurrent edit cannot pass a preflight then expand the snapshot.
    const sizes = queries.map((query, index) => {
      const rows = query.as(`export_size_${index}`);
      const fields = Object.keys(query.getSelectedFields()).map(
        (key) => rows[key]
      );
      const lengths = fields.map((field) =>
        this.dialect === 'postgresql'
          ? sql`coalesce(octet_length(cast(${field} as text)), 0)`
          : sql`coalesce(length(cast(${field} as blob)), 0)`
      );
      return sql`(select coalesce(sum(${sql.join(lengths, sql` + `)}), 0) from ${rows})`;
    });
    const total = sql`(${sql.join(sizes, sql` + `)})`;
    const sizeQuery = executor
      .select({ byteSize: total })
      .from(this.tables.communities)
      .where(eq(this.tables.communities.id, communityId))
      .limit(1);
    return [
      sizeQuery,
      ...queries.map((query, index) => {
        const rows = query.as(`export_rows_${index}`);
        const fields = Object.fromEntries(
          Object.keys(query.getSelectedFields()).map((key) => [key, rows[key]])
        );
        return executor
          .select(fields)
          .from(rows)
          .where(sql`${total} <= ${maxBytes}`);
      }),
    ];
  }

  private mapSnapshotResults(
    communityId: number,
    results: readonly unknown[][]
  ): CommunityExportSnapshot | null {
    const [
      commRows,
      mapRows,
      userRows,
      placeRows,
      speakerRows,
      storyRows,
      spRows,
      ssRows,
      fileRows,
      attRows,
      emlRows,
      cmRows,
      importRows,
      auditRows,
    ] = results as [
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
    ];

    const rawComm = commRows[0];
    if (!rawComm) return null;

    const community: ExportCommunityRow = {
      id: Number(rawComm.id),
      name: String(rawComm.name),
      description:
        rawComm.description === null ? null : String(rawComm.description),
      descriptionPlain:
        rawComm.descriptionPlain === null
          ? null
          : String(rawComm.descriptionPlain),
      slug: String(rawComm.slug),
      locale: String(rawComm.locale),
      country: rawComm.country === null ? null : String(rawComm.country),
      publicStories: toBool(rawComm.publicStories),
      isActive: toBool(rawComm.isActive),
      createdAt: toDate(rawComm.createdAt),
      updatedAt: toDate(rawComm.updatedAt),
    };

    const rawMap = mapRows[0];
    const mapConfig: ExportMapConfigRow | null = rawMap
      ? {
          communityId: Number(rawMap.communityId),
          styleUrl: rawMap.styleUrl === null ? null : String(rawMap.styleUrl),
          basemapStyle:
            rawMap.basemapStyle === null ? null : String(rawMap.basemapStyle),
          mapboxStyleUrl:
            rawMap.mapboxStyleUrl === null
              ? null
              : String(rawMap.mapboxStyleUrl),
          mapboxAccessToken:
            rawMap.mapboxAccessToken === null
              ? null
              : String(rawMap.mapboxAccessToken),
          exposeMapboxCredentials: toBool(rawMap.exposeMapboxCredentials),
          mapbox3d: toBool(rawMap.mapbox3d),
          protomapsApiKey:
            rawMap.protomapsApiKey === null
              ? null
              : String(rawMap.protomapsApiKey),
          protomapsBasemapStyle:
            rawMap.protomapsBasemapStyle === null
              ? null
              : String(rawMap.protomapsBasemapStyle),
          centerLatitude: toOptionalNumber(rawMap.centerLatitude),
          centerLongitude: toOptionalNumber(rawMap.centerLongitude),
          southWestLatitude: toOptionalNumber(rawMap.southWestLatitude),
          southWestLongitude: toOptionalNumber(rawMap.southWestLongitude),
          northEastLatitude: toOptionalNumber(rawMap.northEastLatitude),
          northEastLongitude: toOptionalNumber(rawMap.northEastLongitude),
          zoom: toOptionalNumber(rawMap.zoom),
          pitch: toOptionalNumber(rawMap.pitch),
          bearing: toOptionalNumber(rawMap.bearing),
          threeDimensional: toOptionalBool(rawMap.threeDimensional),
          projection:
            rawMap.projection === null ? null : String(rawMap.projection),
          staticMapFileId:
            rawMap.staticMapFileId === null
              ? null
              : String(rawMap.staticMapFileId),
          createdAt: toDate(rawMap.createdAt),
          updatedAt: toDate(rawMap.updatedAt),
        }
      : null;

    return {
      community,
      mapConfig,
      users: userRows.map((row) => ({
        id: Number(row.id),
        communityId,
        email: String(row.email),
        username: row.username === null ? null : String(row.username),
        displayName: row.displayName === null ? null : String(row.displayName),
        firstName: String(row.firstName),
        lastName: String(row.lastName),
        role: String(row.role),
        isActive: toBool(row.isActive),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
      places: placeRows.map((row) => ({
        id: Number(row.id),
        communityId,
        name: String(row.name),
        description: row.description === null ? null : String(row.description),
        descriptionPlain:
          row.descriptionPlain === null ? null : String(row.descriptionPlain),
        typeOfPlace: row.typeOfPlace === null ? null : String(row.typeOfPlace),
        region: row.region === null ? null : String(row.region),
        latitude: toOptionalNumber(row.latitude),
        longitude: toOptionalNumber(row.longitude),
        isRestricted: toBool(row.isRestricted),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
      speakers: speakerRows.map((row) => ({
        id: Number(row.id),
        communityId,
        name: String(row.name),
        birthDate: row.birthDate === null ? null : String(row.birthDate),
        birthplaceId: toOptionalNumber(row.birthplaceId),
        affiliation: row.affiliation === null ? null : String(row.affiliation),
        isActive: toBool(row.isActive),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
      stories: storyRows.map((row) => ({
        id: Number(row.id),
        communityId,
        title: String(row.title),
        description: row.description === null ? null : String(row.description),
        descriptionPlain:
          row.descriptionPlain === null ? null : String(row.descriptionPlain),
        slug: String(row.slug),
        privacyLevel: String(row.privacyLevel),
        isRestricted: toBool(row.isRestricted),
        topic: row.topic === null ? null : String(row.topic),
        topicNormalized:
          row.topicNormalized === null ? null : String(row.topicNormalized),
        language: String(row.language),
        dateInterviewed: toOptionalDate(row.dateInterviewed),
        interviewLocationId: toOptionalNumber(row.interviewLocationId),
        interviewerId: toOptionalNumber(row.interviewerId),
        createdBy: toOptionalNumber(row.createdBy),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
      storyPlaces: spRows.map((row) => ({
        id: Number(row.id),
        communityId,
        storyId: Number(row.storyId),
        placeId: Number(row.placeId),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
      storySpeakers: ssRows.map((row) => ({
        id: Number(row.id),
        communityId,
        storyId: Number(row.storyId),
        speakerId: Number(row.speakerId),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
      files: fileRows
        .map((row) => ({
          id: String(row.id),
          communityId,
          storageKey:
            typeof row.storageKey === 'string' && row.storageKey.length > 0
              ? row.storageKey
              : String(row.path),
          originalName: String(row.originalName),
          mimeType: String(row.mimeType),
          byteSize: Number(row.byteSize ?? row.size),
          checksum: row.checksum === null ? null : String(row.checksum),
          uploadedBy: toOptionalNumber(row.uploadedBy),
          metadata: parseJsonColumn(row.metadata),
          culturalRestrictions: parseJsonColumn(row.culturalRestrictions),
          isActive: toBool(row.isActive),
          createdAt: toDate(row.createdAt),
          updatedAt: toDate(row.updatedAt),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      attachments: attRows
        .filter((row) => typeof row.fileId === 'string')
        .map((row) => ({
          id: Number(row.id),
          communityId,
          fileId: String(row.fileId),
          ownerType: row.ownerType === null ? null : String(row.ownerType),
          ownerId: toOptionalNumber(row.ownerId),
          role: row.role === null ? null : String(row.role),
          ordinal: Number(row.ordinal ?? 0),
          createdAt: toDate(row.createdAt),
        })),
      externalMediaLinks: emlRows.map((row) => ({
        id: Number(row.id),
        communityId,
        storyId: Number(row.storyId),
        url: String(row.url),
        ordinal: Number(row.ordinal),
        createdAt: toDate(row.createdAt),
      })),
      legacyCommunityMedia: cmRows
        .map((row) => ({
          fileId: String(row.fileId),
          communityId,
          kind: String(row.kind),
        }))
        .sort((a, b) =>
          a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0
        ),
      importManifests: importRows.map((row) => ({
        id: Number(row.id),
        communityId,
        kind: row.kind as ImportManifest['kind'],
        status: row.status as ImportManifest['status'],
        createdBy: toOptionalNumber(row.createdBy),
        sourceFileName:
          row.sourceFileName === null ? null : String(row.sourceFileName),
        sourceFileId: String(row.sourceFileId),
        mappings: parseJsonColumn(row.mappings) as ImportManifest['mappings'],
        normalizedRows: parseJsonColumn(
          row.normalizedRows
        ) as ImportManifest['normalizedRows'],
        rowCount: Number(row.rowCount),
        rowErrors: parseJsonColumn(
          row.rowErrors
        ) as ImportManifest['rowErrors'],
        stagedFileIds: parseJsonColumn(
          row.stagedFileIds
        ) as ImportManifest['stagedFileIds'],
        resultSummary: parseJsonColumn(
          row.resultSummary
        ) as ImportManifest['resultSummary'],
        committedAt: toOptionalNumber(row.committedAt),
        createdAt: Number(row.createdAt),
      })),
      auditEntries: auditRows.map((row) => ({
        id: Number(row.id),
        communityId,
        actorId: toOptionalNumber(row.actorId),
        action: String(row.action),
        resourceType:
          row.resourceType === null ? null : String(row.resourceType),
        resourceIds: normalizeResourceIds(row.resourceIds),
        outcome: String(row.outcome),
        createdAt: toDate(row.createdAt),
      })),
    };
  }

  /**
   * Read a point-in-time snapshot of every community-owned table in one
   * consistent unit (D1 batch, PG REPEATABLE READ READ ONLY transaction, or
   * SQLite synchronous transaction).
   */
  async readCommunityExportSnapshot(
    communityId: number,
    options: { maxRows?: number; maxBytes?: number } = {}
  ): Promise<CommunityExportSnapshot | null> {
    const db = this.db;
    const mapResults = (results: unknown[][]) => {
      if (options.maxBytes !== undefined) {
        const size =
          (results[0]?.[0] as { byteSize?: number } | undefined)?.byteSize ?? 0;
        if (Number(size) > options.maxBytes) {
          throw new ExportLimitExceededError(
            'maxManifestBytes',
            'Export snapshot text exceeds manifest size limit'
          );
        }
        return this.mapSnapshotResults(communityId, results.slice(1));
      }
      return this.mapSnapshotResults(communityId, results);
    };
    if (typeof db.batch === 'function') {
      const results = (await db.batch(
        this.buildSnapshotQueries(
          db,
          communityId,
          options.maxRows,
          options.maxBytes
        )
      )) as unknown[][];
      return mapResults(results);
    }

    if (this.dialect === 'postgresql') {
      const results = await db.transaction(async (tx: Executor) => {
        await tx.execute(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
        );
        const queries = this.buildSnapshotQueries(
          tx,
          communityId,
          options.maxRows,
          options.maxBytes
        );
        const out: unknown[][] = [];
        for (const query of queries) {
          out.push(await query);
        }
        return out;
      });
      return mapResults(results);
    }

    const results = db.transaction((tx: Executor) =>
      this.buildSnapshotQueries(
        tx,
        communityId,
        options.maxRows,
        options.maxBytes
      ).map((query) => query.all())
    );
    return mapResults(results);
  }

  /**
   * Atomically reserve an export job slot for a community while enforcing
   * single-active-generation lock, per-community / per-account sliding-window
   * rate limits, and writing the content-free `community.export.request` audit
   * entry.
   */
  async reserveExportJob(input: {
    jobId: string;
    communityId: number;
    requestedBy: number;
    manifestStorageKey: string;
    zipStorageKey: string;
    createdAtMs: number;
    expiresAtMs: number;
    windowStartMs: number;
    windowMs: number;
    maxPerCommunity: number;
    maxPerAccount: number;
    now: Date;
  }): Promise<ReserveExportJobOutcome> {
    const { communities, exportJobs } = this.tables;
    const db = this.db;

    const successAudit = validateContentFreeAuditEntry({
      communityId: input.communityId,
      actorId: input.requestedBy,
      action: 'community.export.request',
      resourceType: 'community_export',
      resourceIds: [input.jobId],
      outcome: 'success',
      ipAddress: null,
      userAgent: null,
    });
    const failureAuditInput = {
      communityId: input.communityId,
      actorId: input.requestedBy,
      action: 'community.export.request',
      resourceType: 'community_export',
      resourceIds: [] as AuditResourceId[],
      outcome: 'failure',
      ipAddress: null,
      userAgent: null,
    };
    const validatedFailureAudit =
      validateContentFreeAuditEntry(failureAuditInput);

    const retryAfterFromOldest = (oldestMs: number | null): number => {
      if (oldestMs === null || !Number.isFinite(oldestMs)) {
        return Math.max(1, Math.ceil(input.windowMs / 1000));
      }
      const remainingMs = oldestMs + input.windowMs - input.createdAtMs;
      return Math.max(1, Math.ceil(remainingMs / 1000));
    };

    if (typeof db.batch === 'function') {
      const communityCountSub = sql`(
        select count(*) from ${exportJobs}
        where ${exportJobs.communityId} = ${input.communityId}
          and ${exportJobs.createdAt} >= ${input.windowStartMs}
      )`;
      const accountCountSub = sql`(
        select count(*) from ${exportJobs}
        where ${exportJobs.requestedBy} = ${input.requestedBy}
          and ${exportJobs.createdAt} >= ${input.windowStartMs}
      )`;

      const conditionalReserve = db
        .insert(exportJobs)
        .select(
          sql`select
            ${input.jobId},
            ${input.communityId},
            ${input.requestedBy},
            ${'generating'},
            ${input.manifestStorageKey},
            ${null},
            ${null},
            ${input.zipStorageKey},
            ${null},
            ${null},
            ${null},
            ${input.createdAtMs},
            ${null},
            ${input.expiresAtMs},
            ${null}
          where exists (select 1 from ${communities} where ${communities.id} = ${input.communityId})
            and ${communityCountSub} < ${input.maxPerCommunity}
            and ${accountCountSub} < ${input.maxPerAccount}`
        )
        .returning({ id: exportJobs.id });

      const guardedAudit = this.d1AuditInsert(
        db,
        successAudit,
        input.now.getTime(),
        sql`exists (select 1 from ${exportJobs} where ${exportJobs.id} = ${input.jobId})`
      );

      try {
        const [inserted] = await db.batch([conditionalReserve, guardedAudit]);
        if (Array.isArray(inserted) && inserted.length > 0) {
          return { status: 'reserved', jobId: input.jobId };
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          await writeAuditEntry(db, failureAuditInput, input.now);
          return { status: 'in_progress' };
        }
        throw error;
      }

      // Reservation inserted 0 rows: community missing, active job, or rate-limit hit.
      const [commRows, activeRows, commWindow, acctWindow] = await db.batch([
        db
          .select({ id: communities.id })
          .from(communities)
          .where(eq(communities.id, input.communityId))
          .limit(1),
        db
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.communityId, input.communityId),
              eq(exportJobs.status, 'generating')
            )
          )
          .limit(1),
        db
          .select({
            total: sql<number>`count(*)`,
            oldest: sql<number | null>`min(${exportJobs.createdAt})`,
          })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.communityId, input.communityId),
              gte(exportJobs.createdAt, input.windowStartMs)
            )
          ),
        db
          .select({
            total: sql<number>`count(*)`,
            oldest: sql<number | null>`min(${exportJobs.createdAt})`,
          })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.requestedBy, input.requestedBy),
              gte(exportJobs.createdAt, input.windowStartMs)
            )
          ),
      ]);

      if (!commRows[0]) {
        return { status: 'not_found' };
      }

      if (activeRows[0]) {
        await writeAuditEntry(db, failureAuditInput, input.now);
        return { status: 'in_progress' };
      }

      const commCount = Number(commWindow[0]?.total ?? 0);
      const acctCount = Number(acctWindow[0]?.total ?? 0);
      const oldestCandidates: number[] = [];
      if (commCount >= input.maxPerCommunity && commWindow[0]?.oldest != null) {
        oldestCandidates.push(Number(commWindow[0].oldest));
      }
      if (acctCount >= input.maxPerAccount && acctWindow[0]?.oldest != null) {
        oldestCandidates.push(Number(acctWindow[0].oldest));
      }
      const oldestMs =
        oldestCandidates.length > 0 ? Math.min(...oldestCandidates) : null;
      await writeAuditEntry(db, failureAuditInput, input.now);
      return {
        status: 'rate_limited',
        retryAfterSeconds: retryAfterFromOldest(oldestMs),
      };
    }

    if (this.dialect === 'postgresql') {
      return await db.transaction(async (tx: Executor) => {
        // Lock order: communities (FOR SHARE) -> advisory lock -> export_jobs -> audit_entries.
        const commRows = await tx
          .select({ id: communities.id })
          .from(communities)
          .where(eq(communities.id, input.communityId))
          .for('share')
          .limit(1);
        if (commRows.length === 0) {
          return { status: 'not_found' } as const;
        }

        await tx.execute(
          sql`select pg_advisory_xact_lock(${EXPORT_PG_ADVISORY_LOCK_NS}, ${input.communityId})`
        );

        const activeRows = await tx
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.communityId, input.communityId),
              eq(exportJobs.status, 'generating')
            )
          )
          .limit(1);
        if (activeRows.length > 0) {
          await buildAuditEntryInsert(tx, validatedFailureAudit, input.now);
          return { status: 'in_progress' } as const;
        }

        const [commStats] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            oldest: sql<number | null>`min(${exportJobs.createdAt})`,
          })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.communityId, input.communityId),
              gte(exportJobs.createdAt, input.windowStartMs)
            )
          );
        const [acctStats] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            oldest: sql<number | null>`min(${exportJobs.createdAt})`,
          })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.requestedBy, input.requestedBy),
              gte(exportJobs.createdAt, input.windowStartMs)
            )
          );

        const commCount = Number(commStats?.total ?? 0);
        const acctCount = Number(acctStats?.total ?? 0);
        if (
          commCount >= input.maxPerCommunity ||
          acctCount >= input.maxPerAccount
        ) {
          const oldestCandidates: number[] = [];
          if (commCount >= input.maxPerCommunity && commStats?.oldest != null) {
            oldestCandidates.push(Number(commStats.oldest));
          }
          if (acctCount >= input.maxPerAccount && acctStats?.oldest != null) {
            oldestCandidates.push(Number(acctStats.oldest));
          }
          const oldestMs =
            oldestCandidates.length > 0 ? Math.min(...oldestCandidates) : null;
          await buildAuditEntryInsert(tx, validatedFailureAudit, input.now);
          return {
            status: 'rate_limited',
            retryAfterSeconds: retryAfterFromOldest(oldestMs),
          } as const;
        }

        await tx.insert(exportJobs).values({
          id: input.jobId,
          communityId: input.communityId,
          requestedBy: input.requestedBy,
          status: 'generating',
          manifestStorageKey: input.manifestStorageKey,
          zipStorageKey: input.zipStorageKey,
          createdAt: input.createdAtMs,
          expiresAt: input.expiresAtMs,
        });
        await buildAuditEntryInsert(tx, successAudit, input.now);
        return { status: 'reserved', jobId: input.jobId } as const;
      });
    }

    // Synchronous SQLite transaction
    return db.transaction((tx: Executor) => {
      const commRow = tx
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.id, input.communityId))
        .get();
      if (!commRow) {
        return { status: 'not_found' } as const;
      }

      const activeRow = tx
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.communityId, input.communityId),
            eq(exportJobs.status, 'generating')
          )
        )
        .get();
      if (activeRow) {
        buildAuditEntryInsert(tx, validatedFailureAudit, input.now).run();
        return { status: 'in_progress' } as const;
      }

      const commStats = tx
        .select({
          total: sql<number>`count(*)`,
          oldest: sql<number | null>`min(${exportJobs.createdAt})`,
        })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.communityId, input.communityId),
            gte(exportJobs.createdAt, input.windowStartMs)
          )
        )
        .get();
      const acctStats = tx
        .select({
          total: sql<number>`count(*)`,
          oldest: sql<number | null>`min(${exportJobs.createdAt})`,
        })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.requestedBy, input.requestedBy),
            gte(exportJobs.createdAt, input.windowStartMs)
          )
        )
        .get();

      const commCount = Number(commStats?.total ?? 0);
      const acctCount = Number(acctStats?.total ?? 0);
      if (
        commCount >= input.maxPerCommunity ||
        acctCount >= input.maxPerAccount
      ) {
        const oldestCandidates: number[] = [];
        if (commCount >= input.maxPerCommunity && commStats?.oldest != null) {
          oldestCandidates.push(Number(commStats.oldest));
        }
        if (acctCount >= input.maxPerAccount && acctStats?.oldest != null) {
          oldestCandidates.push(Number(acctStats.oldest));
        }
        const oldestMs =
          oldestCandidates.length > 0 ? Math.min(...oldestCandidates) : null;
        buildAuditEntryInsert(tx, validatedFailureAudit, input.now).run();
        return {
          status: 'rate_limited',
          retryAfterSeconds: retryAfterFromOldest(oldestMs),
        } as const;
      }

      tx.insert(exportJobs)
        .values({
          id: input.jobId,
          communityId: input.communityId,
          requestedBy: input.requestedBy,
          status: 'generating',
          manifestStorageKey: input.manifestStorageKey,
          zipStorageKey: input.zipStorageKey,
          createdAt: input.createdAtMs,
          expiresAt: input.expiresAtMs,
        })
        .run();
      buildAuditEntryInsert(tx, successAudit, input.now).run();
      return { status: 'reserved', jobId: input.jobId } as const;
    });
  }

  async recordZipUploadId(jobId: string, uploadId: string): Promise<boolean> {
    const { exportJobs } = this.tables;
    const updated = await this.db
      .update(exportJobs)
      .set({ zipUploadId: uploadId })
      .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'generating')))
      .returning({ id: exportJobs.id });
    return updated.length > 0;
  }

  /**
   * Atomically finalize a generating export job -> `ready`, insert its two
   * single-artifact download tokens, and record the content-free
   * `community.export.generate` audit entry.
   */
  async completeExportJob(input: {
    jobId: string;
    communityId: number;
    requestedBy: number;
    manifestByteSize: number;
    manifestChecksum: string;
    zipByteSize: number;
    zipChecksum: string;
    manifestTokenHash: string;
    zipTokenHash: string;
    completedAtMs: number;
    expiresAtMs: number;
    now: Date;
  }): Promise<boolean> {
    const { exportJobs, exportTokens } = this.tables;
    const db = this.db;
    const generateAudit = validateContentFreeAuditEntry({
      communityId: input.communityId,
      actorId: input.requestedBy,
      action: 'community.export.generate',
      resourceType: 'community_export',
      resourceIds: [input.jobId],
      outcome: 'success',
      ipAddress: null,
      userAgent: null,
    });

    const tokenRows = [
      {
        jobId: input.jobId,
        communityId: input.communityId,
        requestedBy: input.requestedBy,
        artifact: 'manifest' as const,
        tokenHash: input.manifestTokenHash,
        createdAt: input.completedAtMs,
        expiresAt: input.expiresAtMs,
        downloadedAt: null,
      },
      {
        jobId: input.jobId,
        communityId: input.communityId,
        requestedBy: input.requestedBy,
        artifact: 'media_zip' as const,
        tokenHash: input.zipTokenHash,
        createdAt: input.completedAtMs,
        expiresAt: input.expiresAtMs,
        downloadedAt: null,
      },
    ];

    if (typeof db.batch === 'function') {
      const updateJob = db
        .update(exportJobs)
        .set({
          status: 'ready',
          manifestByteSize: input.manifestByteSize,
          manifestChecksum: input.manifestChecksum,
          zipByteSize: input.zipByteSize,
          zipChecksum: input.zipChecksum,
          zipUploadId: null,
          completedAt: input.completedAtMs,
          expiresAt: input.expiresAtMs,
        })
        .where(
          and(
            eq(exportJobs.id, input.jobId),
            eq(exportJobs.communityId, input.communityId),
            eq(exportJobs.status, 'generating')
          )
        )
        .returning({ id: exportJobs.id });

      const readyGate = sql`exists (
        select 1 from ${exportJobs}
        where ${exportJobs.id} = ${input.jobId}
          and ${exportJobs.status} = 'ready'
          and ${exportJobs.completedAt} = ${input.completedAtMs}
      )`;

      const insertToken = (artifact: ExportTokenArtifact, tokenHash: string) =>
        db.insert(exportTokens).select(
          sql`select
            ${null},
            ${input.jobId},
            ${input.communityId},
            ${input.requestedBy},
            ${artifact},
            ${tokenHash},
            ${input.completedAtMs},
            ${input.expiresAtMs},
            ${null}
          where ${readyGate}`
        );

      const [updated] = await db.batch([
        updateJob,
        insertToken('manifest', input.manifestTokenHash),
        insertToken('media_zip', input.zipTokenHash),
        this.d1AuditInsert(db, generateAudit, input.now.getTime(), readyGate),
      ]);
      return Array.isArray(updated) && updated.length > 0;
    }

    if (this.dialect === 'postgresql') {
      return await db.transaction(async (tx: Executor) => {
        const updated = await tx
          .update(exportJobs)
          .set({
            status: 'ready',
            manifestByteSize: input.manifestByteSize,
            manifestChecksum: input.manifestChecksum,
            zipByteSize: input.zipByteSize,
            zipChecksum: input.zipChecksum,
            zipUploadId: null,
            completedAt: input.completedAtMs,
            expiresAt: input.expiresAtMs,
          })
          .where(
            and(
              eq(exportJobs.id, input.jobId),
              eq(exportJobs.communityId, input.communityId),
              eq(exportJobs.status, 'generating')
            )
          )
          .returning({ id: exportJobs.id });
        if (updated.length === 0) return false;
        await tx.insert(exportTokens).values(tokenRows);
        await buildAuditEntryInsert(tx, generateAudit, input.now);
        return true;
      });
    }

    return db.transaction((tx: Executor) => {
      const updated = tx
        .update(exportJobs)
        .set({
          status: 'ready',
          manifestByteSize: input.manifestByteSize,
          manifestChecksum: input.manifestChecksum,
          zipByteSize: input.zipByteSize,
          zipChecksum: input.zipChecksum,
          zipUploadId: null,
          completedAt: input.completedAtMs,
          expiresAt: input.expiresAtMs,
        })
        .where(
          and(
            eq(exportJobs.id, input.jobId),
            eq(exportJobs.communityId, input.communityId),
            eq(exportJobs.status, 'generating')
          )
        )
        .returning({ id: exportJobs.id })
        .all();
      if (updated.length === 0) return false;
      tx.insert(exportTokens).values(tokenRows).run();
      buildAuditEntryInsert(tx, generateAudit, input.now).run();
      return true;
    });
  }

  /**
   * Mark a generating job `'failed'` and emit a content-free failure audit
   * entry in one atomic unit. Transitions `completedAt` strictly once
   * (`null -> failTime`) so concurrent cleanup sweeps cannot confuse states
   * across generations, and preserves `cleanedUpAt = null` if any cleanup
   * failed so a subsequent sweep retries object deletion.
   */
  async failExportJob(input: {
    jobId: string;
    communityId: number;
    requestedBy: number;
    cleanedUpAtMs: number | null;
    clearUploadId: boolean;
    persistUploadId?: string | null;
    now: Date;
  }): Promise<boolean> {
    const { exportJobs } = this.tables;
    const db = this.db;
    const failureAudit = validateContentFreeAuditEntry({
      communityId: input.communityId,
      actorId: input.requestedBy,
      action: 'community.export.generate',
      resourceType: 'community_export',
      resourceIds: [input.jobId],
      outcome: 'failure',
      ipAddress: null,
      userAgent: null,
    });

    const patch: Record<string, unknown> = {
      status: 'failed',
      completedAt: input.now.getTime(),
      cleanedUpAt: input.cleanedUpAtMs,
    };
    if (input.clearUploadId) {
      patch.zipUploadId = null;
    } else if (input.persistUploadId) {
      patch.zipUploadId = input.persistUploadId;
    }

    if (typeof db.batch === 'function') {
      const { auditEntries } = this.tables;
      const updateStmt = db
        .update(exportJobs)
        .set(patch)
        .where(
          and(
            eq(exportJobs.id, input.jobId),
            eq(exportJobs.communityId, input.communityId),
            inArray(exportJobs.status, ['generating', 'failed']),
            isNull(exportJobs.completedAt)
          )
        )
        .returning({ id: exportJobs.id });
      const failedGate = sql`exists (
        select 1 from ${exportJobs}
        where ${exportJobs.id} = ${input.jobId}
          and ${exportJobs.status} = 'failed'
          and ${exportJobs.completedAt} = ${input.now.getTime()}
      ) and not exists (
        select 1 from ${auditEntries}
        where ${auditEntries.communityId} = ${input.communityId}
          and ${auditEntries.action} = 'community.export.generate'
          and ${auditEntries.resourceType} = 'community_export'
          and ${auditEntries.resourceIds} = ${JSON.stringify([input.jobId])}
      )`;
      const [updated] = await db.batch([
        updateStmt,
        this.d1AuditInsert(db, failureAudit, input.now.getTime(), failedGate),
      ]);
      return Array.isArray(updated) && updated.length > 0;
    }

    if (this.dialect === 'postgresql') {
      return await db.transaction(async (tx: Executor) => {
        const updated = await tx
          .update(exportJobs)
          .set(patch)
          .where(
            and(
              eq(exportJobs.id, input.jobId),
              eq(exportJobs.communityId, input.communityId),
              inArray(exportJobs.status, ['generating', 'failed']),
              isNull(exportJobs.completedAt)
            )
          )
          .returning({ id: exportJobs.id });
        if (updated.length === 0) return false;
        await buildAuditEntryInsert(tx, failureAudit, input.now);
        return true;
      });
    }

    return db.transaction((tx: Executor) => {
      const updated = tx
        .update(exportJobs)
        .set(patch)
        .where(
          and(
            eq(exportJobs.id, input.jobId),
            eq(exportJobs.communityId, input.communityId),
            inArray(exportJobs.status, ['generating', 'failed']),
            isNull(exportJobs.completedAt)
          )
        )
        .returning({ id: exportJobs.id })
        .all();
      if (updated.length === 0) return false;
      buildAuditEntryInsert(tx, failureAudit, input.now).run();
      return true;
    });
  }

  async findTokenWithJobByHash(
    tokenHash: string
  ): Promise<ExportTokenWithJobRecord | null> {
    const { exportTokens, exportJobs } = this.tables;
    const rows = await this.db
      .select({
        tokenId: exportTokens.id,
        jobId: exportTokens.jobId,
        communityId: exportTokens.communityId,
        requestedBy: exportTokens.requestedBy,
        artifact: exportTokens.artifact,
        tokenHash: exportTokens.tokenHash,
        tokenCreatedAt: exportTokens.createdAt,
        tokenExpiresAt: exportTokens.expiresAt,
        downloadedAt: exportTokens.downloadedAt,
        jobStatus: exportJobs.status,
        manifestStorageKey: exportJobs.manifestStorageKey,
        manifestByteSize: exportJobs.manifestByteSize,
        manifestChecksum: exportJobs.manifestChecksum,
        zipStorageKey: exportJobs.zipStorageKey,
        zipByteSize: exportJobs.zipByteSize,
        zipChecksum: exportJobs.zipChecksum,
        zipUploadId: exportJobs.zipUploadId,
        jobExpiresAt: exportJobs.expiresAt,
        cleanedUpAt: exportJobs.cleanedUpAt,
      })
      .from(exportTokens)
      .innerJoin(exportJobs, eq(exportTokens.jobId, exportJobs.id))
      .where(eq(exportTokens.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      tokenId: Number(row.tokenId),
      jobId: String(row.jobId),
      communityId: Number(row.communityId),
      requestedBy: Number(row.requestedBy),
      artifact: row.artifact as ExportTokenArtifact,
      tokenHash: String(row.tokenHash),
      tokenCreatedAt: Number(row.tokenCreatedAt),
      tokenExpiresAt: Number(row.tokenExpiresAt),
      downloadedAt: toOptionalNumber(row.downloadedAt),
      jobStatus: row.jobStatus as ExportJobStatus,
      manifestStorageKey:
        row.manifestStorageKey === null ? null : String(row.manifestStorageKey),
      manifestByteSize: toOptionalNumber(row.manifestByteSize),
      manifestChecksum:
        row.manifestChecksum === null ? null : String(row.manifestChecksum),
      zipStorageKey:
        row.zipStorageKey === null ? null : String(row.zipStorageKey),
      zipByteSize: toOptionalNumber(row.zipByteSize),
      zipChecksum: row.zipChecksum === null ? null : String(row.zipChecksum),
      zipUploadId: row.zipUploadId === null ? null : String(row.zipUploadId),
      jobExpiresAt: Number(row.jobExpiresAt),
      cleanedUpAt: toOptionalNumber(row.cleanedUpAt),
    };
  }

  async recordTokenDownload(input: {
    tokenId: number;
    jobId: string;
    communityId: number;
    actorId: number;
    artifact: ExportTokenArtifact;
    now: Date;
  }): Promise<void> {
    const { exportTokens } = this.tables;
    const db = this.db;
    const nowMs = input.now.getTime();
    const audit = validateContentFreeAuditEntry({
      communityId: input.communityId,
      actorId: input.actorId,
      action: 'community.export.download',
      resourceType: 'community_export',
      resourceIds: [input.jobId, input.artifact],
      outcome: 'success',
      ipAddress: null,
      userAgent: null,
    });

    if (typeof db.batch === 'function') {
      await db.batch([
        db
          .update(exportTokens)
          .set({ downloadedAt: nowMs })
          .where(eq(exportTokens.id, input.tokenId)),
        buildAuditEntryInsert(db, audit, input.now),
      ]);
      return;
    }

    if (this.dialect === 'postgresql') {
      await db.transaction(async (tx: Executor) => {
        await tx
          .update(exportTokens)
          .set({ downloadedAt: nowMs })
          .where(eq(exportTokens.id, input.tokenId));
        await buildAuditEntryInsert(tx, audit, input.now);
      });
      return;
    }

    db.transaction((tx: Executor) => {
      tx.update(exportTokens)
        .set({ downloadedAt: nowMs })
        .where(eq(exportTokens.id, input.tokenId))
        .run();
      buildAuditEntryInsert(tx, audit, input.now).run();
    });
  }

  async recordDownloadFailureAudit(input: {
    communityId: number;
    actorId: number;
    jobId?: string;
    now: Date;
  }): Promise<void> {
    await writeAuditEntry(
      this.db,
      {
        communityId: input.communityId,
        actorId: input.actorId,
        action: 'community.export.download',
        resourceType: 'community_export',
        resourceIds: input.jobId ? [input.jobId] : [],
        outcome: 'failure',
        ipAddress: null,
        userAgent: null,
      },
      input.now
    );
  }

  async findJobById(jobId: string): Promise<ExportJobRecord | null> {
    const { exportJobs } = this.tables;
    const rows = await this.db
      .select({
        id: exportJobs.id,
        communityId: exportJobs.communityId,
        requestedBy: exportJobs.requestedBy,
        status: exportJobs.status,
        manifestStorageKey: exportJobs.manifestStorageKey,
        manifestByteSize: exportJobs.manifestByteSize,
        manifestChecksum: exportJobs.manifestChecksum,
        zipStorageKey: exportJobs.zipStorageKey,
        zipByteSize: exportJobs.zipByteSize,
        zipChecksum: exportJobs.zipChecksum,
        zipUploadId: exportJobs.zipUploadId,
        createdAt: exportJobs.createdAt,
        completedAt: exportJobs.completedAt,
        expiresAt: exportJobs.expiresAt,
        cleanedUpAt: exportJobs.cleanedUpAt,
      })
      .from(exportJobs)
      .where(eq(exportJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    return row ? this.mapJobRow(row) : null;
  }

  /**
   * Find uncleaned export jobs eligible for immediate object cleanup:
   * - jobs past `expiresAt`
   * - `'failed'` jobs still carrying uncleaned artifacts/uploads
   * - stale `'generating'` jobs past `staleBeforeMs`
   * Uses `export_jobs_cleanup_idx` (`WHERE cleaned_up_at IS NULL`).
   */
  async findJobsNeedingCleanup(input: {
    nowMs: number;
    staleBeforeMs: number;
    communityId?: number;
    limit: number;
  }): Promise<ExportJobRecord[]> {
    const { exportJobs } = this.tables;
    const rows = await this.db
      .select({
        id: exportJobs.id,
        communityId: exportJobs.communityId,
        requestedBy: exportJobs.requestedBy,
        status: exportJobs.status,
        manifestStorageKey: exportJobs.manifestStorageKey,
        manifestByteSize: exportJobs.manifestByteSize,
        manifestChecksum: exportJobs.manifestChecksum,
        zipStorageKey: exportJobs.zipStorageKey,
        zipByteSize: exportJobs.zipByteSize,
        zipChecksum: exportJobs.zipChecksum,
        zipUploadId: exportJobs.zipUploadId,
        createdAt: exportJobs.createdAt,
        completedAt: exportJobs.completedAt,
        expiresAt: exportJobs.expiresAt,
        cleanedUpAt: exportJobs.cleanedUpAt,
      })
      .from(exportJobs)
      .where(
        and(
          isNull(exportJobs.cleanedUpAt),
          input.communityId === undefined
            ? undefined
            : eq(exportJobs.communityId, input.communityId),
          or(
            lte(exportJobs.expiresAt, input.nowMs),
            eq(exportJobs.status, 'failed'),
            and(
              eq(exportJobs.status, 'generating'),
              lte(exportJobs.createdAt, input.staleBeforeMs)
            )
          )
        )
      )
      .orderBy(
        sql`case when ${exportJobs.status} = 'failed' and ${exportJobs.completedAt} is null then 1 else 0 end`,
        asc(exportJobs.expiresAt),
        asc(exportJobs.createdAt)
      )
      .limit(input.limit);

    return rows.map((row: Record<string, unknown>) => this.mapJobRow(row));
  }

  /**
   * Atomically fence an export job and capture its post-fence cleanup snapshot
   * (`manifestStorageKey`, `zipStorageKey`, `zipUploadId`, `completedAt`) before
   * deleting storage objects or aborting multipart uploads, so a concurrent
   * completion to `'ready'` or writer `failExportJob` cannot leave uncollected
   * artifacts behind.
   */
  async claimJobForCleanup(input: {
    jobId: string;
    status: ExportJobStatus;
    nowMs: number;
    staleBeforeMs: number;
  }): Promise<ExportCleanupClaim | null> {
    const { exportJobs } = this.tables;
    const claimColumns = {
      status: exportJobs.status,
      manifestStorageKey: exportJobs.manifestStorageKey,
      zipStorageKey: exportJobs.zipStorageKey,
      zipUploadId: exportJobs.zipUploadId,
      completedAt: exportJobs.completedAt,
    };
    const toClaim = (
      row: Record<string, unknown>,
      status: 'expired' | 'failed'
    ): ExportCleanupClaim => ({
      status,
      manifestStorageKey:
        row.manifestStorageKey === null ? null : String(row.manifestStorageKey),
      zipStorageKey:
        row.zipStorageKey === null ? null : String(row.zipStorageKey),
      zipUploadId: row.zipUploadId === null ? null : String(row.zipUploadId),
      completedAt: toOptionalNumber(row.completedAt),
    });

    if (input.status === 'generating') {
      const updated = await this.db
        .update(exportJobs)
        .set({ status: 'failed' })
        .where(
          and(
            eq(exportJobs.id, input.jobId),
            eq(exportJobs.status, 'generating'),
            lte(exportJobs.createdAt, input.staleBeforeMs),
            isNull(exportJobs.cleanedUpAt)
          )
        )
        .returning(claimColumns);
      return Array.isArray(updated) && updated.length > 0
        ? toClaim(updated[0], 'failed')
        : null;
    }

    if (input.status === 'ready') {
      const updated = await this.db
        .update(exportJobs)
        .set({ status: 'expired' })
        .where(
          and(
            eq(exportJobs.id, input.jobId),
            eq(exportJobs.status, 'ready'),
            lte(exportJobs.expiresAt, input.nowMs),
            isNull(exportJobs.cleanedUpAt)
          )
        )
        .returning(claimColumns);
      return Array.isArray(updated) && updated.length > 0
        ? toClaim(updated[0], 'expired')
        : null;
    }

    const rows = await this.db
      .select(claimColumns)
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.id, input.jobId),
          eq(exportJobs.status, input.status),
          isNull(exportJobs.cleanedUpAt)
        )
      )
      .limit(1);
    return rows.length > 0
      ? toClaim(rows[0], input.status as 'expired' | 'failed')
      : null;
  }

  async markJobCleanedUp(input: {
    jobId: string;
    nextStatus: 'expired' | 'failed';
    expectedCompletedAt: number | null;
    cleanedUpAtMs: number | null;
    clearUploadId: boolean;
  }): Promise<MarkJobCleanedUpResult> {
    const { exportJobs } = this.tables;
    // A reclaimed writer may still be uploading. Only a sweep that observed a
    // non-null completedAt BEFORE deleting objects may mark cleanedUpAt, and
    // any concurrent completedAt transition during the delete pass forces a retry.
    const canMarkCleaned =
      input.cleanedUpAtMs !== null &&
      (input.nextStatus === 'expired' || input.expectedCompletedAt !== null);
    const patch: Record<string, unknown> = {
      status: input.nextStatus,
      cleanedUpAt: canMarkCleaned ? input.cleanedUpAtMs : null,
    };
    if (input.clearUploadId) {
      patch.zipUploadId = null;
    }
    const completedAtGuard =
      input.expectedCompletedAt === null
        ? isNull(exportJobs.completedAt)
        : eq(exportJobs.completedAt, input.expectedCompletedAt);

    const updated = await this.db
      .update(exportJobs)
      .set(patch)
      .where(
        and(
          eq(exportJobs.id, input.jobId),
          isNull(exportJobs.cleanedUpAt),
          eq(exportJobs.status, input.nextStatus),
          completedAtGuard
        )
      )
      .returning({
        id: exportJobs.id,
        cleanedUpAt: exportJobs.cleanedUpAt,
      });

    if (!Array.isArray(updated) || updated.length === 0) {
      return { updated: false, markedCleaned: false };
    }
    return {
      updated: true,
      markedCleaned: updated[0]!.cleanedUpAt !== null,
    };
  }

  private mapJobRow(row: Record<string, unknown>): ExportJobRecord {
    return {
      id: String(row.id),
      communityId: Number(row.communityId),
      requestedBy: toOptionalNumber(row.requestedBy),
      status: row.status as ExportJobStatus,
      manifestStorageKey:
        row.manifestStorageKey === null ? null : String(row.manifestStorageKey),
      manifestByteSize: toOptionalNumber(row.manifestByteSize),
      manifestChecksum:
        row.manifestChecksum === null ? null : String(row.manifestChecksum),
      zipStorageKey:
        row.zipStorageKey === null ? null : String(row.zipStorageKey),
      zipByteSize: toOptionalNumber(row.zipByteSize),
      zipChecksum: row.zipChecksum === null ? null : String(row.zipChecksum),
      zipUploadId: row.zipUploadId === null ? null : String(row.zipUploadId),
      createdAt: Number(row.createdAt),
      completedAt: toOptionalNumber(row.completedAt),
      expiresAt: Number(row.expiresAt),
      cleanedUpAt: toOptionalNumber(row.cleanedUpAt),
    };
  }
}
