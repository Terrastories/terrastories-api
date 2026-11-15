import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { StreamingSha256 } from '../../src/shared/utils/sha256-stream.js';
import {
  MultipartStreamError,
  extractMultipartBoundary,
  parseMultipartMediaStream,
} from '../../src/shared/utils/multipart-stream.js';
import { sanitizeUploadOriginalName } from '../../src/shared/schemas/media-v2.js';

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function readAllBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

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

  it('streams file bytes across 1-7 byte split boundaries without buffering', async () => {
    const boundary = 'splitBoundary77';
    const filePayload = new Uint8Array(256);
    for (let i = 0; i < filePayload.byteLength; i++) {
      filePayload[i] = i & 0xff;
    }
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="role"\r\n\r\n` +
        `user_photo\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="photo.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const combined = new Uint8Array(
      head.byteLength + filePayload.byteLength + tail.byteLength
    );
    combined.set(head, 0);
    combined.set(filePayload, head.byteLength);
    combined.set(tail, head.byteLength + filePayload.byteLength);

    // Split deliberately into tiny uneven chunks crossing `\r\n--boundary`.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < combined.byteLength; ) {
      const size = (i % 5) + 1;
      chunks.push(combined.subarray(i, i + size));
      i += size;
    }

    const parsed = await parseMultipartMediaStream<{
      bytes: Uint8Array;
      filename: string;
      roleSoFar: string | undefined;
    }>(
      streamFromChunks(chunks),
      `multipart/form-data; boundary=${boundary}`,
      1024 * 1024,
      async (part) => {
        const bytes = await readAllBytes(part.stream);
        part.finish({
          bytes,
          filename: part.filename,
          roleSoFar: part.fieldsSoFar.get('role'),
        });
      }
    );

    expect(parsed.fields.get('role')).toBe('user_photo');
    expect(parsed.fileResult.roleSoFar).toBe('user_photo');
    expect(parsed.fileResult.filename).toBe('photo.png');
    expect(parsed.fileResult.bytes).toEqual(filePayload);
  });

  it('rejects oversized bodies incrementally before full stream exhaustion', async () => {
    const boundary = 'capTest';
    const encoder = new TextEncoder();
    const chunk = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n` +
        'A'.repeat(400) +
        `\r\n--${boundary}--\r\n`
    );

    await expect(
      parseMultipartMediaStream(
        streamFromChunks([chunk]),
        `multipart/form-data; boundary=${boundary}`,
        128,
        async (part) => {
          await readAllBytes(part.stream);
          part.finish(true);
        }
      )
    ).rejects.toThrowError(MultipartStreamError);
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
