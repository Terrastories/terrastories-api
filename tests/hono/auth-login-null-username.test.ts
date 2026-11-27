/**
 * Login for imported accounts that carry no username (#137 L8, #146):
 * Fastify-era users migrate with a null username and sign in by email. An
 * email shared across communities is ambiguous and needs the community slug;
 * every denial is one identical 401 and leaves no session row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { argon2Seed, makeDerivedKey } from './auth-test-utils.js';

describe('POST /v2/auth/login for imported null-username accounts', () => {
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
    const [alpha] = await db
      .insert(communitiesSqlite)
      .values({ name: 'Null Alpha', slug: 'null-alpha', isActive: true })
      .returning();
    const [beta] = await db
      .insert(communitiesSqlite)
      .values({ name: 'Null Beta', slug: 'null-beta', isActive: true })
      .returning();
    const key = makeDerivedKey();
    const seed = await argon2Seed(key);
    const soloEmail = 'solo@null.example.test';
    const sharedEmail = 'shared@null.example.test';
    const row = (email: string, communityId: number) => ({
      ...seed,
      passwordHash: 'imported-legacy-hash',
      firstName: 'Imported',
      lastName: 'Account',
      isActive: true as const,
      role: 'member' as const,
      email,
      emailNormalized: normalizeSearchText(email),
      username: null,
      usernameNormalized: null,
      communityId,
    });
    // Several null usernames must coexist (uniqueness covers non-null only).
    await db
      .insert(usersSqlite)
      .values([
        row(soloEmail, alpha.id),
        row(sharedEmail, alpha.id),
        row(sharedEmail, beta.id),
      ]);
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: makeDerivedKey(),
      secureCookies: false,
      trustProxy: true,
    });
    const postLogin = (body: unknown) =>
      app.request('http://test/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const sessions = () => db.select().from(sessionsSqlite);
    return {
      app,
      db,
      alpha,
      beta,
      key,
      soloEmail,
      sharedEmail,
      postLogin,
      sessions,
    };
  }

  it('logs in by email and exposes a null username', async () => {
    const { postLogin, key, soloEmail, alpha, sessions } = await setup();
    const response = await postLogin({
      identifier: soloEmail,
      derivedKey: key,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { email: string; username: unknown; communityId: number };
    };
    expect(body.user.email).toBe(soloEmail);
    expect(body.user.username).toBeNull();
    expect(body.user.communityId).toBe(alpha.id);
    expect(await sessions()).toHaveLength(1);
  });

  it('never resolves a null username from a placeholder identifier', async () => {
    const { postLogin, key, sessions } = await setup();
    for (const identifier of ['null', 'undefined', 'None', ' ']) {
      const response = await postLogin({ identifier, derivedKey: key });
      expect(response.status, identifier).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid credentials' });
    }
    expect(await sessions()).toHaveLength(0);
  });

  it('answers every denial with one identical contract and no session', async () => {
    const { postLogin, key, sharedEmail, soloEmail, sessions } = await setup();
    const denials = await Promise.all(
      [
        // unknown account
        { identifier: 'nobody@null.example.test', derivedKey: key },
        // email shared across communities, no slug
        { identifier: sharedEmail, derivedKey: key },
        // wrong password for a real null-username account
        { identifier: soloEmail, derivedKey: makeDerivedKey() },
        // slug of a community that does not hold the account
        {
          identifier: soloEmail,
          derivedKey: key,
          communitySlug: 'null-beta',
        },
      ].map(async (body) => {
        const response = await postLogin(body);
        return {
          status: response.status,
          type: response.headers.get('content-type'),
          cookie: response.headers.get('set-cookie'),
          body: await response.json(),
        };
      })
    );
    for (const denial of denials) {
      expect(denial).toEqual({
        status: 401,
        type: denials[0]?.type,
        cookie: null,
        body: { error: 'Invalid credentials' },
      });
    }
    expect(await sessions()).toHaveLength(0);
  });

  it('resolves the shared email only with the matching community slug', async () => {
    const { postLogin, key, sharedEmail, alpha, beta, sessions, db } =
      await setup();
    for (const [slug, community] of [
      ['null-alpha', alpha],
      ['null-beta', beta],
    ] as const) {
      const response = await postLogin({
        identifier: sharedEmail,
        derivedKey: key,
        communitySlug: slug,
      });
      expect(response.status, slug).toBe(200);
      const body = (await response.json()) as {
        user: { communityId: number; username: unknown };
      };
      expect(body.user.communityId).toBe(community.id);
      expect(body.user.username).toBeNull();
    }
    expect(await sessions()).toHaveLength(2);
    await db
      .insert(communitiesSqlite)
      .values({ name: 'Null Gamma', slug: 'null-gamma', isActive: true });
    const wrong = await postLogin({
      identifier: sharedEmail,
      derivedKey: key,
      communitySlug: 'null-gamma',
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Invalid credentials' });
    expect(await sessions()).toHaveLength(2);
  });

  it('keeps a session in the database: deleting the row ends it on the same warmed instance', async () => {
    const { db, app, postLogin, key, soloEmail } = await setup();
    const login = await postLogin({ identifier: soloEmail, derivedKey: key });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const me = (instance: typeof app) =>
      instance.request('http://test/v2/auth/me', { headers: { cookie } });
    // Warm the instance: it has accepted this cookie more than once.
    expect((await me(app)).status).toBe(200);
    expect((await me(app)).status).toBe(200);
    // A second instance over the same database accepts it too.
    const second = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      secureCookies: false,
    });
    expect((await me(second)).status).toBe(200);
    await db.delete(sessionsSqlite);
    // No in-process cache: both instances deny at once.
    for (const instance of [app, second]) {
      const denied = await me(instance);
      expect(denied.status).toBe(401);
      expect(JSON.stringify(await denied.json())).not.toContain(soloEmail);
    }
  });
});
