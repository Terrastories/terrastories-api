import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
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
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auditModule from '../../scripts/trusted-audit-baseline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const workflow = readFileSync(
  join(repoRoot, '.github', 'workflows', 'supply-chain.yml'),
  'utf8'
);

const GUARD_STEP = 'Require a compatible trusted checker on the base branch';
const REVIEW_STEP = 'Review dependency changes with the trusted checker';
const NPMRC_STEP = 'Reject PR-controlled npm configuration';

// Returns the body of a step's `run:` key: either the inline single-line
// value or the block scalar that follows `run: |`, dedented. Workflow text
// is parsed by indentation only; no YAML dependency is allowed here.
function stepRunScript(workflowText, stepName) {
  const lines = workflowText.split('\n');
  const stepIndex = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`
  );
  if (stepIndex === -1) {
    throw new Error(`Step not found in workflow: ${stepName}`);
  }

  const stepIndent =
    lines[stepIndex].length - lines[stepIndex].trimStart().length;

  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    if (indent <= stepIndent) break;

    const runMatch = line.match(/^(\s*)run:\s*(.*)$/);
    if (!runMatch) continue;

    const inline = runMatch[2].trim();
    if (inline !== '|' && inline !== '>') return inline;

    const runIndent = runMatch[1].length;
    const body = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      if (bodyLine.trim() === '') {
        body.push('');
        continue;
      }
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyIndent <= runIndent) break;
      body.push(bodyLine);
    }
    const bodyLines = body.filter((bodyLine) => bodyLine.trim() !== '');
    if (bodyLines.length === 0) return '';
    const minIndent = Math.min(
      ...bodyLines.map(
        (bodyLine) => bodyLine.length - bodyLine.trimStart().length
      )
    );
    return body
      .map((bodyLine) =>
        bodyLine.trim() === '' ? '' : bodyLine.slice(minIndent)
      )
      .join('\n');
  }

  throw new Error(`No run body found for workflow step: ${stepName}`);
}

const tempDirs = [];

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Builds the same layout the supply-chain `dependency-review` job uses:
// <tmp>/trusted/scripts holds the real base-branch checker, and <tmp>/pr is
// a PR checkout whose second commit tries to smuggle in no-op audit scripts
// and a self-approved audit policy.
function createTrustedGateFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'terrastories-trusted-gate-'));
  tempDirs.push(tmp);

  mkdirSync(join(tmp, 'trusted', 'scripts'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'scripts', 'trusted-audit-baseline.mjs'),
    join(tmp, 'trusted', 'scripts', 'trusted-audit-baseline.mjs')
  );
  copyFileSync(
    join(repoRoot, 'scripts', 'review-dependency-changes.mjs'),
    join(tmp, 'trusted', 'scripts', 'review-dependency-changes.mjs')
  );

  const pr = join(tmp, 'pr');
  mkdirSync(join(pr, 'config'), { recursive: true });

  const packageJson = {
    name: 'trusted-gate-fixture',
    version: '1.0.0',
    private: true,
  };
  writeJson(join(pr, 'package.json'), packageJson);
  writeJson(join(pr, 'package-lock.json'), {
    name: 'trusted-gate-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'trusted-gate-fixture', version: '1.0.0' },
    },
  });
  copyFileSync(
    join(repoRoot, 'config', 'security-audit-baseline.json'),
    join(pr, 'config', 'security-audit-baseline.json')
  );
  copyFileSync(
    join(repoRoot, 'config', 'security-audit-policy.json'),
    join(pr, 'config', 'security-audit-policy.json')
  );

  runGit(pr, ['init']);
  runGit(pr, ['config', 'user.name', 'Terrastories Tests']);
  runGit(pr, ['config', 'user.email', 'tests@terrastories.invalid']);
  runGit(pr, ['add', '-A']);
  runGit(pr, ['commit', '-m', 'base state with the reviewed policy']);
  const baseSha = runGit(pr, ['rev-parse', 'HEAD']);

  // --- The malicious PR ----------------------------------------------------
  const marker = join(tmp, 'pr-code-ran');
  writeJson(join(pr, 'package.json'), {
    ...packageJson,
    scripts: { 'audit:baseline': 'exit 0', preaudit: 'exit 0' },
  });

  mkdirSync(join(pr, 'scripts'), { recursive: true });
  for (const script of [
    'trusted-audit-baseline.mjs',
    'review-dependency-changes.mjs',
    'check-audit-baseline.mjs',
  ]) {
    writeFileSync(
      join(pr, 'scripts', script),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(script)});\n`
    );
  }

  // A self-consistent but unapproved policy: every digest matches, but the
  // accepted advisory set silently grows one new advisory.
  const repoBaseline = JSON.parse(
    readFileSync(
      join(repoRoot, 'config', 'security-audit-baseline.json'),
      'utf8'
    )
  );
  const maliciousAdvisories = [
    ...repoBaseline.advisories,
    {
      source: '1099',
      package: 'pr-added-package',
      severity: 'high',
      url: 'https://github.com/advisories/GHSA-pr-added-package',
    },
  ];
  const maliciousPolicy = {
    trackingIssue: 141,
    minimumSeverity: 'moderate',
    expires: '2099-12-31',
    review: {
      status: 'accepted',
      reviewedBy: 'PR author',
      reviewedOn: '2026-11-02',
      rationale: 'Self-approved exception set from a pull request.',
      advisoriesSha256:
        auditModule.computeAdvisorySetDigest(maliciousAdvisories),
    },
  };
  maliciousPolicy.review.policySha256 = auditModule.computeReviewedPolicyDigest(
    maliciousAdvisories,
    maliciousPolicy
  );

  writeJson(join(pr, 'config', 'security-audit-baseline.json'), {
    trackingIssue: 141,
    expires: maliciousPolicy.expires,
    capturedOn: '2026-11-02',
    advisories: maliciousAdvisories,
  });
  writeJson(join(pr, 'config', 'security-audit-policy.json'), maliciousPolicy);

  runGit(pr, ['add', '-A']);
  runGit(pr, ['commit', '-m', 'malicious PR: no-op audit scripts and policy']);

  return { tmp, pr, baseSha, marker };
}

// Executes a real `run:` body from supply-chain.yml the way GitHub Actions
// would: bash with -e, in the step's working directory and environment.
function runWorkflowStep(stepName, { cwd, env }) {
  const script = stepRunScript(workflow, stepName);
  return spawnSync('bash', ['-e', '-c', script], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('trusted dependency review gate workflow', () => {
  it('accepts a compatible trusted checker on the base branch', () => {
    const { tmp } = createTrustedGateFixture();

    const result = runWorkflowStep(GUARD_STEP, {
      cwd: tmp,
      env: { ...process.env, GITHUB_WORKSPACE: tmp },
    });

    expect(result.status).toBe(0);
  }, 30_000);

  it('rejects a malicious PR through the trusted checker without running PR code', () => {
    const { tmp, pr, baseSha, marker } = createTrustedGateFixture();

    const result = runWorkflowStep(REVIEW_STEP, {
      cwd: pr,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GITHUB_WORKSPACE: tmp,
        BASE_SHA: baseSha,
        AUDIT_DATA_DIR: join(tmp, 'pr'),
        GITHUB_TOKEN: '',
      },
    });

    expect(result.status).not.toBe(0);
    // The trusted (base-branch) checker ran: it is the one that demands an
    // external approval the malicious PR cannot provide.
    expect(outputOf(result)).toContain(
      'external approval verification requires'
    );
    // No PR-supplied script, npm lifecycle hook, or `npm run` executed.
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it('refuses to fall back to PR code when the base branch has no checker', () => {
    const { tmp } = createTrustedGateFixture();
    unlinkSync(join(tmp, 'trusted', 'scripts', 'trusted-audit-baseline.mjs'));

    const result = runWorkflowStep(GUARD_STEP, {
      cwd: tmp,
      env: { ...process.env, GITHUB_WORKSPACE: tmp },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('refusing to fall back to PR code');
  }, 30_000);

  it('rejects an incompatible trusted checker version', () => {
    const { tmp } = createTrustedGateFixture();
    writeFileSync(
      join(tmp, 'trusted', 'scripts', 'trusted-audit-baseline.mjs'),
      "console.log('2')\n"
    );

    const result = runWorkflowStep(GUARD_STEP, {
      cwd: tmp,
      env: { ...process.env, GITHUB_WORKSPACE: tmp },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain(
      'Unsupported trusted audit checker version'
    );
  }, 30_000);

  it('rejects a symlinked base checker pointing at PR code', () => {
    const { tmp, pr } = createTrustedGateFixture();
    const checker = join(
      tmp,
      'trusted',
      'scripts',
      'trusted-audit-baseline.mjs'
    );
    unlinkSync(checker);
    symlinkSync(join(pr, 'scripts', 'trusted-audit-baseline.mjs'), checker);

    const result = runWorkflowStep(GUARD_STEP, {
      cwd: tmp,
      env: { ...process.env, GITHUB_WORKSPACE: tmp },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('refusing to fall back to PR code');
  }, 30_000);
});

describe('PR-controlled npm configuration', () => {
  it('accepts a clean PR tree', () => {
    const { pr } = createTrustedGateFixture();

    const result = runWorkflowStep(NPMRC_STEP, {
      cwd: pr,
      env: { ...process.env },
    });

    expect(result.status).toBe(0);
  }, 30_000);

  it('rejects a root .npmrc file pointing at another registry', () => {
    const { pr } = createTrustedGateFixture();
    writeFileSync(join(pr, '.npmrc'), 'registry=http://127.0.0.1:48731/\n');

    const result = runWorkflowStep(NPMRC_STEP, {
      cwd: pr,
      env: { ...process.env },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('.npmrc is not allowed');
  }, 30_000);

  it('rejects a dangling .npmrc symlink', () => {
    const { pr } = createTrustedGateFixture();
    symlinkSync('/nonexistent-npmrc-target', join(pr, '.npmrc'));

    const result = runWorkflowStep(NPMRC_STEP, {
      cwd: pr,
      env: { ...process.env },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('.npmrc is not allowed');
  }, 30_000);

  it('rejects a .npmrc directory', () => {
    const { pr } = createTrustedGateFixture();
    mkdirSync(join(pr, '.npmrc'));

    const result = runWorkflowStep(NPMRC_STEP, {
      cwd: pr,
      env: { ...process.env },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('.npmrc is not allowed');
  }, 30_000);

  it('rejects a committed nested .npmrc even without a root .npmrc', () => {
    const { pr } = createTrustedGateFixture();
    mkdirSync(join(pr, 'sub'));
    writeFileSync(
      join(pr, 'sub', '.npmrc'),
      'registry=http://127.0.0.1:48731/\n'
    );
    runGit(pr, ['add', '-A']);
    runGit(pr, ['commit', '-m', 'sneak in a nested .npmrc']);

    const result = runWorkflowStep(NPMRC_STEP, {
      cwd: pr,
      env: { ...process.env },
    });

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('committed .npmrc');
  }, 30_000);

  it('rejects npm configuration before the trusted checker runs the review', () => {
    const lines = workflow.split('\n');
    const stepLine = (name) =>
      lines.findIndex((line) => line.trim() === `- name: ${name}`);

    // The dependency-review job spans from its key to the next key at the
    // same two-space indentation.
    const jobStart = lines.findIndex((line) =>
      /^  dependency-review:\s*$/.test(line)
    );
    expect(jobStart).not.toBe(-1);
    let jobEnd = lines.length;
    for (let index = jobStart + 1; index < lines.length; index += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
        jobEnd = index;
        break;
      }
    }

    const npmrcLine = stepLine(NPMRC_STEP);
    const reviewLine = stepLine(REVIEW_STEP);
    expect(npmrcLine).not.toBe(-1);
    expect(reviewLine).not.toBe(-1);
    expect(npmrcLine).toBeGreaterThan(jobStart);
    expect(npmrcLine).toBeLessThan(jobEnd);
    expect(reviewLine).toBeGreaterThan(jobStart);
    expect(reviewLine).toBeLessThan(jobEnd);
    expect(npmrcLine).toBeLessThan(reviewLine);
  });
});
