/**
 * Large direct-upload helper for the staging CPU measurement (the 300 MB
 * multipart step of `scripts/staging/smoke.sh --cpu-procedure`):
 * create -> PUT parts -> complete -> DELETE media, requiring 2xx on every
 * call. Credentials come from the environment only and are never printed;
 * presigned part URLs (which carry write capabilities) are never printed.
 *
 *   STAGING_URL=https://terrastories-staging-api.<sub>.workers.dev \
 *   WT_SUPER_IDENTIFIER=... WT_SUPER_PASSWORD=... \
 *     npx tsx scripts/staging/upload-large.ts --file sample300.mp4
 *
 *   --dry-run        read the file and print the upload plan; no network call,
 *                    no credentials needed
 *   --local          rehearsal against a loopback workerd (http://127.0.0.1:...)
 *   --content-type   declared MIME type (default video/mp4)
 *
 * The super admin uploads an UNBOUND media object (no role) and the helper
 * deletes it again after completion, so staging keeps no measurement object.
 * On Workers the create call answers 501 unless the bucket-scoped R2 S3
 * credentials are configured (SPEC-V2 section 6.7).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GuardError, STAGING_PREFIX, assertStagingUrl } from './guards.js';
import { loginMaterial, type PreloginAnswer } from '../walkthrough/kdf.js';

/** The API's default and minimum part size (16 MiB); maximum is 64 MiB. */
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
export const MAX_PART_SIZE = 64 * 1024 * 1024;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PartPlan {
  partNumber: number;
  offset: number;
  size: number;
}

/** Split a file size into the exact part slices the session will declare. */
export function planParts(size: number, partSize: number): PartPlan[] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('file size must be a positive integer');
  }
  if (
    !Number.isSafeInteger(partSize) ||
    partSize < DEFAULT_PART_SIZE ||
    partSize > MAX_PART_SIZE
  ) {
    throw new Error('partSize must be between 16 MiB and 64 MiB');
  }
  const parts: PartPlan[] = [];
  for (let offset = 0, n = 1; offset < size; offset += partSize, n += 1) {
    parts.push({
      partNumber: n,
      offset,
      size: Math.min(partSize, size - offset),
    });
  }
  return parts;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface UploadFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/** The JSON body of POST /v2/media/uploads (CreateDirectUploadRequest). */
export function buildCreateBody(
  file: UploadFile,
  partSize: number = DEFAULT_PART_SIZE
): {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  partSize: number;
  partSha256: string[];
} {
  const plans = planParts(file.bytes.byteLength, partSize);
  return {
    filename: file.name,
    contentType: file.contentType,
    size: file.bytes.byteLength,
    sha256: sha256Hex(file.bytes),
    partSize,
    partSha256: plans.map((p) =>
      sha256Hex(file.bytes.subarray(p.offset, p.offset + p.size))
    ),
  };
}

interface PartTarget {
  partNumber: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  size: number;
}

interface Session {
  id: string;
  mode: 'presigned' | 'api';
  parts: PartTarget[];
}

function parseSession(body: unknown): Session {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (
    !data ||
    typeof data.id !== 'string' ||
    (data.mode !== 'presigned' && data.mode !== 'api') ||
    !Array.isArray(data.parts)
  ) {
    throw new Error('create answered 2xx but the session shape is unexpected');
  }
  const parts = data.parts as Array<Record<string, unknown>>;
  for (const p of parts) {
    if (
      typeof p.partNumber !== 'number' ||
      p.method !== 'PUT' ||
      typeof p.url !== 'string' ||
      typeof p.size !== 'number' ||
      !p.headers ||
      typeof p.headers !== 'object'
    ) {
      throw new Error('create returned a malformed part target');
    }
  }
  return {
    id: data.id,
    mode: data.mode,
    parts: parts as unknown as PartTarget[],
  };
}

/** Strip the quotes S3/R2 wrap around the ETag header value. */
export function cleanEtag(raw: string | null): string {
  return (raw ?? '').replace(/^"|"$/g, '');
}

export interface UploadInput {
  baseUrl: string;
  cookie: string;
  file: UploadFile;
  partSize?: number;
}

export interface UploadDeps {
  fetch: FetchLike;
  log?: (line: string) => void;
}

export interface UploadOutcome {
  sessionId: string;
  mediaId: string;
  mode: string;
  partCount: number;
  createMs: number;
  completeMs: number;
  deleteMs: number;
}

const jsonHeaders = (cookie: string): Record<string, string> => ({
  'content-type': 'application/json',
  cookie,
});

/** R2 S3 endpoint host: <account-id>.r2.cloudflarestorage.com (never the cookie's host). */
const R2_HOST_RE = /^[a-z0-9]+\.r2\.cloudflarestorage\.com$/;

/**
 * Validate where a part PUT goes BEFORE any byte or cookie is sent.
 * mode:api targets must share the validated staging origin (the cookie is
 * attached only then); presigned targets must be https R2 S3 URLs for a
 * terrastories-staging-* bucket and never get the cookie.
 */
export function assertPartTarget(
  targetUrl: string,
  baseUrl: string,
  mode: 'presigned' | 'api'
): void {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new Error('part target is not a valid URL');
  }
  if (mode === 'api') {
    if (target.origin !== new URL(baseUrl).origin) {
      throw new Error(
        'part target origin does not match the staging origin: refusing to send the session cookie'
      );
    }
    return;
  }
  if (
    target.protocol !== 'https:' ||
    !R2_HOST_RE.test(target.hostname) ||
    !target.pathname.startsWith(`/${STAGING_PREFIX}`)
  ) {
    throw new Error(
      `presigned part target is not an https R2 URL for a ${STAGING_PREFIX}* bucket`
    );
  }
}

/**
 * Run create -> parts -> complete -> delete. Every call must answer 2xx.
 * A failure before completion best-effort aborts the upload session so no
 * staged bytes are left behind; nothing here ever prints the cookie or a
 * presigned part URL.
 */
export async function runUpload(
  input: UploadInput,
  deps: UploadDeps
): Promise<UploadOutcome> {
  const { baseUrl, cookie, file } = input;
  const partSize = input.partSize ?? DEFAULT_PART_SIZE;
  const log = deps.log ?? ((): void => {});
  const plans = planParts(file.bytes.byteLength, partSize);
  const createBody = buildCreateBody(file, partSize);

  const createStart = Date.now();
  const created = await deps.fetch(`${baseUrl}/v2/media/uploads`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(createBody),
    redirect: 'error',
  });
  const createMs = Date.now() - createStart;
  if (!created.ok) {
    const hint =
      created.status === 501
        ? ' (direct upload is not configured on this deployment: the Workers profile needs the bucket-scoped R2 S3 credentials)'
        : '';
    throw new Error(
      `POST /v2/media/uploads answered ${created.status} (expected 2xx)${hint}`
    );
  }
  const session = parseSession(await created.json());
  log(
    `create ${created.status} in ${createMs} ms (session ${session.id}, mode ${session.mode}, ${session.parts.length} parts)`
  );
  if (session.parts.length !== plans.length) {
    await abortSession(deps, baseUrl, cookie, session.id);
    throw new Error(
      `session declares ${session.parts.length} parts but the file plans ${plans.length}`
    );
  }

  let completed = false;
  try {
    const targets = [...session.parts].sort(
      (a, b) => a.partNumber - b.partNumber
    );
    // Every target is validated before the first PUT: nothing is sent (and
    // the cookie never leaves) if any one of them points off-origin.
    for (const target of targets) {
      assertPartTarget(target.url, baseUrl, session.mode);
    }
    const etags: Array<{ partNumber: number; etag: string }> = [];
    for (const target of targets) {
      const plan = plans[target.partNumber - 1];
      if (!plan || target.size !== plan.size) {
        throw new Error(
          `part ${target.partNumber}: target size does not match the file plan`
        );
      }
      // Send EXACTLY the returned headers; the session cookie goes only to
      // the validated staging origin (mode:api). Presigned R2 URLs are
      // credential-free: any cookie header the session returned is dropped.
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(target.headers)) {
        if (session.mode === 'presigned' && k.toLowerCase() === 'cookie')
          continue;
        headers[k] = v;
      }
      if (session.mode === 'api') headers.cookie = cookie;
      const slice = file.bytes.subarray(plan.offset, plan.offset + plan.size);
      const start = Date.now();
      // fetch derives Content-Length from the byte body (the presigned URL
      // signs exactly that length); setting it by hand is a forbidden header.
      const res = await deps.fetch(target.url, {
        method: 'PUT',
        headers,
        body: slice,
        redirect: 'error',
      });
      if (!res.ok) {
        throw new Error(
          `part ${target.partNumber} PUT answered ${res.status} (expected 2xx)`
        );
      }
      let etag = cleanEtag(res.headers.get('etag'));
      if (!etag) {
        const body = (await res.json().catch(() => null)) as {
          data?: { etag?: string };
        } | null;
        etag = body?.data?.etag ?? '';
      }
      if (!etag) {
        throw new Error(`part ${target.partNumber}: no ETag in the response`);
      }
      etags.push({ partNumber: target.partNumber, etag });
      log(
        `part ${target.partNumber}/${targets.length} ${res.status} (${plan.size} bytes, ${Date.now() - start} ms)`
      );
    }

    const completeStart = Date.now();
    const done = await deps.fetch(
      `${baseUrl}/v2/media/uploads/${session.id}/complete`,
      {
        method: 'POST',
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ parts: etags }),
        redirect: 'error',
      }
    );
    const completeMs = Date.now() - completeStart;
    if (!done.ok) {
      throw new Error(
        `POST /v2/media/uploads/:id/complete answered ${done.status} (expected 2xx)`
      );
    }
    completed = true;
    const mediaId = ((await done.json()) as { data?: { id?: string } } | null)
      ?.data?.id;
    if (typeof mediaId !== 'string' || !mediaId) {
      throw new Error('complete answered 2xx but returned no media id');
    }
    log(`complete ${done.status} in ${completeMs} ms (media ${mediaId})`);

    const deleteStart = Date.now();
    const removed = await deps.fetch(`${baseUrl}/v2/media/${mediaId}`, {
      method: 'DELETE',
      headers: { cookie },
      redirect: 'error',
    });
    const deleteMs = Date.now() - deleteStart;
    if (!removed.ok) {
      throw new Error(
        `DELETE /v2/media/${mediaId} answered ${removed.status} (expected 2xx): remove the measurement object manually`
      );
    }
    log(
      `delete ${removed.status} in ${deleteMs} ms (measurement object removed)`
    );
    return {
      sessionId: session.id,
      mediaId,
      mode: session.mode,
      partCount: targets.length,
      createMs,
      completeMs,
      deleteMs,
    };
  } catch (error) {
    // Before completion the session still owns staged bytes: abort it so the
    // orphan sweep has nothing to reclaim. After completion the session is
    // gone; the media id in the error tells the operator what to delete.
    if (!completed) await abortSession(deps, baseUrl, cookie, session.id);
    throw error;
  }
}

async function abortSession(
  deps: UploadDeps,
  baseUrl: string,
  cookie: string,
  sessionId: string
): Promise<void> {
  try {
    const res = await deps.fetch(`${baseUrl}/v2/media/uploads/${sessionId}`, {
      method: 'DELETE',
      headers: { cookie },
      redirect: 'error',
    });
    deps.log?.(`abort ${res.status} (upload session ${sessionId})`);
  } catch {
    deps.log?.('abort failed (the orphan sweep will reclaim the session)');
  }
}

/**
 * Sign in as the super admin (prelogin -> client stretching -> login) and
 * return the ts_session cookie as a Cookie header value ("ts_session=...").
 * The password, derived key and cookie are held in memory only; errors name
 * routes and statuses, never values.
 */
export async function loginSuper(
  fetchImpl: FetchLike,
  baseUrl: string,
  identifier: string,
  password: string
): Promise<string> {
  const pre = await fetchImpl(`${baseUrl}/v2/auth/prelogin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
    redirect: 'error',
  });
  if (pre.status !== 200) {
    throw new Error(
      `POST /v2/auth/prelogin answered ${pre.status} (expected 200)`
    );
  }
  const material = await loginMaterial(
    password,
    (await pre.json()) as PreloginAnswer
  );
  const loginBody: Record<string, unknown> = {
    identifier,
    derivedKey: material.derivedKey,
  };
  if (material.upgrade) loginBody.upgrade = material.upgrade;
  const res = await fetchImpl(`${baseUrl}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(loginBody),
    redirect: 'error',
  });
  if (res.status !== 200) {
    throw new Error(
      `POST /v2/auth/login answered ${res.status} (expected 200)`
    );
  }
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair!.indexOf('=');
    if (eq > 0 && pair!.slice(0, eq).trim() === 'ts_session') {
      const value = pair!.slice(eq + 1).trim();
      if (value) return `ts_session=${value}`;
    }
  }
  throw new Error('login succeeded but no ts_session cookie was set');
}

const USAGE = `Usage: STAGING_URL=... WT_SUPER_IDENTIFIER=... WT_SUPER_PASSWORD=... \\
  npx tsx scripts/staging/upload-large.ts --file <path> [options]
  --file <path>        media file to upload (a real mp4/webm sample, ~300 MB)
  --dry-run            print the upload plan; no network call, no credentials
  --local              loopback workerd rehearsal (http://127.0.0.1:<port>)
  --content-type <t>   declared MIME type (default video/mp4)
Credentials are read from the environment only and never printed.`;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  let file = '';
  let dryRun = false;
  let local = false;
  let contentType = 'video/mp4';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const need = (): string => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--file') file = need();
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--local') local = true;
    else if (arg === '--content-type') contentType = need();
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n');
      return 0;
    } else {
      process.stderr.write(`Unknown argument ${arg}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!file) {
    process.stderr.write(`--file is required\n${USAGE}\n`);
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch {
    process.stderr.write(`cannot read ${file}\n`);
    return 2;
  }
  const name = basename(file);
  let plans: PartPlan[];
  try {
    plans = planParts(bytes.byteLength, DEFAULT_PART_SIZE);
  } catch (error) {
    process.stderr.write(
      `cannot plan an upload for ${file}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
  if (dryRun) {
    const body = buildCreateBody({ name, contentType, bytes });
    process.stdout.write(
      [
        `dry run: no network call, no credentials used`,
        `file: ${name} (${bytes.byteLength} bytes, ${contentType})`,
        `sha256: ${body.sha256}`,
        `partSize: ${DEFAULT_PART_SIZE} bytes, parts: ${plans.length}`,
        ...plans.map(
          (p) =>
            `  part ${p.partNumber}: offset ${p.offset}, ${p.size} bytes, sha256 ${body.partSha256[p.partNumber - 1]}`
        ),
        `plan: POST /v2/media/uploads -> PUT each returned part target (exact headers) -> POST /v2/media/uploads/<id>/complete -> DELETE /v2/media/<fileId>`,
        `every call must answer 2xx; record cpuTime/wallTime of create AND complete from wrangler tail (parse-tail.mjs)`,
      ].join('\n') + '\n'
    );
    return 0;
  }
  const baseUrl = env.STAGING_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    process.stderr.write('STAGING_URL is required (environment only)\n');
    return 2;
  }
  try {
    assertStagingUrl(baseUrl, env.STAGING_ALLOW_HOST, local);
  } catch (error) {
    if (error instanceof GuardError) {
      process.stderr.write(error.message + '\n');
      return 1;
    }
    throw error;
  }
  const identifier = env.WT_SUPER_IDENTIFIER?.trim();
  const password = env.WT_SUPER_PASSWORD;
  if (!identifier || !password) {
    process.stderr.write(
      'WT_SUPER_IDENTIFIER and WT_SUPER_PASSWORD are required (environment only)\n'
    );
    return 2;
  }
  const log = (line: string): void => {
    process.stdout.write(`-- ${line}\n`);
  };
  try {
    const cookie = await loginSuper(fetch, baseUrl, identifier, password);
    log('signed in (session cookie held in memory, never printed)');
    const outcome = await runUpload(
      { baseUrl, cookie, file: { name, contentType, bytes } },
      { fetch, log }
    );
    log(
      `done: ${outcome.partCount} parts, mode ${outcome.mode}; wall ms create=${outcome.createMs} complete=${outcome.completeMs} delete=${outcome.deleteMs} (CPU times come from wrangler tail)`
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
