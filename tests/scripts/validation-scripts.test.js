import { describe, expect, it } from 'vitest';
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
