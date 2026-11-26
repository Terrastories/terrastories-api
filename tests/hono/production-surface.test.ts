/**
 * Production surface of the Hono V2 app (#146, #137): no dev/test routes, no
 * memory/KV session authority in the production entrypoints, and the deferred
 * routes the registry lists (SPEC-V2 §6.6, §6.7) have no handler.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { count } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { routeTableOf } from '../../scripts/qa/hono-fixture.js';

describe('Hono production surface (#146 / #137)', () => {
  const openDbs: Sqlite.Database[] = [];
  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  function setup() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    // Production-like options: deployed https origin, secure cookies.
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: 'p'.repeat(48),
      publicOrigin: 'https://api.example.test',
      secureCookies: true,
    });
    return { app, db };
  }

  const tableCounts = async (db: ReturnType<typeof drizzle>) => ({
    communities: (await db.select({ n: count() }).from(communitiesSqlite))[0]
      ?.n,
    users: (await db.select({ n: count() }).from(usersSqlite))[0]?.n,
  });

  it('has no /dev path in the route table', () => {
    const { app } = setup();
    const paths = routeTableOf(app).map((route) => route.path);
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.filter((path) => /(^|\/)dev(\/|$)/.test(path))).toEqual([]);
  });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s /dev/* answers 404 and changes no data',
    async (method) => {
      const { app, db } = setup();
      const before = await tableCounts(db);
      for (const path of ['/dev', '/dev/', '/dev/seed', '/dev/anything/else']) {
        const response = await app.request(`http://test${path}`, { method });
        expect(response.status, `${method} ${path}`).toBe(404);
        if (method !== 'HEAD') {
          expect(await response.json()).toEqual({ error: 'Not found' });
        }
        expect(response.headers.get('set-cookie')).toBeNull();
      }
      expect(await tableCounts(db)).toEqual(before);
    }
  );

  it('registers no deferred routes: /v2/community/themes (§6.6) and /v2/media/:id/copy (§6.7)', async () => {
    const { app } = setup();
    const table = routeTableOf(app);
    expect(table.filter((r) => /\/v2\/community\/themes/.test(r.path))).toEqual(
      []
    );
    expect(table.filter((r) => /\/copy$/.test(r.path))).toEqual([]);
    for (const [method, path] of [
      ['GET', '/v2/community/themes'],
      ['POST', '/v2/media/1/copy'],
    ] as const) {
      const response = await app.request(`http://test${path}`, { method });
      // Never a handler answer: unauthenticated callers get 401 or 404.
      expect([401, 404], `${method} ${path}`).toContain(response.status);
    }
  });

  describe('production entrypoints', () => {
    const read = (path: string) => readFileSync(path, 'utf8');
    const entrypoints = ['src/hono-server.ts', 'src/worker.ts'];

    it.each(entrypoints)(
      '%s authenticates sessions through the DB repository, never memory/KV',
      (path) => {
        const source = read(path);
        expect(source).toContain('new HonoFoundationRepository(');
        expect(source).not.toMatch(
          /MemoryStore|MemorySessionStore|memory-store|session-store|@fastify\/session|KVNamespace|\.kv\b/i
        );
      }
    );

    it('wrangler config binds no KV namespace', () => {
      expect(read('wrangler.jsonc')).not.toMatch(/kv_namespaces/);
    });
  });
});
