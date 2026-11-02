import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as auditModule from '../../scripts/trusted-audit-baseline.mjs';
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
    expect(log).toHaveBeenCalledWith('- changed: alpha 1.0.0 -> 2.0.0');
    expect(log).toHaveBeenCalledWith('- added: @scope/beta none -> 1.0.0');
  });

  it('reports same-version source and integrity substitutions', () => {
    expect(
      dependencyReview.summarizeDependencyChanges(
        {
          packages: {
            'node_modules/alpha': {
              version: '1.0.0',
              resolved: 'https://registry.example/alpha-1.0.0.tgz',
              integrity: 'sha512-old',
            },
          },
        },
        {
          packages: {
            'node_modules/alpha': {
              version: '1.0.0',
              resolved: 'https://mirror.example/alpha-1.0.0.tgz',
              integrity: 'sha512-new',
            },
          },
        }
      )
    ).toEqual([
      {
        name: 'alpha',
        before: '1.0.0',
        after: '1.0.0',
        type: 'changed',
        changedFields: ['resolved', 'integrity'],
      },
    ]);
  });

  it('runs the audit even when package manifests did not change', async () => {
    const { cwd, baseSha } = createGitFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      dependencyReview.main({
        cwd,
        baseSha,
        auditCommand: [process.execPath, '-e', 'process.exit(99)'],
      })
    ).rejects.toThrow(/dependency audit rejected/i);

    expect(log).toHaveBeenCalledWith(
      'Dependency review: no package manifest or lockfile changes.'
    );
  });

  it('rejects an unapproved PR policy without executing PR audit scripts', async () => {
    const { cwd, baseSha } = createGitFixture();
    const marker = join(cwd, 'pr-script-ran');
    const advisories = [
      {
        source: 'new-advisory',
        package: 'added-package',
        severity: 'high',
        url: 'https://example.invalid/new',
        nodes: ['node_modules/added-package'],
      },
    ];
    const policy = {
      trackingIssue: 141,
      minimumSeverity: 'moderate',
      expires: '2099-12-31',
      review: {
        status: 'accepted',
        reviewedBy: 'attacker',
        reviewedOn: '2026-10-31',
        rationale: 'Unapproved PR policy.',
        advisoriesSha256: auditModule.computeAdvisorySetDigest(advisories),
      },
    };
    policy.review.policySha256 = auditModule.computeReviewedPolicyDigest(
      advisories,
      policy
    );
    mkdirSync(join(cwd, 'config'));
    mkdirSync(join(cwd, 'scripts'));
    writeJson(join(cwd, 'config/security-audit-policy.json'), policy);
    writeJson(join(cwd, 'config/security-audit-baseline.json'), {
      trackingIssue: 141,
      expires: policy.expires,
      advisories,
    });
    writeJson(join(cwd, 'package.json'), {
      name: 'dependency-review-fixture',
      version: '1.0.0',
      private: true,
      scripts: { 'audit:baseline': 'node scripts/check-audit-baseline.mjs' },
    });
    writeFileSync(
      join(cwd, 'scripts/check-audit-baseline.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`
    );
    run('git', ['add', 'package.json', 'config', 'scripts'], cwd);
    run('git', ['commit', '-m', 'unapproved policy and no-op audit'], cwd);
    vi.stubEnv('REQUIRE_EXTERNAL_AUDIT_APPROVAL', '1');
    vi.stubEnv('GITHUB_TOKEN', '');

    await expect(dependencyReview.main({ cwd, baseSha })).rejects.toThrow(
      /dependency audit rejected/i
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('requires external approval even when the environment flag is absent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'terrastories-trusted-audit-'));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, 'config'));
    const advisories = [];
    const policy = {
      trackingIssue: 141,
      minimumSeverity: 'moderate',
      expires: '2099-12-31',
      review: {
        status: 'accepted',
        reviewedBy: 'attacker',
        reviewedOn: '2026-10-31',
        rationale: 'Unapproved policy.',
        advisoriesSha256: auditModule.computeAdvisorySetDigest(advisories),
      },
    };
    policy.review.policySha256 = auditModule.computeReviewedPolicyDigest(
      advisories,
      policy
    );
    writeJson(join(cwd, 'config/security-audit-policy.json'), policy);
    writeJson(join(cwd, 'config/security-audit-baseline.json'), {
      trackingIssue: 141,
      advisories,
    });
    vi.stubEnv('REQUIRE_EXTERNAL_AUDIT_APPROVAL', '0');
    vi.stubEnv('GITHUB_TOKEN', '');

    await expect(auditModule.main({ dataDir: cwd })).rejects.toThrow(
      /external approval verification requires/i
    );
  });

  it('audits an approved lockfile without running PR scripts or passing the GitHub token to npm', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'terrastories-trusted-audit-'));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, 'config'));
    mkdirSync(join(cwd, 'bin'));
    const marker = join(cwd, 'npm-invocation.json');
    const policy = {
      trackingIssue: 141,
      minimumSeverity: 'moderate',
      expires: '2099-12-31',
      review: {
        status: 'accepted',
        reviewedBy: 'Maintainer',
        reviewedOn: '2026-10-31',
        rationale: 'Reviewed empty baseline.',
        advisoriesSha256: auditModule.computeAdvisorySetDigest([]),
      },
    };
    policy.review.policySha256 = auditModule.computeReviewedPolicyDigest(
      [],
      policy
    );
    writeJson(join(cwd, 'config/security-audit-policy.json'), policy);
    writeJson(join(cwd, 'config/security-audit-baseline.json'), {
      trackingIssue: 141,
      advisories: [],
    });
    writeJson(join(cwd, 'package.json'), {
      name: 'untrusted-fixture',
      version: '1.0.0',
      scripts: { preaudit: 'exit 99', 'audit:baseline': 'exit 99' },
    });
    writeJson(join(cwd, 'package-lock.json'), {
      name: 'untrusted-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {},
    });
    writeFileSync(
      join(cwd, '.npmrc'),
      'https-proxy=https://attacker.invalid\n'
    );
    writeFileSync(
      join(cwd, 'bin/npm'),
      `#!/usr/bin/env node\nconst { writeFileSync, existsSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), projectConfig: existsSync('.npmrc'), token: process.env.GITHUB_TOKEN, userConfig: process.env.NPM_CONFIG_USERCONFIG, globalConfig: process.env.NPM_CONFIG_GLOBALCONFIG }));\nconsole.log(JSON.stringify({ vulnerabilities: {} }));\n`
    );
    chmodSync(join(cwd, 'bin/npm'), 0o755);
    vi.stubEnv('PATH', `${join(cwd, 'bin')}:${process.env.PATH}`);
    vi.stubEnv('GITHUB_REPOSITORY', 'Terrastories/terrastories-api');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', async (url) => {
      if (url.includes('/issues/141/comments?')) {
        return new Response(
          JSON.stringify([
            {
              body: `SECURITY-AUDIT-APPROVAL v1 policySha256=${policy.review.policySha256} trackingIssue=141`,
              user: { login: 'trusted-maintainer' },
              created_at: '2026-09-27T20:00:00Z',
              updated_at: '2026-09-27T20:00:00Z',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ permission: 'write' }), {
        status: 200,
      });
    });

    await expect(auditModule.main({ dataDir: cwd })).resolves.toBeUndefined();
    const invocation = JSON.parse(readFileSync(marker, 'utf8'));
    expect(invocation.args).toContain('audit');
    expect(invocation.args).toContain('--package-lock-only');
    expect(invocation.args).toContain('--ignore-scripts');
    expect(invocation.args).toContain('--registry=https://registry.npmjs.org/');
    expect(invocation.cwd).not.toBe(cwd);
    expect(invocation.projectConfig).toBe(false);
    expect(invocation.token).toBeUndefined();
    expect(invocation.userConfig).not.toBe(invocation.globalConfig);
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

  it('rejects a lockfile symlink instead of reading its target', async () => {
    const { cwd, baseSha } = createGitFixture();
    writeJson(join(cwd, '{}'), {
      packages: { 'node_modules/alpha': { version: '2.0.0' } },
    });
    unlinkSync(join(cwd, 'package-lock.json'));
    symlinkSync('{}', join(cwd, 'package-lock.json'));
    run('git', ['add', 'package-lock.json', '{}'], cwd);
    run('git', ['commit', '-m', 'substitute lockfile symlink'], cwd);

    await expect(
      dependencyReview.main({
        cwd,
        baseSha,
        auditCommand: [process.execPath, '-e', 'process.exit(0)'],
      })
    ).rejects.toThrow();
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
  const baseline = {
    trackingIssue: 141,
    advisories: [
      {
        source: 'known',
        package: 'known-package',
        severity: 'moderate',
        url: 'https://example.invalid/known',
      },
    ],
  };

  const policy = {
    trackingIssue: 141,
    minimumSeverity: 'moderate',
    expires: '2026-09-30',
    review: {
      status: 'accepted',
      reviewedBy: 'Terrastories maintainers',
      reviewedOn: '2026-08-27',
      rationale: 'Reviewed temporary debt.',
      advisoriesSha256:
        'c353e2ccf16863e21030ebf8f2136aafe376d02643eac10d7f7714a5f871b30e',
    },
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

  it('computes a stable SHA-256 for the exact advisory set', () => {
    expect(typeof auditModule.computeAdvisorySetDigest).toBe('function');
    expect(auditModule.computeAdvisorySetDigest(baseline.advisories)).toBe(
      policy.review.advisoriesSha256
    );
    expect(
      auditModule.computeAdvisorySetDigest([...baseline.advisories].reverse())
    ).toBe(policy.review.advisoriesSha256);
  });

  it('rejects a baseline change not bound to the accepted review', () => {
    const changedBaseline = {
      ...baseline,
      advisories: [
        ...baseline.advisories,
        {
          source: 'newly-added',
          package: 'new-package',
          severity: 'critical',
          url: 'https://example.invalid/new',
        },
      ],
    };

    expect(() =>
      auditModule.compareAuditAdvisories(changedBaseline, policy, {
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
          'new-package': {
            via: [
              {
                source: 'newly-added',
                severity: 'critical',
                url: 'https://example.invalid/new',
              },
            ],
          },
        },
      })
    ).toThrow(/review|digest|exact|approval/i);
  });

  it('compares current audit debt against the reviewed baseline', () => {
    const comparison = auditModule.compareAuditAdvisories(baseline, policy, {
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
    });

    expect(comparison).toMatchObject({
      newAdvisories: [],
      severityChanges: [],
      resolvedCount: 0,
    });
    expect(comparison.current).toHaveLength(1);
  });

  it('rejects stale resolved advisories in the accepted exception set', () => {
    const staleBaseline = {
      ...baseline,
      advisories: [
        ...baseline.advisories,
        {
          source: 'resolved',
          package: 'resolved-package',
          severity: 'high',
          url: 'https://example.invalid/resolved',
        },
      ],
    };
    const stalePolicy = {
      ...policy,
      review: {
        ...policy.review,
        advisoriesSha256: auditModule.computeAdvisorySetDigest(
          staleBaseline.advisories
        ),
      },
    };

    expect(() =>
      auditModule.compareAuditAdvisories(staleBaseline, stalePolicy, {
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
      })
    ).toThrow(/resolved|prune/i);
  });

  it('detects new, changed, and mismatched audit debt', () => {
    expect(() =>
      auditModule.compareAuditAdvisories(
        { ...baseline, trackingIssue: 999 },
        policy,
        { vulnerabilities: {} }
      )
    ).toThrow(/tracking mismatch/i);

    const comparison = auditModule.compareAuditAdvisories(baseline, policy, {
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
    });

    expect(comparison.severityChanges).toHaveLength(1);
    expect(comparison.newAdvisories).toHaveLength(1);
  });
});
