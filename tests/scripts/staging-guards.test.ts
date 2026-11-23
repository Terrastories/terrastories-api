import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GuardError,
  assertAccountMatches,
  assertCronBudget,
  assertD1Size,
  assertStagingName,
  assertStagingUrl,
  countCrons,
  parseJsonc,
} from '../../scripts/staging/guards.js';

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
    expect(() => assertCronBudget(2, 3)).not.toThrow();
    expect(() => assertCronBudget(3, 3)).toThrow(/Free limit/);
    const config = parseJsonc(
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')
    );
    expect(countCrons(config, 'staging')).toBe(2);
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
  *"r2 bucket list"*) echo "" ;;
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

  it('refuses a name without the staging prefix', () => {
    const r = run({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      STAGING_R2_BUCKET: 'terrastories-media',
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('bucket create');
  });

  it('refuses an account mismatch', () => {
    const r = run({ CLOUDFLARE_ACCOUNT_ID: OTHER });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not show|refused/);
    expect(r.stdout).not.toContain('d1 create');
  });
});
