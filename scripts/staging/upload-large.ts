/**
 * Large direct-upload helper for the staging CPU measurement (the 300 MB
 * multipart step of `scripts/staging/smoke.sh --cpu-procedure`):
 * create -> PUT parts -> complete -> DELETE media, requiring 2xx on every
 * call. Credentials come from the environment only and are never printed;
 * presigned part URLs (which carry write capabilities) are never printed.
 *
 * Direct upload authorizes by the actor's role IN a community, so a super
 * admin (who has no membership) gets 403. The helper therefore signs in as the
 * super admin only to provision a throwaway community ("stg-upload-<random>")
 * with a throwaway community admin (random password, memory only), uploads as
 * that admin, deletes the media, and disables the community again (always on
 * normal exit and on SIGINT/SIGTERM; a SIGKILL leaves the community active:
 * disable stg-upload-<slug> by hand). The slug is printed BEFORE the create call.
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
 * The throwaway admin uploads an UNBOUND media object (no role) and the helper
 * deletes it again after completion, so staging keeps no measurement object.
 * The community cannot be deleted once claimed; it stays behind disabled.
 * On Workers the create call answers 501 unless the bucket-scoped R2 S3
 * credentials are configured (SPEC-V2 section 6.7).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GuardError, STAGING_PREFIX, assertStagingUrl } from './guards.js';
import {
  loginMaterial,
  newVerifier,
  randomPassword,
  type PreloginAnswer,
} from '../walkthrough/kdf.js';

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
  createStatus: number;
  partStatuses: number[];
  completeStatus: number;
  deleteStatus: number;
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
    const partStatuses: number[] = [];
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
      partStatuses.push(res.status);
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
      `delete ${removed.status} in ${deleteMs} ms (file record deleted; storage removal not verified by the API)`
    );
    return {
      sessionId: session.id,
      mediaId,
      mode: session.mode,
      partCount: targets.length,
      createMs,
      completeMs,
      deleteMs,
      createStatus: created.status,
      partStatuses,
      completeStatus: done.status,
      deleteStatus: removed.status,
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
 * Sign in as any user (prelogin -> client stretching -> login) and
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

export interface Throwaway {
  id: number;
  slug: string;
  adminIdentifier: string;
  /** Held in memory only; never logged. */
  adminPassword: string;
}

async function expectJson(
  res: Response,
  route: string,
  expected: number[]
): Promise<Record<string, unknown>> {
  if (!expected.includes(res.status)) {
    throw new Error(
      `${route} answered ${res.status} (expected ${expected.join(' or ')})`
    );
  }
  return ((await res.json().catch(() => null)) ?? {}) as Record<
    string,
    unknown
  >;
}

/** Largest page the admin list route serves. */
const ADMIN_PAGE = 100;

/**
 * Validate an admin community body: data.id must match (when expectId is
 * given), data.slug must match, and data.status must be the expected value.
 */
function communityMatches(
  body: unknown,
  want: { slug: string; id?: number; status?: string }
): { id: number } | undefined {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!data || data.slug !== want.slug) return undefined;
  const id = data.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    return undefined;
  if (want.id !== undefined && id !== want.id) return undefined;
  if (want.status !== undefined && data.status !== want.status)
    return undefined;
  return { id };
}

/**
 * Find a community by EXACT slug as the super admin. The list route has no
 * slug filter, so scan the newest pages (rows are ordered by id ascending).
 * Returns undefined when not found or when any call fails.
 */
export async function findCommunityBySlug(
  fetchImpl: FetchLike,
  baseUrl: string,
  superCookie: string,
  slug: string
): Promise<number | undefined> {
  try {
    const page = async (
      offset: number
    ): Promise<{ rows: unknown[]; total: number } | undefined> => {
      const res = await fetchImpl(
        `${baseUrl}/v2/admin/communities?limit=${ADMIN_PAGE}&offset=${offset}`,
        { method: 'GET', headers: { cookie: superCookie }, redirect: 'error' }
      );
      if (res.status !== 200) return undefined;
      const body = (await res.json().catch(() => null)) as {
        data?: unknown;
        meta?: { total?: unknown };
      } | null;
      if (!Array.isArray(body?.data) || typeof body?.meta?.total !== 'number')
        return undefined;
      return { rows: body.data, total: body.meta.total };
    };
    const first = await page(0);
    if (!first) return undefined;
    const lastOffset = Math.max(
      0,
      Math.floor((first.total - 1) / ADMIN_PAGE) * ADMIN_PAGE
    );
    // The new community is the newest row: scan the last pages first.
    for (const offset of [lastOffset, Math.max(0, lastOffset - ADMIN_PAGE)]) {
      const p = offset === 0 ? first : await page(offset);
      if (!p) return undefined;
      for (const row of p.rows) {
        const hit = communityMatches({ data: row }, { slug });
        if (hit) return hit.id;
      }
      if (offset === 0) break;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface ProvisionOptions {
  log?: (line: string) => void;
  /** Called with the generated slug BEFORE the create request is sent. */
  onSlug?: (slug: string) => void;
  /** Seam for tests: the throwaway admin's password generator. */
  randomPassword?: () => string;
}

/**
 * As the super admin: create the throwaway community, issue a claim token and
 * claim it as a new community admin with a random password (the same route
 * the persona walkthrough uses). The slug is printed and reported BEFORE the
 * create call, and the community is returned (via onCreated) only once the
 * create response is validated (same slug, positive safe integer id).
 */
export async function provisionThrowaway(
  fetchImpl: FetchLike,
  baseUrl: string,
  superCookie: string,
  onCreated: (t: Throwaway) => void,
  options: ProvisionOptions = {}
): Promise<Throwaway> {
  const slug = `stg-upload-${randomBytes(4).toString('hex')}`;
  options.log?.(`creating community ${slug}`);
  options.onSlug?.(slug);
  const made = await expectJson(
    await fetchImpl(`${baseUrl}/v2/admin/communities`, {
      method: 'POST',
      headers: jsonHeaders(superCookie),
      body: JSON.stringify({ slug }),
      redirect: 'error',
    }),
    'POST /v2/admin/communities',
    [201]
  );
  const hit = communityMatches(made, { slug });
  if (!hit) {
    throw new Error(
      `create community answered 201 but the response does not match the requested slug ${slug} with a positive integer id`
    );
  }
  const id = hit.id;
  const throwaway: Throwaway = {
    id,
    slug,
    adminIdentifier: `${slug}-admin`,
    adminPassword: (options.randomPassword ?? randomPassword)(),
  };
  onCreated(throwaway);
  const tokenBody = await expectJson(
    await fetchImpl(`${baseUrl}/v2/admin/communities/${id}/claim-tokens`, {
      method: 'POST',
      headers: jsonHeaders(superCookie),
      body: JSON.stringify({ ttlSeconds: 3600 }),
      redirect: 'error',
    }),
    'POST /v2/admin/communities/:id/claim-tokens',
    [201]
  );
  const token = (tokenBody.data as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !token) {
    throw new Error('claim token answered 201 but returned no token');
  }
  const verifier = await newVerifier(throwaway.adminPassword);
  await expectJson(
    // the claimant has no session: no cookie on this call
    await fetchImpl(`${baseUrl}/v2/bootstrap/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        username: throwaway.adminIdentifier,
        email: `${slug}-admin@upload.example.test`,
        displayName: `Upload admin (${slug})`,
        password: verifier,
      }),
      redirect: 'error',
    }),
    'POST /v2/bootstrap/claim',
    [200, 201]
  );
  return throwaway;
}

export interface ThroughCommunityResult {
  community?: { slug: string };
  outcome?: UploadOutcome;
  error?: string;
  /** HTTP status of the disable call, when one was made. */
  disableStatus?: number;
  communityDisabled: boolean;
  mediaDeleted: boolean;
}

export interface ThroughCommunityInput {
  baseUrl: string;
  superCookie: string;
  file: UploadFile;
  partSize?: number;
  /** --local rehearsal and STAGING_ALLOW_HOST, as main() validated them. */
  local?: boolean;
  allowHost?: string;
  /**
   * Receives an idempotent cleanup function (disable the community) so a
   * signal handler can run it; the same call is shared with the finally block.
   */
  onCleanupReady?: (cleanup: () => Promise<void>) => void;
}

/**
 * Provision a throwaway community + admin as the super admin, run the upload
 * as that admin, then disable the community as the super admin (in finally,
 * so on every normal exit; main() also runs it on SIGINT/SIGTERM). Never
 * throws: failures land in `error` so the caller can print the cleanup
 * outcome. Nothing here prints a password or cookie.
 */
export async function uploadViaThrowawayCommunity(
  input: ThroughCommunityInput,
  deps: UploadDeps & { randomPassword?: () => string }
): Promise<ThroughCommunityResult> {
  const { baseUrl, superCookie } = input;
  const result: ThroughCommunityResult = {
    communityDisabled: false,
    mediaDeleted: false,
  };
  try {
    assertStagingUrl(baseUrl, input.allowHost, input.local ?? false);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
  const log = deps.log ?? ((): void => {});
  let created: Throwaway | undefined;
  let plannedSlug: string | undefined;

  const disableOnce = async (): Promise<void> => {
    let id = created?.id;
    let slug = created?.slug;
    if (id === undefined && plannedSlug !== undefined) {
      // The create response was lost, unreadable or invalid: the slug is
      // random, so an exact slug match is this run's community.
      slug = plannedSlug;
      id = await findCommunityBySlug(deps.fetch, baseUrl, superCookie, slug);
      if (id !== undefined) {
        log(`community ${slug} found by slug after an unconfirmed create`);
        result.community = { slug };
      }
    }
    if (id === undefined || slug === undefined) return;
    try {
      const res = await deps.fetch(
        `${baseUrl}/v2/admin/communities/${id}/status`,
        {
          method: 'PATCH',
          headers: jsonHeaders(superCookie),
          body: JSON.stringify({ status: 'disabled' }),
          redirect: 'error',
        }
      );
      result.disableStatus = res.status;
      // Success needs HTTP 200 AND a body naming this community as disabled.
      const body =
        res.status === 200 ? await res.json().catch(() => null) : null;
      result.communityDisabled =
        res.status === 200 &&
        communityMatches(body, { slug, id, status: 'disabled' }) !== undefined;
    } catch {
      result.communityDisabled = false;
    }
  };
  let cleanup: Promise<void> | undefined;
  const cleanupOnce = (): Promise<void> => (cleanup ??= disableOnce());
  input.onCleanupReady?.(cleanupOnce);

  try {
    const t = await provisionThrowaway(
      deps.fetch,
      baseUrl,
      superCookie,
      (c) => {
        created = c;
        result.community = { slug: c.slug };
      },
      {
        log,
        onSlug: (s) => (plannedSlug = s),
        randomPassword: deps.randomPassword,
      }
    );
    log(`community ${t.slug} created and claimed by a throwaway admin`);
    const cookie = await loginSuper(
      deps.fetch,
      baseUrl,
      t.adminIdentifier,
      t.adminPassword
    );
    log('signed in as the throwaway admin (cookie held in memory)');
    result.outcome = await runUpload(
      { baseUrl, cookie, file: input.file, partSize: input.partSize },
      deps
    );
    result.mediaDeleted = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await cleanupOnce();
  }
  return result;
}

const USAGE = `Usage: STAGING_URL=... WT_SUPER_IDENTIFIER=... WT_SUPER_PASSWORD=... \\
  npx tsx scripts/staging/upload-large.ts --file <path> [options]
  --file <path>        media file to upload (a real mp4/webm sample, ~300 MB)
  --dry-run            print the upload plan; no network call, no credentials
  --local              loopback workerd rehearsal (http://127.0.0.1:<port>)
  --content-type <t>   declared MIME type (default video/mp4)
The super admin has no community role, so the helper creates a throwaway
community "stg-upload-<random>" with a throwaway admin (random password, memory
only), uploads as that admin, deletes the media, and disables the community
afterwards (always on normal exit and on SIGINT/SIGTERM; a SIGKILL leaves it
active: disable stg-upload-<slug> by hand). Credentials are read from the environment only and never
printed.`;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  seams: { randomPassword?: () => string } = {}
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
        `plan: as the super admin create a stg-upload-* community and a throwaway admin, sign in as that admin, then POST /v2/media/uploads -> PUT each returned part target (exact headers) -> POST /v2/media/uploads/<id>/complete -> DELETE /v2/media/<fileId> -> disable the community`,
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
  let superCookie: string;
  try {
    superCookie = await loginSuper(fetch, baseUrl, identifier, password);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
  log('signed in as the super admin (cookie held in memory, never printed)');
  // SIGINT/SIGTERM: disable the throwaway community (short timeout) before
  // exiting non-zero. SIGKILL cannot be caught and leaves it active.
  let cleanup: (() => Promise<void>) | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    process.stderr.write(`\n${signal}: disabling the throwaway community...\n`);
    const timeout = new Promise<void>((r) => setTimeout(r, 10_000));
    void Promise.race([cleanup?.() ?? Promise.resolve(), timeout]).finally(
      () => {
        process.stderr.write(
          'exiting; if the community is still active, disable stg-upload-<slug> by hand\n'
        );
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let res: ThroughCommunityResult;
  try {
    res = await uploadViaThrowawayCommunity(
      {
        baseUrl,
        superCookie,
        file: { name, contentType, bytes },
        local,
        allowHost: env.STAGING_ALLOW_HOST,
        onCleanupReady: (fn) => {
          cleanup = fn;
        },
      },
      { fetch, log, randomPassword: seams.randomPassword }
    );
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const o = res.outcome;
  const lines = [
    `community: ${res.community?.slug ?? '(not created)'}`,
    `bytes: ${bytes.byteLength}, parts: ${o?.partCount ?? plans.length}, file id: ${o?.mediaId ?? '(none)'}`,
  ];
  if (o) {
    lines.push(
      `http: create ${o.createStatus}, parts ${o.partStatuses.join('/')}, complete ${o.completeStatus}, delete ${o.deleteStatus}; mode ${o.mode}`,
      `wall ms: create=${o.createMs} complete=${o.completeMs} delete=${o.deleteMs} (CPU times come from wrangler tail)`
    );
  }
  lines.push(
    `cleanup: media ${res.mediaDeleted ? 'file record deleted (storage removal not verified by the API)' : 'NOT confirmed deleted (see error)'}, community ${res.communityDisabled ? 'disabled' : 'NOT disabled: disable it manually as the super admin'}${res.disableStatus !== undefined ? ` (HTTP ${res.disableStatus})` : ''}`
  );
  process.stdout.write(lines.join('\n') + '\n');
  if (res.error) {
    process.stderr.write(res.error + '\n');
    return 1;
  }
  return res.communityDisabled ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
