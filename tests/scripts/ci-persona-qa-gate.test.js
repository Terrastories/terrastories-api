import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const readRepo = (path) => readFileSync(join(repoRoot, path), 'utf8');

const JOB_KEY = 'persona-qa-sqlite';
const JOB_NAME = 'Persona QA gate (SQLite)';

// Returns the body of one top-level workflow job (two-space indentation)
// from its key line until the next job key or end of file. String-based on
// purpose, mirroring the ci-supply-chain workflow tests: no YAML dependency
// and failures point at the literal workflow text.
function workflowJobBlock(workflow, jobKey) {
  const marker = `\n  ${jobKey}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) return '';

  const bodyStart = start + marker.length;
  const rest = workflow.slice(bodyStart);
  const nextJob = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

function externalActionRefs(block) {
  return [
    ...block.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm),
  ].map((match) => match[1]);
}

function isShaPinned(action) {
  const separator = action.lastIndexOf('@');
  if (separator === -1) return false;
  return /^[0-9a-f]{40}$/i.test(action.slice(separator + 1));
}

describe('persona QA CI release gate', () => {
  const ci = readRepo('.github/workflows/ci.yml');
  const job = workflowJobBlock(ci, JOB_KEY);

  it('defines the persona QA gate job', () => {
    expect(job, `ci.yml must define a "${JOB_KEY}" job`).not.toBe('');
    expect(job).toContain(`name: ${JOB_NAME}`);
    expect(job).toContain('runs-on: ubuntu-latest');
  });

  it('runs on pull requests and pushes to main', () => {
    const triggers = ci.slice(ci.indexOf('on:'), ci.indexOf('jobs:'));
    expect(triggers).toContain('push:');
    expect(triggers).toContain('pull_request:');
    expect(triggers).toContain('branches: [main]');
    // pull_request_target would hand PR-controlled code the workflow token.
    expect(ci).not.toContain('pull_request_target');
  });

  it('runs the qa:personas SQLite wrapper on the minimum Node runtime', () => {
    // The gate must invoke the wrapper script, which is bound to the
    // documented SQLite acceptance suite, not an invented command.
    const packageJson = JSON.parse(readRepo('package.json'));
    expect(packageJson.scripts['qa:personas:sqlite']).toBe(
      'vitest run tests/scripts/qa --maxWorkers=2'
    );

    expect(job).toContain('npm ci --legacy-peer-deps');
    expect(job).toContain('npm run qa:personas:sqlite');
    expect(job).toContain('node-version: 20.19.0');
    expect(job).toContain("cache: 'npm'");
    // The SQLite Vitest wrapper only retains the report, including on
    // failure, when QA_REPORT_PATH is absolute.
    expect(job).toContain(
      'QA_REPORT_PATH: ${{ github.workspace }}/qa-report.json'
    );
  });

  it('uses only SHA-pinned actions and never persists credentials', () => {
    const actions = externalActionRefs(job);
    expect(actions.length).toBeGreaterThanOrEqual(3);

    for (const action of actions) {
      expect(
        isShaPinned(action),
        `${action} must be pinned to a 40-hex commit SHA`
      ).toBe(true);
    }

    const names = actions.map((action) =>
      action.slice(0, action.lastIndexOf('@'))
    );
    expect(names).toContain('actions/checkout');
    expect(names).toContain('actions/setup-node');
    expect(names).toContain('actions/upload-artifact');
    expect(job).toContain('persist-credentials: false');
  });

  it('detects a floating action tag as unpinned', () => {
    const actions = externalActionRefs('  - uses: actions/checkout@v4 # v4\n');

    expect(actions).toEqual(['actions/checkout@v4']);
    expect(isShaPinned(actions[0])).toBe(false);
  });

  it('fails closed and uses no secrets', () => {
    expect(job).not.toContain('continue-on-error');
    expect(job).not.toContain('secrets.');
    // The report is published for diagnosis even when the gate fails, and
    // a missing report fails the upload instead of passing silently.
    expect(job).toContain('if: always()');
    expect(job).toContain('name: persona-qa-report');
    expect(job).toContain('path: qa-report.json');
    expect(job).toContain('if-no-files-found: error');
  });

  it('documents the check name for the required status check', () => {
    const readme = readRepo('scripts/qa/README.md');

    expect(readme).toContain(JOB_NAME);
    expect(readme).toMatch(/required status check/i);
  });
});
