import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  D1_HEADROOM_BYTES,
  D1_PAID_HEADROOM_BYTES,
  FREE_CRON_LIMIT_PER_ACCOUNT,
  GuardError,
  PAID_CRON_LIMIT_PER_ACCOUNT,
  WORKER_CRONS,
  assertAccountMatches,
  assertCronBudget,
  assertD1Size,
  assertMediaBucket,
  assertPlanLimits,
  assertStagingConfig,
  assertStagingD1Id,
  assertStagingName,
  assertStagingUrl,
  countCrons,
  extractD1SizeFromInfo,
  listHasName,
  parseJsonc,
  parseWorkersPlan,
  resolveEffectiveEnvConfig,
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

describe('media bucket pin', () => {
  const config = {
    env: {
      staging: {
        r2_buckets: [
          { binding: 'MEDIA', bucket_name: 'terrastories-staging-media' },
        ],
      },
    },
  };
  it('accepts the bound bucket only', () => {
    expect(() =>
      assertMediaBucket(config, 'terrastories-staging-media')
    ).not.toThrow();
    expect(() =>
      assertMediaBucket(config, 'terrastories-staging-other')
    ).toThrow(GuardError);
    expect(() => assertMediaBucket({}, 'terrastories-staging-media')).toThrow(
      GuardError
    );
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
  const origin = 'https://app.terrastories.test';

  it('dry run prints create commands and executes none', () => {
    const r = run({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      STAGING_FRONTEND_ORIGIN: origin,
    });
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
      STAGING_FRONTEND_ORIGIN: origin,
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
  if [ "$op" = get ]; then
    if [ ! -f "${store}/$key" ]; then echo "The specified key does not exist." >&2; exit 1; fi
    cp "${store}/$key" "$f"
  fi
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
      objects: [
        {
          key: 'k1',
          size: 5,
          sha256:
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          contentType: 'video/mp4',
        },
      ],
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

  it('refuses the whole wrangler path when an object is over 300 MiB', () => {
    const manifest = join(sqlOut, 'r2-upload-manifest.json');
    const original = readFileSync(manifest, 'utf8');
    writeFileSync(
      manifest,
      JSON.stringify({
        formatVersion: 1,
        objects: [
          {
            key: 'big',
            size: 400 * 1024 * 1024,
            sha256: 'y',
            contentType: 'video/mp4',
          },
        ],
      })
    );
    try {
      const r = run(['--r2-via-wrangler']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/over 300 MiB/);
    } finally {
      writeFileSync(manifest, original);
    }
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

describe('load-community.sh --r2-via-wrangler fail-closed get (fake npx)', () => {
  // A fresh work dir per scenario. The fake wrangler stores objects under
  // store/, logs every r2 call, and answers a missing key exactly like real
  // wrangler ("The specified key does not exist.", exit 1). R2_GET_ERROR
  // simulates a read failure that is NOT a not-found (a 403 from the R2 API).
  const setup = () => {
    const work = mkdtempSync(join(tmpdir(), 'load-r2-failclosed-'));
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const calls = join(work, 'calls.log');
    const store = join(work, 'store');
    mkdirSync(store);
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
  if [ "$op" = get ]; then
    if [ -n "\${R2_GET_ERROR:-}" ]; then
      echo "Failed to fetch /accounts/x/r2/buckets/b/objects/$key - 403: Forbidden;" >&2
      exit 1
    fi
    if [ ! -f "${store}/$key" ]; then echo "The specified key does not exist." >&2; exit 1; fi
    cp "${store}/$key" "$f"
  fi
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
    const body = 'hello';
    writeFileSync(join(transform, 'v2-media', 'k1'), body);
    const sha = createHash('sha256').update(body).digest('hex');
    const sqlOut = join(work, 'sql');
    mkdirSync(sqlOut);
    writeFileSync(join(sqlOut, 'd1-import.json'), '{"files":[]}');
    writeFileSync(join(sqlOut, '.backup-done'), '');
    writeFileSync(
      join(sqlOut, 'r2-upload-manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        objects: [
          {
            key: 'k1',
            size: body.length,
            sha256: sha,
            contentType: 'video/mp4',
          },
        ],
      })
    );
    writeFileSync(
      join(sqlOut, '.transform-manifest.sha256'),
      createHash('sha256').update('{"a":1}').digest('hex')
    );
    const run = (env: Record<string, string> = {}) =>
      spawnSync(
        'bash',
        [
          'scripts/staging/load-community.sh',
          '--transform-output',
          transform,
          '--sql-out',
          sqlOut,
          '--apply',
          '--r2-via-wrangler',
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
            R2_ACCESS_KEY_ID: '',
            R2_SECRET_ACCESS_KEY: '',
            R2_ACCOUNT_ID: '',
            ...env,
          },
        }
      );
    return { calls, store, run };
  };
  // the fake wrangler flattens bucket/key into one store filename
  const stored = 'terrastories-staging-media_k1';

  it('absent object: confirmed not-found leads to put and verify', () => {
    const { calls, store, run } = setup();
    const r = run();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/uploaded=1 already_present=0/);
    const log = readFileSync(calls, 'utf8');
    expect(log).toMatch(/r2 object get terrastories-staging-media\/k1/);
    expect(log).toMatch(/r2 object put terrastories-staging-media\/k1/);
    expect(readFileSync(join(store, stored), 'utf8')).toBe('hello');
  });

  it('present and matching: skip, never put', () => {
    const { calls, store, run } = setup();
    writeFileSync(join(store, stored), 'hello');
    const r = run();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/uploaded=0 already_present=1/);
    expect(readFileSync(calls, 'utf8')).not.toMatch(/r2 object put/);
  });

  it('present with a different sha256: die without overwriting', () => {
    const { calls, store, run } = setup();
    writeFileSync(join(store, stored), 'HELLO');
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the manifest/);
    expect(readFileSync(calls, 'utf8')).not.toMatch(/r2 object put/);
    expect(readFileSync(join(store, stored), 'utf8')).toBe('HELLO');
  });

  it('present with a different size: die without overwriting', () => {
    const { calls, store, run } = setup();
    writeFileSync(join(store, stored), 'hello world');
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the manifest/);
    expect(readFileSync(calls, 'utf8')).not.toMatch(/r2 object put/);
    expect(readFileSync(join(store, stored), 'utf8')).toBe('hello world');
  });

  it('get error that is not not-found: die without put, object untouched', () => {
    const { calls, store, run } = setup();
    // the object EXISTS: a blind put would overwrite it (and any S3 checksum
    // metadata it carries), so the read error must abort the load instead
    writeFileSync(join(store, stored), 'hello');
    const r = run({ R2_GET_ERROR: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/without confirming the key is absent/);
    expect(readFileSync(calls, 'utf8')).not.toMatch(/r2 object put/);
    expect(readFileSync(join(store, stored), 'utf8')).toBe('hello');
  });
});

describe('staging script --help', () => {
  it('load-community.sh prints the whole header, not a fixed line range', () => {
    const r = spawnSync(
      'bash',
      ['scripts/staging/load-community.sh', '--help'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--r2-via-wrangler');
    // the last header line, beyond the old fixed sed range
    expect(r.stdout).toContain('env -u CLOUDFLARE_API_TOKEN');
    expect(r.stdout).not.toContain('set -euo pipefail');
  });

  it('smoke.sh prints the whole header, not a fixed line range', () => {
    const r = spawnSync('bash', ['scripts/staging/smoke.sh', '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--skip-r2-probe');
    // the last header line, beyond the old fixed sed range
    expect(r.stdout).toContain(
      '(not required with --skip-r2-probe or --local)'
    );
    expect(r.stdout).not.toContain('set -euo pipefail');
  });
});

describe('load-community.sh --r2-via-wrangler empty fields (fake npx)', () => {
  const work = mkdtempSync(join(tmpdir(), 'load-r2-empty-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const calls = join(work, 'calls.log');
  const store = join(work, 'store');
  mkdirSync(store);
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
  if [ "$op" = get ]; then
    if [ ! -f "${store}/$key" ]; then echo "The specified key does not exist." >&2; exit 1; fi
    cp "${store}/$key" "$f"
  fi
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
  const body = 'world';
  writeFileSync(join(transform, 'v2-media', 'k2'), body);
  const sha = createHash('sha256').update(body).digest('hex');
  const sqlOut = join(work, 'sql');
  mkdirSync(sqlOut);
  writeFileSync(join(sqlOut, 'd1-import.json'), '{"files":[]}');
  writeFileSync(join(sqlOut, '.backup-done'), '');
  // an empty contentType sits between size and sha256: with a whitespace IFS
  // separator the fields would collapse and the sha check would fail
  writeFileSync(
    join(sqlOut, 'r2-upload-manifest.json'),
    JSON.stringify({
      formatVersion: 1,
      objects: [{ key: 'k2', size: body.length, sha256: sha, contentType: '' }],
    })
  );
  const stamp = spawnSync('bash', [
    '-c',
    `printf '%s' "$(sha256sum "${transform}/manifest.json" | cut -d' ' -f1)" > "${sqlOut}/.transform-manifest.sha256"`,
  ]);
  expect(stamp.status).toBe(0);

  it('uploads and verifies an object whose contentType is empty', () => {
    const r = spawnSync(
      'bash',
      [
        'scripts/staging/load-community.sh',
        '--transform-output',
        transform,
        '--sql-out',
        sqlOut,
        '--apply',
        '--r2-via-wrangler',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          R2_ACCESS_KEY_ID: '',
          R2_SECRET_ACCESS_KEY: '',
          R2_ACCOUNT_ID: '',
        },
      }
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/uploaded=1 already_present=0/);
    // the empty contentType stays the last argument; fields did not shift
    expect(readFileSync(calls, 'utf8')).toMatch(/--content-type\s*$/m);
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

  it('runs as a CLI when invoked with a relative script path', () => {
    const work = mkdtempSync(join(tmpdir(), 'tail-cli-'));
    const data = join(work, 'tail.json');
    writeFileSync(
      data,
      JSON.stringify({
        outcome: 'ok',
        cpuTime: 3,
        wallTime: 4,
        event: { request: { method: 'GET', url: 'https://x/health?q=1' } },
      })
    );
    const r = spawnSync(
      process.execPath,
      ['scripts/staging/parse-tail.mjs', data],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe(
      'method\turl\toutcome\tcpuTime_ms\twallTime_ms'
    );
    expect(r.stdout).toContain('GET\thttps://x/health\tok\t3\t4');
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

  it('cpu procedure is a concrete 300 MB create -> parts -> complete flow', () => {
    const r = run(['--cpu-procedure']);
    expect(r.status, r.stderr).toBe(0);
    // the helper and the exact routes/bodies of the direct-upload contract
    expect(r.stdout).toContain('scripts/staging/upload-large.ts --file');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('POST $STAGING_URL/v2/media/uploads');
    expect(r.stdout).toContain('partSha256');
    expect(r.stdout).toContain('EXACTLY its returned headers');
    expect(r.stdout).toContain('{parts: [{partNumber, etag}]}');
    expect(r.stdout).toContain('DELETEs /v2/media/<fileId>');
    // 2xx required everywhere; cpuTime AND wallTime for create AND complete
    expect(r.stdout).toMatch(/require 2xx for every part/);
    expect(r.stdout).toContain('(create) AND POST .../complete');
    expect(r.stdout).toMatch(/cpuTime \(ms\), wallTime \(ms\)/);
    // the old pointer at a walkthrough that never calls /v2/media/uploads
    expect(r.stdout).not.toContain('walkthrough media chapter');
    expect(r.stdout).not.toContain('record the complete call only');
  });
});

describe('smoke.sh --apply gating (fake npm, curl, date)', () => {
  const work = mkdtempSync(join(tmpdir(), 'smoke-apply-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  // Fake npm: when WT_RESULTS_FIXTURE is set, play the walkthrough far enough
  // to copy that results.json into the --out directory smoke passes.
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "npm $*" >> "\${NPM_LOG}"
if [ -n "\${WT_RESULTS_FIXTURE:-}" ]; then
  out=""
  args=("$@")
  for i in "\${!args[@]}"; do
    if [ "\${args[$i]}" = --out ]; then out="\${args[$((i+1))]}"; fi
  done
  if [ -n "$out" ]; then mkdir -p "$out"; cp "$WT_RESULTS_FIXTURE" "$out/results.json"; fi
fi
exit "\${NPM_RC:-0}"
`
  );
  // Fake curl: /health answers 200, everything else 404 (dev routes absent).
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
# The R2 CORS preflight (OPTIONS) gets an allowing answer for FAKE_ORIGIN.
for a in "$@"; do
  if [ "$a" = OPTIONS ]; then
    printf 'HTTP/2 204\\r\\naccess-control-allow-origin: %s\\r\\naccess-control-allow-methods: PUT\\r\\naccess-control-allow-headers: x-amz-content-sha256\\r\\n\\r\\n' "\${FAKE_ORIGIN:-}"
    exit 0
  fi
done
for a in "$@"; do url="$a"; done
case "$url" in
  */health) printf 200 ;;
  *) printf 404 ;;
esac
exit "\${FAKE_CURL_RC:-0}"
`
  );
  // Fake date: the first two 'date -u +%F' calls (TODAY and the walkthrough
  // START day) say 2026-01-01; any later one says 2026-01-02, so a marker that
  // wrongly used the END time would be observable. Other formats (the
  // walkthrough out-dir stamp) stay fixed at 20260101T000000Z.
  writeFileSync(
    join(bin, 'date'),
    `#!/usr/bin/env bash
case "$*" in
  *+%F*)
    n="$(cat "$DATE_STATE" 2>/dev/null || echo 0)"
    n=$((n+1)); printf '%s' "$n" > "$DATE_STATE"
    if [ "$n" -le 2 ]; then echo 2026-01-01; else echo 2026-01-02; fi ;;
  *) echo 20260101T000000Z ;;
esac
`
  );
  // Fake npx: the R2 part-checksum probe exits with FAKE_PROBE_RC.
  writeFileSync(
    join(bin, 'npx'),
    `#!/usr/bin/env bash
# Only the probe is faked; guards and everything else run the real npx.
case "$*" in
  *verify-r2-part-checksum*)
    echo "npx $*" >> "\${NPM_LOG}"
    exit "\${FAKE_PROBE_RC:-0}" ;;
esac
PATH="\${PATH#*:}" exec npx "$@"
`
  );
  for (const f of ['npm', 'curl', 'date', 'npx'])
    chmodSync(join(bin, f), 0o755);
  const LOCAL_URL = 'http://127.0.0.1:9';
  const REMOTE_URL = 'https://terrastories-staging-api.x.workers.dev';
  const run = (
    args: string[],
    env: Record<string, string> = {},
    url = LOCAL_URL
  ) =>
    spawnSync('bash', ['scripts/staging/smoke.sh', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STAGING_URL: url,
        NPM_LOG: join(work, 'npm.log'),
        DATE_STATE: join(work, 'date.state'),
        STAGING_MARKER_DIR: join(work, 'marker-out'),
        WT_SUPER_IDENTIFIER: '',
        WT_SUPER_PASSWORD: '',
        R2_ACCOUNT_ID: '',
        R2_ACCESS_KEY_ID: '',
        R2_SECRET_ACCESS_KEY: '',
        R2_BUCKET_NAME: '',
        ...env,
      },
    });

  it('--apply --skip-walkthrough needs no walkthrough credentials', () => {
    const r = run(['--apply', '--local', '--skip-walkthrough']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/walkthrough skipped/);
  });

  it('--apply still requires credentials when the walkthrough will run', () => {
    const r = run(['--apply', '--local']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/WT_SUPER_IDENTIFIER/);
  });

  // The marker must record the UTC day the import COMMITTED: prefer the
  // commit step's timestamp in the walkthrough's results.json, fall back to
  // the walkthrough START day, never the end time (fake date: the first two
  // +%F calls say 2026-01-01, any later one says 2026-01-02).
  const hash = createHash('sha256')
    .update(LOCAL_URL)
    .digest('hex')
    .slice(0, 12);
  // Markers and walkthrough output live in a temp dir (STAGING_MARKER_DIR),
  // never in the repo's real walkthrough-out/.
  const markDir = join(work, 'marker-out');
  const mark = join(markDir, '.staging-import-utc-day-' + hash);
  const wtOut = join(markDir, 'staging-20260101T000000Z');
  const cleanMarker = () => {
    if (existsSync(mark)) unlinkSync(mark);
    if (existsSync(wtOut)) rmSync(wtOut, { recursive: true, force: true });
  };
  const runWithResults = (steps: unknown) =>
    runWithRaw(JSON.stringify({ runId: 'wt-test', steps }));
  const runWithRaw = (text: string) => {
    const fixture = join(work, 'results-fixture.json');
    writeFileSync(fixture, text);
    writeFileSync(join(work, 'date.state'), '0');
    cleanMarker();
    try {
      const r = run(['--apply', '--local'], {
        WT_SUPER_IDENTIFIER: 'test-super',
        WT_SUPER_PASSWORD: 'test-password',
        WT_RESULTS_FIXTURE: fixture,
      });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toMatch(/npm run walkthrough/);
      return existsSync(mark) ? readFileSync(mark, 'utf8').trim() : null;
    } finally {
      cleanMarker();
    }
  };

  it('marker falls back to the walkthrough START day, never the end time', () => {
    // no results.json: the fake npm writes nothing without a fixture
    writeFileSync(join(work, 'date.state'), '0');
    cleanMarker();
    try {
      const r = run(['--apply', '--local'], {
        WT_SUPER_IDENTIFIER: 'test-super',
        WT_SUPER_PASSWORD: 'test-password',
      });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toMatch(/npm run walkthrough/);
      // start day was 2026-01-01; an end-time marker would say 2026-01-02
      expect(readFileSync(mark, 'utf8').trim()).toBe('2026-01-01');
    } finally {
      cleanMarker();
    }
  });

  it('marker records the commit day from results.json, ignoring the 429 retry', () => {
    // committed just before midnight; the run (and a refused second commit)
    // ended on the next day: the marker must stay on the commit day
    const day = runWithResults([
      {
        outcome: 'pass',
        method: 'POST',
        path: '/v2/imports/7/commit',
        status: 201,
        at: '2026-01-01T23:59:50.000Z',
      },
      {
        outcome: 'pass',
        method: 'POST',
        path: '/v2/imports/8/commit',
        status: 429,
        at: '2026-01-02T00:00:05.000Z',
      },
    ]);
    expect(day).toBe('2026-01-01');
  });

  it('marker follows a commit that happened after midnight', () => {
    const day = runWithResults([
      {
        outcome: 'pass',
        method: 'POST',
        path: '/v2/imports/7/commit',
        status: 200,
        at: '2026-01-02T00:00:10.000Z',
      },
    ]);
    expect(day).toBe('2026-01-02');
  });

  it('marker prefers the server commit timestamp over the client response time', () => {
    // server committed before midnight; the response reached the client after
    const day = runWithResults([
      {
        outcome: 'pass',
        method: 'POST',
        path: '/v2/imports/7/commit',
        status: 201,
        serverAt: '2026-01-01T23:59:59.900Z',
        at: '2026-01-02T00:00:00.400Z',
      },
    ]);
    expect(day).toBe('2026-01-01');
  });

  it('writes NO marker when results.json parses but has no passing commit', () => {
    const day = runWithResults([
      {
        outcome: 'skip',
        method: 'POST',
        path: '/v2/imports/7/commit',
        at: '2026-01-01T10:00:00.000Z',
      },
      { outcome: 'pass', method: 'GET', path: '/health', status: 200 },
    ]);
    expect(day).toBeNull();
  });

  it('writes NO marker on a wrong-shape results.json (never the fallback)', () => {
    expect(runWithResults({})).toBeNull();
    expect(runWithResults([null])).toBeNull();
    expect(runWithRaw('[]')).toBeNull();
    // An array entry or a non-string path never counts as a commit step.
    const commit = {
      outcome: 'pass',
      method: 'POST',
      path: '/v2/imports/7/commit',
      status: 200,
      serverAt: '2026-01-03T10:00:00.000Z',
    };
    expect(runWithResults([[], commit])).toBeNull();
    expect(
      runWithResults([{ ...commit, path: ['/v2/imports/7/commit'] }])
    ).toBeNull();
  });

  it('falls back to the START day when results.json is not valid JSON', () => {
    expect(runWithRaw('{ not json')).toBe('2026-01-01');
  });

  it('resolves a relative STAGING_MARKER_DIR against the caller cwd', () => {
    const cwd = mkdtempSync(join(work, 'cwd-'));
    writeFileSync(join(work, 'date.state'), '0');
    const relFixture = join(work, 'rel-results.json');
    writeFileSync(
      relFixture,
      JSON.stringify({
        runId: 'wt-rel',
        steps: [
          {
            outcome: 'pass',
            method: 'POST',
            path: '/v2/imports/7/commit',
            status: 200,
            serverAt: '2026-01-05T12:00:00.000Z',
          },
        ],
      })
    );
    const r = spawnSync(
      'bash',
      [join(ROOT, 'scripts/staging/smoke.sh'), '--apply', '--local'],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STAGING_URL: LOCAL_URL,
          NPM_LOG: join(work, 'npm.log'),
          DATE_STATE: join(work, 'date.state'),
          STAGING_MARKER_DIR: 'rel-out',
          // A real commit day (not the start-day fallback) proves smoke read
          // the results.json the walkthrough wrote under the resolved dir.
          WT_RESULTS_FIXTURE: relFixture,
          WT_SUPER_IDENTIFIER: 'test-super',
          WT_SUPER_PASSWORD: 'test-password',
        },
      }
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(
      readFileSync(
        join(cwd, 'rel-out', '.staging-import-utc-day-' + hash),
        'utf8'
      ).trim()
    ).toBe('2026-01-05');
    expect(existsSync(join(ROOT, 'rel-out'))).toBe(false);
  });

  it('marker-skip branch says so and ends with a walkthrough NOT run summary', () => {
    writeFileSync(join(work, 'date.state'), '0');
    cleanMarker();
    mkdirSync(markDir, { recursive: true });
    writeFileSync(mark, '2026-01-01\n');
    try {
      const r = run(['--apply', '--local'], {});
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toMatch(/walkthrough already ran today/);
      expect(r.stdout).toMatch(/summary: walkthrough NOT run \(/);
      expect(r.stdout).not.toMatch(/npm run walkthrough/);
    } finally {
      cleanMarker();
    }
  });

  it('--skip-walkthrough ends with a walkthrough NOT run summary', () => {
    const r = run(['--apply', '--local', '--skip-walkthrough']);
    expect(r.stdout).toMatch(
      /summary: walkthrough NOT run \(--skip-walkthrough/
    );
  });

  it('--apply fails when curl exits non-zero even if it printed the expected code', () => {
    const r = run(['--apply', '--local', '--skip-walkthrough'], {
      FAKE_CURL_RC: '18',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/curl failed on GET \/health \(exit 18\)/);
  });

  it('cpu procedure never puts the cookie on the curl command line', () => {
    const r = run(['--cpu-procedure']);
    expect(r.stdout).not.toMatch(/-H "Cookie:/);
    expect(r.stdout).toContain('-H @"$f"');
    expect(r.stdout).toContain('mktemp');
    expect(r.stdout).toContain('rm -f "$f"');
    expect(r.stdout).not.toContain('cookie.hdr');
  });

  it('--skip-r2-probe records the probe as NOT done, never a pass', () => {
    const r = run(
      ['--apply', '--skip-walkthrough', '--skip-r2-probe'],
      {},
      REMOTE_URL
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/R2 probe skipped: not verified/);
    expect(r.stdout).toMatch(/summary: R2 part-checksum probe NOT done/);
    expect(r.stdout).not.toMatch(/verify-r2-part-checksum/);
    expect(r.stdout).not.toMatch(/done: enforced/);
  });

  it('dry run with --skip-r2-probe prints the skip and no probe command', () => {
    const r = run(['--skip-r2-probe'], {}, REMOTE_URL);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/R2 probe skipped: not verified/);
    expect(r.stdout).toMatch(/summary: R2 part-checksum probe NOT done/);
    expect(r.stdout).not.toMatch(/verify-r2-part-checksum/);
  });

  const probeEnv = (rc: string) => ({
    R2_ACCOUNT_ID: 'a'.repeat(32),
    R2_ACCESS_KEY_ID: 'test-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET_NAME: 'terrastories-staging-media',
    STAGING_FRONTEND_ORIGIN: 'https://app.terrastories-staging.example.org',
    FAKE_ORIGIN: 'https://app.terrastories-staging.example.org',
    FAKE_PROBE_RC: rc,
  });

  it('an apply run with an enforced probe (exit 0) passes after the CORS preflight', () => {
    const r = run(['--apply', '--skip-walkthrough'], probeEnv('0'), REMOTE_URL);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/CORS preflight allowed/);
    expect(r.stdout).toMatch(/summary: R2 part-checksum probe done: enforced/);
  });

  it('refuses a probe bucket that is not the deployed Worker MEDIA bucket', () => {
    const r = run(
      ['--apply', '--skip-walkthrough'],
      { ...probeEnv('0'), R2_BUCKET_NAME: 'terrastories-staging-other' },
      REMOTE_URL
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not the deployed Worker MEDIA bucket/);
    expect(r.stdout).not.toMatch(/CORS preflight allowed/);
  });

  it('refuses R2_ACCOUNT_ID that differs from CLOUDFLARE_ACCOUNT_ID', () => {
    const r = run(
      ['--apply', '--skip-walkthrough'],
      { ...probeEnv('0'), CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) },
      REMOTE_URL
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/does not match CLOUDFLARE_ACCOUNT_ID/);
    expect(r.stdout).not.toMatch(/CORS preflight allowed/);
  });

  it('fails when R2 accepts corrupted part bytes (probe exit 2), never records it', () => {
    const r = run(['--apply', '--skip-walkthrough'], probeEnv('2'), REMOTE_URL);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/R2 ACCEPTED corrupted part bytes/);
    expect(r.stdout).not.toMatch(/recorded, not a failure/);
  });

  it('fails when the probe is inconclusive (exit 1)', () => {
    const r = run(['--apply', '--skip-walkthrough'], probeEnv('1'), REMOTE_URL);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/probe inconclusive \(exit 1\)/);
  });

  it('without --skip-r2-probe an apply run still fails closed on missing R2 creds', () => {
    const r = run(['--apply', '--skip-walkthrough'], {}, REMOTE_URL);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/R2_ACCOUNT_ID/);
  });
});

describe('D1 database_id guard (assertStagingD1Id + CLI)', () => {
  const makeUuid = (ch: string) =>
    [8, 4, 4, 4, 12].map((n) => ch.repeat(n)).join('-');
  const stagingId = makeUuid('1');
  const prodId = makeUuid('2');
  const zeroId = makeUuid('0');

  const configWithId = (
    databaseId: string | undefined,
    databaseName = 'terrastories-staging-db'
  ) => ({
    env: {
      staging: {
        d1_databases: [
          {
            binding: 'DB',
            database_name: databaseName,
            ...(databaseId === undefined ? {} : { database_id: databaseId }),
          },
        ],
      },
    },
  });

  const d1List = (entries: unknown) => JSON.stringify(entries);

  it('accepts when terrastories-staging-db uuid equals env.staging DB database_id', () => {
    const list = d1List([
      { name: 'terrastories-prod-db', uuid: prodId },
      { name: 'terrastories-staging-db', uuid: stagingId },
    ]);
    expect(() =>
      assertStagingD1Id(configWithId(stagingId), list)
    ).not.toThrow();
    expect(() =>
      assertStagingD1Id(configWithId(stagingId.toUpperCase()), list)
    ).not.toThrow();
  });

  it('refuses a mismatched UUID (e.g. production UUID under staging name) without echoing IDs', () => {
    const list = d1List([
      { name: 'terrastories-prod-db', uuid: prodId },
      { name: 'terrastories-staging-db', uuid: stagingId },
    ]);
    let caught: unknown;
    try {
      assertStagingD1Id(configWithId(prodId), list);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuardError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/does not match/);
    expect(msg).not.toContain(prodId);
    expect(msg).not.toContain(stagingId);
  });

  it('refuses when terrastories-staging-db is absent, lookalike-only, or duplicated', () => {
    for (const list of [
      d1List([]),
      d1List([{ name: 'terrastories-staging-db-old', uuid: stagingId }]),
      d1List([{ name: 'terrastories-prod-db', uuid: stagingId }]),
    ]) {
      expect(() => assertStagingD1Id(configWithId(stagingId), list)).toThrow(
        /not found/
      );
    }
    expect(() =>
      assertStagingD1Id(
        configWithId(stagingId),
        d1List([
          { name: 'terrastories-staging-db', uuid: stagingId },
          { name: 'terrastories-staging-db', uuid: stagingId },
        ])
      )
    ).toThrow(/multiple/);
  });

  it('refuses placeholder, zero, missing, padded, or malformed config/account UUIDs', () => {
    const okList = d1List([
      { name: 'terrastories-staging-db', uuid: stagingId },
    ]);
    for (const badId of [
      'REPLACE-WITH-STAGING-D1-ID',
      zeroId,
      '',
      ` ${stagingId}`,
      'not-a-uuid',
      undefined,
    ]) {
      expect(() => assertStagingD1Id(configWithId(badId), okList)).toThrow(
        GuardError
      );
    }
    expect(() => assertStagingD1Id({}, okList)).toThrow(/no env\.staging/);
    expect(() =>
      assertStagingD1Id({ env: { staging: { d1_databases: [] } } }, okList)
    ).toThrow(/no DB binding/);
    expect(() =>
      assertStagingD1Id(
        {
          env: {
            staging: {
              d1_databases: [
                {
                  binding: 'DB',
                  database_name: 'terrastories-staging-db',
                  database_id: stagingId,
                },
                {
                  binding: 'DB',
                  database_name: 'terrastories-staging-db',
                  database_id: stagingId,
                },
              ],
            },
          },
        },
        okList
      )
    ).toThrow(/multiple DB bindings/);
    expect(() =>
      assertStagingD1Id(configWithId(stagingId, 'terrastories-prod-db'), okList)
    ).toThrow(/DB binding is not/);

    for (const badList of [
      '{ not json',
      '{}',
      'null',
      d1List([{ name: 'terrastories-staging-db', uuid: 'not-a-uuid' }]),
      d1List([{ name: 'terrastories-staging-db', uuid: zeroId }]),
      d1List([{ name: 'terrastories-staging-db' }]),
    ]) {
      expect(() => assertStagingD1Id(configWithId(stagingId), badList)).toThrow(
        GuardError
      );
    }
  });

  it('guards.ts d1-id CLI reads wrangler JSON on stdin and exits 0/1/2', () => {
    const work = mkdtempSync(join(tmpdir(), 'd1-id-cli-'));
    const cfg = join(work, 'wrangler.jsonc');
    writeFileSync(
      cfg,
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(
        'REPLACE-WITH-STAGING-D1-ID',
        stagingId
      )
    );
    const tsx = join(ROOT, 'node_modules/.bin/tsx');
    const runCli = (args: string[], input: string) =>
      spawnSync(tsx, ['scripts/staging/guards.ts', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        input,
      });

    const ok = runCli(
      ['d1-id', cfg],
      d1List([{ name: 'terrastories-staging-db', uuid: stagingId }])
    );
    expect(ok.status, ok.stderr).toBe(0);

    const bad = runCli(
      ['d1-id', cfg],
      d1List([{ name: 'terrastories-staging-db', uuid: prodId }])
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/does not match/);
    expect(bad.stderr).not.toContain(stagingId);
    expect(bad.stderr).not.toContain(prodId);

    const usage = runCli(['d1-id'], '[]');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('d1-id');
  });
});

describe('provision.sh D1 database_id deploy guard (fake npx, no network)', () => {
  const makeUuid = (ch: string) =>
    [8, 4, 4, 4, 12].map((n) => ch.repeat(n)).join('-');
  const stagingId = makeUuid('1');
  const prodId = makeUuid('2');
  const origin = 'https://app.terrastories.test';
  const bucket = 'terrastories-staging-media';
  const erasureBucket = 'terrastories-staging-erasure-records';
  const corsListOk = `Listing CORS rules for bucket '${bucket}'...\n\nallowed_origins:    ${origin}\nallowed_methods:    PUT\nallowed_headers:    x-amz-content-sha256, content-type\nexposed_headers:    ETag\nmax_age_seconds:    3600\n`;
  const lifecycleListOk = `Listing lifecycle rules for bucket '${bucket}'...\n\nname:     terrastories-staging-abort-incomplete-multipart\nenabled:  Yes\nprefix:   (all prefixes)\naction:   Abort incomplete multipart uploads after 1 days\n`;

  const setup = (configuredDbId: string, d1ListJson: string) => {
    const work = mkdtempSync(join(tmpdir(), 'provision-d1-id-'));
    const repo = join(work, 'repo');
    const stagingDir = join(repo, 'scripts/staging');
    const bin = join(work, 'bin');
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(bin);
    for (const f of ['provision.sh', 'lib.sh', 'guards.ts', 'r2-cors.json']) {
      copyFileSync(join(ROOT, 'scripts/staging', f), join(stagingDir, f));
    }
    chmodSync(join(stagingDir, 'provision.sh'), 0o755);
    writeFileSync(
      join(repo, 'wrangler.jsonc'),
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(
        'REPLACE-WITH-STAGING-D1-ID',
        configuredDbId
      )
    );
    const d1ListFile = join(work, 'd1-list.json');
    const corsListFile = join(work, 'cors-list.txt');
    const lifecycleListFile = join(work, 'lifecycle-list.txt');
    const callsLog = join(work, 'npx.log');
    writeFileSync(d1ListFile, d1ListJson);
    writeFileSync(corsListFile, corsListOk);
    writeFileSync(lifecycleListFile, lifecycleListOk);
    writeFileSync(
      join(bin, 'npx'),
      `#!/usr/bin/env bash
echo "$@" >> "${callsLog}"
case "$*" in
  *whoami*) echo "Account ${ACCOUNT}" ;;
  *"d1 list"*) cat "${d1ListFile}" ;;
  *"d1 info"*) echo '{"name":"terrastories-staging-db","database_size":1048576}' ;;
  *"r2 bucket list"*) printf 'name: %s\\nname: %s\\n' "${bucket}" "${erasureBucket}" ;;
  *"r2 bucket cors list"*) cat "${corsListFile}" ;;
  *"r2 bucket lifecycle list"*) cat "${lifecycleListFile}" ;;
  *tsx*) shift; shift; exec "${ROOT}/node_modules/.bin/tsx" "$@" ;;
esac
`
    );
    chmodSync(join(bin, 'npx'), 0o755);

    const run = (args: string[] = []) =>
      spawnSync('bash', [join(stagingDir, 'provision.sh'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          STAGING_FRONTEND_ORIGIN: origin,
        },
      });
    const calls = () =>
      existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '';
    return { run, calls, repo };
  };

  it('match under --apply: verifies D1 database_id and proceeds to dry-run and real deploy', () => {
    const { run, calls, repo } = setup(
      stagingId,
      JSON.stringify([
        { name: 'terrastories-prod-db', uuid: prodId },
        { name: 'terrastories-staging-db', uuid: stagingId },
      ])
    );
    const r = run(['--apply']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('D1 database_id verified');
    const log = calls();
    const d1IdPos = log.indexOf('guards.ts d1-id');
    const config = join(repo, 'wrangler.jsonc');
    const deploy = `wrangler deploy --env staging --config ${config}`;
    expect(log.match(/^wrangler d1 list .*$/gm)).toEqual(
      Array(2).fill(`wrangler d1 list --json --config ${config}`)
    );
    const dryDeployPos = log.indexOf(`${deploy} --dry-run\n`);
    const realDeployPos = log.indexOf(`${deploy}\n`);
    expect(d1IdPos).toBeGreaterThan(-1);
    expect(dryDeployPos).toBeGreaterThan(d1IdPos);
    expect(realDeployPos).toBeGreaterThan(dryDeployPos);
  });

  it('refuses a Wrangler deploy config redirect before any npx call', () => {
    const { run, calls, repo } = setup(stagingId, '[]');
    const redirectDir = join(repo, '.wrangler/deploy');
    mkdirSync(redirectDir, { recursive: true });
    writeFileSync(join(redirectDir, 'config.json'), '{}');

    const r = run(['--apply']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Wrangler deploy config redirect exists');
    expect(calls()).toBe('');
  });

  it('mismatch under --apply: dies before both --dry-run and real deploy', () => {
    const { run, calls } = setup(
      prodId,
      JSON.stringify([
        { name: 'terrastories-prod-db', uuid: prodId },
        { name: 'terrastories-staging-db', uuid: stagingId },
      ])
    );
    const r = run(['--apply']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match/);
    expect(r.stderr).toMatch(/guard 'd1-id' refused/);
    expect(r.stderr + r.stdout).not.toContain(prodId);
    expect(r.stderr + r.stdout).not.toContain(stagingId);
    expect(calls()).not.toContain('wrangler deploy');
  });

  it('missing staging DB under --apply: dies before deploy', () => {
    const { run, calls } = setup(
      stagingId,
      JSON.stringify([{ name: 'terrastories-prod-db', uuid: prodId }])
    );
    const r = run(['--apply']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not found/);
    expect(calls()).not.toContain('wrangler deploy');
  });

  it('dry run with a real database_id prints the check and deploy commands only', () => {
    const { run, calls } = setup(
      prodId,
      JSON.stringify([{ name: 'terrastories-staging-db', uuid: stagingId }])
    );
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('+ npx wrangler d1 list --json');
    expect(r.stdout).toMatch(
      /\+ npx wrangler deploy --env staging --config .* --dry-run/
    );
    expect(r.stdout).toContain('+ npx wrangler deploy --env staging');
    const log = calls();
    expect(log).not.toContain('guards.ts d1-id');
    expect(log).not.toContain('wrangler deploy');
  });

  it('placeholder database_id keeps existing behavior (skips deploy without d1-id guard)', () => {
    const { run, calls } = setup('REPLACE-WITH-STAGING-D1-ID', '[]');
    const r = run(['--apply']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain(
      'wrangler.jsonc still has the placeholder staging database_id: not deploying the Worker'
    );
    const log = calls();
    expect(log).not.toContain('guards.ts d1-id');
    expect(log).not.toContain('wrangler deploy');
  });
});

describe('Workers plan-aware guards (free and paid)', () => {
  const baseConfig = () =>
    parseJsonc(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')) as {
      limits?: unknown;
      d1_databases?: unknown;
      r2_buckets?: unknown;
      vars?: Record<string, string>;
      triggers?: { crons?: string[] };
      env: {
        staging: {
          name?: string;
          d1_databases?: Array<Record<string, unknown>>;
          r2_buckets?: Array<Record<string, unknown>>;
          vars?: Record<string, string>;
          triggers?: { crons?: string[] };
          limits?: unknown;
        };
      };
    };

  it('parseWorkersPlan defaults to free and refuses unknown plans', () => {
    expect(parseWorkersPlan(undefined)).toBe('free');
    expect(parseWorkersPlan('free')).toBe('free');
    expect(parseWorkersPlan('paid')).toBe('paid');
    for (const bad of ['', 'pro', 'PAID', 'Free', 'enterprise']) {
      expect(() => parseWorkersPlan(bad), bad).toThrow(GuardError);
    }
  });

  it('assertCronBudget enforces 5 on free and 1000 on paid', () => {
    expect(FREE_CRON_LIMIT_PER_ACCOUNT).toBe(5);
    expect(PAID_CRON_LIMIT_PER_ACCOUNT).toBe(1000);
    expect(() => assertCronBudget(3, 2, 'free')).not.toThrow();
    expect(() => assertCronBudget(3, 3, 'free')).toThrow(/Workers Free limit/);
    expect(() => assertCronBudget(3, 3, 'paid')).not.toThrow();
    expect(() => assertCronBudget(3, 997, 'paid')).not.toThrow();
    expect(() => assertCronBudget(3, 998, 'paid')).toThrow(
      /Workers Paid limit of 1000/
    );
    expect(() => assertCronBudget(3, Number.NaN, 'paid')).toThrow(GuardError);
  });

  it('assertD1Size enforces 90% headroom of 500 MB (free) and 10 GB (paid)', () => {
    expect(D1_HEADROOM_BYTES).toBe(450_000_000);
    expect(D1_PAID_HEADROOM_BYTES).toBe(9_000_000_000);
    expect(() => assertD1Size(450_000_000, 'free')).not.toThrow();
    expect(() => assertD1Size(450_000_001, 'free')).toThrow(
      /500 MB free limit/
    );
    expect(() => assertD1Size(460_000_000, 'paid')).not.toThrow();
    expect(() => assertD1Size(9_000_000_000, 'paid')).not.toThrow();
    expect(() => assertD1Size(9_000_000_001, 'paid')).toThrow(
      /10 GB paid limit/
    );
  });

  it('extractD1SizeFromInfo parses wrangler d1 info --json (including 0-byte file_size)', () => {
    expect(
      extractD1SizeFromInfo(
        JSON.stringify({
          name: 'terrastories-staging-db',
          database_size: 16384,
        })
      )
    ).toBe(16384);
    expect(
      extractD1SizeFromInfo(
        JSON.stringify({ name: 'terrastories-staging-db', file_size: 0 })
      )
    ).toBe(0);
    for (const bad of [
      '',
      '{ not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ database_size: '100' }),
      JSON.stringify({ database_size: -1 }),
    ]) {
      expect(() => extractD1SizeFromInfo(bad), bad).toThrow(GuardError);
    }
  });

  it('assertStagingConfig applies Wrangler per-key inheritance for limits vs non-inheritable keys', () => {
    // Default free accepts committed wrangler.jsonc (no limits anywhere)
    const clean = baseConfig();
    expect(() => assertStagingConfig(clean, 'free')).not.toThrow();
    expect(() => assertStagingConfig(clean, 'paid')).toThrow(/limits\.cpu_ms/);

    // Inheritable: top-level limits applies to env.staging when omitted there
    const topLimits = baseConfig();
    topLimits.limits = { cpu_ms: 30000 };
    expect(() => assertStagingConfig(topLimits, 'free')).toThrow(
      /effective limits block/
    );
    expect(() => assertStagingConfig(topLimits, 'paid')).not.toThrow();

    // Explicit env.staging.limits overrides top-level limits
    const envLimits = baseConfig();
    envLimits.env.staging.limits = { cpu_ms: 30000 };
    expect(() => assertStagingConfig(envLimits, 'free')).toThrow(
      /effective limits block/
    );
    expect(() => assertStagingConfig(envLimits, 'paid')).not.toThrow();

    // env.staging.limits: {} overrides top-level limits: refused on BOTH plans
    const emptyOverride = baseConfig();
    emptyOverride.limits = { cpu_ms: 30000 };
    emptyOverride.env.staging.limits = {};
    expect(() => assertStagingConfig(emptyOverride, 'free')).toThrow(
      /effective limits block/
    );
    expect(() => assertStagingConfig(emptyOverride, 'paid')).toThrow(
      /limits\.cpu_ms/
    );

    // Paid cpu_ms bounds: integer 1..300000
    for (const okCpu of [1, 30000, 300000]) {
      const cfg = baseConfig();
      cfg.env.staging.limits = { cpu_ms: okCpu };
      expect(
        () => assertStagingConfig(cfg, 'paid'),
        String(okCpu)
      ).not.toThrow();
    }
    for (const badLimits of [
      null,
      [],
      {},
      { cpu_ms: 0 },
      { cpu_ms: -10 },
      { cpu_ms: 300001 },
      { cpu_ms: 10.5 },
      { cpu_ms: '30000' },
    ]) {
      const cfg = baseConfig();
      cfg.env.staging.limits = badLimits;
      expect(
        () => assertStagingConfig(cfg, 'paid'),
        JSON.stringify(badLimits)
      ).toThrow(GuardError);
    }

    // Non-inheritable keys: bindings, vars and triggers NEVER inherit from top-level
    const noBindings = baseConfig();
    noBindings.env.staging.limits = { cpu_ms: 30000 };
    noBindings.d1_databases = noBindings.env.staging.d1_databases;
    delete noBindings.env.staging.d1_databases;
    expect(() => assertStagingConfig(noBindings, 'paid')).toThrow(/DB binding/);

    const noVars = baseConfig();
    noVars.env.staging.limits = { cpu_ms: 30000 };
    noVars.vars = noVars.env.staging.vars;
    delete noVars.env.staging.vars;
    expect(() => assertStagingConfig(noVars, 'paid')).toThrow(/R2_BUCKET_NAME/);
  });

  it('guards.ts CLI accepts explicit free|paid plan on config, crons and d1-size', () => {
    const tsx = join(ROOT, 'node_modules/.bin/tsx');
    const work = mkdtempSync(join(tmpdir(), 'guards-plan-cli-'));
    const paidCfg = join(work, 'wrangler-paid.jsonc');
    const baseText = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    writeFileSync(
      paidCfg,
      baseText.replace(
        '"observability": { "enabled": false, "traces": { "enabled": false } },\n    },\n  },\n}',
        '"limits": { "cpu_ms": 30000 },\n      "observability": { "enabled": false, "traces": { "enabled": false } },\n    },\n  },\n}'
      )
    );
    const runCli = (args: string[], input?: string) =>
      spawnSync(tsx, ['scripts/staging/guards.ts', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        input,
      });

    expect(
      runCli(['config', join(ROOT, 'wrangler.jsonc'), 'free']).status
    ).toBe(0);
    expect(
      runCli(['config', join(ROOT, 'wrangler.jsonc'), 'paid']).status
    ).toBe(1);
    expect(runCli(['config', paidCfg, 'paid']).status).toBe(0);
    expect(runCli(['config', paidCfg, 'free']).status).toBe(1);
    expect(runCli(['config', paidCfg, 'bogus']).status).toBe(1);

    expect(
      runCli(['crons', join(ROOT, 'wrangler.jsonc'), 'staging', '3', 'free'])
        .status
    ).toBe(1);
    expect(
      runCli(['crons', join(ROOT, 'wrangler.jsonc'), 'staging', '3', 'paid'])
        .status
    ).toBe(0);

    expect(runCli(['d1-size', '460000000', 'free']).status).toBe(1);
    expect(runCli(['d1-size', '460000000', 'paid']).status).toBe(0);
    expect(runCli(['d1-size', '9500000000', 'paid']).status).toBe(1);
    expect(
      runCli(
        ['d1-size', '--json', 'paid'],
        JSON.stringify({ database_size: 460_000_000 })
      ).status
    ).toBe(0);
    expect(
      runCli(
        ['d1-size', '--json', 'free'],
        JSON.stringify({ database_size: 460_000_000 })
      ).status
    ).toBe(1);
  });
});

describe('provision.sh plan-aware wiring and d1-size guard (fake npx, no network)', () => {
  const makeUuid = (ch: string) =>
    [8, 4, 4, 4, 12].map((n) => ch.repeat(n)).join('-');
  const stagingId = makeUuid('3');
  const origin = 'https://app.terrastories.test';
  const bucket = 'terrastories-staging-media';
  const erasureBucket = 'terrastories-staging-erasure-records';
  const corsListOk = `Listing CORS rules for bucket '${bucket}'...\n\nallowed_origins:    ${origin}\nallowed_methods:    PUT\nallowed_headers:    x-amz-content-sha256, content-type\nexposed_headers:    ETag\nmax_age_seconds:    3600\n`;
  const lifecycleListOk = `Listing lifecycle rules for bucket '${bucket}'...\n\nname:     terrastories-staging-abort-incomplete-multipart\nenabled:  Yes\nprefix:   (all prefixes)\naction:   Abort incomplete multipart uploads after 1 days\n`;

  const setup = (opts: {
    d1InfoJson?: string;
    d1InfoFail?: boolean;
    stagingLimits?: string;
    topLevelLimits?: string;
  }) => {
    const work = mkdtempSync(join(tmpdir(), 'provision-plan-'));
    const repo = join(work, 'repo');
    const stagingDir = join(repo, 'scripts/staging');
    const bin = join(work, 'bin');
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(bin);
    for (const f of ['provision.sh', 'lib.sh', 'guards.ts', 'r2-cors.json']) {
      copyFileSync(join(ROOT, 'scripts/staging', f), join(stagingDir, f));
    }
    chmodSync(join(stagingDir, 'provision.sh'), 0o755);
    let wranglerText = readFileSync(
      join(ROOT, 'wrangler.jsonc'),
      'utf8'
    ).replace('REPLACE-WITH-STAGING-D1-ID', stagingId);
    if (opts.topLevelLimits) {
      wranglerText = wranglerText.replace(
        '"compatibility_date": "2026-11-12",',
        `"compatibility_date": "2026-11-12",\n  "limits": ${opts.topLevelLimits},`
      );
    }
    if (opts.stagingLimits) {
      wranglerText = wranglerText.replace(
        '"observability": { "enabled": false, "traces": { "enabled": false } },\n    },\n  },\n}',
        `"limits": ${opts.stagingLimits},\n      "observability": { "enabled": false, "traces": { "enabled": false } },\n    },\n  },\n}`
      );
    }
    writeFileSync(join(repo, 'wrangler.jsonc'), wranglerText);
    const d1InfoFile = join(work, 'd1-info.json');
    const corsListFile = join(work, 'cors-list.txt');
    const lifecycleListFile = join(work, 'lifecycle-list.txt');
    const callsLog = join(work, 'npx.log');
    writeFileSync(
      d1InfoFile,
      opts.d1InfoJson ??
        JSON.stringify({
          uuid: stagingId,
          name: 'terrastories-staging-db',
          database_size: 10_000_000,
        })
    );
    writeFileSync(corsListFile, corsListOk);
    writeFileSync(lifecycleListFile, lifecycleListOk);
    writeFileSync(
      join(bin, 'npx'),
      `#!/usr/bin/env bash
echo "$@" >> "${callsLog}"
case "$*" in
  *whoami*) echo "Account ${ACCOUNT}" ;;
  *"d1 list"*) echo '${JSON.stringify([{ name: 'terrastories-staging-db', uuid: stagingId }])}' ;;
  *"d1 info"*)
    if [ "${opts.d1InfoFail ? '1' : '0'}" = "1" ]; then exit 1; fi
    cat "${d1InfoFile}" ;;
  *"r2 bucket list"*) printf 'name: %s\\nname: %s\\n' "${bucket}" "${erasureBucket}" ;;
  *"r2 bucket cors list"*) cat "${corsListFile}" ;;
  *"r2 bucket lifecycle list"*) cat "${lifecycleListFile}" ;;
  *tsx*) shift; shift; exec "${ROOT}/node_modules/.bin/tsx" "$@" ;;
esac
`
    );
    chmodSync(join(bin, 'npx'), 0o755);

    const run = (env: Record<string, string> = {}, args: string[] = []) =>
      spawnSync('bash', [join(stagingDir, 'provision.sh'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          STAGING_FRONTEND_ORIGIN: origin,
          ...env,
        },
      });
    const calls = () =>
      existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '';
    return { run, calls };
  };

  it('prints the plan in both dry-run and apply modes and rejects invalid WORKERS_PLAN', () => {
    const { run, calls } = setup({});
    const bad = run({ WORKERS_PLAN: 'enterprise' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/WORKERS_PLAN must be 'free' or 'paid'/);
    expect(calls()).toBe('');

    const dry = run({});
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('mode: DRY-RUN plan: free');
    expect(dry.stdout).toContain(
      '+ npx wrangler d1 info terrastories-staging-db --json'
    );
    expect(calls()).not.toContain('d1 info');

    const applied = run({}, ['--apply']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('mode: APPLY plan: free');
    expect(applied.stdout).toContain(
      'D1 size verified within free plan headroom'
    );
    expect(calls()).toContain(
      'wrangler d1 info terrastories-staging-db --json'
    );
  });

  it('free plan refuses oversized D1 (460 MB) and inherited top-level limits', () => {
    const big = setup({
      d1InfoJson: JSON.stringify({
        name: 'terrastories-staging-db',
        database_size: 460_000_000,
      }),
    });
    const rBig = big.run({}, ['--apply']);
    expect(rBig.status).not.toBe(0);
    expect(rBig.stderr).toMatch(/500 MB free limit/);
    expect(big.calls()).not.toContain('wrangler deploy');

    const topLim = setup({ topLevelLimits: '{ "cpu_ms": 30000 }' });
    const rLim = topLim.run({});
    expect(rLim.status).not.toBe(0);
    expect(rLim.stderr).toMatch(/effective limits block/);
  });

  it('paid plan accepts 6 crons, 460 MB D1, and limits.cpu_ms; refuses 9.5 GB D1 and missing limits', () => {
    const paidOk = setup({
      stagingLimits: '{ "cpu_ms": 30000 }',
      d1InfoJson: JSON.stringify({
        name: 'terrastories-staging-db',
        database_size: 460_000_000,
      }),
    });
    const dry = paidOk.run({ WORKERS_PLAN: 'paid', OTHER_CRON_TRIGGERS: '3' });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('mode: DRY-RUN plan: paid');
    expect(dry.stdout).toContain(
      'wrangler d1 info terrastories-staging-db --json'
    );

    const applied = paidOk.run(
      { WORKERS_PLAN: 'paid', OTHER_CRON_TRIGGERS: '3' },
      ['--apply']
    );
    expect(applied.status, applied.stderr + applied.stdout).toBe(0);
    expect(applied.stdout).toContain('mode: APPLY plan: paid');
    expect(applied.stdout).toContain(
      'D1 size verified within paid plan headroom'
    );

    const paidBig = setup({
      stagingLimits: '{ "cpu_ms": 30000 }',
      d1InfoJson: JSON.stringify({
        name: 'terrastories-staging-db',
        database_size: 9_500_000_000,
      }),
    });
    const rBig = paidBig.run({ WORKERS_PLAN: 'paid' }, ['--apply']);
    expect(rBig.status).not.toBe(0);
    expect(rBig.stderr).toMatch(/10 GB paid limit/);
    expect(paidBig.calls()).not.toContain('wrangler deploy');

    const paidNoLimits = setup({});
    const rNoLim = paidNoLimits.run({ WORKERS_PLAN: 'paid' });
    expect(rNoLim.status).not.toBe(0);
    expect(rNoLim.stderr).toMatch(/limits\.cpu_ms/);
  });

  it('provision.sh --help documents both plans', () => {
    const r = spawnSync('bash', ['scripts/staging/provision.sh', '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('WORKERS_PLAN');
    expect(r.stdout).toContain('1000 on');
    expect(r.stdout).toContain('10 GB on Paid');
  });
});

describe('smoke.sh WORKERS_PLAN handling (fake npm)', () => {
  const work = mkdtempSync(join(tmpdir(), 'smoke-plan-'));
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const npmLog = join(work, 'npm.log');
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash\necho "npm $*" >> "${npmLog}"\nexit 0\n`
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/staging/smoke.sh', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STAGING_URL: 'http://127.0.0.1:9',
        ...env,
      },
    });

  it('rejects invalid WORKERS_PLAN values', () => {
    const r = run(['--cpu-procedure'], { WORKERS_PLAN: 'pro' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/WORKERS_PLAN must be 'free' or 'paid'/);
  });

  it('keeps cpu_procedure identical on unset vs free and switches pass rule on paid', () => {
    const def = run(['--cpu-procedure']);
    const free = run(['--cpu-procedure'], { WORKERS_PLAN: 'free' });
    expect(def.status, def.stderr).toBe(0);
    expect(free.status, free.stderr).toBe(0);
    expect(free.stdout).toBe(def.stdout);
    expect(def.stdout).toContain('Any 1102 is a NO-GO on Free');

    const paid = run(['--cpu-procedure'], { WORKERS_PLAN: 'paid' });
    expect(paid.status, paid.stderr).toBe(0);
    expect(paid.stdout).toContain('zero exceededCpu');
    expect(paid.stdout).toContain('p99 CPU per route under half of');
    expect(paid.stdout).toContain('limits.cpu_ms');
    expect(paid.stdout).not.toContain('NO-GO on Free');
  });

  it('passes --workers-plan to the walkthrough invocation', () => {
    const dryFree = run(['--local']);
    expect(dryFree.status, dryFree.stderr).toBe(0);
    expect(dryFree.stdout).toContain('--d1 --workers-plan free');

    const dryPaid = run(['--local'], { WORKERS_PLAN: 'paid' });
    expect(dryPaid.status, dryPaid.stderr).toBe(0);
    expect(dryPaid.stdout).toContain('--d1 --workers-plan paid');
  });
});

describe('scripts/production/wrangler.env.production.example.jsonc', () => {
  it('parses cleanly, matches wrangler.jsonc crons, and passes paid effective-config checks', () => {
    const examplePath = join(
      ROOT,
      'scripts/production/wrangler.env.production.example.jsonc'
    );
    const example = parseJsonc(readFileSync(examplePath, 'utf8'));
    const mainWrangler = parseJsonc(
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')
    ) as {
      triggers?: { crons?: string[] };
      env?: { staging?: { triggers?: { crons?: string[] } } };
    };

    const effective = resolveEffectiveEnvConfig(example, 'production');
    expect(effective.name).toBeTruthy();
    expect(
      effective.d1_databases?.find((d) => d.binding === 'DB')
    ).toMatchObject({
      binding: 'DB',
      database_id: 'REPLACE-WITH-PROD-D1-ID',
    });
    expect(
      effective.r2_buckets?.find((b) => b.binding === 'MEDIA')?.bucket_name
    ).toBeTruthy();
    expect(
      effective.r2_buckets?.find((b) => b.binding === 'ERASURE_RECORDS')
        ?.bucket_name
    ).toBeTruthy();
    expect(effective.vars?.PUBLIC_ORIGIN).toBeTruthy();
    expect(effective.vars?.CORS_ORIGINS).toBe('');
    expect(effective.vars?.R2_BUCKET_NAME).toBe(
      effective.r2_buckets?.find((b) => b.binding === 'MEDIA')?.bucket_name
    );
    expect(effective.triggers?.crons).toEqual(mainWrangler.triggers?.crons);
    expect(effective.triggers?.crons).toEqual(
      mainWrangler.env?.staging?.triggers?.crons
    );
    expect(effective.limits).toEqual({ cpu_ms: 30000 });

    // Effective-config plan validation accepts it for Paid and refuses it for Free
    expect(() =>
      assertPlanLimits(effective.limits, 'paid', 'env.production')
    ).not.toThrow();
    expect(() =>
      assertPlanLimits(effective.limits, 'free', 'env.production')
    ).toThrow(/effective limits block/);

    // Combining env.production into wrangler.jsonc keeps env.staging valid on Free
    const combined = {
      ...(mainWrangler as Record<string, unknown>),
      env: {
        ...mainWrangler.env,
        production: (example as { env: { production: unknown } }).env
          .production,
      },
    };
    expect(() => assertStagingConfig(combined, 'free')).not.toThrow();
  });
});
