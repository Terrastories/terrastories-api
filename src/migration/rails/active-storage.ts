import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

export const SAFE_ACTIVE_STORAGE_KEY = /^[A-Za-z0-9_-]+$/;

export interface CapturedSelectedBlob {
  disposition: 'captured';
  id: string;
  key: string;
  filename: string;
  contentType: string | null;
  byteSize: string;
  railsChecksum: string | null;
  sha256: string;
  serviceName: string;
}

export interface NotSelectedBlob {
  disposition: 'not_selected';
  id: string;
  key: string;
  filename: string;
  contentType: string | null;
  byteSize: string;
  railsChecksum: string | null;
  sha256: null;
  serviceName: string;
}

export type ManifestBlob = CapturedSelectedBlob | NotSelectedBlob;
export type CapturedBlob = CapturedSelectedBlob;

export function assertSafeActiveStorageKey(key: string): void {
  if (!SAFE_ACTIVE_STORAGE_KEY.test(key)) {
    throw new Error(`Unsafe ActiveStorage key rejected: ${key}`);
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      fromRoot !== '..' &&
      !isAbsolute(fromRoot))
  );
}

export async function resolveActiveStorageBlobPath(
  blobRoot: string,
  key: string
): Promise<string> {
  assertSafeActiveStorageKey(key);

  const trustedRoot = await realpath(blobRoot);
  const candidates = [
    // Flat export from an object store such as S3.
    join(blobRoot, key),
    // Rails ActiveStorage DiskService layout.
    join(blobRoot, key.slice(0, 2), key.slice(2, 4), key),
  ];

  for (const candidate of candidates) {
    let info: Stats;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }

    if (info.isSymbolicLink()) {
      throw new Error(
        `Symlinked ActiveStorage blob path rejected for key ${key}`
      );
    }
    if (!info.isFile()) continue;

    const resolvedCandidate = await realpath(candidate);
    if (!isWithinRoot(trustedRoot, resolvedCandidate)) {
      throw new Error(
        `ActiveStorage blob path is outside trusted export root for key ${key}`
      );
    }
    return candidate;
  }

  throw new Error(`Missing ActiveStorage blob bytes for key ${key}`);
}

export async function hashFile(
  path: string
): Promise<{ md5: string; sha256: string }> {
  return new Promise((resolve, reject) => {
    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    const stream = createReadStream(path);

    stream.on('data', (chunk) => {
      md5.update(chunk);
      sha256.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve({
        md5: md5.digest('base64'),
        sha256: sha256.digest('hex'),
      });
    });
  });
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, signal: AbortSignal) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error(
      `Invalid blob concurrency: ${concurrency}. Must be an integer between 1 and 32.`
    );
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const controller = new AbortController();
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;

  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index]!, controller.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          controller.abort(error);
        }
        return;
      }
    }
  });

  await Promise.all(runners);
  if (failed) {
    throw firstError;
  }
  return results;
}

export async function verifyAndCopyActiveStorageBlob(options: {
  blobRoot: string;
  destinationRoot: string;
  id: string;
  key: string;
  filename: string;
  contentType: string | null;
  byteSize: string;
  checksum: string | null;
  serviceName: string;
}): Promise<CapturedSelectedBlob> {
  const sourcePath = await resolveActiveStorageBlobPath(
    options.blobRoot,
    options.key
  );
  const expectedSize = BigInt(options.byteSize);
  const sourceStat = await stat(sourcePath, { bigint: true });

  if (sourceStat.size !== expectedSize) {
    throw new Error(
      `ActiveStorage size mismatch for key ${options.key}: expected ${expectedSize}, got ${sourceStat.size}`
    );
  }

  const sourceHashes = await hashFile(sourcePath);
  if (options.checksum && sourceHashes.md5 !== options.checksum) {
    throw new Error(
      `ActiveStorage checksum mismatch for key ${options.key}: Rails checksum does not match source bytes`
    );
  }

  await mkdir(options.destinationRoot, { recursive: true, mode: 0o700 });
  const destinationPath = join(options.destinationRoot, options.key);
  await copyFile(sourcePath, destinationPath);
  await chmod(destinationPath, 0o600);

  const destinationStat = await stat(destinationPath, { bigint: true });
  if (destinationStat.size !== expectedSize) {
    throw new Error(
      `ActiveStorage copied size mismatch for key ${options.key}: expected ${expectedSize}, got ${destinationStat.size}`
    );
  }

  const destinationHashes = await hashFile(destinationPath);
  if (
    destinationHashes.md5 !== sourceHashes.md5 ||
    destinationHashes.sha256 !== sourceHashes.sha256
  ) {
    throw new Error(
      `ActiveStorage copied checksum mismatch for key ${options.key}: destination bytes do not match verified source bytes`
    );
  }
  if (options.checksum && destinationHashes.md5 !== options.checksum) {
    throw new Error(
      `ActiveStorage copied checksum mismatch for key ${options.key}: Rails checksum does not match destination bytes`
    );
  }

  return {
    disposition: 'captured',
    id: options.id,
    key: options.key,
    filename: options.filename,
    contentType: options.contentType,
    byteSize: options.byteSize,
    railsChecksum: options.checksum,
    sha256: destinationHashes.sha256,
    serviceName: options.serviceName,
  };
}
