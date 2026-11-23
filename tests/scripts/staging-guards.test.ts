import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GuardError,
  WORKER_CRONS,
  assertAccountMatches,
  assertStagingConfig,
  listHasName,
  assertCronBudget,
  assertD1Size,
  assertStagingName,
  assertStagingUrl,
  countCrons,
  parseJsonc,
} from '../../scripts/staging/guards.js';
// @ts-expect-error plain .mjs helper without types
import {
  splitJsonObjects,
  tailRows,
} from '../../scripts/staging/parse-tail.mjs';

const ROOT = resolve(__dirname, '../..');
const ACCOUNT = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

describe('staging guards', () => {
  it('accepts only terrastories-staging-* names', () => {
    expect(() => assertStagingName('terrastories-staging-db')).not.toThrow();
    for (const bad of [
      'terrastories',
      'terrastories-prod-db',
      'terrastories-staging',
      'Terrastories-staging-db',
      'xterrastories-staging-db',
      'terrastories-staging-db; rm',
      '',
    ]) {
      expect(() => assertStagingName(bad), bad).toThrow(GuardError);
    }
  });

  it('requires the expected account id in whoami output', () => {
    const who = `account ${ACCOUNT} ok`;
    expect(() => assertAccountMatches(who, ACCOUNT)).not.toThrow();
    expect(() => assertAccountMatches(who, OTHER)).toThrow(/does not show/);
    expect(() => assertAccountMatches(who, undefined)).toThrow(/must be set/);
    expect(() => assertAccountMatches(who, 'short')).toThrow(/must be set/);
  });

  it('enforces the free cron limit and counts the committed staging env', () => {
    expect(() => assertCronBudget(3, 0)).not.toThrow();
    expect(() => assertCronBudget(3, 3)).toThrow(/Free limit/);
    const config = parseJsonc(
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')
    );
    expect(countCrons(config, 'staging')).toBe(3);
    expect(() => assertStagingConfig(config)).not.toThrow();
    // every cron the Worker matches on is declared (exact strings)
    const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
    for (const cron of WORKER_CRONS.filter((c) => c !== '0 * * * *')) {
      expect(worker).toContain("cron === '" + cron + "'");
    }
    const bad = structuredClone(config) as {
      env: {
        staging: { triggers: { crons: string[] }; r2_buckets: unknown[] };
      };
    };
    bad.env.staging.triggers.crons = ['0 * * * *', '* * * * *'];
    expect(() => assertStagingConfig(bad)).toThrow(/crons must be exactly/);
    const noErasure = structuredClone(config) as typeof bad;
    noErasure.env.staging.r2_buckets = noErasure.env.staging.r2_buckets.slice(
      0,
      1
    );
    expect(() => assertStagingConfig(noErasure)).toThrow(/ERASURE_RECORDS/);
    const staging = (config as { env: { staging: { name: string } } }).env
      .staging;
    expect(staging.name.startsWith('terrastories-staging-')).toBe(true);
    expect(JSON.stringify(staging)).not.toMatch(/production|our\.terrastories/);
  });

  it('bounds D1 size and staging URLs', () => {
    expect(() => assertD1Size(10_000_000)).not.toThrow();
    expect(() => assertD1Size(460_000_000)).toThrow(/free limit/);
    expect(() => assertD1Size(Number.NaN)).toThrow(GuardError);
    expect(() =>
      assertStagingUrl('https://terrastories-staging-api.x.workers.dev')
    ).not.toThrow();
    for (const bad of [
      'http://terrastories-staging-api.x.workers.dev',
      'https://our.terrastories.app',
      'https://terrastories.herokuapp.com',
      'https://example.org',
      'nope',
    ]) {
      expect(() => assertStagingUrl(bad), bad).toThrow(GuardError);
    }
    expect(() =>
      assertStagingUrl('https://s.example.org', 's.example.org')
    ).not.toThrow();
    // --local: loopback http only
    for (const ok of ['http://127.0.0.1:8787', 'http://localhost:8787'])
      expect(() => assertStagingUrl(ok, undefined, true), ok).not.toThrow();
    for (const bad of [
      'https://127.0.0.1:8787',
      'http://terrastories-staging-api.x.workers.dev',
      'http://our.terrastories.app',
      'http://192.168.1.5:8787',
      'http://127.0.0.1.evil.example',
    ])
      expect(() => assertStagingUrl(bad, undefined, true), bad).toThrow(
        GuardError
      );
    // without the flag, loopback http stays refused
    expect(() => assertStagingUrl('http://127.0.0.1:8787')).toThrow(GuardError);
  });
});

describe('exact-name matching', () => {
  it('does not treat prefixes or substrings as present', () => {
    const erasure = 'terrastories-staging-erasure-records';
    const json = JSON.stringify([{ name: erasure + '-old' }]);
    expect(listHasName(json, erasure)).toBe(false);
    expect(listHasName(JSON.stringify([{ name: erasure }]), erasure)).toBe(
      true
    );
    expect(listHasName('name:   ' + erasure + '-old\n', erasure)).toBe(false);
    expect(listHasName('name:   ' + erasure + '\n', erasure)).toBe(true);
    expect(listHasName('x ' + erasure + ' y', erasure)).toBe(false);
  });
});

describe('provision.sh guard wiring (fake npx, no network)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'fake-npx-'));
  const log = join(bin, 'calls.log');
  writeFileSync(
    join(bin, 'npx'),
    `#!/usr/bin/env bash
echo "$@" >> "${log}"
case "$*" in
  *whoami*) echo "Account ${ACCOUNT}" ;;
  *"d1 list"*) echo "[]" ;;
  *"r2 bucket list"*) printf 'name:  terrastories-staging-erasure-records-old\n' ;;
  *tsx*) shift; shift; exec "${ROOT}/node_modules/.bin/tsx" "$@" ;;
esac
`
  );
  chmodSync(join(bin, 'npx'), 0o755);
  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync('bash', ['scripts/staging/provision.sh', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });

  it('dry run prints create commands and executes none', () => {
    const r = run({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      '+ npx wrangler d1 create terrastories-staging-db'
    );
    expect(r.stdout).toContain(
      '+ npx wrangler r2 bucket create terrastories-staging-media'
    );
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toMatch(/create/);
  });

  it('creates the erasure-records bucket and ignores name overrides', () => {
    const r = run({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      STAGING_R2_BUCKET: 'terrastories-media',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      '+ npx wrangler r2 bucket create terrastories-staging-erasure-records'
    );
    expect(r.stdout).not.toContain('terrastories-media');
    // the "-old" lookalike must not count as the existing bucket
    expect(r.stdout).not.toContain('erasure-records exists');
  });

  it('refuses when the cron budget is exceeded', () => {
    const r = run({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, OTHER_CRON_TRIGGERS: '3' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('d1 create');
  });

  it('refuses an account mismatch', () => {
    const r = run({ CLOUDFLARE_ACCOUNT_ID: OTHER });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not show|refused/);
    expect(r.stdout).not.toContain('d1 create');
  });
});

describe('load-community.sh resume guard (fake npx)', () => {
  const work = mkdtempSync(join(tmpdir(), 'load-guard-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npx'),
    `#!/usr/bin/env bash
case "$*" in
  *whoami*) echo "Account ${ACCOUNT}" ;;
  *tsx*) shift; shift; exec "${ROOT}/node_modules/.bin/tsx" "$@" ;;
  *) exit 0 ;;
esac
`
  );
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'npx'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  const transform = join(work, 'transform');
  mkdirSync(transform);
  writeFileSync(join(transform, 'manifest.json'), '{"a":1}');
  const run = (sqlOut: string) =>
    spawnSync(
      'bash',
      [
        'scripts/staging/load-community.sh',
        '--transform-output',
        transform,
        '--sql-out',
        sqlOut,
        '--apply',
        '--skip-r2',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        },
      }
    );

  it('refuses an sql-out dir built from another transform output', () => {
    const other = join(work, 'sql-other');
    mkdirSync(other);
    writeFileSync(join(other, '.transform-manifest.sha256'), 'deadbeef');
    writeFileSync(join(other, 'd1-import.json'), '{"files":[]}');
    const r = run(other);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/different transform output/);
  });

  it('refuses an unstamped existing sql-out dir', () => {
    const bare = join(work, 'sql-bare');
    mkdirSync(bare);
    writeFileSync(join(bare, 'd1-import.json'), '{"files":[]}');
    const r = run(bare);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/without a transform stamp/);
  });
});

describe('load-community.sh --r2-via-wrangler (fake npx)', () => {
  const work = mkdtempSync(join(tmpdir(), 'load-r2-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const calls = join(work, 'calls.log');
  const store = join(work, 'store');
  mkdirSync(store);
  // Fake wrangler: r2 object put copies to store; get copies back (or fails).
  writeFileSync(
    join(bin, 'npx'),
    `#!/usr/bin/env bash
case "$*" in
  *whoami*) echo "Account ${ACCOUNT}" ; exit 0 ;;
  *tsx*) shift; shift; exec "${ROOT}/node_modules/.bin/tsx" "$@" ;;
esac
echo "$*" >> "${calls}"
args=("$@")
if [ "\${args[1]}" = r2 ] && [ "\${args[2]}" = object ]; then
  op="\${args[3]}"; key="\${args[4]//\\//_}"
  for i in "\${!args[@]}"; do [ "\${args[$i]}" = --file ] && f="\${args[$((i+1))]}"; done
  if [ "$op" = put ]; then cp "$f" "${store}/$key"; fi
  if [ "$op" = get ]; then [ -f "${store}/$key" ] || exit 1; cp "${store}/$key" "$f"; fi
fi
exit 0
`
  );
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'npx'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  const transform = join(work, 'transform');
  mkdirSync(join(transform, 'v2-media'), { recursive: true });
  writeFileSync(join(transform, 'manifest.json'), '{"a":1}');
  writeFileSync(join(transform, 'v2-media', 'k1'), 'hello');
  const sqlOut = join(work, 'sql');
  mkdirSync(sqlOut);
  writeFileSync(join(sqlOut, 'd1-import.json'), '{"files":[]}');
  writeFileSync(join(sqlOut, '.backup-done'), '');
  writeFileSync(
    join(sqlOut, 'r2-upload-manifest.json'),
    JSON.stringify({
      formatVersion: 1,
      objects: [{ key: 'k1', size: 5, sha256: 'x', contentType: 'video/mp4' }],
    })
  );
  const stamp = spawnSync('bash', [
    '-c',
    `printf '%s' "$(sha256sum "${transform}/manifest.json" | cut -d' ' -f1)" > "${sqlOut}/.transform-manifest.sha256"`,
  ]);
  expect(stamp.status).toBe(0);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_ACCOUNT_ID: '',
  };
  const run = (extra: string[]) =>
    spawnSync(
      'bash',
      [
        'scripts/staging/load-community.sh',
        '--transform-output',
        transform,
        '--sql-out',
        sqlOut,
        '--apply',
        ...extra,
      ],
      { cwd: ROOT, encoding: 'utf8', env }
    );

  it('refuses the S3 path without credentials', () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--r2-via-wrangler/);
  });

  it('puts with content-type, verifies, and skips on rerun', () => {
    const r = run(['--r2-via-wrangler']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/uploaded=1 already_present=0/);
    const log = readFileSync(calls, 'utf8');
    expect(log).toMatch(
      /r2 object put terrastories-staging-media\/k1 --remote --file .*--content-type video\/mp4/
    );
    const again = run(['--r2-via-wrangler']);
    expect(again.stdout).toMatch(/uploaded=0 already_present=1/);
  });
});

describe('parse-tail.mjs', () => {
  it('reads pretty-printed concatenated JSON', () => {
    const ev = (cpu: number) =>
      JSON.stringify(
        {
          outcome: 'ok',
          cpuTime: cpu,
          wallTime: 9,
          event: {
            request: { method: 'POST', url: 'https://x/v2/media?a={b}' },
          },
          logs: [{ message: ['brace } in "string"'] }],
        },
        null,
        2
      );
    const text = ev(9) + '\n' + ev(18) + '\n';
    expect(splitJsonObjects(text)).toHaveLength(2);
    expect(tailRows(text)).toEqual([
      ['POST', 'https://x/v2/media', 'ok', 9, 9],
      ['POST', 'https://x/v2/media', 'ok', 18, 9],
    ]);
  });
});

describe('smoke.sh walkthrough gating (fake npm)', () => {
  const work = mkdtempSync(join(tmpdir(), 'smoke-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npm'),
    '#!/usr/bin/env bash\necho "npm $*" >> "${NPM_LOG}"\nexit "${NPM_RC:-0}"\n'
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const run = (args: string[]) =>
    spawnSync('bash', ['scripts/staging/smoke.sh', '--local', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STAGING_URL: 'http://127.0.0.1:9',
        NPM_LOG: join(work, 'npm.log'),
      },
    });

  it('skips the walkthrough with --skip-walkthrough', () => {
    const r = run(['--skip-walkthrough']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/walkthrough skipped/);
    expect(r.stdout).not.toMatch(/npm run walkthrough/);
  });

  it('cpu procedure has no --env on tail and no role on upload', () => {
    const r = run(['--cpu-procedure']);
    expect(r.stdout).toMatch(
      /wrangler tail terrastories-staging-api --format json/
    );
    expect(r.stdout).not.toMatch(/tail .*--env/);
    expect(r.stdout).not.toMatch(/role=story_media/);
    expect(r.stdout).toMatch(/parse-tail\.mjs/);
  });
});
