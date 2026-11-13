import { describe, expect, it } from 'vitest';
import { resolvePostgresQaTarget } from '../../../scripts/qa/qa-database.js';

// The resolver decides when the persona journeys may destructively reset a
// PostgreSQL database; pin its three outcomes so a wrapper cannot silently
// skip (or silently run) against the wrong target.
describe('PostgreSQL persona QA target resolution', () => {
  const postgresUrl =
    'postgresql://terrastories:terrastories-test@localhost:5432/terrastories_test';

  it('is unconfigured without a PostgreSQL DATABASE_URL', () => {
    expect(resolvePostgresQaTarget(undefined, 'true')).toEqual({
      status: 'unconfigured',
      reason: expect.any(String),
    });
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
    // Same name guard as the PostgreSQL database gate: only bare `test` or
    // `*_test`/`test_*`-style dedicated names may be reset.
    for (const database of ['latest', 'terrastories', 'terrastories_prod']) {
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
