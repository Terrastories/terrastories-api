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
      // Built at runtime so secret scanners do not flag this fake credential.
      ['http://', 'user', ':', 'pass', '@host/'].join(''),
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

describe('session replay and request lifecycle', () => {
  const routes = [
    { method: 'POST', path: '/login' },
    { method: 'POST', path: '/logout' },
    { method: 'GET', path: '/me' },
  ];
  it('replays the old signed cookie after logout clears the jar and detects a revoked-session leak', async () => {
    const journeys = [
      {
        persona: 'viewer',
        steps: [
          { name: 'login', method: 'POST', path: '/login', expected: 200 },
          {
            name: 'logout',
            method: 'POST',
            path: '/logout',
            expected: 200,
            saveCookieAs: 'old',
          },
          {
            name: 'replay revoked session',
            method: 'GET',
            path: '/me',
            expected: 401,
            useSavedCookie: 'old',
          },
        ],
      },
    ];
    for (const revoked of [true, false]) {
      const sent: string[] = [];
      const report = await runJourneys({
        routes,
        journeys,
        handler: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/login')
            return new Response('{}', {
              headers: {
                'set-cookie': 'sessionId=valid-signed-cookie; Path=/',
              },
            });
          sent.push(request.headers.get('cookie') ?? '');
          if (path === '/logout')
            return new Response('{}', {
              headers: { 'set-cookie': 'sessionId=; Max-Age=0; Path=/' },
            });
          return new Response('{}', { status: revoked ? 401 : 200 });
        },
      });
      expect(sent).toEqual([
        'sessionId=valid-signed-cookie',
        'sessionId=valid-signed-cookie',
      ]);
      expect(report.pass).toBe(revoked);
    }
  });
  it('clears the tracked session cookie when Set-Cookie empties it', async () => {
    const sent: (string | null)[] = [];
    const report = await runJourneys({
      sessionCookieName: 'ts_session',
      routes: [
        { method: 'POST', path: '/login' },
        { method: 'POST', path: '/logout' },
        { method: 'GET', path: '/me' },
      ],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'login', method: 'POST', path: '/login', expected: 200 },
            { name: 'logout', method: 'POST', path: '/logout', expected: 204 },
            {
              name: 'me after logout',
              method: 'GET',
              path: '/me',
              expected: 401,
            },
          ],
        },
      ],
      handler: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/login')
          return new Response('{}', {
            headers: { 'set-cookie': 'ts_session=opaque-token; Path=/' },
          });
        sent.push(request.headers.get('cookie'));
        if (path === '/logout')
          return new Response(null, {
            status: 204,
            headers: { 'set-cookie': 'ts_session=; Max-Age=0; Path=/' },
          });
        return new Response('{}', { status: 401 });
      },
    });
    expect(sent).toEqual(['ts_session=opaque-token', null]);
    expect(report.pass).toBe(true);
  });
  it('tracks a non-default session cookie name across journey steps', async () => {
    const sent: string[] = [];
    const report = await runJourneys({
      sessionCookieName: 'ts_session',
      routes: [
        { method: 'POST', path: '/login' },
        { method: 'GET', path: '/me' },
      ],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'login', method: 'POST', path: '/login', expected: 200 },
            { name: 'me', method: 'GET', path: '/me', expected: 200 },
          ],
        },
      ],
      handler: async (request) => {
        if (new URL(request.url).pathname === '/login')
          return new Response('{}', {
            headers: { 'set-cookie': 'ts_session=opaque-token; Path=/' },
          });
        sent.push(request.headers.get('cookie') ?? '');
        return new Response('{}');
      },
    });
    expect(sent).toEqual(['ts_session=opaque-token']);
    expect(report.pass).toBe(true);
  });
  it('rejects replay without a saved cookie before sending a request', async () => {
    let calls = 0;
    const report = await runJourneys({
      routes: [{ method: 'GET', path: '/me' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            {
              name: 'replay',
              method: 'GET',
              path: '/me',
              expected: 401,
              useSavedCookie: 'missing',
            },
          ],
        },
      ],
      handler: async () => {
        calls++;
        return new Response('{}', { status: 401 });
      },
    });
    expect(calls).toBe(0);
    expect(report.pass).toBe(false);
  });
  it('times out a hanging handler and aborts its Request signal', async () => {
    let signal: AbortSignal | undefined;
    const report = await runJourneys({
      requestTimeoutMs: 20,
      routes: [{ method: 'GET', path: '/slow' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'slow', method: 'GET', path: '/slow', expected: 200 },
          ],
        },
      ],
      handler: async (request) => {
        signal = request.signal;
        return new Promise<Response>(() => {});
      },
    });
    expect(signal?.aborted).toBe(true);
    expect(report.results[0]).toMatchObject({
      pass: false,
      failure: 'request-timeout',
      message: 'Sending request exceeded request timeout',
    });
  });
  it('times out and cancels a hanging JSON response body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const report = await runJourneys({
      requestTimeoutMs: 20,
      routes: [{ method: 'GET', path: '/slow' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            {
              name: 'slow JSON',
              method: 'GET',
              path: '/slow',
              expected: 200,
              check: () => true,
            },
          ],
        },
      ],
      handler: async () => new Response(stream),
    });
    expect(cancelled).toBe(true);
    expect(report.results[0]).toMatchObject({
      pass: false,
      failure: 'request-timeout',
      message: 'Reading response JSON exceeded request timeout',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stream.locked).toBe(false);
  });
  it('cancels late handler responses after timeout', async () => {
    let finish: (response: Response) => void = () => {};
    let cancelled = false;
    const report = await runJourneys({
      requestTimeoutMs: 20,
      routes: [{ method: 'GET', path: '/slow' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'slow', method: 'GET', path: '/slow', expected: 200 },
          ],
        },
      ],
      handler: async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    });
    finish(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    expect(report.pass).toBe(false);
  });
  it('cancels status-only/media bodies instead of leaving them unread', async () => {
    let cancelled = false;
    const report = await runJourneys({
      routes: [{ method: 'GET', path: '/media' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'media', method: 'GET', path: '/media', expected: 200 },
          ],
        },
      ],
      handler: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            cancel() {
              cancelled = true;
            },
          })
        ),
    });
    expect(cancelled).toBe(true);
    expect(report.pass).toBe(true);
  });
  it('consumes JSON before a throwing assertion and keeps thrown secrets out of the report', async () => {
    const response = new Response('{"ok":true}');
    const report = await runJourneys({
      routes: [{ method: 'GET', path: '/json' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            {
              name: 'JSON',
              method: 'GET',
              path: '/json',
              expected: 200,
              check: () => {
                throw new Error('credential-secret');
              },
            },
          ],
        },
      ],
      handler: async () => response,
    });
    expect(response.bodyUsed).toBe(true);
    expect(response.body?.locked).toBe(false);
    expect(report.pass).toBe(false);
    expect(JSON.stringify(report)).not.toContain('credential-secret');
  });
});

describe('response cancellation deadlines', () => {
  it('fails within the deadline when a status-only body cancellation never settles', async () => {
    let cancelled = false;
    const report = await runJourneys({
      requestTimeoutMs: 20,
      routes: [{ method: 'GET', path: '/media' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'media', method: 'GET', path: '/media', expected: 200 },
          ],
        },
      ],
      handler: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
              return new Promise<void>(() => {});
            },
          })
        ),
    });
    expect(cancelled).toBe(true);
    expect(report.results[0]).toMatchObject({
      pass: false,
      failure: 'request-timeout',
      message: 'Closing response body exceeded request timeout',
    });
  });
});
