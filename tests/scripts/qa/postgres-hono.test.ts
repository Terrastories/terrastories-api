import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resolvePostgresQaTarget } from '../../../scripts/qa/qa-database.js';
import { createFixture } from '../../../scripts/qa/hono-fixture.js';
import { runJourneys } from '../../../scripts/qa/runner.js';

// Module scope: resolve before any hook could rewrite the environment, so
// the wrapper always reports what the operator actually configured.
const target = resolvePostgresQaTarget(
  process.env.DATABASE_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);
// qa:personas:postgres sets this marker: the dedicated gate must fail closed
// when its PostgreSQL target is misconfigured, not skip green.
const required = process.env.QA_PERSONAS_POSTGRES === '1';

describe(
  target.status === 'ready'
    ? 'Hono V2 persona acceptance (PostgreSQL)'
    : `Hono V2 persona acceptance (PostgreSQL) — skipped: ${target.reason}`,
  () => {
    // Same journeys and expectations as the SQLite wrapper: only the backend
    // differs, so collation, timestamp, boolean and JSON behaviour cannot
    // hide a sovereignty leak behind SQLite semantics.
    it.skipIf(target.status !== 'ready' && !required)(
      'satisfies persona assertions and reaches every registered Hono endpoint',
      async () => {
        if (target.status !== 'ready')
          throw new Error(
            `qa:personas:postgres requires a PostgreSQL target: ${target.reason}`
          );
        const fixture = await createFixture();
        try {
          const report = await runJourneys(fixture);
          // Sibling of every other report so parallel wrappers never race on
          // one QA_REPORT_PATH and each stack and dialect keeps its own
          // diagnosis file.
          if (process.env.QA_REPORT_PATH)
            await writeFile(
              process.env.QA_REPORT_PATH.replace(/\.json$/, '') +
                '-postgres-hono.json',
              JSON.stringify(report, null, 2) + '\n'
            );
          expect(
            report.results.filter((result) => !result.pass),
            'persona failures'
          ).toEqual([]);
          expect(
            report.uncovered,
            'unreached Hono endpoints need journeys or reviewed exclusions'
          ).toEqual([]);
          expect(report.pass).toBe(true);
        } finally {
          await fixture.close();
        }
        // Generous timeout: the runner enforces its own 30s per-request
        // deadline and writes the report before the assertions run, but only
        // if Vitest has not killed the test first.
      },
      120000
    );
  }
);
