/**
 * Deterministic community export manifest builder (SPEC-V2 §7, #187).
 *
 * Pure module with zero Node-only or database imports so SQLite/D1,
 * PostgreSQL, and Cloudflare Workers emit byte-identical manifests for
 * unchanged data.
 *
 * Exclusions (§7):
 * - Account/auth credential material (`passwordHash`, `passwordVerifier`,
 *   `passwordAlgorithm`, `passwordSalt`, `passwordParams`, reset tokens,
 *   login/recovery/claim hashes)
 * - Operational security state (`sessions`, `auth_throttle`)
 * - Export lifecycle's own `audit_entries` (`community.export.*`) so taking an
 *   export never changes the next export
 * - Per-request values (`jobId`, `generatedAt`, download tokens) outside the
 *   digested manifest
 * - Null-community system-profile files (`community_id IS NULL`)
 *
 * Note (§6.6, 2026-11-22 amendment): community-owned map provider tokens
 * (`mapboxAccessToken`, `protomapsApiKey`) are exported under
 * `mapConfig.credentials` and explicitly classified as provider credentials.
 */

import {
  communityFromPhysical,
  storyVisibilityFromPhysical,
  userStatusFromPhysical,
  type CanonicalStoryVisibility,
  type CommunityStatus,
  type CommunityVisibility,
  type UserStatus,
} from '../policy/canonical-state.js';
import type { CommunityExportSnapshot } from '../repositories/community-export.repository.js';
import type { AuditResourceId } from '../db/schema/audit_entries.js';
import {
  COMMUNITY_EXPORT_FORMAT_VERSION,
  COMMUNITY_EXPORT_SCHEMA_VERSION,
  exportArchivePathForFile,
} from '../shared/export-policy.js';
import { ExportLimitExceededError } from '../shared/utils/deterministic-zip.js';
import {
  canonicalJsonStringify,
  CanonicalJsonLimitError,
} from '../shared/utils/canonical-json.js';
import { StreamingSha256 } from '../shared/utils/sha256-stream.js';

export interface VerifiedExportFile {
  id: string;
  storageKey: string;
  archivePath: string;
  byteSize: number;
  checksum: string;
}

export interface ExportedMediaArchiveSummary {
  format: 'zip';
  checksumAlgorithm: 'sha256';
  checksum: string;
  byteSize: number;
  fileCount: number;
}

export interface CommunityExportManifest {
  exportFormatVersion: string;
  schemaVersion: string;
  exclusions: {
    credentialsExcluded: true;
    operationalSecurityStateExcluded: true;
    exportLifecycleAuditEntriesExcluded: true;
  };
  mediaArchive: ExportedMediaArchiveSummary;
  community: {
    id: number;
    name: string;
    description: string | null;
    descriptionPlain: string | null;
    slug: string;
    locale: string;
    country: string | null;
    visibility: CommunityVisibility;
    status: CommunityStatus;
    createdAt: string;
    updatedAt: string;
  };
  mapConfig: {
    communityId: number;
    styleUrl: string | null;
    basemapStyle: string | null;
    mapboxStyleUrl: string | null;
    exposeMapboxCredentials: boolean;
    mapbox3d: boolean;
    protomapsBasemapStyle: string | null;
    credentials: {
      classification: 'community_owned_map_provider_credential';
      containsCredentials: boolean;
      mapboxAccessToken: string | null;
      protomapsApiKey: string | null;
    };
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
    createdAt: string;
    updatedAt: string;
  } | null;
  users: Array<{
    id: number;
    communityId: number;
    email: string;
    username: string | null;
    displayName: string | null;
    firstName: string;
    lastName: string;
    role: string;
    status: UserStatus;
    createdAt: string;
    updatedAt: string;
  }>;
  places: Array<{
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
    createdAt: string;
    updatedAt: string;
  }>;
  speakers: Array<{
    id: number;
    communityId: number;
    name: string;
    birthDate: string | null;
    birthplaceId: number | null;
    affiliation: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  stories: Array<{
    id: number;
    communityId: number;
    title: string;
    description: string | null;
    descriptionPlain: string | null;
    slug: string;
    visibility: CanonicalStoryVisibility;
    privacyLevel: string;
    isRestricted: boolean;
    topic: string | null;
    topicNormalized: string | null;
    language: string;
    dateInterviewed: string | null;
    interviewLocationId: number | null;
    interviewerId: number | null;
    createdBy: number | null;
    createdAt: string;
    updatedAt: string;
  }>;
  storyPlaces: Array<{
    id: number;
    communityId: number;
    storyId: number;
    placeId: number;
    createdAt: string;
    updatedAt: string;
  }>;
  storySpeakers: Array<{
    id: number;
    communityId: number;
    storyId: number;
    speakerId: number;
    createdAt: string;
    updatedAt: string;
  }>;
  files: Array<{
    id: string;
    communityId: number;
    storageKey: string;
    archivePath: string;
    originalName: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
    uploadedBy: number | null;
    metadata: unknown;
    culturalRestrictions: unknown;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  attachments: Array<{
    id: number;
    communityId: number;
    fileId: string;
    ownerType: string | null;
    ownerId: number | null;
    role: string | null;
    ordinal: number;
    createdAt: string;
  }>;
  externalMediaLinks: Array<{
    id: number;
    communityId: number;
    storyId: number;
    url: string;
    ordinal: number;
    createdAt: string;
  }>;
  legacyCommunityMedia: Array<{
    fileId: string;
    communityId: number;
    kind: string;
  }>;
  // Source CSV and staged media bytes are captured in files and the media ZIP.
  importManifests: CommunityExportSnapshot['importManifests'];
  auditEntries: Array<{
    id: number;
    communityId: number;
    actorId: number | null;
    action: string;
    resourceType: string | null;
    resourceIds: AuditResourceId[];
    outcome: string;
    createdAt: string;
  }>;
}

export interface BuiltCommunityExportManifest {
  manifest: CommunityExportManifest;
  jsonText: string;
  bytes: Uint8Array;
  checksum: string;
  byteSize: number;
}

const byNumericId = <T extends { id: number }>(a: T, b: T): number =>
  a.id - b.id;

const byCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Count logical exported rows for Workers Free feasibility enforcement (§7).
 */
export function countSnapshotRows(snapshot: CommunityExportSnapshot): number {
  return (
    1 +
    (snapshot.mapConfig ? 1 : 0) +
    snapshot.users.length +
    snapshot.places.length +
    snapshot.speakers.length +
    snapshot.stories.length +
    snapshot.storyPlaces.length +
    snapshot.storySpeakers.length +
    snapshot.files.length +
    snapshot.attachments.length +
    snapshot.externalMediaLinks.length +
    snapshot.legacyCommunityMedia.length +
    snapshot.importManifests.length +
    snapshot.auditEntries.length
  );
}

export function buildCommunityExportManifest(
  snapshot: CommunityExportSnapshot,
  verifiedFiles: ReadonlyArray<VerifiedExportFile>,
  mediaArchive: { checksum: string; byteSize: number; fileCount: number },
  maxBytes = Infinity
): BuiltCommunityExportManifest {
  const verifiedById = new Map<string, VerifiedExportFile>();
  for (const vf of verifiedFiles) {
    verifiedById.set(vf.id, vf);
  }

  const communityState = communityFromPhysical({
    publicStories: snapshot.community.publicStories,
    isActive: snapshot.community.isActive,
  });

  const manifest: CommunityExportManifest = {
    exportFormatVersion: COMMUNITY_EXPORT_FORMAT_VERSION,
    schemaVersion: COMMUNITY_EXPORT_SCHEMA_VERSION,
    exclusions: {
      credentialsExcluded: true,
      operationalSecurityStateExcluded: true,
      exportLifecycleAuditEntriesExcluded: true,
    },
    mediaArchive: {
      format: 'zip',
      checksumAlgorithm: 'sha256',
      checksum: mediaArchive.checksum,
      byteSize: mediaArchive.byteSize,
      fileCount: mediaArchive.fileCount,
    },
    community: {
      id: snapshot.community.id,
      name: snapshot.community.name,
      description: snapshot.community.description,
      descriptionPlain: snapshot.community.descriptionPlain,
      slug: snapshot.community.slug,
      locale: snapshot.community.locale,
      country: snapshot.community.country,
      visibility: communityState.visibility,
      status: communityState.status,
      createdAt: snapshot.community.createdAt.toISOString(),
      updatedAt: snapshot.community.updatedAt.toISOString(),
    },
    mapConfig: snapshot.mapConfig
      ? {
          communityId: snapshot.mapConfig.communityId,
          styleUrl: snapshot.mapConfig.styleUrl,
          basemapStyle: snapshot.mapConfig.basemapStyle,
          mapboxStyleUrl: snapshot.mapConfig.mapboxStyleUrl,
          exposeMapboxCredentials: snapshot.mapConfig.exposeMapboxCredentials,
          mapbox3d: snapshot.mapConfig.mapbox3d,
          protomapsBasemapStyle: snapshot.mapConfig.protomapsBasemapStyle,
          credentials: {
            classification: 'community_owned_map_provider_credential',
            containsCredentials:
              snapshot.mapConfig.mapboxAccessToken !== null ||
              snapshot.mapConfig.protomapsApiKey !== null,
            mapboxAccessToken: snapshot.mapConfig.mapboxAccessToken,
            protomapsApiKey: snapshot.mapConfig.protomapsApiKey,
          },
          centerLatitude: snapshot.mapConfig.centerLatitude,
          centerLongitude: snapshot.mapConfig.centerLongitude,
          southWestLatitude: snapshot.mapConfig.southWestLatitude,
          southWestLongitude: snapshot.mapConfig.southWestLongitude,
          northEastLatitude: snapshot.mapConfig.northEastLatitude,
          northEastLongitude: snapshot.mapConfig.northEastLongitude,
          zoom: snapshot.mapConfig.zoom,
          pitch: snapshot.mapConfig.pitch,
          bearing: snapshot.mapConfig.bearing,
          threeDimensional: snapshot.mapConfig.threeDimensional,
          projection: snapshot.mapConfig.projection,
          staticMapFileId: snapshot.mapConfig.staticMapFileId,
          createdAt: snapshot.mapConfig.createdAt.toISOString(),
          updatedAt: snapshot.mapConfig.updatedAt.toISOString(),
        }
      : null,
    users: [...snapshot.users].sort(byNumericId).map((user) => ({
      id: user.id,
      communityId: user.communityId,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      status: userStatusFromPhysical(user.isActive),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    })),
    places: [...snapshot.places].sort(byNumericId).map((place) => ({
      id: place.id,
      communityId: place.communityId,
      name: place.name,
      description: place.description,
      descriptionPlain: place.descriptionPlain,
      typeOfPlace: place.typeOfPlace,
      region: place.region,
      latitude: place.latitude,
      longitude: place.longitude,
      isRestricted: place.isRestricted,
      createdAt: place.createdAt.toISOString(),
      updatedAt: place.updatedAt.toISOString(),
    })),
    speakers: [...snapshot.speakers].sort(byNumericId).map((speaker) => ({
      id: speaker.id,
      communityId: speaker.communityId,
      name: speaker.name,
      birthDate: speaker.birthDate,
      birthplaceId: speaker.birthplaceId,
      affiliation: speaker.affiliation,
      isActive: speaker.isActive,
      createdAt: speaker.createdAt.toISOString(),
      updatedAt: speaker.updatedAt.toISOString(),
    })),
    stories: [...snapshot.stories].sort(byNumericId).map((story) => ({
      id: story.id,
      communityId: story.communityId,
      title: story.title,
      description: story.description,
      descriptionPlain: story.descriptionPlain,
      slug: story.slug,
      visibility: storyVisibilityFromPhysical(
        story.privacyLevel,
        story.isRestricted
      ),
      privacyLevel: story.privacyLevel,
      isRestricted: story.isRestricted,
      topic: story.topic,
      topicNormalized: story.topicNormalized,
      language: story.language,
      dateInterviewed: story.dateInterviewed
        ? story.dateInterviewed.toISOString()
        : null,
      interviewLocationId: story.interviewLocationId,
      interviewerId: story.interviewerId,
      createdBy: story.createdBy,
      createdAt: story.createdAt.toISOString(),
      updatedAt: story.updatedAt.toISOString(),
    })),
    storyPlaces: [...snapshot.storyPlaces].sort(byNumericId).map((edge) => ({
      id: edge.id,
      communityId: edge.communityId,
      storyId: edge.storyId,
      placeId: edge.placeId,
      createdAt: edge.createdAt.toISOString(),
      updatedAt: edge.updatedAt.toISOString(),
    })),
    storySpeakers: [...snapshot.storySpeakers]
      .sort(byNumericId)
      .map((edge) => ({
        id: edge.id,
        communityId: edge.communityId,
        storyId: edge.storyId,
        speakerId: edge.speakerId,
        createdAt: edge.createdAt.toISOString(),
        updatedAt: edge.updatedAt.toISOString(),
      })),
    files: [...snapshot.files]
      .sort((a, b) => byCodeUnits(a.id, b.id))
      .map((file) => {
        const verified = verifiedById.get(file.id);
        if (!verified) {
          throw new Error(
            `Export manifest missing verified checksum for file ${file.id}`
          );
        }
        return {
          id: file.id,
          communityId: file.communityId,
          storageKey: file.storageKey,
          archivePath:
            verified.archivePath || exportArchivePathForFile(file.id),
          originalName: file.originalName,
          mimeType: file.mimeType,
          byteSize: verified.byteSize,
          checksum: verified.checksum,
          uploadedBy: file.uploadedBy,
          metadata: file.metadata,
          culturalRestrictions: file.culturalRestrictions,
          isActive: file.isActive,
          createdAt: file.createdAt.toISOString(),
          updatedAt: file.updatedAt.toISOString(),
        };
      }),
    attachments: [...snapshot.attachments].sort(byNumericId).map((att) => ({
      id: att.id,
      communityId: att.communityId,
      fileId: att.fileId,
      ownerType: att.ownerType,
      ownerId: att.ownerId,
      role: att.role,
      ordinal: att.ordinal,
      createdAt: att.createdAt.toISOString(),
    })),
    externalMediaLinks: [...snapshot.externalMediaLinks]
      .sort(byNumericId)
      .map((link) => ({
        id: link.id,
        communityId: link.communityId,
        storyId: link.storyId,
        url: link.url,
        ordinal: link.ordinal,
        createdAt: link.createdAt.toISOString(),
      })),
    legacyCommunityMedia: [...snapshot.legacyCommunityMedia]
      .sort((a, b) => byCodeUnits(a.fileId, b.fileId))
      .map((row) => ({
        fileId: row.fileId,
        communityId: row.communityId,
        kind: row.kind,
      })),
    importManifests: [...snapshot.importManifests].sort(byNumericId),
    auditEntries: [...snapshot.auditEntries].sort(byNumericId).map((entry) => ({
      id: entry.id,
      communityId: entry.communityId,
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceIds: [...entry.resourceIds],
      outcome: entry.outcome,
      createdAt: entry.createdAt.toISOString(),
    })),
  };

  let jsonText: string;
  try {
    jsonText = canonicalJsonStringify(manifest, maxBytes);
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError) {
      throw new ExportLimitExceededError(
        'maxManifestBytes',
        'Export manifest exceeds size limit'
      );
    }
    throw error;
  }
  const bytes = new TextEncoder().encode(jsonText);
  const checksum = new StreamingSha256().update(bytes).digestHex();

  return {
    manifest,
    jsonText,
    bytes,
    checksum,
    byteSize: bytes.byteLength,
  };
}
