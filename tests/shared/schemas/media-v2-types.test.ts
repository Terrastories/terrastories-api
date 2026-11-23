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
  ...enc('heix'),
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
/** ZIP local file header + stored (empty) entries with the given names. */
const zip = (names: string[]) => {
  const out: number[] = [];
  for (const name of names) {
    out.push(0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    out.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // crc, sizes = 0
    out.push(name.length, 0, 0, 0, ...enc(name));
  }
  return pad(out, 256);
};
const DOCX = zip(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
const DOCX_WORD_ONLY = zip(['word/document.xml']);
const XLSX = zip(['[Content_Types].xml', 'xl/workbook.xml']);
const PPTX = zip(['[Content_Types].xml', 'ppt/presentation.xml']);
const PLAIN_ZIP = zip(['readme.txt']);
// ADTS frame: sync FFF1, 44.1 kHz (index 4), stereo, frameLength 16.
const adtsFrame = (len = 16, sfIndex = 4) => {
  const f = new Array<number>(len).fill(0);
  f[0] = 0xff;
  f[1] = 0xf1;
  f[2] = 0x40 | (sfIndex << 2);
  f[3] = 0x80 | ((len >> 11) & 3);
  f[4] = (len >> 3) & 0xff;
  f[5] = ((len & 7) << 5) | 0x1f;
  f[6] = 0xfc;
  return f;
};
const ADTS = Uint8Array.from([...adtsFrame(), ...adtsFrame(), ...adtsFrame()]);
const ADTS_BAD_SECOND = Uint8Array.from([
  ...adtsFrame(),
  ...new Array(40).fill(0x11),
]);
const ADTS_BAD_SF = Uint8Array.from([
  ...adtsFrame(16, 15),
  ...adtsFrame(16, 15),
]);
const ADTS_TINY_LEN = Uint8Array.from([
  ...adtsFrame(4),
  ...new Array(40).fill(0),
]);
const HEIC_MIF1_ONLY = pad([
  0,
  0,
  0,
  24,
  ...enc('ftyp'),
  ...enc('mif1'),
  0,
  0,
  0,
  0,
  ...enc('msf1'),
]);
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
    [DOCX_MIME, 'a.docx', DOCX_WORD_ONLY],
    ['audio/aac', 'a.aac', ADTS],
    ['audio/aac', 'a.aac', ADTS.subarray(0, 10)],
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
    [DOCX_MIME, 'a.docx', PPTX],
    [DOCX_MIME, 'a.docx', PLAIN_ZIP],
    ['image/heic', 'a.heic', HEIC_MIF1_ONLY],
    ['audio/aac', 'a.aac', ADTS_BAD_SECOND],
    ['audio/aac', 'a.aac', ADTS_BAD_SF],
    ['audio/aac', 'a.aac', ADTS_TINY_LEN],
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
