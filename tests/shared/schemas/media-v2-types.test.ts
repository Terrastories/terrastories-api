/**
 * Rails-parity media types (tiff, heic, pdf, docx, aac): allowlist, aliases,
 * magic-byte sniffing, categories, and role rules.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_ROLE_ALLOWED_CATEGORIES,
  DOCX_MIME,
  MEDIA_MIME_RULES,
  normalizeMediaMimeType,
  validateMediaHeaderBytes,
} from '../../../src/shared/schemas/media-v2.js';

const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const pad = (b: number[], n = 64) =>
  Uint8Array.from([...b, ...new Array(Math.max(0, n - b.length)).fill(0)]);

const TIFF_LE = pad([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
const TIFF_BE = pad([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
const HEIC = pad([0, 0, 0, 24, ...enc('ftyp'), ...enc('heic'), 0, 0, 0, 0]);
const HEIC_COMPAT = pad([
  0,
  0,
  0,
  24,
  ...enc('ftyp'),
  ...enc('abcd'),
  0,
  0,
  0,
  0,
  ...enc('mif1'),
]);
const MP4_NOT_HEIC = pad([
  0,
  0,
  0,
  24,
  ...enc('ftyp'),
  ...enc('isom'),
  0,
  0,
  0,
  0,
]);
const PDF = pad(enc('%PDF-1.7\n'));
const DOCX = pad([
  0x50,
  0x4b,
  0x03,
  0x04,
  20,
  0,
  0,
  0,
  8,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  19,
  0,
  0,
  0,
  ...enc('[Content_Types].xml'),
]);
const XLSX = pad([
  0x50,
  0x4b,
  0x03,
  0x04,
  20,
  0,
  0,
  0,
  8,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  11,
  0,
  0,
  0,
  ...enc('xl/workbook'),
]);
const ADTS = pad([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]);
const MP3_FRAME = pad([0xff, 0xfb, 0x90, 0x00]);

async function check(
  declaredMime: string,
  filename: string,
  bytes: Uint8Array
) {
  return validateMediaHeaderBytes({
    headerBytes: bytes,
    declaredMime,
    filename,
  });
}

describe('Rails-parity media types', () => {
  it('registers rules with categories and caps', () => {
    expect(MEDIA_MIME_RULES['image/tiff']?.category).toBe('image_download');
    expect(MEDIA_MIME_RULES['image/heic']?.category).toBe('image_download');
    expect(MEDIA_MIME_RULES['application/pdf']?.category).toBe('document');
    expect(MEDIA_MIME_RULES[DOCX_MIME]?.category).toBe('document');
    expect(MEDIA_MIME_RULES['audio/aac']?.category).toBe('audio');
  });

  it('normalizes aliases', () => {
    expect(normalizeMediaMimeType('audio/vnd.dlna.adts')).toBe('audio/aac');
    expect(normalizeMediaMimeType('audio/x-aac')).toBe('audio/aac');
    expect(normalizeMediaMimeType('image/tif')).toBe('image/tiff');
    expect(normalizeMediaMimeType('image/heif')).toBe('image/heic');
  });

  it.each([
    ['image/tiff', 'a.tif', TIFF_LE],
    ['image/tiff', 'a.tiff', TIFF_BE],
    ['image/heic', 'a.heic', HEIC],
    ['image/heic', 'a.heic', HEIC_COMPAT],
    ['application/pdf', 'a.pdf', PDF],
    [DOCX_MIME, 'a.docx', DOCX],
    ['audio/aac', 'a.aac', ADTS],
    ['audio/vnd.dlna.adts', 'a.aac', ADTS],
  ])('accepts %s (%s)', async (mime, name, bytes) => {
    const r = await check(mime, name, bytes);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['image/tiff', 'a.tif', PDF],
    ['image/heic', 'a.heic', MP4_NOT_HEIC],
    ['application/pdf', 'a.pdf', TIFF_LE],
    [DOCX_MIME, 'a.docx', PDF],
    [DOCX_MIME, 'a.docx', XLSX],
    ['audio/aac', 'a.aac', MP3_FRAME],
    ['application/pdf', 'a.docx', PDF],
    ['application/pdf', 'a.pdf', new TextEncoder().encode('<html>x</html>')],
  ])(
    'rejects %s (%s) on bad signature or extension',
    async (mime, name, bytes) => {
      const r = await check(mime, name, bytes);
      expect(r.ok).toBe(false);
    }
  );

  it('keeps document and download-only types off renderable-image roles', () => {
    const roles = ATTACHMENT_ROLE_ALLOWED_CATEGORIES;
    expect(roles.story_media).toEqual(
      expect.arrayContaining(['document', 'image_download'])
    );
    expect(roles.place_photo).toContain('image_download');
    expect(roles.place_photo).not.toContain('document');
    for (const r of [
      'speaker_photo',
      'user_photo',
      'community_display_image',
      'community_background_image',
      'sponsor_logo',
      'static_map',
    ] as const) {
      expect(roles[r]).toEqual(['image']);
    }
    expect(roles.place_name_audio).toEqual(['audio']);
  });
});
