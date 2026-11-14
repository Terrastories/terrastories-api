import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../../../scripts/qa/sqlite-fixture.js';
import { runJourneys } from '../../../scripts/qa/runner.js';

describe('SQLite frontend persona acceptance', () => {
  it('satisfies persona assertions and reaches every registered endpoint', async () => {
    const fixture = await createFixture();
    try {
      const report = await runJourneys(fixture);
      if (process.env.QA_REPORT_PATH)
        await writeFile(
          process.env.QA_REPORT_PATH,
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
      expect(report.contract).toBe('legacy-v1');
      expect(
        report.results.every((result) => result.contract === 'legacy-v1')
      ).toBe(true);
      expect(report.summary).toEqual({
        'canonical-v2': { passed: 0, failed: 0 },
        'legacy-v1': { passed: report.results.length, failed: 0 },
      });
    } finally {
      await fixture.close();
    }
    // Generous timeout: the runner enforces its own 30s per-request deadline
    // and writes qa-report.json before the assertions run, but only if Vitest
    // has not killed the test first — keep the test timeout well above the
    // request deadline so slow-but-failing runs still surface the report.
  }, 120000);
});
