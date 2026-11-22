import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  verifyCapturedArchive,
  type RailsCaptureManifest,
} from '../rails/capture.js';
import { assertSafeActiveStorageKey } from '../rails/active-storage.js';
import {
  RAILS_MIGRATION_VERSION_2024,
  RAILS_MIGRATION_VERSION_2025,
  RAILS_SOURCE_PROFILE,
} from '../rails/contract.js';

/** One captured source row: every value is PostgreSQL text or null. */
export type SourceRow = Record<string, string | null>;

export interface VerifiedBundle {
  readonly dir: string;
  readonly manifest: RailsCaptureManifest;
  readonly manifestSha256: string;
  readonly tableNames: readonly string[];
  /** Rows of `table` in captured (primary-key) order; [] for a missing table. */
  rows(table: string): SourceRow[];
  close(): void;
}

async function sha256OfFile(path: string): Promise<{
  sha256: string;
  size: number;
}> {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
  });
  return { sha256: hash.digest('hex'), size };
}

/**
 * Open a Stage-1 bundle only after verifying it end to end: manifest shape,
 * archive size/SHA-256 plus the capture-time integrity and row/table digests,
 * and every captured blob's size and SHA-256. Any mismatch throws; the caller
 * never sees a partially trusted bundle (fail closed).
 */
export async function openVerifiedBundle(
  bundleDir: string
): Promise<VerifiedBundle> {
  const dir = resolve(bundleDir);
  let manifestText: string;
  try {
    manifestText = await readFile(join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw new Error('Bundle manifest.json is missing or unreadable');
  }
  let manifest: RailsCaptureManifest;
  try {
    manifest = JSON.parse(manifestText) as RailsCaptureManifest;
  } catch {
    throw new Error('Bundle manifest.json is not valid JSON');
  }
  if (
    manifest?.formatVersion !== 1 ||
    manifest.source?.profile !== RAILS_SOURCE_PROFILE ||
    ![RAILS_MIGRATION_VERSION_2024, RAILS_MIGRATION_VERSION_2025].includes(
      manifest.source.observedSchemaVersion as never
    ) ||
    typeof manifest.archive?.sha256 !== 'string' ||
    !Array.isArray(manifest.blobs) ||
    typeof manifest.tables !== 'object' ||
    manifest.tables === null
  ) {
    throw new Error('Bundle manifest is not a supported Stage-1 manifest');
  }

  const archivePath = join(dir, manifest.archive.filename);
  await verifyCapturedArchive(archivePath, manifest);

  for (const blob of manifest.blobs) {
    if (blob.disposition === 'not_selected') continue;
    assertSafeActiveStorageKey(blob.key);
    const blobPath = join(dir, 'blobs', blob.key);
    let size: number;
    try {
      size = (await stat(blobPath)).size;
    } catch {
      throw new Error(`Bundle blob payload is missing (blob id ${blob.id})`);
    }
    if (String(size) !== blob.byteSize) {
      throw new Error(`Bundle blob size mismatch (blob id ${blob.id})`);
    }
    const digest = await sha256OfFile(blobPath);
    if (digest.sha256 !== blob.sha256) {
      throw new Error(`Bundle blob SHA-256 mismatch (blob id ${blob.id})`);
    }
  }

  const database = new Database(archivePath, {
    readonly: true,
    fileMustExist: true,
  });
  const select = database.prepare(
    'SELECT row_json FROM source_rows WHERE table_name = ? ORDER BY ordinal'
  );
  return {
    dir,
    manifest,
    manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
    tableNames: Object.keys(manifest.tables).sort(),
    rows(table: string): SourceRow[] {
      return (select.all(table) as Array<{ row_json: string }>).map(
        (record) => JSON.parse(record.row_json) as SourceRow
      );
    },
    close(): void {
      database.close();
    },
  };
}
