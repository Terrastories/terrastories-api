/**
 * Canonical V2 media upload, file metadata, and attachment contracts (§5, §6.7, §9).
 */

import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type/core';
import {
  ATTACHMENT_OWNER_TYPES,
  ATTACHMENT_ROLES,
  type AttachmentOwnerType,
  type AttachmentRole,
} from '../../db/schema/attachments.js';
import { makeDatabaseIdSchema } from './community-writes.js';

/** Workers Free per-request upload ceiling (SPEC-V2 §5). */
export const MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB
/** TIFF/HEIC photos are larger than web-ready images; download-only. */
export const MAX_DOWNLOAD_IMAGE_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAGIC_SNIFF_BYTES = 8192;
export const MAX_REORDER_ATTACHMENTS = 100;
export const MAX_METADATA_JSON_LENGTH = 4096;

/**
 * - `image`: browser-renderable raster image.
 * - `image_download`: image format browsers cannot render (TIFF, HEIC); clients
 *   show a download card. Never inline-rendered.
 * - `document`: PDF / DOCX; download card only.
 */
export type MediaCategory =
  | 'image'
  | 'image_download'
  | 'document'
  | 'audio'
  | 'video';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface MediaMimeRule {
  category: MediaCategory;
  extensions: readonly string[];
  maxBytes: number;
}

export const MEDIA_MIME_RULES: Readonly<Record<string, MediaMimeRule>> = {
  'image/jpeg': {
    category: 'image',
    extensions: ['jpg', 'jpeg'],
    maxBytes: MAX_IMAGE_UPLOAD_BYTES,
  },
  'image/png': {
    category: 'image',
    extensions: ['png'],
    maxBytes: MAX_IMAGE_UPLOAD_BYTES,
  },
  'image/webp': {
    category: 'image',
    extensions: ['webp'],
    maxBytes: MAX_IMAGE_UPLOAD_BYTES,
  },
  'image/gif': {
    category: 'image',
    extensions: ['gif'],
    maxBytes: MAX_IMAGE_UPLOAD_BYTES,
  },
  'image/tiff': {
    category: 'image_download',
    extensions: ['tif', 'tiff'],
    maxBytes: MAX_DOWNLOAD_IMAGE_UPLOAD_BYTES,
  },
  'image/heic': {
    category: 'image_download',
    extensions: ['heic', 'heif'],
    maxBytes: MAX_DOWNLOAD_IMAGE_UPLOAD_BYTES,
  },
  'application/pdf': {
    category: 'document',
    extensions: ['pdf'],
    maxBytes: MAX_DOCUMENT_UPLOAD_BYTES,
  },
  [DOCX_MIME]: {
    category: 'document',
    extensions: ['docx'],
    maxBytes: MAX_DOCUMENT_UPLOAD_BYTES,
  },
  'audio/aac': {
    category: 'audio',
    extensions: ['aac', 'adts'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'audio/mpeg': {
    category: 'audio',
    extensions: ['mp3'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'audio/wav': {
    category: 'audio',
    extensions: ['wav'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'audio/ogg': {
    category: 'audio',
    extensions: ['ogg', 'oga'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'audio/mp4': {
    category: 'audio',
    extensions: ['m4a', 'mp4'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'audio/webm': {
    category: 'audio',
    extensions: ['weba', 'webm'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'audio/flac': {
    category: 'audio',
    extensions: ['flac'],
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
  },
  'video/mp4': {
    category: 'video',
    extensions: ['mp4', 'm4v'],
    maxBytes: MAX_VIDEO_UPLOAD_BYTES,
  },
  'video/webm': {
    category: 'video',
    extensions: ['webm'],
    maxBytes: MAX_VIDEO_UPLOAD_BYTES,
  },
  'video/ogg': {
    category: 'video',
    extensions: ['ogv'],
    maxBytes: MAX_VIDEO_UPLOAD_BYTES,
  },
  'video/quicktime': {
    category: 'video',
    extensions: ['mov'],
    maxBytes: MAX_VIDEO_UPLOAD_BYTES,
  },
};

const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-flac': 'audio/flac',
  'video/x-m4v': 'video/mp4',
  'audio/vnd.dlna.adts': 'audio/aac',
  'audio/x-aac': 'audio/aac',
  'audio/aacp': 'audio/aac',
  'image/tif': 'image/tiff',
  'image/heif': 'image/heic',
  'image/heic-sequence': 'image/heic',
  'image/heif-sequence': 'image/heic',
};

const ASCII = (s: string): number[] => Array.from(s, (ch) => ch.charCodeAt(0));

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const HEIC_BRANDS: readonly string[] = [
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
];

function ascii4(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/** Major or compatible brand must be an HEVC-image brand (mif1/msf1 alone are AVIF-capable). */
function sniffHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || !startsWith(bytes, ASCII('ftyp'), 4)) return false;
  if (HEIC_BRANDS.includes(ascii4(bytes, 8))) return true;
  const boxSize = Math.min(
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>>
      0,
    bytes.length
  );
  for (let i = 16; i + 4 <= boxSize; i += 4) {
    if (HEIC_BRANDS.includes(ascii4(bytes, i))) return true;
  }
  return false;
}

/**
 * Walks ZIP local file headers inside the window and returns the entry names
 * that are fully visible. Stops at the first entry it cannot step over
 * (data descriptor, truncated window, bad signature).
 */
function zipLocalEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
    const flags = view.getUint16(pos + 6, true);
    const compressedSize = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const nameEnd = pos + 30 + nameLen;
    if (nameEnd > bytes.length) break;
    names.push(new TextDecoder().decode(bytes.subarray(pos + 30, nameEnd)));
    if ((flags & 0x08) !== 0) break; // sizes follow the data; cannot skip
    pos = nameEnd + extraLen + compressedSize;
  }
  return names;
}

function sniffDocx(bytes: Uint8Array): boolean {
  const names = zipLocalEntryNames(bytes);
  if (names.some((n) => n.startsWith('xl/') || n.startsWith('ppt/'))) {
    return false;
  }
  return names.some(
    (n) => n === '[Content_Types].xml' || n.startsWith('word/')
  );
}

interface AdtsHeader {
  frameLength: number;
}

function parseAdtsHeader(bytes: Uint8Array, at: number): AdtsHeader | null {
  if (at + 7 > bytes.length) return null;
  if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xf6) !== 0xf0) return null;
  const protectionAbsent = (bytes[at + 1]! & 0x01) === 1;
  const samplingIndex = (bytes[at + 2]! >> 2) & 0x0f;
  if (samplingIndex > 12) return null;
  const frameLength =
    ((bytes[at + 3]! & 0x03) << 11) |
    (bytes[at + 4]! << 3) |
    (bytes[at + 5]! >> 5);
  if (frameLength < (protectionAbsent ? 7 : 9)) return null;
  return { frameLength };
}

/**
 * ADTS: sync 0xFFF, layer 00, valid sampling index, sane frame length. When a
 * second frame fits in the window it must also be a valid ADTS header.
 */
function sniffAdts(bytes: Uint8Array): boolean {
  const first = parseAdtsHeader(bytes, 0);
  if (!first) return false;
  const next = first.frameLength;
  if (next === bytes.length) return true;
  if (next + 7 > bytes.length) return true; // second header outside the window
  return parseAdtsHeader(bytes, next) !== null;
}

/**
 * Deterministic magic-byte sniffers for the document / download-only /
 * ADTS types (decided on the 8 KiB header window).
 */
function sniffExtraType(bytes: Uint8Array, mime: string): boolean {
  switch (mime) {
    case 'image/tiff':
      // II*\0 (little endian) or MM\0* (big endian).
      return (
        startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
        startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
      );
    case 'image/heic':
      return sniffHeic(bytes);
    case 'application/pdf':
      return startsWith(bytes, ASCII('%PDF-'));
    case DOCX_MIME:
      return sniffDocx(bytes);
    case 'audio/aac':
      return sniffAdts(bytes);
    default:
      return false;
  }
}

const EXTRA_SNIFFED_MIMES: ReadonlySet<string> = new Set([
  'image/tiff',
  'image/heic',
  'application/pdf',
  DOCX_MIME,
  'audio/aac',
]);

/**
 * Whether a browser can render this stored MIME type inline (e.g. in `img`).
 * False for tiff/heic and documents: clients show a download card instead.
 * Note: the API itself always serves media as an attachment.
 */
export function isBrowserRenderableMime(mime: string): boolean {
  const category = MEDIA_MIME_RULES[normalizeMediaMimeType(mime)]?.category;
  return category === 'image' || category === 'audio' || category === 'video';
}

export function normalizeMediaMimeType(raw: string | undefined): string {
  if (!raw) return '';
  const base = raw.split(';', 1)[0]!.trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

export function extractFilenameExtension(filename: string): string {
  const clean = sanitizeUploadOriginalName(filename);
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/**
 * Strips directory components (both POSIX `/` and Windows `\`), traversal
 * tokens, and control characters from client-supplied filenames so persisted
 * display names are safe metadata only (never used in `storageKey`).
 */
export function sanitizeUploadOriginalName(raw: string): string {
  const withoutNulls = raw.replace(/\0/g, '');
  const segments = withoutNulls.split(/[/\\]/);
  let base = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments[i]!.trim();
    if (candidate && candidate !== '.' && candidate !== '..') {
      base = candidate;
      break;
    }
  }
  const stripped = base
    .replace(/\.\.+/g, '.')
    .replace(/[^A-Za-z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  if (!stripped || stripped === '.' || stripped === '..') {
    return 'upload';
  }
  return stripped.replace(/^\.+/, '') || 'upload';
}

export async function validateMediaHeaderBytes(input: {
  headerBytes: Uint8Array;
  declaredMime: string;
  filename: string;
}): Promise<
  | { ok: true; mimeType: string; rule: MediaMimeRule; originalName: string }
  | { ok: false; message: string }
> {
  const declared = normalizeMediaMimeType(input.declaredMime);
  const declaredRule = MEDIA_MIME_RULES[declared];
  if (!declaredRule) {
    return { ok: false, message: 'Unsupported media Content-Type' };
  }

  const originalName = sanitizeUploadOriginalName(input.filename);
  const ext = extractFilenameExtension(originalName);
  if (!ext || !declaredRule.extensions.includes(ext)) {
    return {
      ok: false,
      message: 'Filename extension does not match Content-Type',
    };
  }

  if (EXTRA_SNIFFED_MIMES.has(declared)) {
    if (!sniffExtraType(input.headerBytes, declared)) {
      return {
        ok: false,
        message: 'File signature does not match declared Content-Type',
      };
    }
    return { ok: true, mimeType: declared, rule: declaredRule, originalName };
  }

  const sniffed = await fileTypeFromBuffer(input.headerBytes);
  if (!sniffed) {
    return {
      ok: false,
      message: 'Unable to verify file signature from bytes',
    };
  }
  const detectedMime = normalizeMediaMimeType(sniffed.mime);
  // Some MP4 audio/video containers share ftyp signatures (m4a -> audio/mp4 vs video/mp4).
  const isContainerAudioMatch =
    (declared === 'audio/mp4' && detectedMime === 'video/mp4') ||
    (declared === 'audio/webm' && detectedMime === 'video/webm') ||
    (declared === 'audio/ogg' && detectedMime === 'video/ogg');

  if (detectedMime !== declared && !isContainerAudioMatch) {
    return {
      ok: false,
      message: 'File signature does not match declared Content-Type',
    };
  }

  return {
    ok: true,
    mimeType: declared,
    rule: declaredRule,
    originalName,
  };
}

export const ATTACHMENT_ROLE_TO_OWNER_TYPE: Readonly<
  Record<AttachmentRole, AttachmentOwnerType>
> = {
  story_media: 'story',
  place_photo: 'place',
  place_name_audio: 'place',
  speaker_photo: 'speaker',
  user_photo: 'user',
  community_display_image: 'community',
  community_background_image: 'community',
  sponsor_logo: 'community',
  static_map: 'map_config',
};

export const ATTACHMENT_ROLE_ALLOWED_CATEGORIES: Readonly<
  Record<AttachmentRole, readonly MediaCategory[]>
> = {
  story_media: ['image', 'image_download', 'document', 'audio', 'video'],
  // TIFF/HEIC place photos exist in legacy Rails data; served download-only.
  place_photo: ['image', 'image_download'],
  place_name_audio: ['audio'],
  speaker_photo: ['image'],
  user_photo: ['image'],
  community_display_image: ['image'],
  community_background_image: ['image'],
  sponsor_logo: ['image'],
  static_map: ['image'],
};

export const REORDERABLE_ATTACHMENT_ROLES = [
  'story_media',
  'sponsor_logo',
  'place_photo',
] as const;

/** Query parameters accepted by the raw-body `POST /v2/media` upload (#249). */
export const ALLOWED_UPLOAD_FIELDS = new Set([
  'filename',
  'role',
  'ownerType',
  'ownerId',
  'metadata',
]);

export const MediaFileMetadataSchema = z
  .object({
    id: z.string().uuid(),
    originalName: z.string(),
    mimeType: z.string(),
    byteSize: z.number().int().nonnegative(),
    checksum: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    url: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type MediaFileMetadata = z.infer<typeof MediaFileMetadataSchema>;

export const MediaMetadataResponseSchema = z
  .object({
    data: MediaFileMetadataSchema,
  })
  .strict();

export type MediaMetadataResponse = z.infer<typeof MediaMetadataResponseSchema>;

export const AttachmentRecordSchema = z
  .object({
    id: z.number().int().positive(),
    fileId: z.string().uuid(),
    ownerType: z.enum(ATTACHMENT_OWNER_TYPES),
    ownerId: z.number().int().positive(),
    role: z.enum(ATTACHMENT_ROLES),
    ordinal: z.number().int().nonnegative(),
    url: z.string(),
    mimeType: z.string(),
    byteSize: z.number().int().nonnegative(),
    originalName: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type AttachmentRecordResponse = z.infer<typeof AttachmentRecordSchema>;

export const MediaUploadResponseSchema = z
  .object({
    data: MediaFileMetadataSchema.extend({
      attachment: AttachmentRecordSchema.nullable(),
    }).strict(),
  })
  .strict();

export type MediaUploadResponse = z.infer<typeof MediaUploadResponseSchema>;

export const CreateAttachmentRequestSchema = z
  .object({
    fileId: z.string().uuid(),
    ownerType: z.enum(ATTACHMENT_OWNER_TYPES),
    ownerId: makeDatabaseIdSchema('ownerId'),
    role: z.enum(ATTACHMENT_ROLES),
    ordinal: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (ATTACHMENT_ROLE_TO_OWNER_TYPE[value.role] !== value.ownerType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'Attachment role does not match ownerType',
      });
    }
  });

export type CreateAttachmentRequest = z.infer<
  typeof CreateAttachmentRequestSchema
>;

export const ReorderAttachmentsRequestSchema = z
  .object({
    ownerType: z.enum(ATTACHMENT_OWNER_TYPES),
    ownerId: makeDatabaseIdSchema('ownerId'),
    role: z.enum(REORDERABLE_ATTACHMENT_ROLES),
    attachmentIds: z
      .array(makeDatabaseIdSchema('attachmentId'))
      .min(1, 'At least one attachmentId is required')
      .max(MAX_REORDER_ATTACHMENTS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (ATTACHMENT_ROLE_TO_OWNER_TYPE[value.role] !== value.ownerType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['role'],
        message: 'Attachment role does not match ownerType',
      });
    }
    const seen = new Set<number>();
    for (let i = 0; i < value.attachmentIds.length; i++) {
      const id = value.attachmentIds[i]!;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachmentIds', i],
          message: 'Duplicate attachmentId is not allowed',
        });
      }
      seen.add(id);
    }
  });

export type ReorderAttachmentsRequest = z.infer<
  typeof ReorderAttachmentsRequestSchema
>;

export const AttachmentResponseSchema = z
  .object({
    data: AttachmentRecordSchema,
  })
  .strict();

export const AttachmentListResponseSchema = z
  .object({
    data: z.array(AttachmentRecordSchema),
  })
  .strict();
