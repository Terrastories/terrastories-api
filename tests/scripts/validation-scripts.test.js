import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('hard-kills and rejects a command that ignores SIGTERM', async () => {
    const startedAt = performance.now();

    await expect(
      runCommand(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 10_000);",
        ],
        {
          label: 'hung-command',
          timeoutMs: 100,
          stdio: 'ignore',
        }
      )
    ).rejects.toThrow('hung-command exceeded 100ms and was terminated');

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('kills descendant processes when a shard exceeds its deadline', async () => {
    if (process.platform === 'win32') {
      // Windows does not expose Unix process groups; the bounded-command test
      // above still verifies the hard deadline on that platform.
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'terrastories-shard-timeout-'));
    const pidPath = join(tempDir, 'grandchild.pid');
    const grandchildCode =
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 10_000);";
    const parentCode = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 10_000);
    `;

    try {
      await expect(
        runCommand(process.execPath, ['-e', parentCode], {
          label: 'process-tree',
          timeoutMs: 500,
          stdio: 'ignore',
        })
      ).rejects.toThrow('process-tree exceeded 500ms and was terminated');

      const grandchildPid = Number(readFileSync(pidPath, 'utf8'));
      let grandchildAlive = true;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          process.kill(grandchildPid, 0);
        } catch (error) {
          if (error?.code === 'ESRCH') {
            grandchildAlive = false;
            break;
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(grandchildAlive).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('deterministic Vitest worker configuration', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );

  it('pins worker bounds for every CI test shard', () => {
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

  it('keeps measurement-sensitive performance tests out of coverage instrumentation', () => {
    const coverageCommand = packageJson.scripts['test:coverage'];
    const productionCommand = packageJson.scripts['test:ci:production'];

    expect(coverageCommand).toContain(
      '--exclude tests/production/performance.test.ts'
    );
    expect(coverageCommand).toContain('--maxWorkers=4');
    expect(coverageCommand).toContain('--minWorkers=4');

    // The performance suite is still required by the canonical CI suite; only
    // V8 instrumentation is excluded because it perturbs memory measurements.
    expect(productionCommand).toContain('tests/production');
    expect(productionCommand).toContain('--maxWorkers=1');
    expect(productionCommand).toContain('--minWorkers=1');
  });
});

describe('V2 sovereignty release gate', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const ciWorkflow = readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8'
  );

  it('defines a deterministic issue-specific sovereignty suite', () => {
    const command = packageJson.scripts['test:sovereignty'];

    expect(command).toBeDefined();
    expect(command).toContain('tests/security/sovereignty-matrix.test.ts');
    expect(command).toContain('tests/security/inactive-principal.test.ts');
    expect(command).toContain(
      'tests/security/sovereignty-audit-logging.test.ts'
    );
    expect(command).toContain(
      'tests/security/sovereignty-route-boundaries.test.ts'
    );
    expect(command).toContain(
      'tests/security/sovereignty-field-serialization.test.ts'
    );
    expect(command).toContain('tests/routes/public-api.test.ts');
    expect(command).toContain(
      'tests/shared/middleware/data-sovereignty.test.ts'
    );
    expect(command).toContain('--maxWorkers=2');
    expect(command).toContain('--minWorkers=2');
    expect(command).not.toContain('cultural-roles.test.ts');
  });

  it('runs the sovereignty suite as an explicit CI release gate', () => {
    expect(ciWorkflow).toContain('name: V2 data sovereignty gate');
    expect(ciWorkflow).toContain('npm run test:sovereignty');
  });
});
