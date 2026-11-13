import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as auditModule from '../../scripts/trusted-audit-baseline.mjs';
import { declaredMinimumNode } from '../../scripts/runtime-smoke.mjs';

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

// npm or npx invocations that would run PR-controlled code or config.
const FORBIDDEN_PACKAGE_COMMAND =
  /\bnpx\b|\bnpm\s+(?:run|run-script|ci|install|i|exec|x|audit)\b/;

// Drops comment lines and plain echo prose, which may name npm commands
// (for example "npm ci would read it"). A double-quoted echo argument that
// contains command substitution, `$(...)` or a backtick, still executes, so
// it is kept and checked.
function executableShellText(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) =>
      line.replace(/echo\s+"([^"]*)"/g, (match, inner) =>
        /\$\(|`/.test(inner) ? match : 'echo'
      )
    )
    .join('\n');
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

  it('declares Node 20.19.0 as the minimum runtime (require(esm) unflagged)', () => {
    // @fastify/static (via @fastify/swagger-ui) is CommonJS and requires the
    // ESM-only content-disposition 3; that needs require(esm), which is
    // unflagged from Node 20.19.0. Sharp 0.35 needs ^20.9.0, so this also
    // keeps Sharp supported.
    const packageJson = JSON.parse(readRepo('package.json'));
    const lockfile = JSON.parse(readRepo('package-lock.json'));
    expect(packageJson.engines.node).toBe('>=20.19.0');
    expect(lockfile.packages[''].engines.node).toBe('>=20.19.0');
    expect(declaredMinimumNode(packageJson)).toBe('20.19.0');
    expect(readRepo('README.md')).toContain('Node.js 20.19+');
    expect(readRepo('CONTRIBUTING.md')).toContain('Node.js 20.19+');
    for (const stage of ['development', 'builder', 'production']) {
      expect(readRepo('Dockerfile')).toContain(
        `FROM node:20.19.0-alpine AS ${stage}`
      );
    }
  });

  it('smoke-tests the built app on exactly the declared minimum Node', () => {
    const packageJson = JSON.parse(readRepo('package.json'));
    const ci = readRepo('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('\n  minimum-runtime:'));

    expect(job).toContain('name: Minimum Node runtime smoke');
    expect(job).toContain(
      `node-version: ${declaredMinimumNode(packageJson)}\n`
    );
    const install = job.indexOf('npm ci --legacy-peer-deps');
    const build = job.indexOf('npm run build');
    const smoke = job.indexOf(
      'node scripts/runtime-smoke.mjs --require-engine-minimum'
    );
    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    expect(smoke).toBeGreaterThan(build);

    const script = readRepo('scripts/runtime-smoke.mjs');
    expect(script).toContain("join(repoRoot, 'dist', 'app.js')");
    expect(script).toContain('await import(appModuleUrl)');
    expect(script).toContain('app.listen(');
    expect(script).toContain('app.close()');
    expect(script).toContain('/docs/static/index.html');
  });

  it('parses only an exact ">=X.Y.Z" engines.node minimum', () => {
    expect(declaredMinimumNode({ engines: { node: '>=20.19.0' } })).toBe(
      '20.19.0'
    );
    for (const range of ['^20.19.0', '>=20.19', '20.x', undefined]) {
      expect(() => declaredMinimumNode({ engines: { node: range } })).toThrow(
        'package.json engines.node must be ">=X.Y.Z"'
      );
    }
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

  it('binds the accepted baseline to the reviewed policy with path-aware scopes', () => {
    expect(() =>
      auditModule.validateReviewedPolicyBinding(baseline, policy)
    ).not.toThrow();
    expect(baseline.expires).toBe(policy.expires);
    expect(baseline.trackingIssue).toBe(141);
    expect(policy.trackingIssue).toBe(141);

    for (const advisory of baseline.advisories) {
      if (!advisory.nodes) continue;
      expect(advisory.nodeScopes).toEqual(expect.any(Object));
      for (const node of advisory.nodes) {
        expect(typeof advisory.nodeScopes[node]).toBe('string');
      }
    }
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
    expect(workflow).toContain(
      'node "$GITHUB_WORKSPACE/trusted/scripts/review-dependency-changes.mjs"'
    );
    // The dependency review must execute the trusted (base-branch) checker,
    // never a script resolved from the PR checkout.
    expect(workflow).not.toMatch(/run:\s*node scripts\//);
    expect(workflow).toContain(
      'BASE_SHA: ${{ github.event.pull_request.base.sha }}'
    );
    expect(workflow).toContain('trufflesecurity/trufflehog@');
    // The pinned trufflehog action injects `--fail` into its own docker
    // invocation; repeating it in extra_args aborts the CLI with
    // "flag 'fail' cannot be repeated" and would skip the scan entirely.
    expect(workflow).toMatch(/extra_args:[^\n]*--results=verified,unknown/);
    expect(workflow).not.toMatch(/extra_args:[^\n]*--fail/);
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

// Returns the indented lines that belong to a mapping key (for example
// `permissions:`) until the next line at the same or lower indentation,
// so nested blocks can be inspected without a YAML parser.
function yamlMappingBlock(text, key) {
  const lines = text.split('\n');
  const startIndex = lines.findIndex((line) =>
    new RegExp(`^\\s*${key}:\\s*$`).test(line)
  );
  if (startIndex === -1) return '';

  const keyIndent =
    lines[startIndex].length - lines[startIndex].trimStart().length;
  const collected = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break;
    collected.push(line);
  }
  return collected.join('\n');
}

describe('trusted dependency review gate', () => {
  const workflow = readRepo('.github/workflows/supply-chain.yml');
  const block = workflowJobBlock(workflow, 'dependency-review');

  it('runs the checker from the base branch and treats the PR tree as data', () => {
    expect(block).not.toBe('');
    expect(block).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(block).toContain('path: trusted');
    expect(block).toContain('path: pr');
    expect(block).toContain('working-directory: pr');
    expect(block).toContain('AUDIT_DATA_DIR: ${{ github.workspace }}/pr');
    expect(block).toContain('--trusted-audit-version');
    expect(block).toContain('!= "3"');
    expect(block).toContain('refusing to fall back to PR code');
  });

  it('never persists credentials from either checkout', () => {
    const persisted = block.match(/persist-credentials:\s*false/g) || [];
    expect(persisted.length).toBeGreaterThanOrEqual(2);
  });

  it('executes no npm command and uses no cache inside the PR tree', () => {
    expect(executableShellText(block)).not.toMatch(FORBIDDEN_PACKAGE_COMMAND);
    expect(block).not.toContain('cache:');
  });

  it('still treats command substitution inside echo text as executable', () => {
    const detected = (text) =>
      FORBIDDEN_PACKAGE_COMMAND.test(executableShellText(text));

    expect(detected('echo "$(npm run audit:baseline)"')).toBe(true);
    expect(detected('echo "`npm ci`"')).toBe(true);
    expect(detected('npx some-package')).toBe(true);
    expect(detected('echo "$(npx some-package)"')).toBe(true);
    expect(detected('echo "::error::npm ci would read it"')).toBe(false);
    expect(detected('# npm ci reads the project .npmrc')).toBe(false);
  });

  it('runs the gate with read-only contents and issues permissions', () => {
    const permissions = yamlMappingBlock(block, 'permissions');
    expect(permissions).toContain('contents: read');
    expect(permissions).toContain('issues: read');
    expect(permissions).not.toContain('write');
  });

  it('never grants the PR tree pull_request_target-style code access', () => {
    expect(workflow).not.toContain('pull_request_target');
  });

  it('rejects PR-controlled npm configuration inside the PR tree', () => {
    expect(block).toContain('- name: Reject PR-controlled npm configuration');
    expect(block).toContain('[ -e .npmrc ] || [ -L .npmrc ]');
    expect(block).toContain("git ls-files | grep -cE '(^|/)\\.npmrc");
  });

  it('tracks no .npmrc anywhere in the repository itself', () => {
    const tracked = spawnSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(tracked.status).toBe(0);
    const npmrcFiles = (tracked.stdout || '')
      .split('\n')
      .filter((line) => /(^|\/)\.npmrc$/.test(line));
    expect(npmrcFiles).toEqual([]);
  });
});

describe('npm cache cannot serve unaudited tarballs (R1)', () => {
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const workflowFiles = readdirSync(workflowsDir).filter((file) =>
    /\.ya?ml$/.test(file)
  );

  it('never restores caches by falling back to stale keys', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const file of workflowFiles) {
      const workflow = readFileSync(join(workflowsDir, file), 'utf8');
      expect(workflow, file).not.toContain('restore-keys');
      expect(workflow, file).not.toContain('actions/cache@');
      expect(workflow, file).not.toContain('cache-from');
      expect(workflow, file).not.toContain('cache-dependency-path');
    }
  });

  it("limits every workflow-managed cache to setup-node's npm lockfile cache", () => {
    // actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    // (src/cache-restore.ts:60) restores npm caches by the exact
    // lockfile-hash primary key with no restore-keys, so a PR cannot
    // repopulate the shared cache with unaudited tarballs under a key a
    // later `npm ci` would hit.
    for (const file of workflowFiles) {
      const workflow = readFileSync(join(workflowsDir, file), 'utf8');
      const cacheValues = [...workflow.matchAll(/^\s*cache:\s*(.+)$/gm)].map(
        (match) => match[1].trim()
      );
      for (const value of cacheValues) {
        expect(
          value === "'npm'" || value === 'npm',
          `${file} sets cache: ${value}`
        ).toBe(true);
      }
    }
  });

  it('keeps the Dockerfile free of BuildKit cache mounts', () => {
    const dockerfile = readRepo('Dockerfile');
    expect(dockerfile).not.toContain('--mount=type=cache');
  });
});

describe('secret scan regression', () => {
  const workflow = readRepo('.github/workflows/supply-chain.yml');
  const secretScan = workflowJobBlock(workflow, 'secret-scan');
  const regression = workflowJobBlock(workflow, 'secret-scan-regression');

  it('pins trufflehog at or above the early-branch-secret regression fix', () => {
    const versionMatch = secretScan.match(/^\s*version:\s*(\S+)\s*$/m);
    expect(versionMatch).not.toBeNull();
    const version = versionMatch[1];
    // The action runs "${image}:${version}", so only the tag plus index
    // digest pins the exact multi-arch image; a bare tag stays mutable.
    expect(version).toMatch(/^(\d+)\.(\d+)\.(\d+)@sha256:[0-9a-f]{64}$/);
    const [, major, minor, patch] = version.match(
      /^(\d+)\.(\d+)\.(\d+)@sha256:[0-9a-f]{64}$/
    );
    // TruffleHog 3.97.1 missed secrets committed early on a PR branch after
    // merging main; anything below 3.97.9 must not be pinned.
    const numeric = (a, b, c) => a * 1_000_000 + b * 1_000 + c;
    expect(
      numeric(Number(major), Number(minor), Number(patch))
    ).toBeGreaterThanOrEqual(numeric(3, 97, 9));

    // The regression job must scan with the exact same pinned reference.
    expect(regression).toContain(
      `scripts/secret-scan-merge-regression.sh ${version}`
    );
    expect(regression).toContain('persist-credentials: false');
  });

  it('ships an executable offline regression script with no literal secret', () => {
    const scriptPath = join(
      repoRoot,
      'scripts/secret-scan-merge-regression.sh'
    );
    expect(existsSync(scriptPath)).toBe(true);
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);

    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('--network none');
    expect(script).toContain('--results=verified,unknown');
    // The script must accept the digest-suffixed pins the workflow passes.
    expect(script).toContain('(@sha256:[0-9a-f]{64})?');
    expect(script).not.toMatch(/AKIA[A-Z2-7]{16}/);
  });
});

describe('workflow permissions', () => {
  const workflowsDir = join(repoRoot, '.github', 'workflows');

  it('declares least-privilege top-level permissions before jobs in every workflow', () => {
    const files = readdirSync(workflowsDir).filter((file) =>
      /\.ya?ml$/.test(file)
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const workflow = readFileSync(join(workflowsDir, file), 'utf8');
      const permissionsIndex = workflow.search(/^permissions:/m);
      const jobsIndex = workflow.search(/^jobs:/m);
      expect(permissionsIndex, `${file} has no top-level permissions`).not.toBe(
        -1
      );
      expect(jobsIndex, `${file} has no jobs`).not.toBe(-1);
      expect(permissionsIndex, file).toBeLessThan(jobsIndex);

      const topPermissions = yamlMappingBlock(
        workflow.slice(permissionsIndex),
        'permissions'
      );
      expect(topPermissions, file).not.toBe('');
      expect(topPermissions, file).not.toContain('write');
    }
  });

  it('keeps supply-chain top-level permissions to contents: read only', () => {
    const workflow = readRepo('.github/workflows/supply-chain.yml');
    const topLevel = workflow.search(/^permissions:/m);
    expect(topLevel).not.toBe(-1);
    const topPermissions = yamlMappingBlock(
      workflow.slice(topLevel),
      'permissions'
    );
    expect(topPermissions).toContain('contents: read');
    expect(topPermissions).not.toContain('issues:');

    // The job-level grant survives: only dependency-review widens its own
    // permissions beyond the workflow default.
    expect(workflowJobBlock(workflow, 'dependency-review')).toContain(
      'issues: read'
    );
  });

  it('lets only the api-comparison job write PR comments', () => {
    const workflow = readRepo('.github/workflows/api-comparison.yml');
    const block = workflowJobBlock(workflow, 'api-comparison');
    expect(block).not.toBe('');
    expect(block).toContain('pull-requests: write');
  });
});

describe('pinned scanners and owners', () => {
  it('pins every trivy scan to the same reviewed scanner version', () => {
    const workflow = readRepo('.github/workflows/supply-chain.yml');
    const actionCount = (workflow.match(/aquasecurity\/trivy-action@/g) || [])
      .length;
    const versionCount = (workflow.match(/version:\s*v0\.74\.0/g) || []).length;

    expect(actionCount).toBe(2);
    expect(versionCount).toBe(2);
    expect(actionCount).toBe(versionCount);
  });

  it('requests code-owner review for security-sensitive paths', () => {
    const codeowners = readRepo('.github/CODEOWNERS');
    for (const ownedPath of [
      '/.github/',
      '/config/security-audit-*',
      '/scripts/*audit*',
      '/scripts/review-dependency-changes.mjs',
      '/.npmrc',
      '/Dockerfile',
      '/package-lock.json',
      '/scripts/secret-scan-merge-regression.sh',
      '/tests/scripts/trusted-gate-workflow.test.js',
    ]) {
      expect(codeowners).toContain(`${ownedPath} @luandro`);
    }
  });
});
