import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SAFE_ACTIVE_STORAGE_KEY = /^[A-Za-z0-9_-]+$/;

export interface CapturedBlob {
  id: string;
  key: string;
  filename: string;
  contentType: string | null;
  byteSize: string;
  railsChecksum: string | null;
  sha256: string;
  serviceName: string;
}

export async function resolveActiveStorageBlobPath(
  blobRoot: string,
  key: string
): Promise<string> {
  if (!SAFE_ACTIVE_STORAGE_KEY.test(key)) {
    throw new Error(`Unsafe ActiveStorage key rejected: ${key}`);
  }

  const candidates = [
    // Flat export from an object store such as S3.
    join(blobRoot, key),
    // Rails ActiveStorage DiskService layout.
    join(blobRoot, key.slice(0, 2), key.slice(2, 4), key),
  ];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next supported source layout.
    }
  }

  throw new Error(`Missing ActiveStorage blob bytes for key ${key}`);
}

async function hashFile(path: string): Promise<{ md5: string; sha256: string }> {
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
}): Promise<CapturedBlob> {
  const sourcePath = await resolveActiveStorageBlobPath(
    options.blobRoot,
    options.key
  );
  const sourceStat = await stat(sourcePath, { bigint: true });
  const expectedSize = BigInt(options.byteSize);

  if (sourceStat.size !== expectedSize) {
    throw new Error(
      `ActiveStorage size mismatch for key ${options.key}: expected ${expectedSize}, got ${sourceStat.size}`
    );
  }

  const hashes = await hashFile(sourcePath);
  if (options.checksum && hashes.md5 !== options.checksum) {
    throw new Error(
      `ActiveStorage checksum mismatch for key ${options.key}: Rails checksum does not match source bytes`
    );
  }

  await mkdir(options.destinationRoot, { recursive: true, mode: 0o700 });
  const destinationPath = join(options.destinationRoot, options.key);
  await copyFile(sourcePath, destinationPath);

  return {
    id: options.id,
    key: options.key,
    filename: options.filename,
    contentType: options.contentType,
    byteSize: options.byteSize,
    railsChecksum: options.checksum,
    sha256: hashes.sha256,
    serviceName: options.serviceName,
  };
}
