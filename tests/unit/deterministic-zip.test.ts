import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createDeterministicZipStream,
  ExportLimitExceededError,
  ExportMediaIntegrityError,
  parseDeterministicZip,
} from '../../src/shared/utils/deterministic-zip.js';

async function readAllBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

describe('deterministic-zip', () => {
  it('emits a valid empty ZIP archive when there are zero entries', async () => {
    const { stream, summary } = createDeterministicZipStream([], {
      maxTotalMediaBytes: 1024,
      maxArchiveBytes: 1024,
    });
    const bytes = await readAllBytes(stream);
    const meta = await summary;

    expect(bytes.byteLength).toBe(22);
    expect(meta.archiveByteSize).toBe(22);
    expect(meta.entries).toEqual([]);
    expect(meta.archiveChecksum).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
    expect(parseDeterministicZip(bytes)).toEqual([]);
  });

  it('streams multi-chunk entries with matching CRC-32 and SHA-256 deterministically', async () => {
    const payloadA = new TextEncoder().encode('Hello Terrastories 🌍!');
    const payloadB = new Uint8Array([0, 1, 2, 254, 255]);
    const shaA = createHash('sha256').update(payloadA).digest('hex');
    const shaB = createHash('sha256').update(payloadB).digest('hex');

    const buildOnce = async () => {
      const { stream, summary } = createDeterministicZipStream(
        [
          {
            id: 'a-id',
            storageKey: 'communities/1/a',
            archivePath: 'media/a-id',
            expectedByteSize: payloadA.byteLength,
            expectedChecksum: shaA,
            read: async () =>
              new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(payloadA.subarray(0, 5));
                  c.enqueue(payloadA.subarray(5));
                  c.close();
                },
              }),
          },
          {
            id: 'b-id',
            storageKey: 'communities/1/b',
            archivePath: 'media/b-id',
            expectedByteSize: payloadB.byteLength,
            expectedChecksum: null,
            read: async () => payloadB,
          },
        ],
        {
          maxTotalMediaBytes: 1024 * 1024,
          maxArchiveBytes: 1024 * 1024,
        }
      );
      const bytes = await readAllBytes(stream);
      const meta = await summary;
      return { bytes, meta };
    };

    const run1 = await buildOnce();
    const run2 = await buildOnce();

    expect(Buffer.from(run1.bytes).equals(Buffer.from(run2.bytes))).toBe(true);
    expect(run1.meta.archiveChecksum).toBe(run2.meta.archiveChecksum);
    expect(run1.meta.archiveChecksum).toBe(
      createHash('sha256').update(run1.bytes).digest('hex')
    );
    expect(run1.meta.entries.map((e) => e.checksum)).toEqual([shaA, shaB]);

    const parsed = parseDeterministicZip(run1.bytes);
    expect(parsed.map((p) => p.path)).toEqual(['media/a-id', 'media/b-id']);
    expect(Array.from(parsed[0]!.data)).toEqual(Array.from(payloadA));
    expect(Array.from(parsed[1]!.data)).toEqual(Array.from(payloadB));
  });

  it('fails closed on missing bytes, size/checksum mismatches, and byte limits', async () => {
    const missing = createDeterministicZipStream(
      [
        {
          id: 'missing',
          storageKey: 'communities/1/missing',
          archivePath: 'media/missing',
          expectedByteSize: 4,
          expectedChecksum: null,
          read: async () => null,
        },
      ],
      { maxTotalMediaBytes: 1024, maxArchiveBytes: 1024 }
    );
    await expect(readAllBytes(missing.stream)).rejects.toBeInstanceOf(
      ExportMediaIntegrityError
    );

    const badChecksum = createDeterministicZipStream(
      [
        {
          id: 'bad-hash',
          storageKey: 'communities/1/bad-hash',
          archivePath: 'media/bad-hash',
          expectedByteSize: 3,
          expectedChecksum: '0'.repeat(64),
          read: async () => new Uint8Array([1, 2, 3]),
        },
      ],
      { maxTotalMediaBytes: 1024, maxArchiveBytes: 1024 }
    );
    await expect(readAllBytes(badChecksum.stream)).rejects.toBeInstanceOf(
      ExportMediaIntegrityError
    );

    const overLimit = createDeterministicZipStream(
      [
        {
          id: 'big',
          storageKey: 'communities/1/big',
          archivePath: 'media/big',
          expectedByteSize: 20,
          expectedChecksum: null,
          read: async () => new Uint8Array(20),
        },
      ],
      { maxTotalMediaBytes: 10, maxArchiveBytes: 1024 }
    );
    await expect(readAllBytes(overLimit.stream)).rejects.toBeInstanceOf(
      ExportLimitExceededError
    );
  });

  it('pulls entries lazily with backpressure so later entries are not read until consumed', async () => {
    const payloadA = new Uint8Array([10, 20, 30]);
    const payloadB = new Uint8Array([40, 50]);
    const readCalls: string[] = [];

    const { stream, summary } = createDeterministicZipStream(
      [
        {
          id: 'first',
          storageKey: 'communities/1/first',
          archivePath: 'media/first',
          expectedByteSize: payloadA.byteLength,
          expectedChecksum: null,
          read: async () => {
            readCalls.push('first');
            return payloadA;
          },
        },
        {
          id: 'second',
          storageKey: 'communities/1/second',
          archivePath: 'media/second',
          expectedByteSize: payloadB.byteLength,
          expectedChecksum: null,
          read: async () => {
            readCalls.push('second');
            return payloadB;
          },
        },
      ],
      { maxTotalMediaBytes: 1024, maxArchiveBytes: 1024 }
    );

    // Before reading, no entries have been pulled yet.
    expect(readCalls).toEqual([]);

    const reader = stream.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    // Reading entry #1 header/payload has not triggered entry #2 read yet.
    expect(readCalls).not.toContain('second');

    const chunks: Uint8Array[] = [firstChunk.value!];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const meta = await summary;
    expect(readCalls).toEqual(['first', 'second']);
    expect(meta.entries).toHaveLength(2);
    const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    expect(parseDeterministicZip(merged)).toHaveLength(2);
  });

  it('cancels an in-flight entry stream reader cleanly and rejects summary when cancelled', async () => {
    let entryCancelled = false;
    let chunkIndex = 0;
    const { stream, summary } = createDeterministicZipStream(
      [
        {
          id: 'slow',
          storageKey: 'communities/1/slow',
          archivePath: 'media/slow',
          expectedByteSize: 100,
          expectedChecksum: null,
          read: async () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (chunkIndex === 0) {
                  chunkIndex += 1;
                  controller.enqueue(new Uint8Array([1, 2, 3]));
                  return;
                }
                // Wait indefinitely until cancelled
                return new Promise(() => {});
              },
              cancel() {
                entryCancelled = true;
              },
            }),
        },
      ],
      { maxTotalMediaBytes: 1024, maxArchiveBytes: 1024 }
    );

    const reader = stream.getReader();
    // Pull local header and first chunk so activeReader is waiting on entry stream
    await reader.read();
    await reader.read();
    const cancelReason = new Error('consumer aborted');
    await reader.cancel(cancelReason);

    await expect(summary).rejects.toBe(cancelReason);
    expect(entryCancelled).toBe(true);
  });
});
