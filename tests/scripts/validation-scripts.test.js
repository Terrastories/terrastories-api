import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  collectAdvisories,
  parseAuditReport,
} from '../../scripts/check-audit-baseline.mjs';
import { runCommand } from '../../scripts/run-test-shards.mjs';

describe('security audit baseline validation', () => {
  it('rejects valid JSON error responses from npm audit', () => {
    expect(() =>
      parseAuditReport(
        JSON.stringify({
          error: {
            code: 'EAI_AGAIN',
            summary: 'registry audit endpoint unavailable',
          },
        })
      )
    ).toThrow('npm audit failed: registry audit endpoint unavailable');
  });

  it('rejects reports that omit the vulnerabilities object', () => {
    expect(() => parseAuditReport(JSON.stringify({ metadata: {} }))).toThrow(
      'npm audit report is missing a vulnerabilities object'
    );
  });

  it('accepts a valid audit report and extracts advisory identities', () => {
    const report = parseAuditReport(
      JSON.stringify({
        vulnerabilities: {
          example: {
            via: [
              {
                source: 1234,
                severity: 'high',
                url: 'https://example.invalid/advisory',
              },
            ],
          },
        },
      })
    );

    expect(collectAdvisories(report)).toEqual([
      {
        source: '1234',
        package: 'example',
        severity: 'high',
        url: 'https://example.invalid/advisory',
      },
    ]);
  });
});

describe('bounded test shard runner', () => {
  it('resolves commands that finish before the deadline', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(0)'], {
        label: 'fast-command',
        timeoutMs: 2_000,
        stdio: 'ignore',
      })
    ).resolves.toBeUndefined();
  });

  it('terminates and rejects a command that exceeds its deadline', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
        label: 'hung-command',
        timeoutMs: 100,
        stdio: 'ignore',
      })
    ).rejects.toThrow('hung-command exceeded 100ms and was terminated');
  });
});

describe('deterministic Vitest worker configuration', () => {
  it('pins worker bounds for every CI test shard', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    );
    const shardScripts = Object.entries(packageJson.scripts).filter(([name]) =>
      name.startsWith('test:ci:')
    );

    expect(shardScripts.length).toBeGreaterThan(0);
    for (const [name, command] of shardScripts) {
      // Performance tests generate their own 100+ request concurrency and must
      // run without unrelated test-file contention. Other shards use a fixed
      // four-worker production-like CI configuration.
      const expectedWorkers = name === 'test:ci:production' ? 1 : 4;
      expect(command, `${name} must pin max workers`).toContain(
        `--maxWorkers=${expectedWorkers}`
      );
      expect(command, `${name} must pin min workers`).toContain(
        `--minWorkers=${expectedWorkers}`
      );
    }
  });
});
