import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { StreamingSha256 } from '../../src/shared/utils/sha256-stream.js';
import { extractMultipartBoundary } from '../../src/shared/utils/multipart-stream.js';
import { sanitizeUploadOriginalName } from '../../src/shared/schemas/media-v2.js';

describe('StreamingSha256', () => {
  it('matches Node crypto sha256 across empty, small, block-boundary, and fragmented chunks', () => {
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 128, 1024, 65_541];
    for (const length of lengths) {
      const payload = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        payload[i] = (i * 131 + 17) & 0xff;
      }
      const expected = createHash('sha256').update(payload).digest('hex');

      const singleShot = new StreamingSha256().update(payload).digestHex();
      expect(singleShot).toBe(expected);

      const fragmented = new StreamingSha256();
      for (let pos = 0; pos < payload.byteLength; ) {
        const step = ((pos % 19) + 1) | 0;
        fragmented.update(payload.subarray(pos, pos + step));
        pos += step;
      }
      expect(fragmented.digestHex()).toBe(expected);
      expect(fragmented.digestHex()).toBe(expected);
    }
  });
});

describe('Streaming multipart parser & filename sanitizer', () => {
  it('extracts quoted and unquoted multipart boundaries cleanly', () => {
    expect(
      extractMultipartBoundary('multipart/form-data; boundary=---abc123')
    ).toBe('---abc123');
    expect(
      extractMultipartBoundary(
        'multipart/form-data; charset=utf-8; boundary="quotedBoundary"'
      )
    ).toBe('quotedBoundary');
    expect(extractMultipartBoundary('application/json')).toBeNull();
    expect(extractMultipartBoundary('multipart/form-data')).toBeNull();
  });

  it('neutralizes path traversal and null bytes in client filenames', () => {
    expect(sanitizeUploadOriginalName('../../etc/passwd')).toBe('passwd');
    expect(
      sanitizeUploadOriginalName('C:\\Users\\evil\\..\\..\\secret.png\0')
    ).toBe('secret.png');
    expect(sanitizeUploadOriginalName('...')).toBe('upload');
    expect(sanitizeUploadOriginalName('../../..')).toBe('upload');
    expect(sanitizeUploadOriginalName('  my image (1).jpg  ')).toBe(
      'my image -1-.jpg'
    );
  });
});
