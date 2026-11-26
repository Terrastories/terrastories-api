import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';

const storage = { read: async () => null };

describe('readiness', () => {
  it('reports a closed SQLite database as not ready while remaining live', async () => {
    const sqlite = new Sqlite(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage,
    });
    expect((await app.request('/ready')).status).toBe(200);
    sqlite.close();
    expect((await app.request('/ready')).status).toBe(503);
    expect((await app.request('/health')).status).toBe(200);
  });

  it('reports an unreachable PostgreSQL client as not ready while remaining live', async () => {
    const failing = {
      select: () => ({
        from: () => ({
          limit: () => Promise.reject(new Error('connection refused')),
        }),
      }),
    };
    const repository = new HonoFoundationRepository(
      failing as unknown as ConstructorParameters<
        typeof HonoFoundationRepository
      >[0]
    );
    const app = createHonoApp({ repository, storage });
    const ready = await app.request('/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ error: 'Service unavailable' });
    expect((await app.request('/health')).status).toBe(200);
  });
});

describe('Node server process', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

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
  const start = (env: NodeJS.ProcessEnv) => {
    const child = spawn('node_modules/.bin/tsx', ['src/hono-server.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  const migratedDb = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsapi-runtime-'));
    const file = path.join(dir, 'app.db');
    const sqlite = new Sqlite(file);
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    sqlite.close();
    return file;
  };

  it('drains an in-flight request on SIGTERM, refuses new connections, exits 0', async () => {
    const port = await freePort();
    const { child, exited } = start(baseEnv(migratedDb(), port));
    await waitReady(port);

    // Hold a request open: headers sent, body incomplete.
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.on('data', (d) => (response += d));
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
    expect(response).toMatch(/^HTTP\/1\.1 \d{3}/);
    expect(await exited).toBe(0);
  }, 120_000);

  it('exits non-zero when required production config is missing', async () => {
    const port = await freePort();
    const env = { ...baseEnv(migratedDb(), port) } as NodeJS.ProcessEnv;
    env.NODE_ENV = 'production';
    delete env.AUTH_SERVER_SECRET;
    delete env.HONO_PUBLIC_ORIGIN;
    delete env.BOOTSTRAP_SECRET;
    const { exited, output } = start(env);
    expect(await exited).not.toBe(0);
    expect(output()).toMatch(/AUTH_SERVER_SECRET|HONO_PUBLIC_ORIGIN/);
  }, 120_000);

  it('exits non-zero with a clear message when the database is not migrated', async () => {
    const port = await freePort();
    const dir = mkdtempSync(path.join(tmpdir(), 'tsapi-runtime-'));
    const { exited, output } = start(baseEnv(path.join(dir, 'empty.db'), port));
    expect(await exited).toBe(1);
    expect(output()).toContain('not migrated');
  }, 120_000);
});
