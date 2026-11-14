import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  closeServer,
  createFixture,
  HONO_PERSONA_CULTURAL_STRINGS,
} from '../../../scripts/qa/hono-fixture.js';
import { runJourneysCapturingOutput } from '../../../scripts/qa/output-capture.js';

describe('Hono V2 persona acceptance (real HTTP)', () => {
  it('satisfies persona assertions over real HTTP and reaches every registered Hono endpoint', async () => {
    const fixture = await createFixture({ transport: 'http' });
    try {
      expect(fixture.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const { report, lines } = await runJourneysCapturingOutput(fixture);
      if (process.env.QA_REPORT_PATH)
        await writeFile(
          process.env.QA_REPORT_PATH.replace(/\.json$/, '') + '-hono-http.json',
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
      expect(report.contract).toBe('canonical-v2');
      expect(
        report.results.every((result) => result.contract === 'canonical-v2')
      ).toBe(true);
      expect(report.summary).toEqual({
        'canonical-v2': { passed: report.results.length, failed: 0 },
        'legacy-v1': { passed: 0, failed: 0 },
      });
      expect(
        lines.filter((line) =>
          HONO_PERSONA_CULTURAL_STRINGS.some((text) => line.includes(text))
        ),
        'cultural content in app console output (#191)'
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 120000);

  it('closeServer returns cleanly on a never-listening server and ERR_SERVER_NOT_RUNNING', async () => {
    const server = createServer();
    expect(server.listening).toBe(false);
    await expect(closeServer(server)).resolves.toBeUndefined();

    await expect(
      closeServer({
        listening: true,
        close(callback) {
          callback?.(
            Object.assign(new Error('Server is not running.'), {
              code: 'ERR_SERVER_NOT_RUNNING',
            })
          );
        },
      })
    ).resolves.toBeUndefined();
  });
});
