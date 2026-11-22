import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import {
  assertSafeActiveStorageKey,
  hashFile,
  type CapturedSelectedBlob,
} from './active-storage.js';
import { fsyncPath } from './fsync.js';

const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9-]+$/;

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3BlobSourceConfig {
  bucket: string;
  region: string;
  prefix?: string;
  /** Optional HTTP(S) path-style endpoint override (for local test servers). */
  endpoint?: string;
  /** Optional env map override; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Max attempts per blob including retries (default 4). */
  maxAttempts?: number;
  /** Base exponential backoff delay in ms (default 250). */
  retryBaseDelayMs?: number;
  /** Per-request/inactivity timeout in ms (default 30_000). */
  requestTimeoutMs?: number;
}

export interface NormalizedS3Config {
  bucket: string;
  region: string;
  prefix: string | null;
  endpoint?: string;
}

class NonRetryableS3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableS3Error';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function resolveS3CredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): S3Credentials {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  const sessionToken = env.AWS_SESSION_TOKEN?.trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 blob source requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.'
    );
  }

  return sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };
}

export function normalizeS3Prefix(prefix: string | undefined): string | null {
  if (prefix === undefined) return null;
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return null;
  if (trimmed.includes('\\') || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error('Unsafe S3 prefix rejected');
  }
  const segments = trimmed.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new Error('Unsafe S3 prefix path segment rejected');
  }
  return segments.join('/');
}

export function validateS3Config(
  config: S3BlobSourceConfig
): NormalizedS3Config {
  const bucket = config.bucket.trim();
  const region = config.region.trim();

  if (!BUCKET_PATTERN.test(bucket) || bucket.includes('..')) {
    throw new Error(`Invalid S3 bucket name: ${config.bucket}`);
  }
  if (!REGION_PATTERN.test(region)) {
    throw new Error(`Invalid S3 region: ${config.region}`);
  }

  const prefix = normalizeS3Prefix(config.prefix);
  let endpoint: string | undefined;
  if (config.endpoint !== undefined) {
    const parsed = new URL(config.endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported S3 endpoint protocol: ${parsed.protocol}`);
    }
    endpoint = parsed.toString().replace(/\/+$/, '');
  }

  return {
    bucket,
    region,
    prefix,
    ...(endpoint ? { endpoint } : {}),
  };
}

export function buildS3ObjectUrl(
  config: NormalizedS3Config,
  blobKey: string
): URL {
  assertSafeActiveStorageKey(blobKey);
  const objectSegments = config.prefix
    ? [...config.prefix.split('/'), blobKey]
    : [blobKey];
  const encodedObjectPath = objectSegments.map(encodeRfc3986).join('/');

  if (config.endpoint) {
    const base = new URL(config.endpoint);
    const basePath = base.pathname.replace(/\/+$/, '');
    base.pathname = `${basePath}/${encodeRfc3986(config.bucket)}/${encodedObjectPath}`;
    return base;
  }

  if (config.bucket.includes('.')) {
    return new URL(
      `https://s3.${config.region}.amazonaws.com/${encodeRfc3986(config.bucket)}/${encodedObjectPath}`
    );
  }

  return new URL(
    `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodedObjectPath}`
  );
}

export function signS3GetRequest(options: {
  url: URL;
  region: string;
  credentials: S3Credentials;
  now?: Date;
}): Record<string, string> {
  const timestamp = options.now ?? new Date();
  const amzDate = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${options.region}/s3/aws4_request`;

  const headerPairs: Array<[string, string]> = [
    ['host', options.url.host],
    ['x-amz-content-sha256', EMPTY_PAYLOAD_SHA256],
    ['x-amz-date', amzDate],
  ];
  if (options.credentials.sessionToken) {
    headerPairs.push([
      'x-amz-security-token',
      options.credentials.sessionToken.trim(),
    ]);
  }
  headerPairs.sort(([a], [b]) => a.localeCompare(b));

  const canonicalHeaders = headerPairs
    .map(([name, value]) => `${name}:${value}\n`)
    .join('');
  const signedHeaders = headerPairs.map(([name]) => name).join(';');

  const queryEntries = [...options.url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as [string, string])
    .sort(([ka, va], [kb, vb]) =>
      ka === kb ? va.localeCompare(vb) : ka.localeCompare(kb)
    );
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    'GET',
    options.url.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(
    `AWS4${options.credentials.secretAccessKey}`,
    dateStamp
  );
  const kRegion = hmacSha256(kDate, options.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const headers: Record<string, string> = {
    'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (options.credentials.sessionToken) {
    headers['x-amz-security-token'] = options.credentials.sessionToken.trim();
  }
  return headers;
}

async function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new NonRetryableS3Error('S3 download aborted');
  }
  if (delayMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NonRetryableS3Error('S3 download aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function attemptDownloadAndVerify(options: {
  url: URL;
  region: string;
  credentials: S3Credentials;
  destinationRoot: string;
  key: string;
  expectedSize: bigint;
  checksum: string | null;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const attemptController = new AbortController();
  const onParentAbort = () => attemptController.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      throw new NonRetryableS3Error('S3 download aborted');
    }
    options.signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timeoutHandle = setTimeout(() => {
    attemptController.abort(
      new Error(`S3 request timed out for key ${options.key}`)
    );
  }, options.requestTimeoutMs);

  const resetInactivityTimer = () => {
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      attemptController.abort(
        new Error(`S3 stream stalled for key ${options.key}`)
      );
    }, options.requestTimeoutMs);
  };

  const partPath = join(
    options.destinationRoot,
    `.${options.key}.part-${randomUUID()}`
  );

  try {
    const headers = signS3GetRequest({
      url: options.url,
      region: options.region,
      credentials: options.credentials,
    });

    const response = await fetch(options.url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: attemptController.signal,
    });
    resetInactivityTimer();

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore stream cancellation error on failed response.
      }
      if (response.status === 404) {
        throw new NonRetryableS3Error(
          `Missing ActiveStorage blob bytes in S3 for key ${options.key} (HTTP 404)`
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new NonRetryableS3Error(
          `S3 access denied for key ${options.key} (HTTP ${response.status}); verify AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY and bucket permissions`
        );
      }
      if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
        throw new Error(
          `Transient S3 error for key ${options.key} (HTTP ${response.status})`
        );
      }
      throw new NonRetryableS3Error(
        `S3 download failed for key ${options.key} (HTTP ${response.status})`
      );
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)) {
      const advertisedSize = BigInt(contentLengthHeader);
      if (advertisedSize !== options.expectedSize) {
        try {
          await response.body?.cancel();
        } catch {
          // Ignore stream cancellation error on size mismatch.
        }
        throw new NonRetryableS3Error(
          `ActiveStorage size mismatch for key ${options.key}: expected ${options.expectedSize}, got ${advertisedSize}`
        );
      }
    }

    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    let bytesReceived = 0n;

    await mkdir(options.destinationRoot, { recursive: true, mode: 0o700 });
    const destinationPath = join(options.destinationRoot, options.key);

    if (response.body === null) {
      if (options.expectedSize !== 0n) {
        throw new Error(
          `S3 returned empty body for non-empty key ${options.key}`
        );
      }
      const emptyStream = Readable.from([]);
      await pipeline(
        emptyStream,
        createWriteStream(partPath, { flags: 'wx', mode: 0o600 })
      );
    } else {
      const sourceStream = Readable.fromWeb(
        response.body as unknown as NodeWebReadableStream<Uint8Array>
      );
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          resetInactivityTimer();
          bytesReceived += BigInt(chunk.length);
          if (bytesReceived > options.expectedSize) {
            callback(
              new NonRetryableS3Error(
                `ActiveStorage size mismatch for key ${options.key}: expected ${options.expectedSize}, received more than ${options.expectedSize} bytes`
              )
            );
            return;
          }
          md5.update(chunk);
          sha256.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        sourceStream,
        verifier,
        createWriteStream(partPath, { flags: 'wx', mode: 0o600 }),
        { signal: attemptController.signal }
      );
    }

    await chmod(partPath, 0o600);
    const partStat = await stat(partPath, { bigint: true });
    if (
      bytesReceived !== options.expectedSize ||
      partStat.size !== options.expectedSize
    ) {
      throw new NonRetryableS3Error(
        `ActiveStorage size mismatch for key ${options.key}: expected ${options.expectedSize}, got ${partStat.size}`
      );
    }

    const streamMd5 = md5.digest('base64');
    const streamSha256 = sha256.digest('hex');
    if (options.checksum && streamMd5 !== options.checksum) {
      throw new NonRetryableS3Error(
        `ActiveStorage checksum mismatch for key ${options.key}: Rails checksum does not match S3 bytes`
      );
    }

    const writtenHashes = await hashFile(partPath);
    if (
      writtenHashes.md5 !== streamMd5 ||
      writtenHashes.sha256 !== streamSha256
    ) {
      throw new NonRetryableS3Error(
        `ActiveStorage copied checksum mismatch for key ${options.key}: destination bytes do not match downloaded bytes`
      );
    }
    if (options.checksum && writtenHashes.md5 !== options.checksum) {
      throw new NonRetryableS3Error(
        `ActiveStorage copied checksum mismatch for key ${options.key}: Rails checksum does not match destination bytes`
      );
    }

    await fsyncPath(partPath);
    await rename(partPath, destinationPath);
    await fsyncPath(dirname(destinationPath));
    return writtenHashes.sha256;
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

export async function verifyAndDownloadS3Blob(options: {
  s3: S3BlobSourceConfig;
  credentials: S3Credentials;
  destinationRoot: string;
  id: string;
  key: string;
  filename: string;
  contentType: string | null;
  byteSize: string;
  checksum: string | null;
  serviceName: string;
  signal?: AbortSignal;
}): Promise<CapturedSelectedBlob> {
  const normalized = validateS3Config(options.s3);
  const url = buildS3ObjectUrl(normalized, options.key);
  const expectedSize = BigInt(options.byteSize);
  const maxAttempts = options.s3.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseDelayMs =
    options.s3.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const requestTimeoutMs =
    options.s3.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Invalid S3 maxAttempts: ${maxAttempts}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const sha256 = await attemptDownloadAndVerify({
        url,
        region: normalized.region,
        credentials: options.credentials,
        destinationRoot: options.destinationRoot,
        key: options.key,
        expectedSize,
        checksum: options.checksum,
        requestTimeoutMs,
        signal: options.signal,
      });

      return {
        disposition: 'captured',
        id: options.id,
        key: options.key,
        filename: options.filename,
        contentType: options.contentType,
        byteSize: options.byteSize,
        railsChecksum: options.checksum,
        sha256,
        serviceName: options.serviceName,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof NonRetryableS3Error || options.signal?.aborted) {
        throw error;
      }
      if (attempt < maxAttempts) {
        const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
        await sleepWithAbort(delayMs, options.signal);
      }
    }
  }

  throw lastError;
}
