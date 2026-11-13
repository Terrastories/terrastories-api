import { describe, expect, it } from 'vitest';
import {
  decidePostgresPersonaQa,
  resolvePostgresQaTarget,
} from '../../../scripts/qa/qa-database.js';

// The resolver decides when the persona journeys may destructively reset a
// PostgreSQL database; pin its three outcomes so a wrapper cannot silently
// skip (or silently run) against the wrong target. The gate decision layers
// the dedicated-gate marker on top: only qa:personas:postgres runs these
// journeys at all.
describe('PostgreSQL persona QA target resolution', () => {
  const postgresUrl =
    'postgresql://terrastories:terrastories-test@localhost:5432/terrastories_test';

  it('is unconfigured without a PostgreSQL QA_POSTGRES_URL', () => {
    const unconfigured = resolvePostgresQaTarget(undefined, 'true');
    expect(unconfigured).toEqual({
      status: 'unconfigured',
      reason: expect.any(String),
    });
    // The unconfigured reason names the selector, not DATABASE_URL: the
    // Vitest test environment pins DATABASE_URL to in-memory SQLite.
    expect(
      unconfigured.status === 'unconfigured' && unconfigured.reason
    ).toContain('QA_POSTGRES_URL');
    expect(resolvePostgresQaTarget('sqlite::memory:', 'true').status).toBe(
      'unconfigured'
    );
    // Both postgres schemes select the target.
    expect(
      resolvePostgresQaTarget(
        postgresUrl.replace('postgresql://', 'postgres://'),
        'true'
      ).status
    ).toBe('ready');
  });

  it('refuses a PostgreSQL URL without the reset guard', () => {
    const target = resolvePostgresQaTarget(postgresUrl, undefined);
    expect(target).toEqual({
      status: 'refused',
      reason: expect.any(String),
    });
    // The refusal names the guard so an operator can fix the environment.
    expect(target.status === 'refused' && target.reason).toContain(
      'ALLOW_POSTGRES_TEST_RESET'
    );
  });

  it('refuses a database whose name is not a dedicated test database', () => {
    // Same name guard as the PostgreSQL database gate: only bare `test` and
    // `*_test`-suffixed dedicated names may be reset — a `test_*` prefix is
    // NOT allowed (regex /^(?:test|[a-z0-9][a-z0-9_]*_test)$/i).
    for (const database of [
      'latest',
      'terrastories',
      'terrastories_prod',
      'test_community',
    ]) {
      const url = `postgresql://user:pass@localhost:5432/${database}`;
      const target = resolvePostgresQaTarget(url, 'true');
      expect(target.status, database).toBe('refused');
      if (target.status === 'refused')
        expect(target.reason).toContain(database);
    }
    expect(
      resolvePostgresQaTarget(
        'postgresql://user:pass@localhost:5432/test',
        'true'
      ).status
    ).toBe('ready');
    expect(
      resolvePostgresQaTarget(
        'postgresql://user:pass@localhost:5432/persona_qa_test',
        'true'
      ).status
    ).toBe('ready');
  });
});

describe('PostgreSQL persona QA gate decision', () => {
  const postgresUrl =
    'postgresql://terrastories:terrastories-test@localhost:5432/terrastories_test';

  it('runs only under the dedicated gate, even with a ready target', () => {
    // required=false with a ready target still skips: qa:personas:sqlite
    // shares this directory and must never touch PostgreSQL, so the marker
    // alone — never a reachable database — decides whether the journeys run.
    const skipped = decidePostgresPersonaQa(undefined, postgresUrl, 'true');
    expect(skipped.run).toBe(false);
    expect(skipped.reason).toContain('QA_PERSONAS_POSTGRES');
    expect(skipped.target.status).toBe('ready');

    const gated = decidePostgresPersonaQa('1', postgresUrl, 'true');
    expect(gated.run).toBe(true);
    expect(gated.reason).toBe('');
    expect(gated.target).toEqual({ status: 'ready', url: postgresUrl });
  });

  it('fails closed inside the gate when the target is not ready', () => {
    // The marker still runs the journeys; the wrapper throws on the target's
    // own reason instead of skipping green.
    for (const [url, allowReset] of [
      [undefined, 'true'],
      [postgresUrl, undefined],
      ['postgresql://user:pass@localhost:5432/terrastories', 'true'],
    ] as const) {
      const decision = decidePostgresPersonaQa('1', url, allowReset);
      expect(decision.run, `${url}`).toBe(true);
      expect(decision.target.status).not.toBe('ready');
    }
  });
});
