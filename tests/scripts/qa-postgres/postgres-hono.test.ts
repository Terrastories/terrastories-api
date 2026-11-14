import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decidePostgresPersonaQa } from '../../../scripts/qa/qa-database.js';
import {
  createFixture,
  HONO_PERSONA_CULTURAL_STRINGS,
} from '../../../scripts/qa/hono-fixture.js';
import { runJourneysCapturingOutput } from '../../../scripts/qa/output-capture.js';

// #191: the shared capture (scripts/qa/output-capture.ts) records every
// console and process stdout/stderr write while the journeys run, so the
// assertion below fails if any cultural string reaches log output on either
// channel (loggers such as pino bypass console and write to the streams
// directly).

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
    ? 'Hono V2 persona acceptance (PostgreSQL)'
    : `Hono V2 persona acceptance (PostgreSQL) — skipped: ${decision.reason}`,
  () => {
    // Same journeys and expectations as the SQLite wrapper: only the backend
    // differs, so collation, timestamp, boolean and JSON behaviour cannot
    // hide a sovereignty leak behind SQLite semantics.
    it.skipIf(!decision.run)(
      'satisfies persona assertions and reaches every registered Hono endpoint',
      async () => {
        if (decision.target.status !== 'ready')
          throw new Error(
            `qa:personas:postgres requires a PostgreSQL target: ${decision.target.reason}`
          );
        const fixture = await createFixture();
        try {
          const { report, lines } = await runJourneysCapturingOutput(fixture);
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
          // #191: no cultural content may appear in any console or stream
          // line the app emitted while serving the journeys (empty today:
          // the app logs nothing, which this assertion keeps true).
          expect(
            lines.filter((line) =>
              HONO_PERSONA_CULTURAL_STRINGS.some((text) => line.includes(text))
            ),
            'cultural content in app console output (#191)'
          ).toEqual([]);
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
