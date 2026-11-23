/**
 * AWS Signature Version 4 query-string presigning (UNSIGNED-PAYLOAD) for the
 * R2 S3-compatible endpoint, built on Web Crypto only so it runs unchanged in
 * the Workers bundle, on Node and in unit tests (#286).
 *
 * The signing key is derived once per presigner; each URL then costs one
 * SHA-256 and one HMAC, both native, which keeps a 32-part upload far below
 * the Workers Free CPU budget.
 */

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

/** RFC 3986 unreserved set, as SigV4 requires (not encodeURIComponent). */
export function sigV4Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Encode an object key path once per segment, keeping the separators. */
export function sigV4EncodePath(path: string): string {
  return path.split('/').map(sigV4Encode).join('/');
}

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: string
): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', imported, encoder.encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

export interface SigV4PresignRequest {
  method: string;
  /** Host header value, e.g. `<account>.r2.cloudflarestorage.com`. */
  host: string;
  /** Unencoded absolute path, e.g. `/bucket/communities/1/media/<id>`. */
  path: string;
  /** Extra query parameters (unencoded), e.g. partNumber and uploadId. */
  query?: Record<string, string>;
  /** Extra signed request headers (the client must send exactly these). */
  signedHeaders?: Record<string, string>;
  expiresSeconds: number;
  now: Date;
}

export interface SigV4Presigner {
  presign(request: SigV4PresignRequest): Promise<string>;
}

/** Derive the signing key for one UTC day and return a reusable presigner. */
export async function createSigV4Presigner(
  credentials: SigV4Credentials,
  now: Date
): Promise<SigV4Presigner> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  let key: ArrayBuffer = await hmac(
    encoder.encode(`AWS4${credentials.secretAccessKey}`),
    dateStamp
  );
  key = await hmac(key, credentials.region);
  key = await hmac(key, credentials.service);
  key = await hmac(key, 'aws4_request');
  const signingKey = key;

  return {
    async presign(request) {
      if (
        !Number.isInteger(request.expiresSeconds) ||
        request.expiresSeconds < 1 ||
        request.expiresSeconds > 604800
      ) {
        throw new RangeError('expiresSeconds must be 1..604800');
      }
      const headers: Record<string, string> = { host: request.host };
      for (const [name, value] of Object.entries(request.signedHeaders ?? {})) {
        headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
      }
      const names = Object.keys(headers).sort();
      const canonicalHeaders = names
        .map((name) => `${name}:${headers[name]}\n`)
        .join('');
      const signedHeaders = names.join(';');
      const query: Record<string, string> = {
        ...(request.query ?? {}),
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(request.expiresSeconds),
        'X-Amz-SignedHeaders': signedHeaders,
      };
      const canonicalQuery = Object.entries(query)
        .map(([k, v]) => [sigV4Encode(k), sigV4Encode(v)] as const)
        .sort((a, b) =>
          a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1
        )
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const canonicalPath = sigV4EncodePath(request.path);
      const canonicalRequest = [
        request.method.toUpperCase(),
        canonicalPath,
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        await sha256Hex(canonicalRequest),
      ].join('\n');
      const signature = toHex(await hmac(signingKey, stringToSign));
      return `https://${request.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    },
  };
}
