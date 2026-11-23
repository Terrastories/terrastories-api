/**
 * MUST-VERIFY-ON-STAGING (#286): does R2 accept or enforce a signed
 * `x-amz-checksum-sha256` on UploadPart?
 *
 * Cloudflare's S3 compatibility page lists only Content-MD5 for UploadPart and
 * community reports describe 501 NotImplemented for the SHA-256 header, so the
 * API signs only Content-Length on presigned parts and does not rely on a part
 * checksum. This script records the actual behaviour of your bucket: it creates
 * a multipart upload through the S3 API, sends a deliberately corrupted part
 * with a signed checksum header, and aborts the upload.
 *
 * Usage (secrets from the environment only, never printed):
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *   R2_BUCKET_NAME=<staging bucket> npx tsx scripts/staging/verify-r2-part-checksum.ts
 *
 * Exit 0: R2 rejected the corrupted part (checksum enforced; per-part signed
 * checksums could be reintroduced). Exit 2: R2 accepted it or answered 501
 * (keep relying on size + sniff). Exit 1: misconfiguration.
 */
import { createHash } from 'node:crypto';
import { createSigV4Presigner } from '../../src/shared/utils/sigv4-presign.js';

const env = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
};

const accountId = env('R2_ACCOUNT_ID');
const bucket = env('R2_BUCKET_NAME');
const host = `${accountId}.r2.cloudflarestorage.com`;
const now = new Date();
const presigner = await createSigV4Presigner(
  {
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    region: 'auto',
    service: 's3',
  },
  now
);
const key = `staging-verify/checksum-probe-${crypto.randomUUID()}`;
const path = `/${bucket}/${key}`;
const sign = (method: string, query: Record<string, string>, headers = {}) =>
  presigner.presign({
    method,
    host,
    path,
    query,
    signedHeaders: headers,
    expiresSeconds: 300,
    now,
  });

const created = await fetch(await sign('POST', { uploads: '' }), {
  method: 'POST',
});
const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(
  await created.text()
)?.[1];
if (!created.ok || !uploadId) {
  console.error(`CreateMultipartUpload failed: HTTP ${created.status}`);
  process.exit(1);
}

const good = new Uint8Array(6 * 1024 * 1024).fill(7);
const corrupted = good.slice();
corrupted[0] = 8;
const claimed = createHash('sha256').update(good).digest('base64');
const part = await fetch(
  await sign(
    'PUT',
    { partNumber: '1', uploadId },
    {
      'content-length': String(corrupted.byteLength),
      'x-amz-checksum-sha256': claimed,
    }
  ),
  {
    method: 'PUT',
    headers: { 'x-amz-checksum-sha256': claimed },
    body: corrupted,
  }
);
await fetch(await sign('DELETE', { uploadId }), { method: 'DELETE' });

if (part.status >= 400 && part.status !== 501) {
  console.log(
    `R2 REJECTED the corrupted part (HTTP ${part.status}): signed checksum is enforced.`
  );
  process.exit(0);
}
console.log(
  part.status === 501
    ? 'R2 answered 501: the signed checksum header is not implemented for UploadPart.'
    : `R2 ACCEPTED the corrupted part (HTTP ${part.status}): the checksum is not enforced.`
);
process.exit(2);
