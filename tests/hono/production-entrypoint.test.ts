/**
 * The real Node production entrypoint (src/hono-server.ts) running as a
 * process over a SQLite file (#146, #137): no /dev surface, no deferred
 * routes, and sessions live only in the database — deleting the row denies a
 * cookie that the same running instance accepted a moment earlier.
 * (The Workers entrypoint is covered by tests/hono/worker.test.ts on workerd.)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { argon2Seed, makeDerivedKey } from './auth-test-utils.js';

let child: ChildProcess | undefined;
let base = '';
let dbPath = '';
const key = makeDerivedKey();

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hono-entrypoint-'));
  dbPath = join(dir, 'app.db');
  await mkdir(join(dir, 'uploads'));
  const sqlite = new Sqlite(dbPath);
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const [community] = await db
    .insert(communitiesSqlite)
    .values({ name: 'Entry', slug: 'entry', isActive: true })
    .returning();
  await db.insert(usersSqlite).values({
    ...(await argon2Seed(key)),
    passwordHash: 'legacy-hash',
    firstName: 'Entry',
    lastName: 'Editor',
    isActive: true,
    role: 'editor',
    email: 'editor@entry.example.test',
    emailNormalized: normalizeSearchText('editor@entry.example.test'),
    username: 'entry_editor',
    usernameNormalized: 'entry_editor',
    communityId: community!.id,
  });
  sqlite.close();

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'src/hono-server.ts'],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'development',
        DATABASE_URL: dbPath,
        HONO_PORT: String(port),
        HONO_STORAGE_ROOT: join(dir, 'uploads'),
        AUTH_SERVER_SECRET: 'e'.repeat(48),
      },
      stdio: 'ignore',
    }
  );
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('hono-server did not start');
}, 60_000);

afterAll(() => {
  child?.kill('SIGTERM');
});

it('serves no /dev routes and no deferred routes from the real process', async () => {
  for (const method of ['GET', 'HEAD', 'POST']) {
    for (const path of ['/dev/seed', '/dev/']) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  }
  const login = await fetch(`${base}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'entry_editor', derivedKey: key }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  for (const [method, path] of [
    ['GET', '/v2/community/themes'],
    ['POST', '/v2/media/1/copy'],
  ] as const) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    expect(response.status, `${method} ${path}`).toBe(404);
  }
});

it('authorizes sessions from the database only, on the running instance', async () => {
  const login = await fetch(`${base}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'entry_editor', derivedKey: key }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const me = () => fetch(`${base}/v2/auth/me`, { headers: { cookie } });
  expect((await me()).status).toBe(200);
  expect((await me()).status).toBe(200);

  const sqlite = new Sqlite(dbPath);
  try {
    expect(
      sqlite.prepare('DELETE FROM sessions').run().changes
    ).toBeGreaterThan(0);
  } finally {
    sqlite.close();
  }
  const denied = await me();
  expect(denied.status).toBe(401);
  expect(JSON.stringify(await denied.json())).not.toContain('entry.example');
});
