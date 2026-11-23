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
 *   tsx guards.ts url <staging-url>            URL is a staging origin
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

export function assertStagingUrl(raw: string, allowHost?: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError('refused: STAGING_URL is not a URL');
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

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'name' && rest.length > 0) rest.forEach(assertStagingName);
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
    else {
      process.stderr.write(
        'usage: guards.ts name|account|crons|d1-size|url ...\n'
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
