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
 * Exit 0: R2 rejected the corrupted part with a checksum error code AND a
 * control part with the correct checksum succeeded (enforced). Exit 2: the
 * corrupted part was accepted (not enforced; keep relying on size + sniff).
 * Exit 1: inconclusive (misconfiguration, 501, or any other error).
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

const putPart = async (
  partNumber: string,
  bytes: Uint8Array,
  checksum: string
) => {
  const response = await fetch(
    await sign(
      'PUT',
      { partNumber, uploadId },
      {
        'content-length': String(bytes.byteLength),
        'x-amz-checksum-sha256': checksum,
      }
    ),
    {
      method: 'PUT',
      headers: { 'x-amz-checksum-sha256': checksum },
      body: bytes,
    }
  );
  return { status: response.status, text: await response.text() };
};

// Control: a correct checksum must succeed, otherwise nothing below means
// anything (bad signing, 501, permissions...).
const control = await putPart('1', good, claimed);
const probe = await putPart('2', corrupted, claimed);
await fetch(await sign('DELETE', { uploadId }), { method: 'DELETE' });

const checksumError =
  /<Code>(BadDigest|InvalidDigest|XAmzContentChecksumMismatch)<\/Code>/.test(
    probe.text
  );
if (control.status >= 200 && control.status < 300) {
  if (probe.status >= 400 && checksumError) {
    console.log(
      `R2 ENFORCES the signed checksum: corrupted part refused with a checksum error (HTTP ${probe.status}), control accepted.`
    );
    process.exit(0);
  }
  if (probe.status >= 200 && probe.status < 300) {
    console.log(
      'R2 ACCEPTED the corrupted part: the checksum is not enforced.'
    );
    process.exit(2);
  }
}
console.log(
  `INCONCLUSIVE: control HTTP ${control.status}, corrupted-part HTTP ${probe.status} without a checksum error code (501 means the header is not implemented). Fix the setup and rerun.`
);
process.exit(1);
