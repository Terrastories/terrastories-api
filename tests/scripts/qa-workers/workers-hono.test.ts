import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../../../scripts/qa/workers-fixture.js';
import { runJourneys } from '../../../scripts/qa/runner.js';

// Module scope: resolve before any hook could rewrite the environment, so
// the wrapper always reports what the operator actually configured. Only the
// dedicated gate (`QA_PERSONAS_WORKERS=1`, set by `npm run
// qa:personas:workers`) runs these journeys; every other invocation —
// `qa:personas:sqlite`, the plain test suite — skips with this reason, so
// the gate is the only thing that pays for a workerd runtime.
const gate = process.env.QA_PERSONAS_WORKERS === '1';

describe(
  gate
    ? 'Hono V2 persona acceptance (Workers D1/R2)'
    : 'Hono V2 persona acceptance (Workers D1/R2) — skipped: QA_PERSONAS_WORKERS is not "1"; only npm run qa:personas:workers runs these journeys',
  () => {
    // Same journeys and expectations as the SQLite wrapper: only the runtime
    // differs — the bundled src/worker.ts executing in workerd over D1 and
    // R2 — so Node-only behaviour cannot hide a sovereignty leak from the
    // hosted Workers Free profile.
    it.skipIf(!gate)(
      'satisfies persona assertions and reaches every endpoint the worker serves',
      async () => {
        const fixture = await createFixture();
        try {
          const report = await runJourneys(fixture);
          // Sibling of every other report so parallel wrappers never race on
          // one QA_REPORT_PATH and each runtime keeps its own diagnosis file.
          if (process.env.QA_REPORT_PATH)
            await writeFile(
              process.env.QA_REPORT_PATH.replace(/\.json$/, '') +
                '-workers-hono.json',
              JSON.stringify(report, null, 2) + '\n'
            );
          expect(
            report.results.filter((result) => !result.pass),
            'persona failures'
          ).toEqual([]);
          expect(
            report.uncovered,
            'unreached Workers endpoints need journeys or reviewed exclusions'
          ).toEqual([]);
          expect(report.pass).toBe(true);
        } finally {
          await fixture.close();
        }
        // Generous timeout: the runner enforces its own 30s per-request
        // deadline and writes the report before the assertions run, but only
        // if Vitest has not killed the test first — and workerd startup,
        // D1 migrations and PBKDF2 verification add real seconds around the
        // requests.
      },
      120000
    );
  }
);
