import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface FakeS3RecordedRequest {
  method: string;
  path: string;
  bucket: string | null;
  objectKey: string | null;
  headers: IncomingHttpHeaders;
}

export type FakeS3ObjectOutcome =
  | { kind: 'ok'; body: Buffer; contentLengthOverride?: string }
  | { kind: 'status'; status: number; body?: string }
  | {
      kind: 'custom';
      handle: (
        req: IncomingMessage,
        res: ServerResponse
      ) => Promise<void> | void;
    };

export interface FakeS3ServerOptions {
  expectedCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
  };
  onGetObject: (
    objectKey: string,
    attemptForKey: number,
    bucket: string
  ) => Promise<FakeS3ObjectOutcome> | FakeS3ObjectOutcome;
}

export interface FakeS3Server {
  endpoint: string;
  requests: FakeS3RecordedRequest[];
  getAttemptCount: (objectKey: string) => number;
  getMaxInFlight: () => number;
  close: () => Promise<void>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function verifySigV4Authorization(
  req: IncomingMessage,
  url: URL,
  expected: NonNullable<FakeS3ServerOptions['expectedCredentials']>
): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  const match = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/
  );
  if (!match) return false;

  const [, accessKeyId, dateStamp, region, signedHeadersRaw, providedSig] =
    match;
  if (
    accessKeyId !== expected.accessKeyId ||
    region !== expected.region ||
    !signedHeadersRaw
  ) {
    return false;
  }

  const amzDate = req.headers['x-amz-date'];
  if (typeof amzDate !== 'string' || !amzDate.startsWith(dateStamp!)) {
    return false;
  }
  if (expected.sessionToken !== undefined) {
    if (req.headers['x-amz-security-token'] !== expected.sessionToken) {
      return false;
    }
  }

  const signedHeaders = signedHeadersRaw.split(';');
  if (
    !signedHeaders.includes('host') ||
    !signedHeaders.includes('x-amz-date') ||
    !signedHeaders.includes('x-amz-content-sha256')
  ) {
    return false;
  }

  const canonicalHeaders = signedHeaders
    .map((headerName) => {
      const value = req.headers[headerName];
      const normalized = Array.isArray(value)
        ? value.join(',').trim()
        : (value ?? '').trim();
      return `${headerName}:${normalized}\n`;
    })
    .join('');

  const canonicalRequest = [
    req.method ?? 'GET',
    url.pathname || '/',
    '',
    canonicalHeaders,
    signedHeadersRaw,
    EMPTY_PAYLOAD_SHA256,
  ].join('\n');

  const credentialScope = `${dateStamp}/${expected.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${expected.secretAccessKey}`, dateStamp!);
  const kRegion = hmacSha256(kDate, expected.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const expectedSig = hmacSha256(kSigning, stringToSign).toString('hex');

  return timingSafeEqual(
    Buffer.from(expectedSig, 'hex'),
    Buffer.from(providedSig!, 'hex')
  );
}

export async function startFakeS3Server(
  options: FakeS3ServerOptions
): Promise<FakeS3Server> {
  const requests: FakeS3RecordedRequest[] = [];
  const attemptsByKey = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;

  const server = createServer((req, res) => {
    void (async () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;

      try {
        const host = req.headers.host ?? '127.0.0.1';
        const url = new URL(req.url ?? '/', `http://${host}`);
        const pathWithoutLeadingSlash = url.pathname.replace(/^\/+/, '');
        const slashIndex = pathWithoutLeadingSlash.indexOf('/');
        const bucket =
          slashIndex === -1
            ? null
            : decodeURIComponent(pathWithoutLeadingSlash.slice(0, slashIndex));
        const objectKey =
          slashIndex === -1
            ? null
            : decodeURIComponent(pathWithoutLeadingSlash.slice(slashIndex + 1));

        requests.push({
          method: req.method ?? 'GET',
          path: url.pathname,
          bucket,
          objectKey,
          headers: req.headers,
        });

        if (
          options.expectedCredentials &&
          !verifySigV4Authorization(req, url, options.expectedCredentials)
        ) {
          res.statusCode = 403;
          res.end('SignatureDoesNotMatch');
          return;
        }

        if (!bucket || !objectKey || req.method !== 'GET') {
          res.statusCode = 404;
          res.end('NotFound');
          return;
        }

        const attempt = (attemptsByKey.get(objectKey) ?? 0) + 1;
        attemptsByKey.set(objectKey, attempt);

        const outcome = await options.onGetObject(objectKey, attempt, bucket);
        if (outcome.kind === 'custom') {
          await outcome.handle(req, res);
          return;
        }
        if (outcome.kind === 'status') {
          res.statusCode = outcome.status;
          res.end(outcome.body ?? '');
          return;
        }

        res.statusCode = 200;
        res.setHeader(
          'Content-Length',
          outcome.contentLengthOverride ?? String(outcome.body.length)
        );
        res.end(outcome.body);
      } finally {
        inFlight -= 1;
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    getAttemptCount: (objectKey: string) => attemptsByKey.get(objectKey) ?? 0,
    getMaxInFlight: () => maxInFlight,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
