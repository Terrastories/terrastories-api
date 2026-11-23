/**
 * Guard logic for the staging kit (provision.sh, load-community.sh, smoke.sh).
 * Pure functions are exported for tests; the CLI at the bottom is what the
 * shell scripts call. Nothing here talks to Cloudflare and nothing is printed
 * beyond the verdict (never credentials or account listings).
 *
 * CLI (exit 0 ok, 1 refused, 2 usage):
 *   tsx guards.ts name <resource-name>...      every name starts with the prefix
 *   tsx guards.ts account <expected-id>        reads `wrangler whoami` text on stdin
 *   tsx guards.ts crons <wrangler.jsonc> <env> cron triggers within the free limit
 *   tsx guards.ts d1-size <bytes>              D1 database within the free limit
 *   tsx guards.ts config <wrangler.jsonc>      env.staging matches the kit's fixed names
 *   tsx guards.ts url <staging-url> [--local]  URL is a staging origin (--local: loopback http only)
 *   tsx guards.ts origin <origin>              bare frontend origin (scheme://host[:port])
 *   tsx guards.ts cors-file <path> <origin>    R2 CORS rules[] file allows that origin's part PUT
 *   tsx guards.ts cors-policy <origin>         stdin: `wrangler r2 bucket cors list` allows the part PUT from exactly <origin>
 *   tsx guards.ts media-bucket <wrangler.jsonc> <bucket>  <bucket> is the env.staging MEDIA binding
 *   tsx guards.ts lifecycle <days>             stdin: `wrangler r2 bucket lifecycle list` aborts after <days>
 *   tsx guards.ts preflight <origin>           stdin: OPTIONS answer allows the part PUT from <origin>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STAGING_PREFIX = 'terrastories-staging-';
/** Workers Free: 5 cron triggers per account (all Workers, all environments). */
export const FREE_CRON_LIMIT_PER_ACCOUNT = 5;
/** D1 Free: 500 MB per database. Keep 10 percent headroom. */
export const D1_FREE_MAX_BYTES = 500 * 1000 * 1000;
export const D1_HEADROOM_BYTES = Math.floor(D1_FREE_MAX_BYTES * 0.9);

/** Fixed staging resource names: the deployed config and the scripts share them. */
export const STAGING_NAMES = {
  worker: 'terrastories-staging-api',
  d1: 'terrastories-staging-db',
  media: 'terrastories-staging-media',
  erasure: 'terrastories-staging-erasure-records',
} as const;
/** Exact cron strings src/worker.ts dispatches on (matched by string equality). */
export const WORKER_CRONS = ['0 * * * *', '* * * * *', '*/1 * * * *'] as const;

/** Placeholder origin in the committed CORS template (r2-cors.json); the kit
 * substitutes STAGING_FRONTEND_ORIGIN before wrangler reads the file. */
export const CORS_ORIGIN_PLACEHOLDER = '__STAGING_FRONTEND_ORIGIN__';
/** The one header a direct part upload must be allowed to send (SPEC-V2 §6.7). */
export const PART_UPLOAD_HEADER = 'x-amz-content-sha256';
/** SPEC-V2 §6.7: allowed method PUT and MaxAgeSeconds of at least 3600. */
export const CORS_MIN_MAX_AGE_SECONDS = 3600;
/** SPEC-V2 §6.7: abort incomplete multipart uploads after 1 day. */
export const ABORT_MULTIPART_DAYS = 1;

const NAME_RE = /^terrastories-staging-[a-z0-9][a-z0-9-]*$/;

export class GuardError extends Error {}

export function assertStagingName(name: string): void {
  if (!NAME_RE.test(name) || name.length > 63) {
    throw new GuardError(
      'refused: resource name must match ' +
        STAGING_PREFIX +
        '* (lowercase letters, digits, hyphens; max 63 chars)'
    );
  }
}

export function extractAccountIds(whoamiText: string): string[] {
  return [...whoamiText.matchAll(/\b[0-9a-f]{32}\b/gi)].map((m) =>
    (m[0] as string).toLowerCase()
  );
}

/**
 * The expected id must be a 32-hex account id AND appear in the whoami output.
 * With several accounts listed the match is still required, and the caller must
 * pin CLOUDFLARE_ACCOUNT_ID for wrangler so it targets that account.
 */
export function assertAccountMatches(
  whoamiText: string,
  expected: string | undefined
): void {
  const want = (expected ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(want)) {
    throw new GuardError(
      'refused: CLOUDFLARE_ACCOUNT_ID must be set to the expected 32-hex account id'
    );
  }
  if (!extractAccountIds(whoamiText).includes(want)) {
    throw new GuardError(
      'refused: wrangler whoami does not show the expected CLOUDFLARE_ACCOUNT_ID (wrong login or token)'
    );
  }
}

/** Strip // and /* *\/ comments and trailing commas, string-aware. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/'))
        i += 1;
      i += 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function countCrons(config: unknown, env: string): number {
  const root = config as {
    env?: Record<string, { triggers?: { crons?: string[] } }>;
  };
  return root.env?.[env]?.triggers?.crons?.length ?? 0;
}

/**
 * Cron triggers are counted per account. `otherCrons` is the number already
 * used by other Workers (production template: 3). Default assumes the repo's
 * top-level (production) block is deployed too.
 */
type StagingEnv = {
  name?: string;
  d1_databases?: Array<{ binding?: string; database_name?: string }>;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  vars?: Record<string, string>;
  triggers?: { crons?: string[] };
};

/** The committed env.staging block must match the names the scripts create. */
export function assertStagingConfig(config: unknown): void {
  const staging = (config as { env?: { staging?: StagingEnv } }).env?.staging;
  if (!staging)
    throw new GuardError('refused: wrangler.jsonc has no env.staging');
  const bad = (what: string): never => {
    throw new GuardError('refused: env.staging ' + what);
  };
  if (staging.name !== STAGING_NAMES.worker)
    bad('name is not ' + STAGING_NAMES.worker);
  const d1 = staging.d1_databases?.find((d) => d.binding === 'DB');
  if (d1?.database_name !== STAGING_NAMES.d1)
    bad('DB binding is not ' + STAGING_NAMES.d1);
  const bucket = (binding: string) =>
    staging.r2_buckets?.find((b) => b.binding === binding)?.bucket_name;
  if (bucket('MEDIA') !== STAGING_NAMES.media)
    bad('MEDIA binding is not ' + STAGING_NAMES.media);
  if (bucket('ERASURE_RECORDS') !== STAGING_NAMES.erasure)
    bad('ERASURE_RECORDS binding is not ' + STAGING_NAMES.erasure);
  if (staging.vars?.R2_BUCKET_NAME !== STAGING_NAMES.media)
    bad('R2_BUCKET_NAME var is not the media bucket');
  if (!staging.vars?.PUBLIC_ORIGIN) bad('has no PUBLIC_ORIGIN');
  const crons = [...(staging.triggers?.crons ?? [])].sort();
  if (JSON.stringify(crons) !== JSON.stringify([...WORKER_CRONS].sort()))
    bad('crons must be exactly ' + WORKER_CRONS.join(' | '));
}

/**
 * Exact-name membership in `wrangler d1 list --json` / `r2 bucket list`
 * output. JSON: any string equal to the name under a name-like key. Text:
 * a `name: <value>` line or a whole line equal to the name. Never a
 * substring or prefix match.
 */
export function listHasName(output: string, name: string): boolean {
  const keys = new Set(['name', 'database_name', 'Name']);
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') {
      return Object.entries(v).some(([k, x]) =>
        typeof x === 'string' ? keys.has(k) && x === name : walk(x)
      );
    }
    return false;
  };
  try {
    return walk(JSON.parse(output));
  } catch {
    return output.split('\n').some((line) => {
      const t = line.trim();
      const m = /^name:\s*(\S+)$/i.exec(t);
      return (m ? m[1] : t) === name;
    });
  }
}

export function assertCronBudget(
  stagingCrons: number,
  otherCrons: number
): void {
  if (stagingCrons + otherCrons > FREE_CRON_LIMIT_PER_ACCOUNT) {
    throw new GuardError(
      'refused: ' +
        String(stagingCrons) +
        ' staging + ' +
        String(otherCrons) +
        ' other cron triggers exceed the Workers Free limit of ' +
        String(FREE_CRON_LIMIT_PER_ACCOUNT) +
        ' per account'
    );
  }
}

export function assertD1Size(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new GuardError('refused: unreadable D1 size');
  }
  if (bytes > D1_HEADROOM_BYTES) {
    throw new GuardError(
      'refused: D1 database is ' +
        String(bytes) +
        ' bytes, above 90 percent of the 500 MB free limit'
    );
  }
}

export function assertStagingUrl(
  raw: string,
  allowHost?: string,
  local = false
): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError('refused: STAGING_URL is not a URL');
  }
  if (local) {
    // Explicit rehearsal against a workerd (wrangler dev --local) on this
    // machine: plain http, loopback host only, never a staging or production
    // name, so the flag cannot point the kit at a remote plain-http target.
    const loopback = ['127.0.0.1', 'localhost', '[::1]'];
    if (url.protocol !== 'http:' || !loopback.includes(url.hostname)) {
      throw new GuardError(
        'refused: --local accepts only http://127.0.0.1, http://localhost or http://[::1]'
      );
    }
    return;
  }
  if (url.protocol !== 'https:') {
    throw new GuardError('refused: STAGING_URL must be https');
  }
  const host = url.hostname.toLowerCase();
  const isProd =
    host === 'our.terrastories.app' || host.endsWith('herokuapp.com');
  const stagingHost =
    host.startsWith(STAGING_PREFIX) || host.includes('-staging-');
  if (isProd || !(stagingHost || (allowHost && allowHost === host))) {
    throw new GuardError(
      'refused: STAGING_URL host is not a staging host (' +
        STAGING_PREFIX +
        '*.workers.dev); set STAGING_ALLOW_HOST to the exact host to override'
    );
  }
}

// Wrangler colours its tables on a TTY: strip ANSI so a captured answer and
// an interactive one parse the same way.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const LABEL_RE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

/**
 * Labelled blocks from `wrangler r2 bucket cors list` and `lifecycle list`:
 * one block per rule, blocks separated by blank lines, `label: value` lines
 * whose values are column-aligned, and a wrapped value continued on the next
 * (indented) line. The same parser reads an HTTP header block, which is why
 * the label charset includes `-`.
 */
export function parseLabelledBlocks(text: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  for (const block of text
    .replace(ANSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)) {
    const view: Record<string, string> = {};
    let key = '';
    for (const line of block.split('\n')) {
      const field = LABEL_RE.exec(line);
      if (field) {
        key = field[1] as string;
        view[key] = (field[2] as string).trim();
      } else if (key && line.trim()) {
        view[key] = (view[key] ?? '') + ' ' + line.trim();
      }
    }
    if (key) blocks.push(view);
  }
  return blocks;
}

/** Comma-separated CORS list value as lowercase tokens (`PUT, GET` -> ...). */
function tokens(value: string | string[] | undefined): string[] {
  const list = Array.isArray(value) ? value : (value ?? '').split(',');
  return list.map((token) => token.trim().toLowerCase()).filter(Boolean);
}

/** STAGING_FRONTEND_ORIGIN: a bare http(s) origin, no path, query or fragment. */
export function assertFrontendOrigin(raw: string): void {
  // Not trimmed: a padded value would be substituted verbatim into the CORS file.
  const value = raw ?? '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GuardError(
      'refused: STAGING_FRONTEND_ORIGIN is not a URL (expected an origin such as https://app.example.org)'
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GuardError(
      'refused: STAGING_FRONTEND_ORIGIN must be an http(s) origin'
    );
  }
  if (value !== url.origin) {
    throw new GuardError(
      'refused: STAGING_FRONTEND_ORIGIN must be exactly scheme://host[:port] (no trailing slash, path, query or fragment, lowercase host, no default port)'
    );
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new GuardError(
      'refused: STAGING_FRONTEND_ORIGIN must be a bare origin (scheme://host[:port]), without a path, query or fragment'
    );
  }
}

type CorsRule = {
  allowed?: { origins?: string[]; methods?: string[]; headers?: string[] };
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
};

/**
 * The rendered CORS file wrangler gets: R2's `rules` (not AWS `CORSRules`),
 * one rule that allows the part upload, and — when the origin is passed —
 * exactly the operator's frontend origin, so a template that was never
 * rendered is refused before it reaches the bucket.
 */
export function assertCorsFile(path: string, origin?: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GuardError('refused: CORS config ' + path + ' is not valid JSON');
  }
  const rules = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new GuardError(
      'refused: CORS config ' +
        path +
        ' must hold a non-empty rules array (the R2 format, not AWS CORSRules)'
    );
  }
  const match = (rules as CorsRule[]).find(
    (rule) =>
      tokens(rule.allowed?.methods).includes('put') &&
      tokens(rule.allowed?.headers).includes(PART_UPLOAD_HEADER)
  );
  if (!match) {
    throw new GuardError(
      'refused: CORS config ' +
        path +
        ' has no rule allowing PUT with ' +
        PART_UPLOAD_HEADER
    );
  }
  if (!tokens(match.exposeHeaders).includes('etag')) {
    throw new GuardError('refused: CORS config ' + path + ' must expose ETag');
  }
  if ((match.maxAgeSeconds ?? 0) < CORS_MIN_MAX_AGE_SECONDS) {
    throw new GuardError(
      'refused: CORS config ' +
        path +
        ' must set maxAgeSeconds to at least ' +
        String(CORS_MIN_MAX_AGE_SECONDS)
    );
  }
  const origins = tokens(match.allowed?.origins);
  if (origin !== undefined && !origins.includes(origin.toLowerCase())) {
    throw new GuardError(
      'refused: CORS config ' +
        path +
        ' does not allow the origin ' +
        origin +
        ' (was STAGING_FRONTEND_ORIGIN substituted?)'
    );
  }
}

/**
 * stdin: `wrangler r2 bucket cors list` must show one rule that allows
 * exactly the configured origin (no other, no wildcard), PUT, the part header,
 * exposes ETag and caches the preflight for at least CORS_MIN_MAX_AGE_SECONDS.
 */
export function assertCorsPolicyAllowsUploads(
  listText: string,
  origin: string
): void {
  const want = origin.trim().toLowerCase();
  const rules = parseLabelledBlocks(listText);
  // Every rule that lets a browser PUT must be for exactly this origin: a
  // second rule with a wildcard or another origin would widen the policy.
  const widened = rules.some(
    (rule) =>
      tokens(rule.allowed_methods).includes('put') &&
      tokens(rule.allowed_origins).some((o) => o !== want)
  );
  if (widened) {
    throw new GuardError(
      'refused: the R2 CORS policy lets another origin (or *) PUT; only ' +
        origin +
        ' may'
    );
  }
  const allowed = rules.some((rule) => {
    const origins = tokens(rule.allowed_origins);
    return (
      origins.length === 1 &&
      origins[0] === want &&
      tokens(rule.allowed_methods).includes('put') &&
      tokens(rule.allowed_headers).includes(PART_UPLOAD_HEADER) &&
      tokens(rule.exposed_headers).includes('etag') &&
      Number(rule.max_age_seconds) >= CORS_MIN_MAX_AGE_SECONDS
    );
  });
  if (!allowed) {
    throw new GuardError(
      'refused: the R2 CORS policy has no rule for exactly the origin ' +
        origin +
        ' allowing PUT with ' +
        PART_UPLOAD_HEADER +
        ', exposing ETag, with max age >= ' +
        String(CORS_MIN_MAX_AGE_SECONDS) +
        ' (wrangler r2 bucket cors list)'
    );
  }
}

/** stdin: `wrangler r2 bucket lifecycle list` must show an enabled rule that
 * aborts incomplete multipart uploads after exactly <days> days. */
export function assertLifecycleAbortRule(listText: string, days: number): void {
  if (!Number.isInteger(days) || days < 1) {
    throw new GuardError('refused: lifecycle days must be a positive integer');
  }
  // One phrase, so "after N days" must belong to the abort action itself. The
  // rule must cover the whole bucket: a prefix-scoped rule leaves the rest of
  // the bucket's incomplete uploads in place.
  const phrase = new RegExp(
    'abort incomplete multipart uploads after ' + String(days) + ' days?\\b',
    'i'
  );
  const wholeBucket = (prefix: string | undefined): boolean => {
    if (prefix === undefined) return false;
    const value = prefix.trim().toLowerCase();
    return (
      value === '' || value === '(all prefixes)' || value === 'all prefixes'
    );
  };
  const found = parseLabelledBlocks(listText).some((rule) => {
    // A rule without an explicit "enabled: Yes" never counts (fail closed).
    const enabled = (rule.enabled ?? 'no').trim().toLowerCase();
    return (
      enabled === 'yes' &&
      wholeBucket(rule.prefix) &&
      phrase.test(rule.action ?? '')
    );
  });
  if (!found) {
    throw new GuardError(
      'refused: no enabled lifecycle rule aborting incomplete multipart uploads after ' +
        String(days) +
        ' day(s) (wrangler r2 bucket lifecycle list)'
    );
  }
}

/** The probe/preflight bucket must be the one the deployed Worker's MEDIA binding uses. */
export function assertMediaBucket(config: unknown, bucket: string): void {
  const staging = (
    config as {
      env?: {
        staging?: {
          r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
        };
      };
    }
  ).env?.staging;
  const bound = staging?.r2_buckets?.find(
    (b) => b.binding === 'MEDIA'
  )?.bucket_name;
  if (!bound) {
    throw new GuardError(
      'refused: wrangler.jsonc env.staging has no MEDIA bucket binding'
    );
  }
  if (bound !== bucket) {
    throw new GuardError(
      'refused: R2_BUCKET_NAME ' +
        bucket +
        ' is not the deployed Worker MEDIA bucket ' +
        bound
    );
  }
}

/** stdin: the OPTIONS answer a browser sends before a direct part PUT. */
export function assertCorsPreflight(origin: string, response: string): void {
  // Header block only (up to the first blank line), and only a 2xx answer: a
  // body that merely looks like headers must not pass.
  const head = response.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)[0] ?? '';
  // Browsers reject a repeated Access-Control-Allow-Origin, and the block
  // parser would keep only the last one: require exactly one.
  const allowOriginCount = (
    head.match(/^access-control-allow-origin[ \t]*:/gim) ?? []
  ).length;
  const statusOk =
    /^HTTP\/\S+\s+2\d\d\b/.test(head.trimStart()) && allowOriginCount === 1;
  const allowed =
    statusOk &&
    parseLabelledBlocks(head).some((block) => {
      const header: Record<string, string> = {};
      for (const [name, value] of Object.entries(block))
        header[name.toLowerCase()] = value;
      const allowOrigin = (header['access-control-allow-origin'] ?? '').trim();
      // A single exact value (browsers compare case-sensitively): a
      // comma-separated list or a differently cased origin is not valid.
      const originsOk = allowOrigin === '*' || allowOrigin === origin;
      const methods = tokens(header['access-control-allow-methods']);
      const headers = tokens(header['access-control-allow-headers']);
      return (
        originsOk &&
        (methods.includes('put') || methods.includes('*')) &&
        (headers.includes('*') || headers.includes(PART_UPLOAD_HEADER))
      );
    });
  if (!allowed) {
    throw new GuardError(
      'refused: the R2 preflight answer does not allow PUT with ' +
        PART_UPLOAD_HEADER +
        ' from ' +
        origin +
        ' (Access-Control-Allow-Origin/Methods/Headers)'
    );
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'name' && rest.length > 0) rest.forEach(assertStagingName);
    else if (cmd === 'has-name' && rest.length === 1)
      return listHasName(readStdin(), rest[0] as string) ? 0 : 3;
    else if (cmd === 'config' && rest.length === 1)
      assertStagingConfig(parseJsonc(readFileSync(rest[0] as string, 'utf8')));
    else if (cmd === 'account' && rest.length === 1)
      assertAccountMatches(readStdin(), rest[0]);
    else if (cmd === 'crons' && rest.length >= 2) {
      const config = parseJsonc(readFileSync(rest[0] as string, 'utf8'));
      assertCronBudget(
        countCrons(config, rest[1] as string),
        Number(rest[2] ?? '0')
      );
    } else if (cmd === 'd1-size' && rest.length === 1)
      assertD1Size(Number(rest[0]));
    else if (cmd === 'url' && rest.length === 1)
      assertStagingUrl(rest[0] as string, process.env.STAGING_ALLOW_HOST);
    else if (cmd === 'url' && rest.length === 2 && rest[1] === '--local')
      assertStagingUrl(rest[0] as string, undefined, true);
    else if (cmd === 'origin' && rest.length === 1)
      assertFrontendOrigin(rest[0] as string);
    else if (cmd === 'cors-file' && rest.length === 2)
      assertCorsFile(rest[0] as string, rest[1]);
    else if (cmd === 'cors-policy' && rest.length === 1)
      assertCorsPolicyAllowsUploads(readStdin(), rest[0] as string);
    else if (cmd === 'media-bucket' && rest.length === 2)
      assertMediaBucket(
        parseJsonc(readFileSync(rest[0] as string, 'utf8')),
        rest[1] as string
      );
    else if (cmd === 'lifecycle' && rest.length === 1)
      assertLifecycleAbortRule(readStdin(), Number(rest[0]));
    else if (cmd === 'preflight' && rest.length === 1)
      assertCorsPreflight(rest[0] as string, readStdin());
    else {
      process.stderr.write(
        'usage: guards.ts name|has-name|account|crons|d1-size|config|url|' +
          'origin|cors-file|cors-policy|media-bucket|lifecycle|preflight ...\n'
      );
      return 2;
    }
  } catch (error) {
    if (error instanceof GuardError) {
      process.stderr.write(error.message + '\n');
      return 1;
    }
    throw error;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2));
}
