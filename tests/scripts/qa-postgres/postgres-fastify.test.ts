import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decidePostgresPersonaQa } from '../../../scripts/qa/qa-database.js';
import { createFixture } from '../../../scripts/qa/sqlite-fixture.js';
import { runJourneys } from '../../../scripts/qa/runner.js';

// Module scope: resolve before any hook could rewrite the environment, so
// the wrapper always reports what the operator actually configured. The
// dedicated gate marker decides whether these journeys run at all; the
// target itself is selected through QA_POSTGRES_URL because the Vitest test
// environment pins DATABASE_URL to in-memory SQLite for every worker.
const decision = decidePostgresPersonaQa(
  process.env.QA_PERSONAS_POSTGRES,
  process.env.QA_POSTGRES_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);

describe(
  decision.run
    ? 'Fastify frontend persona acceptance (PostgreSQL)'
    : `Fastify frontend persona acceptance (PostgreSQL) — skipped: ${decision.reason}`,
  () => {
    // Same journeys and expectations as the SQLite wrapper: only the backend
    // differs, so collation, timestamp, boolean and JSON behaviour cannot
    // hide a sovereignty leak behind SQLite semantics.
    it.skipIf(!decision.run)(
      'satisfies persona assertions and reaches every registered endpoint',
      async () => {
        if (decision.target.status !== 'ready')
          throw new Error(
            `qa:personas:postgres requires a PostgreSQL target: ${decision.target.reason}`
          );
        const fixture = await createFixture();
        try {
          const report = await runJourneys(fixture);
          // Sibling of the SQLite reports so parallel wrappers never race on
          // one QA_REPORT_PATH and each dialect keeps its own diagnosis file.
          if (process.env.QA_REPORT_PATH)
            await writeFile(
              process.env.QA_REPORT_PATH.replace(/\.json$/, '') +
                '-postgres.json',
              JSON.stringify(report, null, 2) + '\n'
            );
          expect(
            report.results.filter((result) => !result.pass),
            'persona failures'
          ).toEqual([]);
          expect(
            report.uncovered,
            'unreached endpoints need journeys or reviewed exclusions'
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
