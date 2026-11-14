import { describe, expect, it } from 'vitest';
import { createFixture } from '../../../scripts/qa/hono-fixture.js';
import { runJourneys, type Journey } from '../../../scripts/qa/runner.js';

describe('Hono V2 deliberate-mismatch proof (#134)', () => {
  it('fails closed and names status-mismatch and body-mismatch steps when journeys are mutated', async () => {
    const fixture = await createFixture();
    try {
      const journeys: Journey[] = fixture.journeys.map((journey) => ({
        ...journey,
        steps: journey.steps.map((step) => ({ ...step })),
      }));
      const anonymous = journeys.find(
        (journey) => journey.persona === 'anonymous'
      );
      expect(anonymous).toBeDefined();

      const hiddenStep = anonymous!.steps.find(
        (step) => step.name === 'hide restricted story'
      );
      expect(hiddenStep?.expected).toBe(404);
      hiddenStep!.expected = 200;

      const detailStep = anonymous!.steps.find(
        (step) => step.name === 'explore story detail'
      );
      expect(detailStep?.check).toBeTypeOf('function');
      detailStep!.check = (body) =>
        'isRestricted' in
        ((body as { data?: Record<string, unknown> }).data ?? {});

      const report = await runJourneys({ ...fixture, journeys });

      expect(report.pass).toBe(false);
      expect(report.uncovered).toEqual([]);
      const failures = report.results.filter((result) => !result.pass);
      expect(
        failures.map((result) => ({
          persona: result.persona,
          step: result.step,
          failure: result.failure,
          expected: result.expected,
          actual: result.actual,
        }))
      ).toEqual([
        {
          persona: 'anonymous',
          step: 'explore story detail',
          failure: 'body-mismatch',
          expected: 200,
          actual: 200,
        },
        {
          persona: 'anonymous',
          step: 'hide restricted story',
          failure: 'status-mismatch',
          expected: 200,
          actual: 404,
        },
      ]);

      // Verify the fixture's original journeys were not mutated.
      const originalAnonymous = fixture.journeys.find(
        (journey) => journey.persona === 'anonymous'
      )!;
      expect(
        originalAnonymous.steps.find(
          (step) => step.name === 'hide restricted story'
        )?.expected
      ).toBe(404);
    } finally {
      await fixture.close();
    }
  }, 120000);
});
