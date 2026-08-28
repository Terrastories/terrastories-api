import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as auditModule from '../../scripts/check-audit-baseline.mjs';
import * as dependencyReview from '../../scripts/review-dependency-changes.mjs';

const tempDirs = [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createGitFixture({ currentLock = null } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'terrastories-dependency-review-'));
  tempDirs.push(cwd);

  const packageJson = {
    name: 'dependency-review-fixture',
    version: '1.0.0',
    private: true,
  };
  const baseLock = {
    name: 'dependency-review-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'dependency-review-fixture', version: '1.0.0' },
      'node_modules/alpha': { version: '1.0.0' },
    },
  };

  writeJson(join(cwd, 'package.json'), packageJson);
  writeJson(join(cwd, 'package-lock.json'), baseLock);
  run('git', ['init'], cwd);
  run('git', ['config', 'user.name', 'Terrastories Tests'], cwd);
  run('git', ['config', 'user.email', 'tests@terrastories.invalid'], cwd);
  run('git', ['add', 'package.json', 'package-lock.json'], cwd);
  run('git', ['commit', '-m', 'base'], cwd);
  const baseSha = run('git', ['rev-parse', 'HEAD'], cwd);

  if (currentLock) {
    writeJson(join(cwd, 'package-lock.json'), currentLock);
    run('git', ['add', 'package-lock.json'], cwd);
    run('git', ['commit', '-m', 'dependency change'], cwd);
  }

  return { cwd, baseSha };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of tempDirs.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe('dependency review execution', () => {
  it('reports dependency delta for a changed lockfile', async () => {
    const currentLock = {
      name: 'dependency-review-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'dependency-review-fixture', version: '1.0.0' },
        'node_modules/alpha': { version: '2.0.0' },
        'node_modules/@scope/beta': { version: '1.0.0' },
      },
    };
    const { cwd, baseSha } = createGitFixture({ currentLock });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dependencyReview.main({
      cwd,
      baseSha,
      auditCommand: [process.execPath, '-e', 'process.exit(0)'],
    });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('2 locked dependency changes detected')
    );
    expect(log).toHaveBeenCalledWith(
      '- changed: alpha 1.0.0 -> 2.0.0'
    );
    expect(log).toHaveBeenCalledWith('- added: @scope/beta none -> 1.0.0');
  });

  it('returns early when package manifests did not change', async () => {
    const { cwd, baseSha } = createGitFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dependencyReview.main({
      cwd,
      baseSha,
      auditCommand: [process.execPath, '-e', 'process.exit(99)'],
    });

    expect(log).toHaveBeenCalledWith(
      'Dependency review: no package manifest or lockfile changes.'
    );
  });

  it('fails closed when dependency audit rejects the change', async () => {
    const currentLock = {
      name: 'dependency-review-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'dependency-review-fixture', version: '1.0.0' },
        'node_modules/alpha': { version: '2.0.0' },
      },
    };
    const { cwd, baseSha } = createGitFixture({ currentLock });

    await expect(
      dependencyReview.main({
        cwd,
        baseSha,
        auditCommand: [process.execPath, '-e', 'process.exit(7)'],
      })
    ).rejects.toThrow(/dependency audit rejected/i);
  });

  it('fails closed when the audit executable cannot start', async () => {
    const currentLock = {
      name: 'dependency-review-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'dependency-review-fixture', version: '1.0.0' },
        'node_modules/alpha': { version: '2.0.0' },
      },
    };
    const { cwd, baseSha } = createGitFixture({ currentLock });

    await expect(
      dependencyReview.main({
        cwd,
        baseSha,
        auditCommand: ['terrastories-command-that-does-not-exist'],
      })
    ).rejects.toThrow(/could not execute dependency audit/i);
  });

  it('rejects a non-SHA base revision before invoking git', async () => {
    await expect(
      dependencyReview.main({
        cwd: process.cwd(),
        baseSha: 'main',
        auditCommand: [process.execPath, '-e', 'process.exit(0)'],
      })
    ).rejects.toThrow(/40-character commit SHA/i);
  });
});

describe('npm audit report handling', () => {
  const policy = {
    trackingIssue: 141,
    minimumSeverity: 'moderate',
    expires: '2026-09-30',
    review: {
      status: 'accepted',
      reviewedBy: 'Terrastories maintainers',
      reviewedOn: '2026-08-27',
      rationale: 'Reviewed temporary debt.',
    },
  };

  const baseline = {
    trackingIssue: 141,
    advisories: [
      {
        source: 'known',
        package: 'known-package',
        severity: 'moderate',
        url: 'https://example.invalid/known',
      },
      {
        source: 'resolved',
        package: 'resolved-package',
        severity: 'high',
        url: 'https://example.invalid/resolved',
      },
    ],
  };

  it('collects object advisories and ignores transitive strings', () => {
    const report = auditModule.parseAuditReport(
      JSON.stringify({
        vulnerabilities: {
          'known-package': {
            via: [
              'transitive-package',
              {
                source: 'known',
                severity: 'moderate',
                url: 'https://example.invalid/known',
              },
            ],
          },
        },
      })
    );

    expect(auditModule.collectAdvisories(report)).toEqual([
      {
        source: 'known',
        package: 'known-package',
        severity: 'moderate',
        url: 'https://example.invalid/known',
      },
    ]);
  });

  it('rejects malformed, failed, and incomplete npm audit reports', () => {
    expect(() => auditModule.parseAuditReport('{')).toThrow(/parse npm audit/i);
    expect(() => auditModule.parseAuditReport('[]')).toThrow(
      /invalid JSON report shape/i
    );
    expect(() =>
      auditModule.parseAuditReport(
        JSON.stringify({ error: { summary: 'registry unavailable' } })
      )
    ).toThrow(/registry unavailable/i);
    expect(() => auditModule.parseAuditReport('{}')).toThrow(
      /missing a vulnerabilities object/i
    );
  });

  it('rejects unsupported policy and advisory severities', () => {
    expect(() => auditModule.filterBlockingAdvisories([], 'severe')).toThrow(
      /severity threshold/i
    );
    expect(() =>
      auditModule.filterBlockingAdvisories(
        [{ source: 'x', package: 'x', severity: 'unknown' }],
        'moderate'
      )
    ).toThrow(/advisory severity/i);
  });

  it('rejects invalid current-date and review metadata', () => {
    expect(() => auditModule.validateBaselinePolicy(policy, 'today')).toThrow(
      /current date/i
    );
    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...policy, minimumSeverity: 'severe' },
        '2026-08-27'
      )
    ).toThrow(/policy metadata/i);
    expect(() =>
      auditModule.validateBaselinePolicy(
        {
          ...policy,
          review: { ...policy.review, rationale: '   ' },
        },
        '2026-08-27'
      )
    ).toThrow(/accepted review/i);
  });

  it('compares current audit debt against the reviewed baseline', () => {
    const comparison = auditModule.compareAuditAdvisories(
      baseline,
      policy,
      {
        vulnerabilities: {
          'known-package': {
            via: [
              {
                source: 'known',
                severity: 'moderate',
                url: 'https://example.invalid/known',
              },
            ],
          },
        },
      }
    );

    expect(comparison).toMatchObject({
      newAdvisories: [],
      severityChanges: [],
      resolvedCount: 1,
    });
    expect(comparison.current).toHaveLength(1);
  });

  it('detects new, changed, and mismatched audit debt', () => {
    expect(() =>
      auditModule.compareAuditAdvisories(
        { ...baseline, trackingIssue: 999 },
        policy,
        { vulnerabilities: {} }
      )
    ).toThrow(/tracking mismatch/i);

    const comparison = auditModule.compareAuditAdvisories(
      baseline,
      policy,
      {
        vulnerabilities: {
          'known-package': {
            via: [
              {
                source: 'known',
                severity: 'high',
                url: 'https://example.invalid/known',
              },
            ],
          },
          'new-package': {
            via: [
              {
                source: 'new',
                severity: 'critical',
                url: 'https://example.invalid/new',
              },
            ],
          },
        },
      }
    );

    expect(comparison.severityChanges).toHaveLength(1);
    expect(comparison.newAdvisories).toHaveLength(1);
  });
});
