import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
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

describe('Hono V2 persona acceptance', () => {
  it('satisfies persona assertions and reaches every registered Hono endpoint', async () => {
    const fixture = await createFixture();
    try {
      const { report, lines } = await runJourneysCapturingOutput(fixture);
      // Sibling of the Fastify report so parallel wrappers never race on
      // one QA_REPORT_PATH and each stack keeps its own diagnosis file.
      if (process.env.QA_REPORT_PATH)
        await writeFile(
          process.env.QA_REPORT_PATH.replace(/\.json$/, '') + '-hono.json',
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
      // #191: no cultural content may appear in any console or stream line
      // the app emitted while serving the journeys (empty today: the app
      // logs nothing, which this assertion keeps true).
      expect(
        lines.filter((line) =>
          HONO_PERSONA_CULTURAL_STRINGS.some((text) => line.includes(text))
        ),
        'cultural content in app console output (#191)'
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
    // Generous timeout: the runner enforces its own 30s per-request deadline
    // and writes the report before the assertions run, but only if Vitest
    // has not killed the test first — keep the test timeout well above the
    // request deadline so slow-but-failing runs still surface the report.
  }, 120000);
});
