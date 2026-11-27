/**
 * The PostgreSQL drill must FAIL, not skip, when CI requires it and its
 * prerequisites are missing (DRILL_REQUIRE_POSTGRES=true), and may skip only
 * without that flag.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runDrill = (env: Record<string, string>) =>
  spawnSync(
    'npx',
    [
      'vitest',
      'run',
      'tests/drills/postgres-restore.test.ts',
      '--reporter=default',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DRILL_POSTGRES_URL: '', ...env },
    }
  );

describe('PostgreSQL drill prerequisite policy', () => {
  it('fails when required and prerequisites are missing', () => {
    const r = runDrill({ DRILL_REQUIRE_POSTGRES: 'true' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(
      'PostgreSQL restore drill cannot run'
    );
  }, 120_000);

  it('skips (exit 0) when not required', () => {
    const r = runDrill({ DRILL_REQUIRE_POSTGRES: '' });
    expect(r.status).toBe(0);
  }, 120_000);
});
