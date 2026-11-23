/**
 * In-memory R2 bucket (binding surface used by the Workers storage adapter)
 * plus a fake S3 endpoint that accepts presigned UploadPart PUTs (#286).
 *
 * The fake endpoint verifies the SigV4 signature with an independent
 * node:crypto derivation and enforces the signed Content-Length and
 * The fake rejects the unsupported UploadPart checksum header with 501 (as
 * R2 does) and, like R2, checks the signed x-amz-content-sha256 header
 * against the bytes.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { R2Bucket } from '@cloudflare/workers-types';

const toBytes = async (
  value: string | ArrayBuffer | Uint8Array | ReadableStream | null
): Promise<Uint8Array> => {
  if (value === null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(
    await new Response(value as ReadableStream).arrayBuffer()
  );
};

interface FakeUpload {
  key: string;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

export class FakeR2Bucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, FakeUpload>();
  readonly completed: string[] = [];

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.byteLength } : null;
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } }
  ) {
    const all = this.objects.get(key);
    if (!all) return null;
    const bytes = options?.range
      ? all.subarray(
          options.range.offset,
          options.range.offset + options.range.length
        )
      : all;
    return {
      key,
      size: all.byteLength,
      body: new Response(bytes).body!,
      json: async () => JSON.parse(new TextDecoder().decode(all)),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream | null
  ) {
    const bytes = await toBytes(value);
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }

  async list(options?: {
    prefix?: string;
    startAfter?: string;
    limit?: number;
  }) {
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(options?.prefix ?? ''))
      .filter((k) => (options?.startAfter ? k > options.startAfter : true))
      .sort();
    const page = keys.slice(0, options?.limit ?? 1000);
    return {
      objects: page.map((key) => ({ key, uploaded: new Date() })),
      truncated: keys.length > page.length,
    };
  }

  async createMultipartUpload(key: string) {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return this.handle(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    return this.handle(key, uploadId);
  }

  private handle(key: string, uploadId: string) {
    const find = () => {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) {
        throw new Error('The specified upload does not exist. (10024)');
      }
      return upload;
    };
    return {
      uploadId,
      key,
      uploadPart: async (partNumber: number, value: Uint8Array) => {
        const bytes = await toBytes(value);
        const etag = createHash('md5').update(bytes).digest('hex');
        find().parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        const upload = find();
        const chunks: Uint8Array[] = [];
        for (const part of parts) {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error(
              'One or more of the specified parts could not be found. (10025)'
            );
          }
          chunks.push(stored.bytes);
        }
        const all = Buffer.concat(chunks);
        this.objects.set(key, new Uint8Array(all));
        this.uploads.delete(uploadId);
        this.completed.push(uploadId);
        return { key, size: all.byteLength };
      },
      abort: async () => {
        find();
        this.uploads.delete(uploadId);
      },
    };
  }

  asR2Bucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );

export interface FakeS3Options {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface MultipartUploadBucket {
  resumeMultipartUpload(
    key: string,
    uploadId: string
  ): {
    uploadPart(
      partNumber: number,
      value: Uint8Array
    ): Promise<{ partNumber: number; etag: string }>;
  };
}

/**
 * Verify a presigned R2 UploadPart request the way real R2 does (#291):
 * - 501 for any `x-amz-checksum-sha256` header;
 * - SigV4 query signature over `UNSIGNED-PAYLOAD` (403 otherwise);
 * - signed `content-length` and `x-amz-content-sha256` headers;
 * - `x-amz-content-sha256` matched against the body bytes
 *   (400 `XAmzContentSHA256Mismatch` otherwise);
 * - stores the part in `bucket` and answers 200 with the quoted `ETag`.
 */
export async function handleFakeR2PartRequest(
  bucket: MultipartUploadBucket,
  options: FakeS3Options,
  input: {
    method: string;
    url: URL;
    header: (name: string) => string;
    body: Uint8Array;
  }
): Promise<{
  status: number;
  headers?: Record<string, string>;
  body?: string;
}> {
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  const q = input.url.searchParams;
  const signedHeaderNames = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
  const headerValue = (name: string) =>
    name === 'host' ? host : input.header(name);
  if (input.header('x-amz-checksum-sha256')) return { status: 501 };
  const payloadHash = headerValue('x-amz-content-sha256');
  const amzDate = q.get('X-Amz-Date') ?? '';
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const canonicalQuery = [...q.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    input.method,
    input.url.pathname,
    canonicalQuery,
    signedHeaderNames.map((n) => `${n}:${headerValue(n)}\n`).join(''),
    signedHeaderNames.join(';'),
    // Real R2 (verified 2026-11-23) canonicalizes presigned requests over
    // UNSIGNED-PAYLOAD and enforces the signed x-amz-content-sha256 header
    // separately (400 XAmzContentSHA256Mismatch).
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const hmac = (k: Buffer | string, d: string) =>
    createHmac('sha256', k).update(d).digest();
  const key = hmac(
    hmac(
      hmac(hmac(`AWS4${options.secretAccessKey}`, amzDate.slice(0, 8)), 'auto'),
      's3'
    ),
    'aws4_request'
  );
  const signature = hmac(
    key,
    [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n')
  ).toString('hex');
  if (
    input.url.host !== host ||
    signature !== q.get('X-Amz-Signature') ||
    !(q.get('X-Amz-Credential') ?? '').startsWith(options.accessKeyId + '/')
  ) {
    return { status: 403 };
  }
  if (
    !signedHeaderNames.includes('content-length') ||
    !signedHeaderNames.includes('x-amz-content-sha256') ||
    String(input.body.byteLength) !== input.header('content-length')
  ) {
    return { status: 400 };
  }
  if (payloadHash !== createHash('sha256').update(input.body).digest('hex')) {
    return {
      status: 400,
      body: '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>',
    };
  }
  const prefix = `/${options.bucketName}/`;
  if (input.method !== 'PUT' || !input.url.pathname.startsWith(prefix)) {
    return { status: 404 };
  }
  const objectKey = decodeURIComponent(input.url.pathname.slice(prefix.length));
  try {
    const part = await bucket
      .resumeMultipartUpload(objectKey, q.get('uploadId') ?? '')
      .uploadPart(Number(q.get('partNumber')), input.body);
    return { status: 200, headers: { ETag: `"${part.etag}"` } };
  } catch {
    return { status: 404 };
  }
}

/** Listens on 127.0.0.1; presigned URLs are replayed against it with the real Host. */
export async function startFakeS3(
  bucket: FakeR2Bucket,
  options: FakeS3Options
) {
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  const requests: Array<{ status: number; partNumber: string | null }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, `https://${req.headers.host || host}`);
    const result = await handleFakeR2PartRequest(bucket, options, {
      method: req.method ?? '',
      url,
      header: (name) => String(req.headers[name] ?? ''),
      body: new Uint8Array(body),
    });
    requests.push({
      status: result.status,
      partNumber: url.searchParams.get('partNumber'),
    });
    res.writeHead(result.status, result.headers ?? {});
    res.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    /** PUT a part to a presigned URL the way a browser would, with the real Host header. */
    async putPart(
      target: { url: string; headers: Record<string, string> },
      bytes: Uint8Array
    ) {
      const url = new URL(target.url);
      return new Promise<{ status: number; etag: string | undefined }>(
        (resolve, reject) => {
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              method: 'PUT',
              path: url.pathname + url.search,
              headers: {
                ...target.headers,
                host: url.host,
                'content-length': String(bytes.byteLength),
              },
            },
            (res) => {
              res.resume();
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  etag: res.headers.etag?.replace(/"/g, ''),
                })
              );
            }
          );
          req.on('error', reject);
          req.end(Buffer.from(bytes));
        }
      );
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
