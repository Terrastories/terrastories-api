/**
 * Pure TypeScript deterministic streaming PKZIP 2.0 (STORE) builder and
 * verifier (SPEC-V2 §7, #187).
 *
 * Zero Node-only imports (`node:zlib`, `node:buffer`, `node:stream`) so the
 * exact same streaming code executes inside Cloudflare Workers and Node.js.
 *
 * Determinism guarantees:
 * - Fixed DOS timestamp (1980-01-01 00:00:00 UTC) and fixed Unix mode (0644)
 * - Deterministic entry ordering preserved from the caller
 * - UTF-8 filenames (`0x0808`: bit 3 data descriptor + bit 11 UTF-8)
 * - Unbuffered entry streaming through CRC-32, per-entry SHA-256, and
 *   whole-archive SHA-256
 */

import { StreamingSha256 } from './sha256-stream.js';

const ZIP32_MAX_UINT32 = 0xffff_ffff;
const ZIP32_MAX_ENTRIES = 0xffff;
const ZIP_VERSION_MADE_BY = 0x0314; // Unix + PKZIP 2.0
const ZIP_VERSION_NEEDED = 20;
const ZIP_FLAGS_DATA_DESCRIPTOR_UTF8 = 0x0808;
const ZIP_METHOD_STORE = 0;
const ZIP_DOS_TIME_ZERO = 0x0000;
const ZIP_DOS_DATE_1980 = 0x0021;
const ZIP_EXTERNAL_ATTR_FILE_644 = 0x81a4_0000;

const LOCAL_FILE_HEADER_SIG = 0x0403_4b50;
const DATA_DESCRIPTOR_SIG = 0x0807_4b50;
const CENTRAL_DIR_HEADER_SIG = 0x0201_4b50;
const EOCD_SIG = 0x0605_4b50;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, chunk: Uint8Array): number {
  let current = crc ^ 0xffff_ffff;
  for (let i = 0; i < chunk.byteLength; i += 1) {
    current = CRC32_TABLE[(current ^ chunk[i]!) & 0xff]! ^ (current >>> 8);
  }
  return (current ^ 0xffff_ffff) >>> 0;
}

export class ExportLimitExceededError extends Error {
  constructor(
    public readonly limitName: string,
    message: string
  ) {
    super(message);
    this.name = 'ExportLimitExceededError';
  }
}

export class ExportMediaIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportMediaIntegrityError';
  }
}

export interface DeterministicZipEntryInput {
  id: string;
  storageKey: string;
  archivePath: string;
  expectedByteSize: number;
  expectedChecksum: string | null;
  read: () => Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
}

export interface VerifiedZipEntryResult {
  id: string;
  storageKey: string;
  archivePath: string;
  byteSize: number;
  checksum: string;
  crc32: number;
}

export interface DeterministicZipSummary {
  archiveChecksum: string;
  archiveByteSize: number;
  entries: VerifiedZipEntryResult[];
}

export interface DeterministicZipStreamResult {
  stream: ReadableStream<Uint8Array>;
  summary: Promise<DeterministicZipSummary>;
}

interface CentralDirectoryRecord {
  nameBytes: Uint8Array;
  crc32: number;
  byteSize: number;
  localHeaderOffset: number;
}

function buildLocalHeader(nameBytes: Uint8Array): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
  view.setUint16(4, ZIP_VERSION_NEEDED, true);
  view.setUint16(6, ZIP_FLAGS_DATA_DESCRIPTOR_UTF8, true);
  view.setUint16(8, ZIP_METHOD_STORE, true);
  view.setUint16(10, ZIP_DOS_TIME_ZERO, true);
  view.setUint16(12, ZIP_DOS_DATE_1980, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, 0, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function buildDataDescriptor(crc32: number, byteSize: number): Uint8Array {
  const descriptor = new Uint8Array(16);
  const view = new DataView(descriptor.buffer);
  view.setUint32(0, DATA_DESCRIPTOR_SIG, true);
  view.setUint32(4, crc32 >>> 0, true);
  view.setUint32(8, byteSize >>> 0, true);
  view.setUint32(12, byteSize >>> 0, true);
  return descriptor;
}

function buildCentralDirectoryHeader(
  record: CentralDirectoryRecord
): Uint8Array {
  const header = new Uint8Array(46 + record.nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
  view.setUint16(4, ZIP_VERSION_MADE_BY, true);
  view.setUint16(6, ZIP_VERSION_NEEDED, true);
  view.setUint16(8, ZIP_FLAGS_DATA_DESCRIPTOR_UTF8, true);
  view.setUint16(10, ZIP_METHOD_STORE, true);
  view.setUint16(12, ZIP_DOS_TIME_ZERO, true);
  view.setUint16(14, ZIP_DOS_DATE_1980, true);
  view.setUint32(16, record.crc32 >>> 0, true);
  view.setUint32(20, record.byteSize >>> 0, true);
  view.setUint32(24, record.byteSize >>> 0, true);
  view.setUint16(28, record.nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, ZIP_EXTERNAL_ATTR_FILE_644, true);
  view.setUint32(42, record.localHeaderOffset >>> 0, true);
  header.set(record.nameBytes, 46);
  return header;
}

function buildEocd(
  entryCount: number,
  centralDirSize: number,
  centralDirOffset: number
): Uint8Array {
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, EOCD_SIG, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirSize >>> 0, true);
  view.setUint32(16, centralDirOffset >>> 0, true);
  view.setUint16(20, 0, true);
  return eocd;
}

const STREAM_CHUNK_SIZE = 65_536;

/**
 * Assemble a deterministic pull-driven streaming PKZIP (STORE) archive over
 * the supplied entries while computing per-entry checksums and the overall
 * archive SHA-256 without buffering the archive in memory.
 */
export function createDeterministicZipStream(
  entries: ReadonlyArray<DeterministicZipEntryInput>,
  options: {
    maxTotalMediaBytes: number;
    maxArchiveBytes: number;
  }
): DeterministicZipStreamResult {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new ExportLimitExceededError(
      'maxFiles',
      'Export file count exceeds ZIP32 maximum entry count'
    );
  }

  let resolveSummary!: (summary: DeterministicZipSummary) => void;
  let rejectSummary!: (reason?: unknown) => void;
  const summary = new Promise<DeterministicZipSummary>((resolve, reject) => {
    resolveSummary = resolve;
    rejectSummary = reject;
  });

  const archiveHash = new StreamingSha256();
  let archiveOffset = 0;
  let totalMediaBytes = 0;
  const verifiedEntries: VerifiedZipEntryResult[] = [];
  const cdRecords: CentralDirectoryRecord[] = [];
  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const prepareChunk = (chunk: Uint8Array): Uint8Array | null => {
    if (chunk.byteLength === 0) return null;
    const nextOffset = archiveOffset + chunk.byteLength;
    if (nextOffset > ZIP32_MAX_UINT32) {
      throw new ExportLimitExceededError(
        'maxArchiveBytes',
        'Export archive exceeds ZIP32 maximum byte size'
      );
    }
    if (nextOffset > options.maxArchiveBytes) {
      throw new ExportLimitExceededError(
        'maxArchiveBytes',
        'Export archive exceeds profile archive size limit'
      );
    }
    archiveHash.update(chunk);
    archiveOffset = nextOffset;
    return chunk;
  };

  async function* generateChunks(): AsyncGenerator<Uint8Array> {
    try {
      for (const entry of entries) {
        if (cancelled) return;
        if (
          !Number.isSafeInteger(entry.expectedByteSize) ||
          entry.expectedByteSize < 0
        ) {
          throw new ExportMediaIntegrityError(
            `Invalid expected byte size for media ${entry.id}`
          );
        }

        const nameBytes = textEncoder.encode(entry.archivePath);
        if (nameBytes.byteLength > 0xffff) {
          throw new ExportMediaIntegrityError(
            `Archive path too long for media ${entry.id}`
          );
        }

        const localHeaderOffset = archiveOffset;
        const localHeader = prepareChunk(buildLocalHeader(nameBytes));
        if (localHeader) yield localHeader;
        if (cancelled) return;

        const payload = await entry.read();
        if (cancelled) return;
        if (payload === null) {
          throw new ExportMediaIntegrityError(
            `Missing stored bytes for media ${entry.id}`
          );
        }

        let entryCrc = 0;
        let entryByteSize = 0;
        const entryHash = new StreamingSha256();

        const processChunk = (chunk: Uint8Array): Uint8Array | null => {
          if (chunk.byteLength === 0) return null;
          totalMediaBytes += chunk.byteLength;
          if (totalMediaBytes > options.maxTotalMediaBytes) {
            throw new ExportLimitExceededError(
              'maxMediaBytes',
              'Export media bytes exceed profile limit'
            );
          }
          entryByteSize += chunk.byteLength;
          if (entryByteSize > entry.expectedByteSize) {
            throw new ExportMediaIntegrityError(
              `Media byte size mismatch for ${entry.id}`
            );
          }
          entryCrc = crc32Update(entryCrc, chunk);
          entryHash.update(chunk);
          return prepareChunk(chunk);
        };

        if (payload instanceof Uint8Array) {
          for (
            let offset = 0;
            offset < payload.byteLength;
            offset += STREAM_CHUNK_SIZE
          ) {
            if (cancelled) return;
            const prepared = processChunk(
              payload.subarray(offset, offset + STREAM_CHUNK_SIZE)
            );
            if (prepared) yield prepared;
          }
        } else {
          const reader = payload.getReader();
          activeReader = reader;
          let entryDone = false;
          try {
            while (!cancelled) {
              const { done, value } = await reader.read();
              if (done) {
                entryDone = true;
                break;
              }
              if (value) {
                const prepared = processChunk(value);
                if (prepared) yield prepared;
              }
            }
          } finally {
            activeReader = null;
            if (!entryDone) {
              await reader.cancel().catch(() => {});
            }
            reader.releaseLock();
          }
        }

        if (cancelled) return;
        if (entryByteSize !== entry.expectedByteSize) {
          throw new ExportMediaIntegrityError(
            `Media byte size mismatch for ${entry.id}`
          );
        }

        const entryChecksum = entryHash.digestHex();
        if (
          entry.expectedChecksum !== null &&
          entry.expectedChecksum !== entryChecksum
        ) {
          throw new ExportMediaIntegrityError(
            `Media checksum mismatch for ${entry.id}`
          );
        }

        const descriptor = prepareChunk(
          buildDataDescriptor(entryCrc, entryByteSize)
        );
        if (descriptor) yield descriptor;

        cdRecords.push({
          nameBytes,
          crc32: entryCrc,
          byteSize: entryByteSize,
          localHeaderOffset,
        });
        verifiedEntries.push({
          id: entry.id,
          storageKey: entry.storageKey,
          archivePath: entry.archivePath,
          byteSize: entryByteSize,
          checksum: entryChecksum,
          crc32: entryCrc,
        });
      }

      if (cancelled) return;
      const centralDirOffset = archiveOffset;
      for (const record of cdRecords) {
        if (cancelled) return;
        const cdHeader = prepareChunk(buildCentralDirectoryHeader(record));
        if (cdHeader) yield cdHeader;
      }
      const centralDirSize = archiveOffset - centralDirOffset;
      const eocd = prepareChunk(
        buildEocd(cdRecords.length, centralDirSize, centralDirOffset)
      );
      if (eocd) yield eocd;

      const archiveChecksum = archiveHash.digestHex();
      resolveSummary({
        archiveChecksum,
        archiveByteSize: archiveOffset,
        entries: verifiedEntries,
      });
    } catch (error) {
      rejectSummary(error);
      throw error;
    }
  }

  const gen = generateChunks();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await gen.next();
        if (cancelled) return;
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (cancelled) return;
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (activeReader) {
        await activeReader.cancel(reason).catch(() => {});
      }
      rejectSummary(reason ?? new Error('ZIP stream cancelled'));
      await gen.return(undefined).catch(() => {});
    },
  });

  // Prevent unhandled rejection when caller consumes stream errors via pipe/read.
  summary.catch(() => {});

  return { stream, summary };
}

export interface ParsedZipEntry {
  path: string;
  crc32: number;
  byteSize: number;
  data: Uint8Array;
}

/**
 * Pure-TS ZIP reader and CRC-32 verifier for validating generated exports in
 * unit, Hono, and Workers QA tests without Node-only zlib bindings.
 */
export function parseDeterministicZip(bytes: Uint8Array): ParsedZipEntry[] {
  if (bytes.byteLength < 22) {
    throw new Error('Archive shorter than ZIP EOCD');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIG) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Missing ZIP EOCD signature');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Corrupt ZIP central directory bounds');
  }

  const parsed: ParsedZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (
      cursor + 46 > bytes.byteLength ||
      view.getUint32(cursor, true) !== CENTRAL_DIR_HEADER_SIG
    ) {
      throw new Error('Invalid ZIP central directory header');
    }
    const method = view.getUint16(cursor + 10, true);
    if (method !== ZIP_METHOD_STORE) {
      throw new Error(`Unsupported ZIP compression method ${method}`);
    }
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (compressedSize !== uncompressedSize) {
      throw new Error('STORE entry compressed/uncompressed mismatch');
    }

    const cdName = textDecoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLen)
    );
    cursor += 46 + nameLen + extraLen + commentLen;

    if (
      localOffset + 30 > bytes.byteLength ||
      view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIG
    ) {
      throw new Error(`Invalid local header for ${cdName}`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + uncompressedSize;
    if (dataEnd > cdOffset) {
      throw new Error(`Entry data out of bounds for ${cdName}`);
    }
    const data = bytes.slice(dataStart, dataEnd);
    const actualCrc = crc32Update(0, data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC-32 mismatch for ${cdName}`);
    }
    if ((localFlags & 0x0008) !== 0) {
      if (
        dataEnd + 16 > cdOffset ||
        view.getUint32(dataEnd, true) !== DATA_DESCRIPTOR_SIG ||
        view.getUint32(dataEnd + 4, true) !== expectedCrc ||
        view.getUint32(dataEnd + 8, true) !== uncompressedSize ||
        view.getUint32(dataEnd + 12, true) !== uncompressedSize
      ) {
        throw new Error(`Invalid data descriptor for ${cdName}`);
      }
    }

    parsed.push({
      path: cdName,
      crc32: expectedCrc,
      byteSize: uncompressedSize,
      data,
    });
  }

  return parsed;
}
