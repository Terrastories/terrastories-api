import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function externalActionRefs(workflow) {
  return [
    ...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm),
  ].map((match) => match[1]);
}

function workflowJobBlock(workflow, jobName) {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) return '';

  const bodyStart = start + marker.length;
  const rest = workflow.slice(bodyStart);
  const nextJob = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

describe('GitHub Actions supply-chain policy', () => {
  it('pins every external action to an immutable commit SHA', () => {
    const unpinned = [];
    let observedExternalActions = 0;

    for (const path of criticalWorkflowPaths) {
      if (!existsSync(join(repoRoot, path))) continue;
      const workflow = readRepo(path);
      for (const action of externalActionRefs(workflow)) {
        if (action.startsWith('./')) continue;
        observedExternalActions += 1;
        const separator = action.lastIndexOf('@');
        const ref = separator === -1 ? '' : action.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/i.test(ref)) {
          unpinned.push(`${path}: ${action}`);
        }
      }
    }

    expect(observedExternalActions).toBeGreaterThan(0);
    expect(unpinned).toEqual([]);
  });

  it('detects a commented floating action reference as mutable', () => {
    const actions = externalActionRefs(
      '  - uses: actions/checkout@v4 # human-readable version\n'
    );

    expect(actions).toEqual(['actions/checkout@v4']);
    const ref = actions[0].slice(actions[0].lastIndexOf('@') + 1);
    expect(/^[0-9a-f]{40}$/i.test(ref)).toBe(false);
  });

  it('keeps required CI and Docker checks fail closed', () => {
    const ci = readRepo('.github/workflows/ci.yml');
    const docker = readRepo('.github/workflows/docker-ci.yml');
    const supplyChain = readRepo('.github/workflows/supply-chain.yml');

    expect(ci).not.toContain('continue-on-error: true');
    expect(docker).not.toContain('continue-on-error: true');
    expect(docker).not.toMatch(/docker run[^\n]*\|\|\s*echo/);
    expect(docker).not.toMatch(/npm list[^\n]*\|\|\s*echo/);
    expect(docker).toContain('curl --fail --silent --show-error');
    expect(docker).toContain('docker inspect');
    expect(docker).toContain('health.config.valid');
    expect(docker).toContain('health.database.connected');
    expect(supplyChain).toContain('health.config.valid');
    expect(supplyChain).toContain('health.database.connected');
  });

  it('keeps the declared Node runtime compatible with Sharp 0.35', () => {
    const packageJson = JSON.parse(readRepo('package.json'));
    expect(packageJson.engines.node).toBe('>=20.9.0');
  });

  it('keeps production Compose compatible with the package-manager-free runtime', () => {
    const dockerfile = readRepo('Dockerfile');
    const productionCompose = readRepo('docker-compose.prod.yml');

    expect(dockerfile).toContain('/usr/local/bin/npm');
    expect(productionCompose).not.toMatch(/\bnpm\b/);
    expect(productionCompose).toContain('node dist/db/migrate.js');
    expect(productionCompose).toContain('exec node dist/server.js');
    expect(dockerfile).toContain('/app/src/db/migrations');
    expect(dockerfile).toContain('./dist/db/migrations');
  });

  it('defines weekly automated dependency updates for all release inputs', () => {
    const path = join(repoRoot, '.github/dependabot.yml');
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const dependabot = readFileSync(path, 'utf8');
    for (const ecosystem of ['npm', 'github-actions', 'docker']) {
      expect(dependabot).toMatch(
        new RegExp(`package-ecosystem:\\s*['\"]?${ecosystem}['\"]?`)
      );
    }
    expect(dependabot.match(/interval:\s*['"]?weekly['"]?/g)).toHaveLength(3);
  });
});

describe('dependency audit exception policy', () => {
  const policy = JSON.parse(readRepo('config/security-audit-policy.json'));
  const baseline = JSON.parse(readRepo('config/security-audit-baseline.json'));

  it('defines a blocking severity threshold and reviewed expiring exception set', () => {
    expect(policy.minimumSeverity).toBe('moderate');
    expect(policy.review).toMatchObject({ status: 'accepted' });
    expect(policy.review.reviewedBy).toEqual(expect.any(String));
    expect(policy.review.reviewedBy.length).toBeGreaterThan(0);
    expect(policy.review.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(policy.review.rationale).toEqual(expect.any(String));
    expect(policy.review.rationale.length).toBeGreaterThan(0);
    expect(policy.review.advisoriesSha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(policy.review.advisoriesSha256).toBe(
      auditModule.computeAdvisorySetDigest(baseline.advisories)
    );
    expect(policy.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('validates policy metadata and rejects expired exceptions', () => {
    expect(typeof auditModule.validateBaselinePolicy).toBe('function');
    if (typeof auditModule.validateBaselinePolicy !== 'function') return;

    expect(() =>
      auditModule.validateBaselinePolicy(policy, '2026-08-27')
    ).not.toThrow();
    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...policy, expires: '2026-08-26' },
        '2026-08-27'
      )
    ).toThrow(/expired/i);
    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...policy, review: { ...policy.review, reviewedBy: '' } },
        '2026-08-27'
      )
    ).toThrow(/review/i);
  });

  it('rejects malformed and impossible policy dates', () => {
    expect(typeof auditModule.validateBaselinePolicy).toBe('function');
    if (typeof auditModule.validateBaselinePolicy !== 'function') return;

    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...policy, expires: 'not-a-date' },
        '2026-08-27'
      )
    ).toThrow(/date/i);
    expect(() =>
      auditModule.validateBaselinePolicy(
        { ...policy, expires: '2026-02-30' },
        '2026-08-27'
      )
    ).toThrow(/date/i);
    expect(() =>
      auditModule.validateBaselinePolicy(
        {
          ...policy,
          review: { ...policy.review, reviewedOn: '2026-02-30' },
        },
        '2026-08-27'
      )
    ).toThrow(/date/i);
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

describe('PR dependency review', () => {
  const scriptPath = join(repoRoot, 'scripts/review-dependency-changes.mjs');

  it('reports added, changed, and removed locked dependencies', async () => {
    const scriptExists = existsSync(scriptPath);
    expect(scriptExists).toBe(true);
    if (!scriptExists) return;

    const { summarizeDependencyChanges } = await import(
      pathToFileURL(scriptPath).href
    );

    expect(
      summarizeDependencyChanges(
        {
          packages: {
            '': { name: 'example' },
            'node_modules/a': { version: '1.0.0' },
            'node_modules/b': { version: '1.0.0' },
          },
        },
        {
          packages: {
            '': { name: 'example' },
            'node_modules/a': { version: '2.0.0' },
            'node_modules/c': { version: '1.0.0' },
          },
        }
      )
    ).toEqual([
      { name: 'a', before: '1.0.0', after: '2.0.0', type: 'changed' },
      { name: 'b', before: '1.0.0', after: null, type: 'removed' },
      { name: 'c', before: null, after: '1.0.0', type: 'added' },
    ]);
  });
});

describe('release evidence workflow', () => {
  const path = join(repoRoot, '.github/workflows/supply-chain.yml');

  it('exists and covers PR dependency review plus secret scanning', () => {
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const workflow = readFileSync(path, 'utf8');
    expect(workflow).toContain('node scripts/review-dependency-changes.mjs');
    expect(workflow).toContain(
      'BASE_SHA: ${{ github.event.pull_request.base.sha }}'
    );
    expect(workflow).toContain('trufflesecurity/trufflehog@');
    expect(workflow).toMatch(/extra_args:.*--fail/);
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
    expect(workflow).not.toContain('ignore-unfixed: true');
    expect(workflow).toContain('format: json');
    expect(workflow).toContain('output: release-vulnerabilities.json');
    expect(workflow).toContain('release-vulnerabilities.json');
    expect(workflow).toContain('anchore/sbom-action@');
    expect(workflow).toContain('actions/attest-build-provenance@');
    expect(workflow).toContain('outputs: type=docker,dest=release-image.tar');
    expect(workflow).toContain('docker load --input release-image.tar');
    expect(workflow).not.toContain('docker save');
    expect(workflow).toContain('image_archive_sha256');
    expect(workflow).toContain('release-image.tar');
    expect(workflow).toContain('${{ github.sha }}');
    expect(workflow).toMatch(/digest/i);
  });

  it('keeps PR image checks read-only and isolates provenance writes to main pushes', () => {
    expect(existsSync(path)).toBe(true);
    if (!existsSync(path)) return;

    const workflow = readFileSync(path, 'utf8');
    const productionImage = workflowJobBlock(workflow, 'production_image');
    const provenance = workflowJobBlock(workflow, 'provenance');

    expect(productionImage).not.toBe('');
    expect(productionImage).not.toContain('id-token: write');
    expect(productionImage).not.toContain('attestations: write');
    expect(provenance).not.toBe('');
    expect(provenance).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'"
    );
    expect(provenance).toContain('needs: production_image');
    expect(provenance).toContain('id-token: write');
    expect(provenance).toContain('attestations: write');
    expect(provenance).toContain(
      'subject-digest: ${{ needs.production_image.outputs.image_archive_sha256 }}'
    );
  });
});
