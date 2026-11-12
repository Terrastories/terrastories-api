import { describe, expect, it } from 'vitest';
import { runJourneys, validateBaseUrl } from '../../../scripts/qa/runner.js';

describe('persona runner fail-closed mechanics', () => {
  const routes = [{ method: 'GET', path: '/items/:id' }];
  const journeys = [
    {
      persona: 'viewer',
      steps: [{ name: 'read', method: 'GET', path: '/items/1', expected: 200 }],
    },
  ];
  it('records a response and matches parameterized routes', async () => {
    const report = await runJourneys({
      routes,
      journeys,
      handler: async () => new Response('{}'),
    });
    expect(report.pass).toBe(true);
    expect(report.coverage.reached).toBe(1);
  });
  it('fails on status mismatch, thrown transport and body mismatch', async () => {
    for (const handler of [
      async () => new Response('{}', { status: 403 }),
      async (): Promise<Response> => {
        throw new Error('offline');
      },
    ]) {
      expect((await runJourneys({ routes, journeys, handler })).pass).toBe(
        false
      );
    }
    expect(
      (
        await runJourneys({
          routes,
          journeys: [
            {
              persona: 'viewer',
              steps: [{ ...journeys[0].steps[0], check: () => false }],
            },
          ],
          handler: async () => new Response('{}'),
        })
      ).pass
    ).toBe(false);
  });
  it('fails for uncovered routes and never counts skips', async () => {
    const report = await runJourneys({
      routes,
      journeys: [{ ...journeys[0], skipped: 'not available' }],
      handler: async () => new Response('{}'),
    });
    expect(report.pass).toBe(false);
    expect(report.uncovered).toEqual(routes);
  });
  it('rejects stale and blank exclusions', async () => {
    for (const exclusion of [
      { method: 'GET', path: '/missing', reason: 'internal' },
      { ...routes[0], reason: ' ' },
    ]) {
      await expect(
        runJourneys({
          routes,
          journeys,
          exclusions: [exclusion],
          handler: async () => new Response('{}'),
        })
      ).rejects.toThrow('Invalid exclusion');
    }
  });
  it('validates HTTP origins before requests', () => {
    for (const value of [
      'file:///tmp/qa',
      'http://user:pass@host/',
      'http://host/path',
      'http://host/?a=1',
    ])
      expect(() => validateBaseUrl(value)).toThrow();
    expect(validateBaseUrl('http://localhost:3000').origin).toBe(
      'http://localhost:3000'
    );
  });
});

describe('persona runner state and route selection', () => {
  it('counts the static route without counting an overlapping parameter route', async () => {
    const report = await runJourneys({
      handler: async () => new Response('{}'),
      routes: [
        { method: 'GET', path: '/items/:id' },
        { method: 'GET', path: '/items/search' },
      ],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            {
              name: 'search',
              method: 'GET',
              path: '/items/search',
              expected: 200,
            },
          ],
        },
      ],
    });
    expect(report.uncovered).toEqual([{ method: 'GET', path: '/items/:id' }]);
  });
  it('captures created ids then uses the signed cookie in later calls', async () => {
    let count = 0;
    const report = await runJourneys({
      handler: async (request) => {
        if (++count === 1) {
          const headers = new Headers();
          headers.append('set-cookie', 'sessionId=short; Path=/');
          headers.append('set-cookie', 'sessionId=signed-long-session; Path=/');
          return new Response(JSON.stringify({ data: { id: 42 } }), {
            status: 201,
            headers,
          });
        }
        expect(new URL(request.url).pathname).toBe('/items/42');
        expect(request.headers.get('cookie')).toBe(
          'sessionId=signed-long-session'
        );
        return new Response('{}');
      },
      routes: [
        { method: 'POST', path: '/items' },
        { method: 'GET', path: '/items/:id' },
      ],
      journeys: [
        {
          persona: 'editor',
          steps: [
            {
              name: 'create',
              method: 'POST',
              path: '/items',
              expected: 201,
              captureId: 'item',
            },
            {
              name: 'read',
              method: 'GET',
              path: '/items/{item}',
              expected: 200,
            },
          ],
        },
      ],
    });
    expect(report.pass).toBe(true);
  });
  it('reports missing created ids and never substitutes an unresolved capture', async () => {
    let calls = 0;
    const report = await runJourneys({
      handler: async () => {
        calls++;
        return new Response('{}', { status: 201 });
      },
      routes: [
        { method: 'POST', path: '/items' },
        { method: 'GET', path: '/items/:id' },
      ],
      journeys: [
        {
          persona: 'editor',
          steps: [
            {
              name: 'create',
              method: 'POST',
              path: '/items',
              expected: 201,
              captureId: 'item',
            },
            {
              name: 'read',
              method: 'GET',
              path: '/items/{item}',
              expected: 200,
            },
          ],
        },
      ],
    });
    expect(calls).toBe(1);
    expect(report.results.map((result) => result.failure)).toEqual([
      'missing-created-id',
      'request-failed',
    ]);
    expect(report.pass).toBe(false);
  });
});

describe('route inventory integrity', () => {
  it('fails when route discovery returns no routes', async () => {
    const report = await runJourneys({
      routes: [],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'read', method: 'GET', path: '/typo', expected: 404 },
          ],
        },
      ],
      handler: async () => new Response('{}', { status: 404 }),
    });
    expect(report.pass).toBe(false);
  });
  it('fails unmatched negative steps even when all known routes are reached', async () => {
    const report = await runJourneys({
      routes: [{ method: 'GET', path: '/known' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'known', method: 'GET', path: '/known', expected: 200 },
            { name: 'typo', method: 'GET', path: '/typo', expected: 404 },
          ],
        },
      ],
      handler: async (request) =>
        new Response('{}', {
          status: new URL(request.url).pathname === '/known' ? 200 : 404,
        }),
    });
    expect(report.pass).toBe(false);
    expect(report.results[1]).toMatchObject({
      pass: false,
      failure: 'unmatched-route',
    });
  });
  it('records a useful safe operation message without exposing exception credentials', async () => {
    const report = await runJourneys({
      routes: [{ method: 'GET', path: '/known' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'known', method: 'GET', path: '/known', expected: 200 },
          ],
        },
      ],
      handler: async () => {
        throw new Error('secret=never-record-me');
      },
    });
    expect(report.results[0]).toMatchObject({
      failure: 'request-failed',
      message: 'Sending request failed',
    });
    expect(JSON.stringify(report)).not.toContain('never-record-me');
  });
});
