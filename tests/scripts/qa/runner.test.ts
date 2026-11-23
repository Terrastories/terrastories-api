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
      contract: 'canonical-v2',
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
      expect(
        (
          await runJourneys({
            contract: 'canonical-v2',
            routes,
            journeys,
            handler,
          })
        ).pass
      ).toBe(false);
    }
    expect(
      (
        await runJourneys({
          contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
          contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
        contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
      requestTimeoutMs: 250,
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
      contract: 'canonical-v2',
      requestTimeoutMs: 250,
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
      contract: 'canonical-v2',
      requestTimeoutMs: 250,
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
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
      contract: 'canonical-v2',
      requestTimeoutMs: 250,
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

describe('contract classification and HTTP baseUrl transport', () => {
  it('rejects an unknown contract label on a journey or a step before sending a request', async () => {
    let requests = 0;
    const handler = async () => {
      requests += 1;
      return new Response('{}');
    };
    const routes = [{ method: 'GET', path: '/items' }];
    const step = { name: 'list', method: 'GET', path: '/items', expected: 200 };
    await expect(
      runJourneys({
        contract: 'canonical-v2',
        routes,
        handler,
        journeys: [{ persona: 'viewer', contract: 'legacy', steps: [step] }],
      } as unknown as Parameters<typeof runJourneys>[0])
    ).rejects.toThrow("Invalid contract class on journey 'viewer'");
    await expect(
      runJourneys({
        contract: 'canonical-v2',
        routes,
        handler,
        journeys: [{ persona: 'viewer', steps: [{ ...step, contract: 'v2' }] }],
      } as unknown as Parameters<typeof runJourneys>[0])
    ).rejects.toThrow("Invalid contract class on step 'viewer/list'");
    expect(requests).toBe(0);
  });

  it('requires an explicit contract class and records canonical-v2 on report, results and summary', async () => {
    await expect(
      runJourneys({
        routes: [{ method: 'GET', path: '/items' }],
        journeys: [],
        handler: async () => new Response('{}'),
      } as unknown as Parameters<typeof runJourneys>[0])
    ).rejects.toThrow('Persona runner requires an explicit contract class');

    const report = await runJourneys({
      contract: 'canonical-v2',
      routes: [{ method: 'GET', path: '/items' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'list', method: 'GET', path: '/items', expected: 200 },
          ],
        },
      ],
      handler: async () => new Response('{}'),
    });
    expect(report.contract).toBe('canonical-v2');
    expect(report.results[0]?.contract).toBe('canonical-v2');
    expect(report.summary).toEqual({
      'canonical-v2': { passed: 1, failed: 0 },
      'legacy-v1': { passed: 0, failed: 0 },
    });
  });

  it('labels legacy-v1 on report and results while still failing closed', async () => {
    const report = await runJourneys({
      contract: 'legacy-v1',
      routes: [{ method: 'GET', path: '/items' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'ok', method: 'GET', path: '/items', expected: 200 },
            { name: 'mismatch', method: 'GET', path: '/items', expected: 404 },
          ],
        },
      ],
      handler: async () => new Response('{}', { status: 200 }),
    });
    expect(report.contract).toBe('legacy-v1');
    expect(report.results.map((result) => result.contract)).toEqual([
      'legacy-v1',
      'legacy-v1',
    ]);
    expect(report.summary).toEqual({
      'canonical-v2': { passed: 0, failed: 0 },
      'legacy-v1': { passed: 1, failed: 1 },
    });
    expect(report.pass).toBe(false);
  });

  it('counts per-class pass and fail totals across mixed journeys and steps', async () => {
    const report = await runJourneys({
      contract: 'canonical-v2',
      routes: [{ method: 'GET', path: '/items' }],
      journeys: [
        {
          persona: 'viewer',
          steps: [
            { name: 'v2 pass', method: 'GET', path: '/items', expected: 200 },
            {
              name: 'v1 fail',
              method: 'GET',
              path: '/items',
              expected: 404,
              contract: 'legacy-v1',
            },
          ],
        },
        {
          persona: 'legacy',
          contract: 'legacy-v1',
          steps: [
            { name: 'v1 pass', method: 'GET', path: '/items', expected: 200 },
          ],
        },
      ],
      handler: async () => new Response('{}', { status: 200 }),
    });
    expect(report.summary).toEqual({
      'canonical-v2': { passed: 1, failed: 0 },
      'legacy-v1': { passed: 1, failed: 1 },
    });
    expect(report.pass).toBe(false);
  });

  it('requires a handler or baseUrl and sends real HTTP requests when baseUrl is set', async () => {
    await expect(
      runJourneys({
        contract: 'canonical-v2',
        routes: [{ method: 'GET', path: '/items' }],
        journeys: [],
      })
    ).rejects.toThrow('Persona runner requires a handler or baseUrl');

    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected TCP address');
      const report = await runJourneys({
        contract: 'canonical-v2',
        baseUrl: `http://127.0.0.1:${address.port}`,
        routes: [{ method: 'GET', path: '/ping' }],
        journeys: [
          {
            persona: 'viewer',
            steps: [
              {
                name: 'ping',
                method: 'GET',
                path: '/ping?ok=1',
                expected: 200,
                check: (body) =>
                  (body as { url?: string }).url === '/ping?ok=1',
              },
            ],
          },
        ],
      });
      expect(report.pass).toBe(true);
    } finally {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 15_000);

  it('supports binary response verification via checkBytes and fails closed on mismatch', async () => {
    const routes = [{ method: 'GET', path: '/artifact' }];
    const expected = new Uint8Array([1, 2, 3, 4]);
    const okReport = await runJourneys({
      contract: 'canonical-v2',
      routes,
      journeys: [
        {
          persona: 'admin',
          steps: [
            {
              name: 'verify bytes',
              method: 'GET',
              path: '/artifact',
              expected: 200,
              checkBytes: (bytes) =>
                bytes.byteLength === expected.byteLength &&
                bytes.every((b, idx) => b === expected[idx]),
            },
          ],
        },
      ],
      handler: async () => new Response(expected),
    });
    expect(okReport.pass).toBe(true);

    const failReport = await runJourneys({
      contract: 'canonical-v2',
      routes,
      journeys: [
        {
          persona: 'admin',
          steps: [
            {
              name: 'reject wrong bytes',
              method: 'GET',
              path: '/artifact',
              expected: 200,
              checkBytes: () => false,
            },
          ],
        },
      ],
      handler: async () => new Response(expected),
    });
    expect(failReport.pass).toBe(false);
    expect(failReport.results[0]).toMatchObject({
      pass: false,
      failure: 'body-mismatch',
    });
  });

  it('dispatches journeys with per-journey handler and validates per-journey baseUrl', async () => {
    const routes = [
      { method: 'GET', path: '/main' },
      { method: 'GET', path: '/fresh' },
    ];
    const hits: string[] = [];
    const report = await runJourneys({
      contract: 'canonical-v2',
      routes,
      handler: async (request) => {
        const path = new URL(request.url).pathname;
        hits.push(`main:${path}`);
        return new Response(JSON.stringify({ source: 'main' }), {
          headers: { 'set-cookie': 'sessionId=main-cookie; Path=/' },
        });
      },
      journeys: [
        {
          persona: 'seeded',
          steps: [
            {
              name: 'hit main',
              method: 'GET',
              path: '/main',
              expected: 200,
              check: (body) => (body as { source?: string }).source === 'main',
            },
          ],
        },
        {
          persona: 'isolated',
          handler: async (request) => {
            const path = new URL(request.url).pathname;
            hits.push(`fresh:${path}:${request.headers.get('cookie') ?? ''}`);
            return new Response(JSON.stringify({ source: 'fresh' }), {
              headers: { 'set-cookie': 'sessionId=fresh-cookie; Path=/' },
            });
          },
          steps: [
            {
              name: 'hit fresh first',
              method: 'GET',
              path: '/fresh',
              expected: 200,
              check: (body) => (body as { source?: string }).source === 'fresh',
            },
            {
              name: 'hit fresh with own cookie',
              method: 'GET',
              path: '/fresh',
              expected: 200,
            },
          ],
        },
      ],
    });
    expect(report.pass).toBe(true);
    expect(report.uncovered).toEqual([]);
    expect(hits).toEqual([
      'main:/main',
      'fresh:/fresh:',
      'fresh:/fresh:sessionId=fresh-cookie',
    ]);

    await expect(
      runJourneys({
        contract: 'canonical-v2',
        routes: [{ method: 'GET', path: '/fresh' }],
        handler: async () => new Response('{}'),
        journeys: [
          {
            persona: 'bad_url',
            baseUrl: 'file:///tmp/qa',
            steps: [
              {
                name: 'never runs',
                method: 'GET',
                path: '/fresh',
                expected: 200,
              },
            ],
          },
        ],
      })
    ).rejects.toThrow('Invalid base URL');
  });
});
