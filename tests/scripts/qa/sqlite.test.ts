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
    } finally {
      await fixture.close();
    }
  }, 30000);
});
