import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const readRepo = (path) => readFileSync(join(repoRoot, path), 'utf8');

const JOB_KEY = 'persona-qa-sqlite';
const JOB_NAME = 'Persona QA gate (SQLite)';

// The repository declares no YAML parser dependency (js-yaml is present
// only as a pinned transitive override for eslint), so these helpers parse
// the YAML subset the workflow files use — `key: value` mappings and
// `- key: value` sequence items — into structure. This mirrors the
// string-based ci-supply-chain workflow tests while still allowing exact
// command and step-shape assertions.

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// One entry per `key: value` line, in document order. Full-line comments
// and blank lines produce no entry; trailing ` # comment` suffixes are
// stripped because no workflow value here legitimately contains " #".
function mappingEntries(lines) {
  const entries = [];
  lines.forEach((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) return;
    entries.push({
      indent: match[1].length,
      key: match[2],
      value: match[3].split(' #')[0].trim(),
    });
  });
  return entries;
}

function entryByKey(entries, key) {
  return entries.find((candidate) => candidate.key === key);
}

function valueOf(entries, key) {
  const entry = entryByKey(entries, key);
  return entry ? entry.value : undefined;
}

// Entries nested under a block parent (for example `with:` or `env:`),
// until the next entry at the parent's own indentation. Looks up the
// parent's array position (not any line number) so comment lines inside
// the block cannot desynchronize the scan.
function childrenOf(entries, parent) {
  const children = [];
  for (let at = entries.indexOf(parent) + 1; at < entries.length; at += 1) {
    if (entries[at].indent <= parent.indent) break;
    children.push(entries[at]);
  }
  return children;
}

// Lines of a top-level mapping block (for example `on:`) until the next
// top-level key.
function topLevelBlockLines(text, key) {
  const lines = text.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return [];

  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (indentOf(line) === 0) break;
    collected.push(line);
  }
  return collected;
}

// One job (a two-space indented key under `jobs:`): raw text, direct
// mapping entries (indent 4), and steps as parsed entry lists.
function parseWorkflowJob(workflow, jobKey) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${jobKey}:`);
  if (start === -1) return { text: '', entries: [], steps: [] };

  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (indentOf(line) <= 2) break;
    collected.push(line);
  }

  const entries = mappingEntries(collected);
  const stepsLine = collected.findIndex((line) => line.trim() === 'steps:');
  const steps = [];
  if (stepsLine !== -1) {
    let current = null;
    for (let next = stepsLine + 1; next < collected.length; next += 1) {
      const item = collected[next].match(/^(\s*)- (.*)$/);
      if (item && item[1].length === 6) {
        if (current) steps.push(current);
        current = [item[1] + '  ' + item[2]];
        continue;
      }
      if (current) current.push(collected[next]);
    }
    if (current) steps.push(current);
  }

  return {
    text: collected.join('\n'),
    entries,
    steps: steps.map((stepLines) => mappingEntries(stepLines)),
  };
}

function stepValue(stepEntries, key) {
  const entry = entryByKey(stepEntries, key);
  return entry && entry.value !== '' ? entry.value : undefined;
}

// Entries nested under a step's block key such as `with:` or `env:`.
function stepParent(stepEntries, key) {
  const parent = stepEntries.find(
    (entry) => entry.key === key && entry.value === ''
  );
  return parent ? childrenOf(stepEntries, parent) : [];
}

const stepNamed = (steps, name) =>
  steps.find((step) => stepValue(step, 'name') === name);

const stepUsing = (steps, action) =>
  steps.find((step) => {
    const uses = stepValue(step, 'uses');
    return uses !== undefined && uses.startsWith(`${action}@`);
  });

function isShaPinned(action) {
  const separator = action.lastIndexOf('@');
  if (separator === -1) return false;
  return /^[0-9a-f]{40}$/i.test(action.slice(separator + 1));
}

describe('persona QA CI release gate', () => {
  const ci = readRepo('.github/workflows/ci.yml');
  const job = parseWorkflowJob(ci, JOB_KEY);
  const jobKeys = job.entries.filter((entry) => entry.indent === 4);

  it('defines the persona QA gate job', () => {
    expect(job.text, `ci.yml must define a "${JOB_KEY}" job`).not.toBe('');
    expect(valueOf(jobKeys, 'name')).toBe(JOB_NAME);
    expect(valueOf(jobKeys, 'runs-on')).toBe('ubuntu-latest');
    expect(valueOf(jobKeys, 'timeout-minutes')).toBe('15');
  });

  it('runs on pull requests and pushes to main without gating on other jobs', () => {
    const onEntries = mappingEntries(topLevelBlockLines(ci, 'on'));
    const events = onEntries.filter((entry) => entry.indent === 2);
    const eventNames = events.map((entry) => entry.key);
    expect(eventNames).toContain('push');
    expect(eventNames).toContain('pull_request');

    for (const eventName of ['push', 'pull_request']) {
      const event = entryByKey(onEntries, eventName);
      const constraints = childrenOf(onEntries, event);
      expect(constraints, `${eventName} must target only main`).toEqual([
        expect.objectContaining({ key: 'branches', value: '[main]' }),
      ]);
    }

    // The gate must run on its own: no unrelated job can defer or mask it.
    expect(entryByKey(jobKeys, 'needs')).toBeUndefined();
    // pull_request_target would hand PR-controlled code the workflow token.
    expect(eventNames).not.toContain('pull_request_target');
    expect(ci).not.toContain('pull_request_target');
  });

  it('installs dependencies and runs the qa:personas SQLite wrapper', () => {
    // The gate must invoke the wrapper script, which is bound to the
    // documented SQLite acceptance suite, not an invented command.
    const packageJson = JSON.parse(readRepo('package.json'));
    expect(packageJson.scripts['qa:personas:sqlite']).toBe(
      'vitest run tests/scripts/qa --maxWorkers=2'
    );

    expect(job.steps).toHaveLength(5);

    const install = stepNamed(job.steps, 'Install dependencies');
    expect(stepValue(install, 'run')).toBe('npm ci --legacy-peer-deps');

    const gate = stepNamed(job.steps, 'Run persona QA gate (SQLite)');
    expect(gate).toBeDefined();
    expect(stepValue(gate, 'run')).toBe('npm run qa:personas:sqlite');
    // The SQLite Vitest wrapper only retains the report, including on
    // failure, when QA_REPORT_PATH is absolute.
    const gateEnv = stepParent(gate, 'env');
    expect(valueOf(gateEnv, 'QA_REPORT_PATH')).toBe(
      '${{ github.workspace }}/qa-report.json'
    );

    const setupNode = stepUsing(job.steps, 'actions/setup-node');
    const setupNodeWith = stepParent(setupNode, 'with');
    expect(valueOf(setupNodeWith, 'node-version')).toBe('20.19.0');
    expect(valueOf(setupNodeWith, 'cache')).toBe("'npm'");
  });

  it('uses only SHA-pinned actions and never persists credentials', () => {
    const uses = job.steps
      .map((step) => stepValue(step, 'uses'))
      .filter((value) => value !== undefined);
    expect(uses.length).toBeGreaterThanOrEqual(3);

    for (const ref of uses) {
      expect(isShaPinned(ref), `${ref} must be 40-hex SHA pinned`).toBe(true);
    }

    const actionNames = uses.map((ref) => ref.slice(0, ref.lastIndexOf('@')));
    expect(actionNames).toContain('actions/checkout');
    expect(actionNames).toContain('actions/setup-node');
    expect(actionNames).toContain('actions/upload-artifact');

    const checkout = stepUsing(job.steps, 'actions/checkout');
    const checkoutWith = stepParent(checkout, 'with');
    expect(valueOf(checkoutWith, 'persist-credentials')).toBe('false');
  });

  it('treats a floating action tag or bare name as unpinned', () => {
    const pinned = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
    expect(isShaPinned(pinned)).toBe(true);
    expect(isShaPinned('actions/checkout@v4')).toBe(false);
    expect(isShaPinned('actions/checkout@11d5960')).toBe(false);
    expect(isShaPinned('actions/checkout')).toBe(false);
  });

  it('fails closed on every step and uses no secrets', () => {
    const continueOnError = (entries) =>
      entries.find((entry) => entry.key === 'continue-on-error');
    expect(continueOnError(jobKeys)).toBeUndefined();
    for (const step of job.steps) {
      const label = stepValue(step, 'name') ?? stepValue(step, 'uses');
      expect(continueOnError(step), `step "${label}"`).toBeUndefined();
    }
    expect(job.text).not.toContain('secrets.');

    // The report is published for diagnosis even when the gate fails, and
    // a missing report fails the upload instead of passing silently.
    const upload = stepUsing(job.steps, 'actions/upload-artifact');
    expect(stepValue(upload, 'if')).toBe('always()');
    const uploadWith = stepParent(upload, 'with');
    expect(valueOf(uploadWith, 'name')).toBe('persona-qa-report');
    expect(valueOf(uploadWith, 'path')).toBe('qa-report.json');
    expect(valueOf(uploadWith, 'if-no-files-found')).toBe('error');
  });

  it('documents the check name for the required status check', () => {
    const readme = readRepo('scripts/qa/README.md');

    expect(readme).toContain(JOB_NAME);
    expect(readme).toMatch(/required status check/i);
  });
});

const PG_JOB_KEY = 'persona-qa-postgres';
const PG_JOB_NAME = 'Persona QA gate (PostgreSQL 13)';

describe('PostgreSQL persona QA CI release gate', () => {
  const ci = readRepo('.github/workflows/ci.yml');
  const job = parseWorkflowJob(ci, PG_JOB_KEY);
  const jobKeys = job.entries.filter((entry) => entry.indent === 4);

  it('defines the PostgreSQL persona QA gate job', () => {
    expect(job.text, `ci.yml must define a "${PG_JOB_KEY}" job`).not.toBe('');
    expect(valueOf(jobKeys, 'name')).toBe(PG_JOB_NAME);
    expect(valueOf(jobKeys, 'runs-on')).toBe('ubuntu-latest');
    expect(valueOf(jobKeys, 'timeout-minutes')).toBe('15');
    // The gate must run on its own, like the SQLite gate.
    expect(entryByKey(jobKeys, 'needs')).toBeUndefined();

    const permissions = childrenOf(
      job.entries,
      entryByKey(jobKeys, 'permissions')
    );
    expect(valueOf(permissions, 'contents')).toBe('read');
  });

  it('mirrors the PostgreSQL database gate service, env and non-UTC TZ', () => {
    const postgresService = entryByKey(job.entries, 'postgres');
    expect(
      postgresService,
      'job must run the postgres:13 service'
    ).toBeDefined();
    const serviceEntries = childrenOf(job.entries, postgresService);
    expect(valueOf(serviceEntries, 'image')).toBe('postgres:13');
    expect(valueOf(serviceEntries, 'POSTGRES_DB')).toBe('terrastories_test');
    expect(valueOf(serviceEntries, 'POSTGRES_USER')).toBe('terrastories');
    expect(valueOf(serviceEntries, 'POSTGRES_PASSWORD')).toBe(
      'terrastories-test'
    );
    // Non-UTC on purpose: collation and timestamp drift must surface, and
    // sessions must pin UTC themselves instead of riding a UTC default.
    expect(valueOf(serviceEntries, 'TZ')).toBe('America/Sao_Paulo');
    expect(valueOf(serviceEntries, 'PGTZ')).toBe('America/Sao_Paulo');
    expect(job.text).toContain('- 5432:5432');
    expect(job.text).toContain(
      '--health-cmd "pg_isready -U terrastories -d terrastories_test"'
    );

    const jobEnv = childrenOf(job.entries, entryByKey(jobKeys, 'env'));
    // The persona target travels through QA_POSTGRES_URL, never DATABASE_URL:
    // the Vitest test environment pins DATABASE_URL to in-memory SQLite for
    // every worker, overriding any job-level value.
    expect(valueOf(jobEnv, 'QA_POSTGRES_URL')).toBe(
      'postgresql://terrastories:terrastories-test@localhost:5432/terrastories_test'
    );
    expect(
      entryByKey(jobEnv, 'DATABASE_URL'),
      'the persona gate must not set DATABASE_URL'
    ).toBeUndefined();
    expect(valueOf(jobEnv, 'ALLOW_POSTGRES_TEST_RESET')).toBe("'true'");
    expect(valueOf(jobEnv, 'TZ')).toBe('America/Sao_Paulo');
  });

  it('installs dependencies and runs the qa:personas:postgres wrapper', () => {
    // The gate must invoke the dedicated wrapper script, which runs the two
    // PostgreSQL persona wrappers serially (they reset one shared database)
    // and fails closed when the PostgreSQL target is not selected.
    const packageJson = JSON.parse(readRepo('package.json'));
    expect(packageJson.scripts['qa:personas:postgres']).toBe(
      'QA_PERSONAS_POSTGRES=1 vitest run tests/scripts/qa/postgres-fastify.test.ts tests/scripts/qa/postgres-hono.test.ts --maxWorkers=1'
    );

    expect(job.steps).toHaveLength(5);

    const install = stepNamed(job.steps, 'Install dependencies');
    expect(stepValue(install, 'run')).toBe('npm ci --legacy-peer-deps');

    const gate = stepNamed(job.steps, 'Run persona QA gate (PostgreSQL 13)');
    expect(gate).toBeDefined();
    expect(stepValue(gate, 'run')).toBe('npm run qa:personas:postgres');
    // The wrappers only retain their reports, including on failure, when
    // QA_REPORT_PATH is absolute.
    const gateEnv = stepParent(gate, 'env');
    expect(valueOf(gateEnv, 'QA_REPORT_PATH')).toBe(
      '${{ github.workspace }}/qa-report.json'
    );

    const setupNode = stepUsing(job.steps, 'actions/setup-node');
    const setupNodeWith = stepParent(setupNode, 'with');
    expect(valueOf(setupNodeWith, 'node-version')).toBe('20.19.0');
    expect(valueOf(setupNodeWith, 'cache')).toBe("'npm'");
  });

  it('uses only SHA-pinned actions and never persists credentials', () => {
    const uses = job.steps
      .map((step) => stepValue(step, 'uses'))
      .filter((value) => value !== undefined);
    expect(uses.length).toBeGreaterThanOrEqual(3);

    for (const ref of uses) {
      expect(isShaPinned(ref), `${ref} must be 40-hex SHA pinned`).toBe(true);
    }

    const checkout = stepUsing(job.steps, 'actions/checkout');
    const checkoutWith = stepParent(checkout, 'with');
    expect(valueOf(checkoutWith, 'persist-credentials')).toBe('false');
  });

  it('fails closed on every step and uses no secrets', () => {
    const continueOnError = (entries) =>
      entries.find((entry) => entry.key === 'continue-on-error');
    expect(continueOnError(jobKeys)).toBeUndefined();
    for (const step of job.steps) {
      const label = stepValue(step, 'name') ?? stepValue(step, 'uses');
      expect(continueOnError(step), `step "${label}"`).toBeUndefined();
    }
    expect(job.text).not.toContain('secrets.');

    // Both dialect reports are published for diagnosis even when the gate
    // fails, and a missing report fails the upload instead of passing
    // silently. The parser flattens `path: |`, so the two report names are
    // pinned in the raw job text.
    const upload = stepUsing(job.steps, 'actions/upload-artifact');
    expect(stepValue(upload, 'if')).toBe('always()');
    const uploadWith = stepParent(upload, 'with');
    expect(valueOf(uploadWith, 'name')).toBe('persona-qa-report-postgres');
    expect(valueOf(uploadWith, 'path')).toBe('|');
    expect(job.text).toContain('qa-report-postgres.json');
    expect(job.text).toContain('qa-report-postgres-hono.json');
    expect(valueOf(uploadWith, 'if-no-files-found')).toBe('error');
  });

  it('documents the check name alongside the SQLite gate', () => {
    const readme = readRepo('scripts/qa/README.md');

    expect(readme).toContain(PG_JOB_NAME);
  });
});
