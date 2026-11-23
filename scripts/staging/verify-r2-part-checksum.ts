/**
 * Verify that R2 enforces the SHA-256 payload hash on a presigned UploadPart.
 * Run with staging R2 credentials in the environment:
 *   R2_BUCKET_NAME=<staging bucket> npx tsx scripts/staging/verify-r2-part-checksum.ts
 *
 * Exit 0: hash enforced. Exit 2: corrupted bytes accepted.
 * Exit 1: inconclusive, including failure to confirm cleanup.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createSigV4Presigner } from '../../src/shared/utils/sigv4-presign.js';

async function probe(): Promise<number> {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    console.error(
      'INCONCLUSIVE: configure R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.'
    );
    return 1;
  }
  if (
    !/^[0-9a-zA-Z-]{1,64}$/.test(accountId) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
  ) {
    console.error('INCONCLUSIVE: invalid R2 account or bucket name.');
    return 1;
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/staging-verify/checksum-probe-${randomUUID()}`;
  const now = new Date();
  const presigner = await createSigV4Presigner(
    {
      accessKeyId,
      secretAccessKey,
      region: 'auto',
      service: 's3',
    },
    now
  );
  const sign = (
    method: string,
    query: Record<string, string>,
    signedHeaders?: Record<string, string>
  ) =>
    presigner.presign({
      method,
      host,
      path,
      query,
      signedHeaders,
      expiresSeconds: 300,
      now,
    });
  const send = (url: string, init: RequestInit) =>
    fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });

  const created = await send(await sign('POST', { uploads: '' }), {
    method: 'POST',
  });
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(
    await created.text()
  )?.[1];
  if (!created.ok || !uploadId) {
    console.error(
      `INCONCLUSIVE: CreateMultipartUpload HTTP ${created.status} or missing upload ID.`
    );
    return 1;
  }

  let controlStatus: number;
  let corruptStatus: number | undefined;
  let mismatch = false;
  try {
    const good = new Uint8Array(16 * 1024 * 1024).fill(7);
    const corrupted = good.slice();
    corrupted[0] = 8;
    const headers = {
      'content-length': String(good.byteLength),
      'x-amz-content-sha256': createHash('sha256').update(good).digest('hex'),
    };
    const url = await sign('PUT', { partNumber: '1', uploadId }, headers);
    const put = (body: Uint8Array<ArrayBuffer>) =>
      send(url, { method: 'PUT', headers, body });

    const control = await put(good);
    controlStatus = control.status;
    await control.body?.cancel();
    if (controlStatus === 200) {
      const corrupt = await put(corrupted);
      corruptStatus = corrupt.status;
      mismatch = /<Code>XAmzContentSHA256Mismatch<\/Code>/.test(
        await corrupt.text()
      );
    }
  } finally {
    const aborted = await send(await sign('DELETE', { uploadId }), {
      method: 'DELETE',
    });
    await aborted.body?.cancel();
    if (!aborted.ok) throw new Error('AbortMultipartUpload failed');
  }

  if (corruptStatus !== undefined) {
    if (corruptStatus >= 400 && corruptStatus < 500 && mismatch) {
      console.log(
        `R2 ENFORCED the signed payload hash (control HTTP 200, corrupted part HTTP ${corruptStatus} XAmzContentSHA256Mismatch).`
      );
      return 0;
    }
    if (corruptStatus >= 200 && corruptStatus < 300) {
      console.error(`R2 ACCEPTED corrupted bytes (HTTP ${corruptStatus}).`);
      return 2;
    }
  }
  console.error(
    `INCONCLUSIVE: control HTTP ${controlStatus}, corrupted part ${corruptStatus ?? 'skipped'}.`
  );
  return 1;
}

try {
  process.exitCode = await probe();
} catch {
  // Network errors may contain signed URLs. Keep the output credential-free.
  console.error('INCONCLUSIVE: R2 probe request or cleanup failed.');
  process.exitCode = 1;
}
