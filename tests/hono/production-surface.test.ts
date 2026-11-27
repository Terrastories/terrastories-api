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
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { routeTableOf } from '../../scripts/qa/hono-fixture.js';
import { argon2Seed, makeDerivedKey } from './auth-test-utils.js';

describe('Hono production surface (#146 / #137)', () => {
  const openDbs: Sqlite.Database[] = [];
  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup() {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const [community] = await db
      .insert(communitiesSqlite)
      .values({ name: 'Surface', slug: 'surface', isActive: true })
      .returning();
    const key = makeDerivedKey();
    await db.insert(usersSqlite).values({
      ...(await argon2Seed(key)),
      passwordHash: 'legacy-hash',
      firstName: 'Surface',
      lastName: 'Editor',
      isActive: true,
      role: 'editor',
      email: 'editor@surface.example.test',
      emailNormalized: normalizeSearchText('editor@surface.example.test'),
      username: 'surface_editor',
      usernameNormalized: 'surface_editor',
      communityId: community!.id,
    });
    sqlite.exec(
      "INSERT INTO files(id,filename,original_name,path,url,mime_type,size,community_id,uploaded_by,created_at,updated_at) VALUES('00000000-0000-4000-8000-0000000000aa','f','f','communities/1/f','https://ignored.invalid','image/png',1,1,1,0,0)"
    );
    // Production-like options: deployed https origin, secure cookies.
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: 'p'.repeat(48),
      publicOrigin: 'https://api.example.test',
      secureCookies: true,
      isWorkers: true,
    });
    const login = async () => {
      const response = await app.request(
        'https://api.example.test/v2/auth/login',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': '203.0.113.7',
          },
          body: JSON.stringify({
            identifier: 'surface_editor',
            derivedKey: key,
          }),
        }
      );
      expect(response.status).toBe(200);
      return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };
    return { app, db, login };
  }

  const tableCounts = async (db: ReturnType<typeof drizzle>) => ({
    communities: (await db.select({ n: count() }).from(communitiesSqlite))[0]
      ?.n,
    users: (await db.select({ n: count() }).from(usersSqlite))[0]?.n,
  });

  // routeTableOf skips ALL registrations; this includes them.
  const registeredPaths = (app: ReturnType<typeof createHonoApp>) =>
    app.routes.map((route) => `${route.method} ${route.path}`);

  it('has no /dev path in the route table (any method, ALL included)', async () => {
    const { app } = await setup();
    expect(routeTableOf(app).length).toBeGreaterThan(10);
    expect(
      registeredPaths(app).filter((entry) => /\s\/dev(\/|\*|$)/.test(entry))
    ).toEqual([]);
  });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s /dev/* answers 404 and changes no data',
    async (method) => {
      const { app, db } = await setup();
      const before = await tableCounts(db);
      for (const path of ['/dev', '/dev/', '/dev/seed', '/dev/anything/else']) {
        const response = await app.request(`https://api.example.test${path}`, {
          method,
        });
        expect(response.status, `${method} ${path}`).toBe(404);
        if (method !== 'HEAD') {
          expect(await response.json()).toEqual({ error: 'Not found' });
        }
        expect(response.headers.get('set-cookie')).toBeNull();
      }
      expect(await tableCounts(db)).toEqual(before);
    }
  );

  it('deferred routes /v2/community/themes (§6.6) and /v2/media/:id/copy (§6.7) have no handler, even for a signed-in editor', async () => {
    const { app, login, db } = await setup();
    // No registration under any method, ALL included.
    expect(
      registeredPaths(app).filter((entry) =>
        /\/v2\/community\/themes|\/copy(\/|$)/.test(entry)
      )
    ).toEqual([]);
    const cookie = await login();
    const before = await tableCounts(db);
    for (const [method, path] of [
      ['GET', '/v2/community/themes'],
      ['PUT', '/v2/community/themes'],
      ['POST', '/v2/media/00000000-0000-4000-8000-0000000000aa/copy'],
    ] as const) {
      const response = await app.request(`https://api.example.test${path}`, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(response.status, `${method} ${path}`).toBe(404);
      // The router's own not-found body, even though the file exists.
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
    expect(await tableCounts(db)).toEqual(before);
  });

  describe('production entrypoints (source guard)', () => {
    const read = (path: string) => readFileSync(path, 'utf8');
    it.each(['src/hono-server.ts', 'src/worker.ts'])(
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
