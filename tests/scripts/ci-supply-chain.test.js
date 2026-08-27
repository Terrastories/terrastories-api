import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as auditModule from '../../scripts/check-audit-baseline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const readRepo = (path) => readFileSync(join(repoRoot, path), 'utf8');

const criticalWorkflowPaths = [
  '.github/workflows/ci.yml',
  '.github/workflows/docker-ci.yml',
  '.github/workflows/api-comparison.yml',
  '.github/workflows/user-workflow-test.yml',
  '.github/workflows/issue-agent.yml',
  '.github/workflows/pr-agent.yml',
  '.github/workflows/claude.yml',
  '.github/workflows/claude-code-review.yml',
  '.github/workflows/supply-chain.yml',
];

describe('GitHub Actions supply-chain policy', () => {
  it('pins every external action to an immutable commit SHA', () => {
    const unpinned = [];

    for (const path of criticalWorkflowPaths) {
      if (!existsSync(join(repoRoot, path))) continue;
      const workflow = readRepo(path);
      for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*$/gm)) {
        const action = match[1];
        if (action.startsWith('./')) continue;
        const separator = action.lastIndexOf('@');
        const ref = separator === -1 ? '' : action.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/i.test(ref)) {
          unpinned.push(`${path}: ${action}`);
        }
      }
    }

    expect(unpinned).toEqual([]);
  });

  it('keeps required CI and Docker checks fail closed', () => {
    const ci = readRepo('.github/workflows/ci.yml');
    const docker = readRepo('.github/workflows/docker-ci.yml');

    expect(ci).not.toContain('continue-on-error: true');
    expect(docker).not.toContain('continue-on-error: true');
    expect(docker).not.toMatch(/docker run[^\n]*\|\|\s*echo/);
    expect(docker).not.toMatch(/npm list[^\n]*\|\|\s*echo/);
    expect(docker).toContain('curl --fail --silent --show-error');
    expect(docker).toContain('docker inspect');
  });
});

describe('dependency audit exception policy', () => {
  const baseline = JSON.parse(readRepo('config/security-audit-baseline.json'));

  it('defines a blocking severity threshold and reviewed expiring exception set', () => {
    expect(baseline.minimumSeverity).toBe('moderate');
    expect(baseline.review).toMatchObject({ status: 'accepted' });
    expect(baseline.review.reviewedBy).toEqual(expect.any(String));
    expect(baseline.review.reviewedBy.length).toBeGreaterThan(0);
    expect(baseline.review.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseline.review.rationale).toEqual(expect.any(String));
    expect(baseline.review.rationale.length).toBeGreaterThan(0);
    expect(baseline.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('validates policy metadata and rejects expired exceptions', () => {
    expect(typeof auditModule.validateBaselinePolicy).toBe('function');
    if (typeof auditModule.validateBaselinePolicy !== 'function') return;

    expect(() => auditModule.validateBaselinePolicy(baseline, '2026-08-27')).not.toThrow();
    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...baseline, expires: '2026-08-26' },
        '2026-08-27'
      )
    ).toThrow(/expired/i);
    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...baseline, review: { ...baseline.review, reviewedBy: '' } },
        '2026-08-27'
      )
    ).toThrow(/review/i);
  });

  it('only treats advisories at or above the configured severity as blocking', () => {
    expect(typeof auditModule.filterBlockingAdvisories).toBe('function');
    if (typeof auditModule.filterBlockingAdvisories !== 'function') return;

    const advisories = [
      { source: '1', package: 'low', severity: 'low' },
      { source: '2', package: 'moderate', severity: 'moderate' },
      { source: '3', package: 'high', severity: 'high' },
    ];

    expect(
      auditModule
        .filterBlockingAdvisories(advisories, 'moderate')
        .map((entry) => entry.package)
    ).toEqual(['moderate', 'high']);
  });
});

describe('release evidence workflow', () => {
  const path = join(repoRoot, '.github/workflows/supply-chain.yml');

  it('exists and covers PR dependency review plus secret scanning', () => {
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const workflow = readFileSync(path, 'utf8');
    expect(workflow).toContain('actions/dependency-review-action@');
    expect(workflow).toContain('fail-on-severity: moderate');
    expect(workflow).toMatch(/gitleaks\/gitleaks-action@|trufflesecurity\/trufflehog@/);
  });

  it('builds and verifies the production image before emitting release evidence', () => {
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const workflow = readFileSync(path, 'utf8');
    expect(workflow).toMatch(/--target production|target:\s*production/);
    expect(workflow).toContain('curl --fail --silent --show-error');
    expect(workflow).toContain('docker inspect');
    expect(workflow).toMatch(/trivy-action@|scan-action@/);
    expect(workflow).toMatch(/exit-code:\s*['"]?1['"]?/);
    expect(workflow).toMatch(/severity:\s*['"]?HIGH,CRITICAL['"]?/);
    expect(workflow).toContain('anchore/sbom-action@');
    expect(workflow).toContain('actions/attest-build-provenance@');
    expect(workflow).toContain('${{ github.sha }}');
    expect(workflow).toMatch(/digest/i);
  });
});
