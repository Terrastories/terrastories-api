import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../../../scripts/qa/hono-fixture.js';
import { runJourneys } from '../../../scripts/qa/runner.js';

describe('Hono V2 persona acceptance', () => {
  it('satisfies persona assertions and reaches every registered Hono endpoint', async () => {
    const fixture = await createFixture();
    try {
      const report = await runJourneys(fixture);
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
    } finally {
      await fixture.close();
    }
    // Generous timeout: the runner enforces its own 30s per-request deadline
    // and writes the report before the assertions run, but only if Vitest
    // has not killed the test first — keep the test timeout well above the
    // request deadline so slow-but-failing runs still surface the report.
  }, 120000);
});
