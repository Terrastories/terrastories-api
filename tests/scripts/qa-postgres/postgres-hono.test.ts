import { writeFile } from 'node:fs/promises';
import { format } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decidePostgresPersonaQa } from '../../../scripts/qa/qa-database.js';
import {
  createFixture,
  HONO_PERSONA_CULTURAL_STRINGS,
} from '../../../scripts/qa/hono-fixture.js';
import { runJourneys } from '../../../scripts/qa/runner.js';

/**
 * #191: capture every console write while the journeys run, so the assertion
 * below can prove cultural content (seeded story titles, descriptions, place
 * names) never reaches log output. The Hono app has no logging seam —
 * `src/hono-app.ts` answers errors without logging anything and the Explore
 * adapter logs nothing — so the in-process wrappers (this PostgreSQL wrapper
 * and the SQLite one) assert over console output. The Workers wrapper runs
 * the app inside workerd, where console output is out of process and is not
 * captured.
 */
const runJourneysCapturingConsole = async (
  fixture: Awaited<ReturnType<typeof createFixture>>
) => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = methods.map((method) => console[method]);
  const lines: string[] = [];
  for (const method of methods)
    console[method] = (...args: unknown[]) => {
      lines.push(format(...args));
    };
  try {
    return { report: await runJourneys(fixture), lines };
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
};

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
          const { report, lines } = await runJourneysCapturingConsole(fixture);
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
          // #191: no cultural content may appear in any console line the app
          // emitted while serving the journeys (empty today: the app logs
          // nothing, which this assertion keeps true).
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
