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
    else if (cmd === 'account' && rest.length === 1)
      assertAccountMatches(readStdin(), rest[0]);
    else if (cmd === 'crons' && rest.length >= 2) {
      const config = parseJsonc(readFileSync(rest[0] as string, 'utf8'));
      assertCronBudget(
        countCrons(config, rest[1] as string),
        Number(rest[2] ?? '3')
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
