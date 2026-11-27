import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { serve } from '@hono/node-server';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import { allMigrationsApplied } from '../../src/db/migration-status.js';
import {
  createShutdown,
  trackedFetch,
  trackInFlight,
} from '../../src/node-shutdown.js';
import { withDeadline } from '../../src/shared/deadline.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';

const storage = { read: async () => null };

const migratedDb = () => {
  const sqlite = new Sqlite(':memory:');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  return { sqlite, db };
};

/** Live DB for middleware queries; the /ready probe is replaced by `probe`. */
const appWithProbe = (
  probe: () => Promise<void>,
  readinessTimeoutMs?: number
) => {
  const { db } = migratedDb();
  const repository = new HonoFoundationRepository(db);
  const readiness = vi.fn(probe);
  repository.readiness = readiness;
  return {
    readiness,
    app: createHonoApp({ repository, storage, readinessTimeoutMs }),
  };
};

describe('readiness', () => {
  it('is ready when the probe succeeds', async () => {
    const { app, readiness } = appWithProbe(async () => undefined);
    expect((await app.request('/ready')).status).toBe(200);
    expect(readiness).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when the SQLite probe hits a closed database, health stays 200', async () => {
    const live = migratedDb();
    const closed = migratedDb();
    closed.sqlite.close();
    const closedRepo = new HonoFoundationRepository(closed.db);
    const probe = vi.fn(() => closedRepo.readiness());
    const repository = new HonoFoundationRepository(live.db);
    repository.readiness = probe;
    const app = createHonoApp({ repository, storage });
    // Middleware queries succeed on the live database; only the probe fails.
    const res = await app.request('/ready');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect((await app.request('/health')).status).toBe(200);
  });

  it('returns 503 when the PostgreSQL client rejects at the probe', async () => {
    const failing = {
      select: () => ({
        from: () => ({
          limit: () => Promise.reject(new Error('connection refused')),
        }),
      }),
    };
    const pgRepo = new HonoFoundationRepository(
      failing as unknown as ConstructorParameters<
        typeof HonoFoundationRepository
      >[0]
    );
    const { app, readiness } = appWithProbe(() => pgRepo.readiness());
    const res = await app.request('/ready');
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service unavailable' });
    expect((await app.request('/health')).status).toBe(200);
  });

  it('returns 503 within the deadline when the probe never settles', async () => {
    const { app, readiness } = appWithProbe(() => new Promise(() => {}), 100);
    const started = Date.now();
    const res = await app.request('/ready');
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await app.request('/health')).status).toBe(200);
  });
});

describe('readiness: earlier middleware', () => {
  it.each(['applyDueWithdrawals', 'activateDueErasures'] as const)(
    'returns 503 within the deadline when %s stalls',
    async (method) => {
      const spy = vi
        .spyOn(CommunitySovereigntyRepository.prototype, method)
        .mockImplementation(() => new Promise(() => {}));
      try {
        const { app } = appWithProbe(async () => undefined, 100);
        const started = Date.now();
        const res = await app.request('/ready');
        expect(spy).toHaveBeenCalled();
        expect(res.status).toBe(503);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('keeps abandoned sovereignty work tracked so shutdown waits before closeDb', async () => {
    let finish: () => void = () => undefined;
    const spy = vi
      .spyOn(CommunitySovereigntyRepository.prototype, 'applyDueWithdrawals')
      .mockImplementation(
        () => new Promise<boolean>((resolve) => (finish = () => resolve(true)))
      );
    try {
      const { db } = migratedDb();
      const inFlight = new Set<Promise<void>>();
      const app = createHonoApp({
        repository: new HonoFoundationRepository(db),
        storage,
        readinessTimeoutMs: 50,
        trackWork: (work) => void trackInFlight(inFlight, work),
      });
      expect((await app.request('/ready')).status).toBe(503);
      expect(inFlight.size).toBe(1); // deadline fired, work still tracked
      const events: string[] = [];
      let closeCb: () => void = () => undefined;
      createShutdown({
        server: { close: (cb) => void (closeCb = cb) },
        inFlight,
        closeDb: async () => void events.push('closeDb'),
        stopTimers: () => undefined,
        drainMs: 5000,
        exit: (code) => void events.push(`exit ${code}`),
        log: () => undefined,
      })();
      closeCb();
      await new Promise((r) => setTimeout(r, 100));
      expect(events).toEqual([]);
      finish();
      await vi.waitFor(() => expect(events).toEqual(['closeDb', 'exit 0']));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('allMigrationsApplied', () => {
  const sqlitePlan = {
    dialect: 'sqlite' as const,
    migrationsFolder: 'src/db/migrations',
  };
  const journal = (
    JSON.parse(
      readFileSync('src/db/migrations/meta/_journal.json', 'utf8')
    ) as { entries: { when: number }[] }
  ).entries.map((e) => e.when);
  const pgPlan = {
    dialect: 'postgresql' as const,
    migrationsFolder: 'src/db/migrations',
  };
  const pgWith = (rows: { created_at: string }[] | Error) =>
    ({
      execute: vi.fn(async () => {
        if (rows instanceof Error) throw rows;
        return rows;
      }),
    }) as never;

  it('accepts a fully migrated SQLite database', async () => {
    expect(await allMigrationsApplied(migratedDb().db, sqlitePlan)).toBe(true);
  });

  it('rejects SQLite when a middle entry is missing even if a newer row exists', async () => {
    const { sqlite, db } = migratedDb();
    sqlite
      .prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?')
      .run(journal[5]);
    sqlite
      .prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
      )
      .run('bogus', journal[journal.length - 1] + 1000);
    expect(await allMigrationsApplied(db, sqlitePlan)).toBe(false);
  });

  it('PostgreSQL: accepts when every entry is recorded (bigint strings)', async () => {
    const db = pgWith(journal.map((w) => ({ created_at: String(w) })));
    expect(await allMigrationsApplied(db, pgPlan)).toBe(true);
  });

  it('PostgreSQL: rejects a missing entry and a missing journal table', async () => {
    const partial = pgWith(
      journal.slice(0, -1).map((w) => ({ created_at: String(w) }))
    );
    expect(await allMigrationsApplied(partial, pgPlan)).toBe(false);
    await expect(
      allMigrationsApplied(pgWith(new Error('relation does not exist')), pgPlan)
    ).rejects.toThrow();
  });
});

describe('tracked fetch on a real listener', () => {
  it('keeps the DB open until a handler that outlived its socket settles', async () => {
    const events: string[] = [];
    const inFlight = new Set<Promise<void>>();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => undefined;
    const handlerEntered = new Promise<void>((resolve) => (entered = resolve));
    const server = serve({
      fetch: trackedFetch(inFlight, async () => {
        entered();
        await gate; // stands in for a DB or storage operation
        events.push('handler done');
        return new Response('ok');
      }),
      hostname: '127.0.0.1',
      port: 0,
    });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as net.AddressInfo;
    const exitCodes: number[] = [];
    const shutdown = createShutdown({
      server,
      inFlight,
      closeDb: async () => void events.push('closeDb'),
      stopTimers: () => undefined,
      drainMs: 5000,
      exit: (code) => void exitCodes.push(code),
      log: () => undefined,
    });
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => undefined);
    await new Promise<void>((r) => client.on('connect', r));
    client.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await handlerEntered; // handler provably running before shutdown
    shutdown();
    client.destroy(); // socket gone while the handler is still awaiting
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([]);
    release();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
    expect(events).toEqual(['handler done', 'closeDb']);
  });
});

describe('withDeadline', () => {
  it('rejects a promise that never settles and passes through the rest', async () => {
    await expect(withDeadline(new Promise(() => {}), 50)).rejects.toThrow(
      'deadline exceeded'
    );
    await expect(withDeadline(Promise.resolve(7), 50)).resolves.toBe(7);
  });
});

describe('createShutdown', () => {
  const setup = () => {
    const events: string[] = [];
    const inFlight = new Set<Promise<void>>();
    let closeCb: () => void = () => undefined;
    const shutdown = createShutdown({
      server: { close: (cb) => void (closeCb = cb) },
      inFlight,
      closeDb: async () => void events.push('closeDb'),
      stopTimers: () => void events.push('stopTimers'),
      drainMs: 200,
      exit: (code) => void events.push(`exit ${code}`),
      log: () => undefined,
    });
    return { events, inFlight, shutdown, closeServer: () => closeCb() };
  };

  it('waits for a handler that outlives its closed socket before closeDb', async () => {
    const { events, inFlight, shutdown, closeServer } = setup();
    let finish: () => void = () => undefined;
    trackInFlight(
      inFlight,
      new Promise<void>((resolve) => (finish = resolve)).then(() => {
        events.push('handler done');
      })
    );
    shutdown();
    closeServer(); // socket gone, handler still running
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['stopTimers']);
    finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['stopTimers', 'handler done', 'closeDb', 'exit 0']);
  });

  it('exits 1 without closing the DB when a handler never finishes', async () => {
    const { events, inFlight, shutdown, closeServer } = setup();
    trackInFlight(inFlight, new Promise<void>(() => {}));
    shutdown();
    closeServer();
    await new Promise((r) => setTimeout(r, 400));
    expect(events).toEqual(['stopTimers', 'exit 1']);
  });
});

describe('Node server process', () => {
  const children: ChildProcess[] = [];
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const dir of tmpDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const makeTmpDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsapi-runtime-'));
    tmpDirs.push(dir);
    return dir;
  };

  const baseEnv = (dbFile: string, port: number) => {
    mkdirSync(path.join(path.dirname(dbFile), 'uploads'), { recursive: true });
    return {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: dbFile,
      HONO_PORT: String(port),
      HONO_HOST: '127.0.0.1',
      HONO_STORAGE_ROOT: path.join(path.dirname(dbFile), 'uploads'),
    };
  };
  const start = (env: NodeJS.ProcessEnv, preload: string[] = []) => {
    const child = spawn(
      'node_modules/.bin/tsx',
      [...preload, 'src/hono-server.ts'],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    children.push(child);
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    return { child, exited, output: () => output };
  };
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => resolve(port));
      });
    });
  const waitReady = async (port: number) => {
    for (let i = 0; i < 150; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ready`);
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not become ready');
  };
  const migratedDbFile = () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'app.db');
    const sqlite = new Sqlite(file);
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    sqlite.close();
    return file;
  };

  it('drains an in-flight request on SIGTERM, refuses new connections, exits 0', async () => {
    const port = await freePort();
    const { child, exited, output } = start(baseEnv(migratedDbFile(), port));
    await waitReady(port);

    // Hold a request open: headers sent, body incomplete.
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    let outputAtResponse = '';
    socket.on('data', (d) => {
      if (!response) outputAtResponse = output();
      response += d;
    });
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    socket.write(
      'POST /v2/auth/prelogin HTTP/1.1\r\nHost: x\r\n' +
        'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{'
    );
    await new Promise((r) => setTimeout(r, 300));

    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await expect(
      new Promise((resolve, reject) => {
        const probe = net.connect(port, '127.0.0.1');
        probe.on('connect', () => {
          probe.destroy();
          resolve('connected');
        });
        probe.on('error', reject);
      })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(child.exitCode).toBeNull();

    socket.write('}');
    await new Promise((r) => socket.on('close', r));
    // The handler entered before SIGTERM (headers parsed, body pending) and
    // completes normally: a 503 here would mean the DB closed under it.
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response).toContain('{"error":"Invalid request"}');
    // Cleanup ran only after the response was delivered.
    expect(outputAtResponse).not.toContain('database closed');
    expect(await exited).toBe(0);
    expect(output()).toContain('shutdown: database closed');
  }, 120_000);

  it('production entrypoint tracks requests: DB closes only after a handler that outlived its socket', async () => {
    const port = await freePort();
    const dbFile = migratedDbFile();
    const armFile = path.join(path.dirname(dbFile), 'arm-slow');
    const { child, exited, output } = start(
      { ...baseEnv(dbFile, port), SLOW_ARM_FILE: armFile },
      ['--import', './tests/hono/fixtures/slow-sovereignty-preload.ts']
    );
    await waitReady(port);
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((r) => socket.on('connect', r));
    writeFileSync(armFile, '1');
    socket.write('GET /x HTTP/1.1\r\nHost: x\r\n\r\n');
    await vi.waitFor(() => expect(output()).toContain('slow handler entered'), {
      timeout: 15_000,
    });
    child.kill('SIGTERM');
    socket.destroy(); // socket gone, handler still running
    expect(await exited).toBe(0);
    const out = output();
    expect(out).toContain('slow handler done');
    expect(out.indexOf('slow handler done')).toBeLessThan(
      out.indexOf('shutdown: database closed')
    );
  }, 120_000);

  it('force-exits 1 after the drain deadline when a request never finishes', async () => {
    const port = await freePort();
    const { child, exited, output } = start({
      ...baseEnv(migratedDbFile(), port),
      SHUTDOWN_DRAIN_TIMEOUT_MS: '1500',
    });
    await waitReady(port);
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    // Body never completes, so the request stays in flight.
    socket.write(
      'POST /v2/auth/prelogin HTTP/1.1\r\nHost: x\r\n' +
        'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{'
    );
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    child.kill('SIGTERM');
    expect(await exited).toBe(1);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    expect(elapsed).toBeLessThan(5000);
    expect(output()).toContain('drain deadline exceeded');
    expect(output()).not.toContain('database closed');
    socket.destroy();
  }, 120_000);

  it('exits non-zero when required production config is missing', async () => {
    const port = await freePort();
    const env = { ...baseEnv(migratedDbFile(), port) } as NodeJS.ProcessEnv;
    env.NODE_ENV = 'production';
    delete env.AUTH_SERVER_SECRET;
    delete env.HONO_PUBLIC_ORIGIN;
    delete env.BOOTSTRAP_SECRET;
    const { exited, output } = start(env);
    expect(await exited).not.toBe(0);
    expect(output()).toMatch(/AUTH_SERVER_SECRET|HONO_PUBLIC_ORIGIN/);
  }, 120_000);

  it('refuses a partially migrated database (last migration not applied)', async () => {
    const port = await freePort();
    const file = migratedDbFile();
    const sqlite = new Sqlite(file);
    sqlite
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)'
      )
      .run();
    sqlite.close();
    const { exited, output } = start(baseEnv(file, port));
    expect(await exited).toBe(1);
    expect(output()).toContain('not migrated');
  }, 120_000);

  it('exits 1 within the deadline when PostgreSQL accepts connections but never answers', async () => {
    const port = await freePort();
    const sockets: net.Socket[] = [];
    const silent = net.createServer((sock) => sockets.push(sock));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const pgPort = (silent.address() as net.AddressInfo).port;
    try {
      const { exited, output } = start({
        ...baseEnv(migratedDbFile(), port),
        DATABASE_URL: `postgresql://u:p@127.0.0.1:${pgPort}/db`,
        DATABASE_SSL: 'disable',
        READINESS_TIMEOUT_MS: '500',
      });
      expect(await exited).toBe(1);
      expect(output()).toContain('not migrated');
      expect(sockets.length).toBeGreaterThan(0); // the probe was attempted
    } finally {
      for (const sock of sockets) sock.destroy();
      silent.close();
    }
  }, 120_000);

  it('exits non-zero with a clear message when the database is not migrated', async () => {
    const port = await freePort();
    const dir = makeTmpDir();
    const { exited, output } = start(baseEnv(path.join(dir, 'empty.db'), port));
    expect(await exited).toBe(1);
    expect(output()).toContain('not migrated');
  }, 120_000);
});
