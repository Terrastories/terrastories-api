/**
 * Local fake of the R2 S3-compatible API for the Stage-3 loader tests:
 * SigV4 verification (including the canonical query string), single PUT,
 * HEAD, and multipart upload (create / part / complete / abort). Bodies are
 * hashed as they stream in and never retained, so a large upload costs no
 * memory here. Fault injection is per request.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeR2Object {
  size: number;
  sha256Meta: string;
  parts: Array<{ size: number; sha256: string }> | null;
}

export interface FakeR2Request {
  method: string;
  key: string;
  query: Record<string, string>;
  /** 1-based count of requests with the same method, key, partNumber. */
  attempt: number;
}

/** 'drop': process the request fully, then cut the connection (lost response). */
export type FakeR2Fault = number | 'reset' | 'drop' | undefined;

export interface FakeR2Options {
  accessKeyId: string;
  secretAccessKey: string;
  fault?: (request: FakeR2Request) => FakeR2Fault;
}

export interface FakeR2 {
  endpoint: string;
  objects: Map<string, FakeR2Object>;
  requests: FakeR2Request[];
  aborted: string[];
  peakBodyBytesInFlight: () => number;
  resetPeak: () => void;
  close: () => Promise<void>;
}

const sha = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();
const enc = (v: string): string =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );

function signatureOk(
  req: IncomingMessage,
  url: URL,
  options: FakeR2Options
): boolean {
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      req.headers.authorization ?? ''
    );
  if (!match || match[1] !== options.accessKeyId) return false;
  const [, , date, signedHeaders, signature] = match;
  const canonicalHeaders = signedHeaders!
    .split(';')
    .map(
      (h) => h + ':' + String(req.headers[h]).trim().replace(/\s+/g, ' ') + '\n'
    )
    .join('');
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('&');
  const canonical = [
    req.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    String(req.headers['x-amz-content-sha256']),
  ].join('\n');
  const scope = date + '/auto/s3/aws4_request';
  const toSign = [
    'AWS4-HMAC-SHA256',
    String(req.headers['x-amz-date']),
    scope,
    sha(canonical),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac('AWS4' + options.secretAccessKey, date!), 'auto'), 's3'),
    'aws4_request'
  );
  return hmac(key, toSign).toString('hex') === signature;
}

export async function startFakeR2(options: FakeR2Options): Promise<FakeR2> {
  const objects = new Map<string, FakeR2Object>();
  const uploads = new Map<
    string,
    {
      path: string;
      sha256Meta: string;
      parts: Map<number, { size: number; sha256: string; etag: string }>;
    }
  >();
  const requests: FakeR2Request[] = [];
  const aborted: string[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  let uploadCounter = 0;

  let dropNext = false;
  const end = (res: ServerResponse, status: number, body = ''): void => {
    if (dropNext) {
      dropNext = false;
      res.destroy();
      return;
    }
    res.statusCode = status;
    res.end(body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = decodeURIComponent(url.pathname);
      const query = Object.fromEntries(url.searchParams.entries());
      const method = req.method ?? 'GET';
      const attemptKey = [
        method,
        path,
        query.partNumber ?? '',
        query.uploads ?? '',
        query.uploadId ? 'u' : '',
      ].join('|');
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);
      const info: FakeR2Request = { method, key: path, query, attempt };
      requests.push(info);

      const declared = Number(req.headers['content-length'] ?? 0);
      inFlight += declared;
      if (inFlight > peak) peak = inFlight;
      try {
        const hash = createHash('sha256');
        let size = 0;
        const fault = options.fault?.(info);
        if (fault === 'reset') {
          req.destroy();
          return;
        }
        for await (const chunk of req) {
          hash.update(chunk as Buffer);
          size += (chunk as Buffer).length;
        }
        const bodySha = hash.digest('hex');
        if (fault === 'drop') dropNext = true;
        else if (fault !== undefined) return end(res, fault as number);
        if (!signatureOk(req, url, options)) return end(res, 403);
        const payload = String(req.headers['x-amz-content-sha256']);
        if (
          method !== 'HEAD' &&
          method !== 'DELETE' &&
          payload !== 'UNSIGNED-PAYLOAD' &&
          payload !== bodySha
        ) {
          return end(res, 400, 'XAmzContentSHA256Mismatch');
        }
        const meta = String(req.headers['x-amz-meta-sha256'] ?? '');

        if (method === 'HEAD') {
          const object = objects.get(path);
          if (!object) return end(res, 404);
          res.setHeader('content-length', String(object.size));
          res.setHeader('x-amz-meta-sha256', object.sha256Meta);
          return end(res, 200);
        }
        if (method === 'PUT' && query.partNumber && query.uploadId) {
          const upload = uploads.get(query.uploadId);
          if (!upload) return end(res, 404, 'NoSuchUpload');
          const etag = '"' + bodySha.slice(0, 32) + '"';
          upload.parts.set(Number(query.partNumber), {
            size,
            sha256: bodySha,
            etag,
          });
          res.setHeader('etag', etag);
          return end(res, 200);
        }
        if (method === 'PUT') {
          objects.set(path, { size, sha256Meta: meta, parts: null });
          if (
            String(req.headers['x-amz-checksum-sha256']) !==
            Buffer.from(bodySha, 'hex').toString('base64')
          ) {
            objects.delete(path);
            return end(res, 400, 'BadDigest');
          }
          return end(res, 200);
        }
        if (method === 'POST' && 'uploads' in query) {
          uploadCounter += 1;
          const id = 'upload-' + String(uploadCounter);
          uploads.set(id, { path, sha256Meta: meta, parts: new Map() });
          return end(
            res,
            200,
            '<InitiateMultipartUploadResult><UploadId>' +
              id +
              '</UploadId></InitiateMultipartUploadResult>'
          );
        }
        if (method === 'POST' && query.uploadId) {
          const upload = uploads.get(query.uploadId);
          if (!upload) return end(res, 404, 'NoSuchUpload');
          const listed = [...upload.parts.entries()].sort(
            (a, b) => a[0] - b[0]
          );
          objects.set(path, {
            size: listed.reduce((s, [, p]) => s + p.size, 0),
            sha256Meta: upload.sha256Meta,
            parts: listed.map(([, p]) => ({ size: p.size, sha256: p.sha256 })),
          });
          uploads.delete(query.uploadId);
          return end(res, 200, '<CompleteMultipartUploadResult/>');
        }
        if (method === 'DELETE' && query.uploadId) {
          uploads.delete(query.uploadId);
          aborted.push(query.uploadId);
          return end(res, 204);
        }
        return end(res, 400);
      } finally {
        inFlight -= declared;
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint:
      'http://127.0.0.1:' + String((server.address() as AddressInfo).port),
    objects,
    requests,
    aborted,
    peakBodyBytesInFlight: () => peak,
    resetPeak: () => {
      peak = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
