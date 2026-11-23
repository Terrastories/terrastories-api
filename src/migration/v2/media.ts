/**
 * Stage-2 media: Stage-1 ActiveStorage blobs -> V2 files + attachments
 * (SPEC-V2 section 6.7, 10.2, 10.4, 10.5).
 *
 * planMedia() is pure: it turns the Stage-2 plan and the verified bundle into
 * canonical file/attachment rows and a per-blob disposition ledger. Every
 * source blob receives exactly one disposition:
 *
 *   canonical     one files row per destination community (tenant fan-out),
 *                 each with its own tenant-scoped storage key and verified copy
 *   archive       one protected archive object (orphans, variants, previews and
 *                 blobs without an accepted attachment)
 *   not_selected  outside the selected communities; no bytes were captured
 *
 * writeMediaObjects() copies the bytes (streamed, SHA-256 checked while
 * writing and again after fsync) and fails closed on any mismatch.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fsyncPath } from '../rails/fsync.js';
import type { VerifiedBundle, SourceRow } from './bundle-reader.js';
import {
  ATTACHMENT_ROLE_ALLOWED_CATEGORIES,
  MEDIA_MIME_RULES,
  normalizeMediaMimeType,
} from '../../shared/schemas/media-v2.js';
import { classifyAttachment } from './dispositions.js';
import {
  parseTimestamp,
  type ArchivedField,
  type ArchivedRow,
  type CanonicalRow,
  type RowStatus,
  type TransformPlan,
  type WarningItem,
} from './plan.js';

export const MEDIA_DIRECTORY = 'v2-media';
export const ARCHIVE_MEDIA_DIRECTORY = 'archive-media';

export const MEDIA_TABLES = [
  'media',
  'active_storage_blobs',
  'active_storage_attachments',
  'active_storage_variant_records',
] as const;
export type MediaTable = (typeof MEDIA_TABLES)[number];

export type BlobDisposition = 'canonical' | 'archive' | 'not_selected';
export type ArchiveReason =
  | 'orphan'
  | 'derived_variant'
  | 'derived_preview'
  | 'no_accepted_attachment';

export interface LedgerDestination {
  fileId: string;
  /** Destination community, or null for the super_admin account namespace. */
  communityId: number | null;
  /** Account owner when communityId is null. */
  accountUserId: number | null;
  storageKey: string;
  /** Path of the verified copy relative to the output directory. */
  path: string;
}

export interface LedgerAttachment {
  id: string;
  status: 'imported' | 'archived';
  fileId: string | null;
}

export interface BlobLedgerEntry {
  blobId: string;
  sourceKey: string;
  byteSize: string;
  sha256: string | null;
  disposition: BlobDisposition;
  archiveReason?: ArchiveReason;
  /** Path of the protected archive object relative to the output directory. */
  archiveObject?: string;
  destinations: LedgerDestination[];
  attachments: LedgerAttachment[];
}

export interface MediaCopyJob {
  blobId: string;
  sourceKey: string;
  sha256: string;
  byteSize: number;
  /** Destination relative to the output directory. */
  path: string;
}

export interface MediaPlan {
  files: CanonicalRow[];
  attachments: CanonicalRow[];
  /** community id -> file id of its static map. */
  staticMaps: Map<number, string>;
  copies: MediaCopyJob[];
  ledger: BlobLedgerEntry[];
  /** Final status for every row the plan left as pending_media_slice. */
  finalStatus: Record<MediaTable, Map<string, RowStatus>>;
  archivedRows: ArchivedRow[];
  archivedFields: ArchivedField[];
  warnings: WarningItem[];
  events: Record<string, number>;
  attachmentSequenceFloor: number;
  counts: {
    blobs: Record<BlobDisposition, number>;
    files: number;
    attachments: number;
    objects: number;
    bytes: number;
  };
}

function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

function compareIds(left: string, right: string): number {
  const l = numeric(left);
  const r = numeric(right);
  if (l !== null && r !== null) return l - r;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable UUID-shaped id derived from the source blob and tenant scope. */
export function deterministicFileId(blobId: string, scope: string): string {
  const hex = createHash('sha256')
    .update('terrastories-v2-file|' + blobId + '|' + scope, 'utf8')
    .digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-4' +
    hex.slice(13, 16) +
    '-' +
    variant +
    hex.slice(17, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

interface CanonicalAttachment {
  attachmentId: string;
  blobId: string;
  createdAt: string | null | undefined;
  ownerType: string;
  ownerId: number;
  role: string;
  recordId: string;
  /** Destination community, or null for the system-account namespace. */
  communityId: number | null;
  accountUserId: number | null;
  /** Ordering signal inside (owner, role): the media id for story media. */
  sortKey: string;
}

function scopeOf(attachment: CanonicalAttachment): string {
  return attachment.communityId !== null
    ? String(attachment.communityId)
    : 'u' + String(attachment.accountUserId);
}

export function planMedia(
  bundle: VerifiedBundle,
  plan: TransformPlan
): MediaPlan {
  const archivedRows: ArchivedRow[] = [];
  const archivedFields: ArchivedField[] = [];
  const warnings: WarningItem[] = [];
  const events: Record<string, number> = {};
  const warn = (code: string, table: string, id: string | null): void => {
    warnings.push({ code, table, id });
  };
  const event = (key: string): void => {
    events[key] = (events[key] ?? 0) + 1;
  };
  const byId = (rows: SourceRow[]): Map<string, SourceRow> =>
    new Map(rows.map((row) => [row.id ?? '', row]));

  const blobRows = byId(bundle.rows('active_storage_blobs'));
  const mediaRows = byId(bundle.rows('media'));
  const variantRows = byId(bundle.rows('active_storage_variant_records'));
  const sourceAttachments = bundle
    .rows('active_storage_attachments')
    .slice()
    .sort((a, b) => compareIds(a.id ?? '', b.id ?? ''));

  const ownerSets: Record<string, Set<number>> = {
    community: new Set(plan.canonical.communities.map((r) => r.id as number)),
    place: new Set(plan.canonical.places.map((r) => r.id as number)),
    speaker: new Set(plan.canonical.speakers.map((r) => r.id as number)),
    user: new Set(plan.canonical.users.map((r) => r.id as number)),
    story: new Set(plan.canonical.stories.map((r) => r.id as number)),
    map_config: new Set(
      plan.canonical.community_map_configs.map((r) => r.community_id as number)
    ),
  };

  const pendingBlobs = plan.pendingMedia.blobs.filter(
    (blob) => blob.status === 'pending_media_slice'
  );
  const pendingAttachmentRows = new Map(
    plan.pendingMedia.attachments
      .filter((a) => a.status === 'pending_media_slice')
      .map((a) => [a.id, a])
  );

  const canonicalAttachments: CanonicalAttachment[] = [];
  const derivedBlobs = new Map<string, Set<'variant' | 'preview'>>();
  const attachmentsByBlob = new Map<string, string[]>();
  const finalStatus: MediaPlan['finalStatus'] = {
    media: new Map(),
    active_storage_blobs: new Map(),
    active_storage_attachments: new Map(),
    active_storage_variant_records: new Map(),
  };

  for (const row of sourceAttachments) {
    const id = row.id ?? '';
    const pending = pendingAttachmentRows.get(id);
    if (!pending) continue;
    const blobId = row.blob_id ?? '';
    const list = attachmentsByBlob.get(blobId) ?? [];
    list.push(id);
    attachmentsByBlob.set(blobId, list);
    const classification = classifyAttachment(
      row.record_type ?? '',
      row.name ?? ''
    );
    if (classification === null) {
      throw new Error(
        'Internal error: pending media attachment without a role (' + id + ')'
      );
    }
    if (classification.kind === 'derived') {
      const kinds = derivedBlobs.get(blobId) ?? new Set();
      kinds.add(classification.derived);
      derivedBlobs.set(blobId, kinds);
      finalStatus.active_storage_attachments.set(id, 'archived');
      archivedRows.push({
        table: 'active_storage_attachments',
        id,
        reason: 'derived_' + classification.derived,
        row,
      });
      continue;
    }

    const recordId = row.record_id ?? '';
    let ownerId: number | null;
    let sortKey = id;
    switch (classification.ownerType) {
      case 'story':
        ownerId = numeric(mediaRows.get(recordId)?.story_id);
        sortKey = recordId;
        break;
      case 'map_config':
        ownerId = pending.communityId;
        break;
      default:
        ownerId = numeric(recordId);
    }
    if (
      ownerId === null ||
      !(ownerSets[classification.ownerType]?.has(ownerId) ?? false)
    ) {
      throw new Error(
        'Internal error: media attachment owner is not a canonical row (' +
          id +
          ')'
      );
    }
    const accountUserId =
      pending.communityId === null && classification.ownerType === 'user'
        ? ownerId
        : null;
    if (pending.communityId === null && accountUserId === null) {
      throw new Error(
        'Internal error: null-community media attachment is not a user photo (' +
          id +
          ')'
      );
    }
    // Same allowlist and role/category rule the runtime upload path enforces
    // (MEDIA_MIME_RULES, ATTACHMENT_ROLE_ALLOWED_CATEGORIES): an attachment
    // the runtime would reject is archived with a warning, never imported.
    if (blobRows.has(blobId)) {
      const rule =
        MEDIA_MIME_RULES[
          normalizeMediaMimeType(blobRows.get(blobId)?.content_type ?? '')
        ];
      const allowed: readonly string[] =
        ATTACHMENT_ROLE_ALLOWED_CATEGORIES[classification.role];
      if (rule === undefined || !allowed.includes(rule.category)) {
        finalStatus.active_storage_attachments.set(id, 'archived');
        archivedRows.push({
          table: 'active_storage_attachments',
          id,
          reason: 'media_type_not_supported_runtime',
          row,
        });
        // Explicit, countable per content type: these are archived (not
        // lost); widening the runtime allowlist is tracked separately.
        warn(
          'media_type_not_supported_runtime',
          'active_storage_attachments',
          id
        );
        event(
          'media_type_not_supported_runtime:' +
            (normalizeMediaMimeType(blobRows.get(blobId)?.content_type ?? '') ||
              'unknown')
        );
        continue;
      }
    }
    canonicalAttachments.push({
      attachmentId: id,
      blobId,
      createdAt: row.created_at,
      ownerType: classification.ownerType,
      ownerId,
      role: classification.role,
      recordId,
      communityId: pending.communityId,
      accountUserId,
      sortKey,
    });
    finalStatus.active_storage_attachments.set(id, 'imported');
  }

  // ---- ordinals: deterministic rank inside (destination, owner, role) -----
  const groups = new Map<string, CanonicalAttachment[]>();
  for (const attachment of canonicalAttachments) {
    const key = [
      scopeOf(attachment),
      attachment.ownerType,
      attachment.ownerId,
      attachment.role,
    ].join('|');
    const list = groups.get(key) ?? [];
    list.push(attachment);
    groups.set(key, list);
  }
  const ordinals = new Map<string, number>();
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        compareIds(a.sortKey, b.sortKey) ||
        compareIds(a.attachmentId, b.attachmentId)
    );
    list.forEach((attachment, index) => {
      ordinals.set(attachment.attachmentId, index);
    });
    const first = list[0];
    if (
      first !== undefined &&
      list.length > 1 &&
      first.role !== 'story_media' &&
      first.role !== 'sponsor_logo'
    ) {
      warn(
        'multiple_single_slot_attachments',
        'active_storage_attachments',
        first.attachmentId
      );
    }
  }

  // ---- files: one per (blob, destination community / account) -------------
  const files: CanonicalRow[] = [];
  const copies: MediaCopyJob[] = [];
  const fileIdByDestination = new Map<string, string>();
  const blobFieldsArchived = new Set<string>();
  const destinationsByBlob = new Map<string, LedgerDestination[]>();
  const blobInfo = new Map(pendingBlobs.map((blob) => [blob.id, blob]));
  const orderedForFiles = [...canonicalAttachments].sort(
    (a, b) =>
      compareIds(a.blobId, b.blobId) ||
      compareIds(a.attachmentId, b.attachmentId)
  );
  for (const attachment of orderedForFiles) {
    const blob = blobInfo.get(attachment.blobId);
    const row = blobRows.get(attachment.blobId);
    if (!blob || !row || blob.sha256 === null) {
      throw new Error(
        'Internal error: attachment blob has no captured payload (' +
          attachment.attachmentId +
          ')'
      );
    }
    const scope = scopeOf(attachment);
    const destinationKey = attachment.blobId + '|' + scope;
    if (fileIdByDestination.has(destinationKey)) continue;
    const fileId = deterministicFileId(attachment.blobId, scope);
    fileIdByDestination.set(destinationKey, fileId);
    const storageKey =
      attachment.communityId !== null
        ? 'communities/' + attachment.communityId + '/media/' + fileId
        : 'users/' + String(attachment.accountUserId) + '/media/' + fileId;
    const byteSize = Number(blob.byteSize);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error('Internal error: blob byte size is invalid');
    }

    let originalName = row.filename ?? '';
    if (originalName.trim() === '') {
      originalName = 'upload';
      event('TRANSFORM_DEFAULT:files.original_name');
      warn('blob_filename_missing_defaulted', 'active_storage_blobs', blob.id);
    }
    let mimeType = normalizeMediaMimeType(row.content_type ?? '');
    if (mimeType === '') {
      mimeType = 'application/octet-stream';
      event('TRANSFORM_DEFAULT:files.mime_type');
      warn(
        'blob_content_type_missing_defaulted',
        'active_storage_blobs',
        blob.id
      );
    }
    let metadata: string | null = null;
    if (row.metadata !== null && row.metadata !== undefined) {
      try {
        const parsed: unknown = JSON.parse(row.metadata);
        if (parsed !== null && typeof parsed === 'object') {
          metadata = JSON.stringify(parsed);
        }
      } catch {
        // kept verbatim in the archive below
      }
      if (metadata === null && !blobFieldsArchived.has(blob.id)) {
        warn(
          'blob_metadata_not_json_archived',
          'active_storage_blobs',
          blob.id
        );
        archivedFields.push({
          table: 'active_storage_blobs',
          id: blob.id,
          column: 'metadata',
          disposition: 'ARCHIVE',
          value: row.metadata,
        });
      }
    }
    const stamp = parseTimestamp(row.created_at);
    if (!blobFieldsArchived.has(blob.id)) {
      if (stamp === null) {
        warn(
          'blob_created_at_invalid_defaulted',
          'active_storage_blobs',
          blob.id
        );
      } else if (stamp.subMillisecond) {
        // Keep the original when millisecond storage loses precision.
        archivedFields.push({
          table: 'active_storage_blobs',
          id: blob.id,
          column: 'created_at',
          disposition: 'ARCHIVE',
          value: row.created_at ?? '',
        });
        event('active_storage_blobs.created_at:sub_millisecond_archived');
      }
      // A blob shared by several destinations is archived once, not per file.
      blobFieldsArchived.add(blob.id);
    }
    const createdMs = stamp?.ms ?? 0;
    files.push({
      id: fileId,
      filename: fileId,
      original_name: originalName,
      path: storageKey,
      storage_key: storageKey,
      url: '/v2/media/' + fileId,
      mime_type: mimeType,
      size: byteSize,
      byte_size: byteSize,
      checksum: blob.sha256,
      community_id: attachment.communityId,
      uploaded_by: null,
      metadata,
      cultural_restrictions: null,
      is_active: 1,
      created_at: createdMs,
      updated_at: createdMs,
    });
    const destination: LedgerDestination = {
      fileId,
      communityId: attachment.communityId,
      accountUserId: attachment.accountUserId,
      storageKey,
      path: MEDIA_DIRECTORY + '/' + storageKey,
    };
    const list = destinationsByBlob.get(attachment.blobId) ?? [];
    list.push(destination);
    destinationsByBlob.set(attachment.blobId, list);
    copies.push({
      blobId: attachment.blobId,
      sourceKey: blob.key,
      sha256: blob.sha256,
      byteSize,
      path: destination.path,
    });
  }
  files.sort((a, b) => (a.id as string).localeCompare(b.id as string));

  // ---- attachments --------------------------------------------------------
  const staticMaps = new Map<number, string>();
  const attachments: CanonicalRow[] = [];
  let attachmentSequenceFloor = 0;
  for (const row of sourceAttachments) {
    const id = numeric(row.id);
    if (id !== null && id > attachmentSequenceFloor)
      attachmentSequenceFloor = id;
  }
  const attachmentById = new Map(
    canonicalAttachments.map((a) => [a.attachmentId, a])
  );
  for (const attachment of canonicalAttachments) {
    const fileId = fileIdByDestination.get(
      attachment.blobId + '|' + scopeOf(attachment)
    );
    if (fileId === undefined) {
      throw new Error('Internal error: attachment file was not created');
    }
    const ordinal = ordinals.get(attachment.attachmentId) ?? 0;
    const stamp = parseTimestamp(attachment.createdAt);
    if (stamp === null) {
      warn(
        'attachment_created_at_invalid_defaulted',
        'active_storage_attachments',
        attachment.attachmentId
      );
    } else if (stamp.subMillisecond) {
      archivedFields.push({
        table: 'active_storage_attachments',
        id: attachment.attachmentId,
        column: 'created_at',
        disposition: 'ARCHIVE',
        value: attachment.createdAt ?? '',
      });
      event('active_storage_attachments.created_at:sub_millisecond_archived');
    }
    attachments.push({
      id: Number(attachment.attachmentId),
      community_id: attachment.communityId,
      file_id: fileId,
      owner_type: attachment.ownerType,
      owner_id: attachment.ownerId,
      role: attachment.role,
      ordinal,
      created_at: stamp?.ms ?? 0,
    });
    if (attachment.role === 'static_map' && ordinal === 0) {
      staticMaps.set(attachment.ownerId, fileId);
    }
  }
  attachments.sort((a, b) => (a.id as number) - (b.id as number));

  // ---- blob ledger and dispositions ---------------------------------------
  const ledger: BlobLedgerEntry[] = [];
  const archiveCopies: MediaCopyJob[] = [];
  const blobCounts: Record<BlobDisposition, number> = {
    canonical: 0,
    archive: 0,
    not_selected: 0,
  };
  const ledgerAttachments = (blobId: string): LedgerAttachment[] =>
    (attachmentsByBlob.get(blobId) ?? [])
      .map((attachmentId) => {
        const imported = attachmentById.get(attachmentId);
        return {
          id: attachmentId,
          status: imported ? ('imported' as const) : ('archived' as const),
          fileId: imported
            ? (fileIdByDestination.get(blobId + '|' + scopeOf(imported)) ??
              null)
            : null,
        };
      })
      .sort((a, b) => compareIds(a.id, b.id));

  for (const blob of plan.pendingMedia.blobs) {
    if (blob.status !== 'pending_media_slice') {
      blobCounts.not_selected += 1;
      ledger.push({
        blobId: blob.id,
        sourceKey: blob.key,
        byteSize: blob.byteSize,
        sha256: blob.sha256,
        disposition: 'not_selected',
        destinations: [],
        attachments: [],
      });
      continue;
    }
    const row = blobRows.get(blob.id);
    const destinations = (destinationsByBlob.get(blob.id) ?? []).sort((a, b) =>
      a.storageKey.localeCompare(b.storageKey)
    );
    if (row) {
      for (const column of ['key', 'service_name', 'checksum'] as const) {
        const value = row[column];
        if (value !== null && value !== undefined) {
          archivedFields.push({
            table: 'active_storage_blobs',
            id: blob.id,
            column,
            disposition: 'ARCHIVE',
            value,
          });
        }
      }
    }
    if (destinations.length > 0) {
      blobCounts.canonical += 1;
      finalStatus.active_storage_blobs.set(blob.id, 'imported');
      ledger.push({
        blobId: blob.id,
        sourceKey: blob.key,
        byteSize: blob.byteSize,
        sha256: blob.sha256,
        disposition: 'canonical',
        destinations,
        attachments: ledgerAttachments(blob.id),
      });
      continue;
    }
    const kinds = derivedBlobs.get(blob.id);
    const reason: ArchiveReason = kinds?.has('variant')
      ? 'derived_variant'
      : kinds?.has('preview')
        ? 'derived_preview'
        : (attachmentsByBlob.get(blob.id) ?? []).length === 0
          ? 'orphan'
          : 'no_accepted_attachment';
    if (blob.sha256 === null) {
      throw new Error('Internal error: archived blob has no captured payload');
    }
    blobCounts.archive += 1;
    finalStatus.active_storage_blobs.set(blob.id, 'archived');
    const archiveObject = ARCHIVE_MEDIA_DIRECTORY + '/' + blob.key;
    archiveCopies.push({
      blobId: blob.id,
      sourceKey: blob.key,
      sha256: blob.sha256,
      byteSize: Number(blob.byteSize),
      path: archiveObject,
    });
    if (row) {
      archivedRows.push({
        table: 'active_storage_blobs',
        id: blob.id,
        reason,
        row,
      });
    }
    if (reason === 'orphan') {
      warn('orphan_blob_archived', 'active_storage_blobs', blob.id);
    }
    ledger.push({
      blobId: blob.id,
      sourceKey: blob.key,
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      disposition: 'archive',
      archiveReason: reason,
      archiveObject,
      destinations: [],
      attachments: ledgerAttachments(blob.id),
    });
  }
  ledger.sort((a, b) => compareIds(a.blobId, b.blobId));
  copies.push(...archiveCopies);
  copies.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // ---- media rows and variant records -------------------------------------
  const storyMediaRecords = new Set(
    canonicalAttachments
      .filter((a) => a.role === 'story_media')
      .map((a) => a.recordId)
  );
  for (const id of plan.pendingMedia.mediaIds) {
    const row = mediaRows.get(id);
    if (storyMediaRecords.has(id)) {
      finalStatus.media.set(id, 'imported');
      for (const column of ['created_at', 'updated_at'] as const) {
        const value = row?.[column];
        if (value !== null && value !== undefined) {
          archivedFields.push({
            table: 'media',
            id,
            column,
            disposition: 'ARCHIVE',
            value,
          });
        }
      }
    } else {
      finalStatus.media.set(id, 'archived');
      warn('media_without_attachment_archived', 'media', id);
      if (row) {
        archivedRows.push({
          table: 'media',
          id,
          reason: 'media_without_attachment',
          row,
        });
      }
    }
  }
  for (const id of plan.pendingMedia.variantIds) {
    finalStatus.active_storage_variant_records.set(id, 'archived');
    const row = variantRows.get(id);
    if (row) {
      archivedRows.push({
        table: 'active_storage_variant_records',
        id,
        reason: 'variant_regenerated',
        row,
      });
    }
  }

  // ---- hard gate: exactly one disposition per source blob (10.4/10.5) -----
  const seen = new Set<string>();
  for (const entry of ledger) {
    if (seen.has(entry.blobId)) {
      throw new Error(
        'Media ledger lists a blob twice (blob id ' + entry.blobId + ')'
      );
    }
    seen.add(entry.blobId);
  }
  for (const blob of bundle.manifest.blobs) {
    if (!seen.has(blob.id)) {
      throw new Error(
        'Media ledger is missing a source blob (blob id ' + blob.id + ')'
      );
    }
  }
  const ledgerByBlob = new Map(ledger.map((entry) => [entry.blobId, entry]));
  for (const blob of pendingBlobs) {
    const entry = ledgerByBlob.get(blob.id);
    if (!entry || entry.disposition === 'not_selected') {
      throw new Error(
        'Media ledger lost a pending blob (blob id ' + blob.id + ')'
      );
    }
  }

  let bytes = 0;
  for (const copy of copies) bytes += copy.byteSize;
  archivedRows.sort((a, b) =>
    a.table === b.table ? compareIds(a.id, b.id) : a.table < b.table ? -1 : 1
  );
  return {
    files,
    attachments,
    staticMaps,
    copies,
    ledger,
    finalStatus,
    archivedRows,
    archivedFields,
    warnings,
    events,
    attachmentSequenceFloor,
    counts: {
      blobs: blobCounts,
      files: files.length,
      attachments: attachments.length,
      objects: copies.length,
      bytes,
    },
  };
}

export async function sha256OfFile(path: string): Promise<{
  sha256: string;
  size: number;
}> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    size += buffer.length;
  }
  return { sha256: hash.digest('hex'), size };
}

export interface WriteMediaOptions {
  /** Test seam: runs after the bytes are written and before read-back. */
  afterWrite?: (path: string, job: MediaCopyJob) => Promise<void>;
}

async function copyVerified(
  source: string,
  destination: string,
  job: MediaCopyJob,
  options: WriteMediaOptions
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  );
  if (hash.digest('hex') !== job.sha256 || size !== job.byteSize) {
    throw new Error(
      'Media source changed while copying (blob id ' + job.blobId + ')'
    );
  }
  await fsyncPath(destination);
  if (options.afterWrite) await options.afterWrite(destination, job);
  const written = await sha256OfFile(destination);
  const info = await stat(destination);
  if (
    written.sha256 !== job.sha256 ||
    written.size !== job.byteSize ||
    info.size !== job.byteSize
  ) {
    throw new Error(
      'Media write verification failed (blob id ' + job.blobId + ')'
    );
  }
}

/**
 * Copy every planned object into outputRoot, verifying SHA-256 while writing
 * and again after an fsync. Throws on the first mismatch; the caller discards
 * the whole (temporary) output directory.
 */
export async function writeMediaObjects(
  bundleDir: string,
  outputRoot: string,
  plan: MediaPlan,
  options: WriteMediaOptions = {}
): Promise<void> {
  await mkdir(join(outputRoot, MEDIA_DIRECTORY), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(outputRoot, ARCHIVE_MEDIA_DIRECTORY), {
    recursive: true,
    mode: 0o700,
  });
  for (const job of plan.copies) {
    await copyVerified(
      join(bundleDir, 'blobs', job.sourceKey),
      join(outputRoot, job.path),
      job,
      options
    );
  }
}
