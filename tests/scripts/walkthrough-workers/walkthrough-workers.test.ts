import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVERAGE_ROWS } from '../../../scripts/walkthrough/coverage.js';
import { startWorkersApp } from '../../../scripts/walkthrough/workers-app.js';
import type { Config } from '../../../scripts/walkthrough/context.js';
import { runWalkthrough } from '../../../scripts/walkthrough/run.js';

// Only `npm run walkthrough:workers` (WALKTHROUGH_WORKERS=1) pays for a
// workerd runtime; every other invocation skips with this reason.
const gate = process.env.WALKTHROUGH_WORKERS === '1';

describe(
  gate
    ? 'persona walkthrough on Workers (D1/R2)'
    : 'persona walkthrough on Workers (D1/R2) — skipped: WALKTHROUGH_WORKERS is not "1"; only npm run walkthrough:workers runs it',
  () => {
    it.skipIf(!gate)(
      'passes every handoff row on D1 semantics, including the daily import limit',
      async () => {
        const app = await startWorkersApp({ adminRecoveryCode: true });
        try {
          const dir = await mkdtemp(join(tmpdir(), 'tsapi-walkthrough-wk-'));
          const cfg: Config = {
            baseUrl: app.baseUrl,
            community: app.community,
            adminIdentifier: app.admin.identifier,
            adminPassword: app.admin.password,
            superIdentifier: app.superAdmin.identifier,
            superPassword: app.superAdmin.password,
            bootstrapSecret: app.bootstrapSecret,
            setupFromBootstrap: false,
            allowDestructive: true,
            loginRealAdmin: true,
            d1: true,
          };
          const result = await runWalkthrough(cfg, {
            persona: 'all',
            outDir: dir,
            quiet: true,
            authSpacingMs: 0,
          });
          const records = result.walk.records;
          expect(
            records
              .filter((r) => r.outcome === 'fail')
              .map((r) => `${r.label} ${r.text}: ${r.error}`)
          ).toEqual([]);
          expect(result.uncovered, 'handoff rows with no step').toEqual([]);
          expect(result.ok).toBe(true);
          expect(COVERAGE_ROWS.length - result.uncovered.length).toBe(
            COVERAGE_ROWS.length
          );

          // the D1 rule is asserted, not skipped: one commit, then 429s
          const refused = records.filter(
            (r) => r.negative && r.outcome === 'pass' && r.status === 429
          );
          expect(refused.length).toBeGreaterThanOrEqual(2);
          expect(
            records.filter(
              (r) =>
                r.outcome === 'pass' &&
                r.method === 'POST' &&
                /^\/v2\/imports\/\d+\/commit$/.test(r.path ?? '') &&
                r.status !== 429
            )
          ).toHaveLength(1);

          // the real admin streamed the migrated file through /v2/media/:id
          expect(
            records.some(
              (r) =>
                r.outcome === 'pass' &&
                r.actor.startsWith('Real admin') &&
                /^\/v2\/media\/[0-9a-f-]{36}$/.test(r.path ?? '')
            )
          ).toBe(true);

          const summary = await readFile(join(dir, 'summary.md'), 'utf8');
          for (const row of COVERAGE_ROWS) {
            const line = summary
              .split('\n')
              .find((l) => l.startsWith(`| ${row.id} |`));
            expect(line, row.id).toBeDefined();
            expect(line).not.toContain('**none**');
          }
        } finally {
          await app.close();
        }
      },
      540_000
    );
  }
);
