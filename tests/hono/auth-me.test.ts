/**
 * Focused tests for the Slice 10 self-service account routes (#137 item 4):
 * PATCH /v2/auth/me (own profile) and POST /v2/auth/password (current-key
 * verification, atomic verifier write, revocation of the account's other
 * sessions) plus the kind-aware `ts_session` renewal cookie on both the
 * session gate and the password change itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  ARGON2ID_PARAMS_JSON,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';

describe('PATCH /v2/auth/me and POST /v2/auth/password (#137 item 4)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(options: { serverSecret?: string | undefined } = {}) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });

    const passwordHash = await hash('LegacyAnchorPassword!', 4);
    const [alpha] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Account Alpha',
        slug: 'account-alpha',
        publicStories: true,
        isActive: true,
      })
      .returning();

    const stretchedKey = makeDerivedKey();
    const seed = await argon2Seed(stretchedKey);
    await db.insert(usersSqlite).values({
      ...seed,
      passwordHash,
      email: 'member@account.example.test',
      username: 'member_alpha',
      emailNormalized: normalizeSearchText('member@account.example.test'),
      usernameNormalized: normalizeSearchText('member_alpha'),
      firstName: 'Member',
      lastName: 'Alpha',
      displayName: 'Member Alpha',
      role: 'member',
      communityId: alpha.id,
      isActive: true,
    });

    const secret = options.serverSecret ?? makeServerSecret();
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: secret,
      secureCookies: false,
    });
    const postLogin = (body: unknown, cookie?: string) =>
      app.request('http://test/v2/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      });
    const loginCookie = async (deviceSession = false): Promise<string> => {
      const response = await postLogin({
        identifier: 'member@account.example.test',
        derivedKey: stretchedKey,
        ...(deviceSession ? { deviceSession: true } : {}),
      });
      expect(response.status).toBe(200);
      const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
      expect(cookie).toContain('ts_session=');
      return cookie ?? '';
    };
    const getMe = (cookie: string) =>
      app.request('http://test/v2/auth/me', { headers: { cookie } });
    const patchMe = (body: unknown, cookie: string) =>
      app.request('http://test/v2/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    const postPassword = (body: unknown, cookie: string) =>
      app.request('http://test/v2/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    return {
      app,
      db,
      alpha,
      stretchedKey,
      loginCookie,
      getMe,
      patchMe,
      postPassword,
      postLogin,
    };
  }

  it('lets the account holder update their display name and reads it back', async () => {
    const { patchMe, getMe, loginCookie } = await setup();
    const cookie = await loginCookie();
    const response = await patchMe({ displayName: 'New Name üñî' }, cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { displayName: string } };
    expect(body.user.displayName).toBe('New Name üñî');
    const me = (await (await getMe(cookie)).json()) as {
      user: { displayName: string; username: string; role: string };
    };
    expect(me.user.displayName).toBe('New Name üñî');
    // The rest of the projection is unchanged.
    expect(me.user.username).toBe('member_alpha');
    expect(me.user.role).toBe('member');
  });

  it('normalizes the display name to NFC without case-folding', async () => {
    const { patchMe, getMe, loginCookie } = await setup();
    const cookie = await loginCookie();
    // Decomposed input (e + combining acute) must be stored composed.
    const response = await patchMe({ displayName: 'Jose\u0301' }, cookie);
    expect(response.status).toBe(200);
    const me = (await (await getMe(cookie)).json()) as {
      user: { displayName: string };
    };
    expect(me.user.displayName).toBe('José');
  });

  it('clears the display name with an explicit null', async () => {
    const { patchMe, getMe, loginCookie } = await setup();
    const cookie = await loginCookie();
    const response = await patchMe({ displayName: null }, cookie);
    expect(response.status).toBe(200);
    const me = (await (await getMe(cookie)).json()) as {
      user: { displayName: string | null };
    };
    expect(me.user.displayName).toBeNull();
  });

  it('rejects privileged or extra fields with 400 (.strict())', async () => {
    const { patchMe, loginCookie, db, alpha } = await setup();
    const cookie = await loginCookie();
    for (const body of [
      { displayName: 'ok', role: 'admin' },
      { displayName: 'ok', communityId: 1 },
      { displayName: 'ok', status: 'disabled' },
      { displayName: 'ok', username: 'takeover' },
      { displayName: 'ok', email: 'takeover@example.test' },
      { role: 'admin' },
      { username: 'takeover' },
      { communityId: 1 },
      {},
      { displayName: 42 },
      { displayName: '   ' },
      { displayName: 'x'.repeat(256) },
    ]) {
      const response = await patchMe(body, cookie);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    // The privileged fields were never touched.
    const [row] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'member@account.example.test'));
    expect(row?.role).toBe('member');
    expect(row?.communityId).toBe(alpha.id);
  });

  it('requires authentication and JSON content type', async () => {
    const { app, loginCookie } = await setup();
    const cookie = await loginCookie();
    const unauthenticated = await app.request('http://test/v2/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: '' },
      body: JSON.stringify({ displayName: 'x' }),
    });
    expect(unauthenticated.status).toBe(401);
    const plain = await app.request('http://test/v2/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/plain', cookie },
      body: 'displayName=x',
    });
    expect(plain.status).toBe(415);
    const malformed = await app.request('http://test/v2/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{',
    });
    expect(malformed.status).toBe(400);
  });

  it('renews the cookie with the standard lifetime for standard sessions', async () => {
    const { patchMe, loginCookie } = await setup();
    const cookie = await loginCookie(false);
    const response = await patchMe({ displayName: 'renew me' }, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=43200');
  });

  it('renews the cookie with the device idle lifetime for device sessions', async () => {
    const { patchMe, loginCookie } = await setup();
    const cookie = await loginCookie(true);
    const response = await patchMe({ displayName: 'device me' }, cookie);
    expect(response.status).toBe(200);
    // A device cookie must survive a browser restart, so it carries the 60-day
    // idle Max-Age; the session row stays the enforcement point.
    expect(response.headers.get('set-cookie')).toContain('Max-Age=5184000');
  });

  it('changes the password, revokes other sessions and rotates this one', async () => {
    const { db, stretchedKey, loginCookie, getMe, postPassword, postLogin } =
      await setup();
    const cookieA = await loginCookie();
    const cookieB = await loginCookie();
    const newKey = makeDerivedKey();
    const response = await postPassword(
      {
        currentDerivedKey: stretchedKey,
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: newKey,
      },
      cookieA
    );
    expect(response.status).toBe(200);
    const newCookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    expect(newCookie).toContain('ts_session=');

    // Both pre-change sessions are revoked (trigger), the fresh one is not.
    expect((await getMe(cookieA)).status).toBe(401);
    expect((await getMe(cookieB)).status).toBe(401);
    expect((await getMe(newCookie!)).status).toBe(200);
    expect((await db.select().from(sessionsSqlite)).length).toBe(1);

    // The stored verifier now matches the new key only.
    const oldLogin = await postLogin({
      identifier: 'member@account.example.test',
      derivedKey: stretchedKey,
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await postLogin({
      identifier: 'member@account.example.test',
      derivedKey: newKey,
    });
    expect(newLogin.status).toBe(200);

    // The new verifier is the Argon2id material supplied by the client.
    const [row] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'member@account.example.test'));
    expect(row?.passwordAlgorithm).toBe(ARGON2ID_ALGORITHM);
    expect(row?.passwordVerifier).toBe(await sha256Hex(newKey));
    expect(JSON.parse(row?.passwordParams ?? '{}')).toEqual(ARGON2ID_PARAMS);
  });

  it('rejects a wrong current key and leaves the row untouched', async () => {
    const { db, loginCookie, postPassword } = await setup();
    const cookie = await loginCookie();
    const [before] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'member@account.example.test'));
    const response = await postPassword(
      {
        currentDerivedKey: makeDerivedKey(),
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      cookie
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
    const [after] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'member@account.example.test'));
    expect(after).toEqual(before);
  });

  it('rejects below-policy material with 400 without changing anything', async () => {
    const { db, stretchedKey, loginCookie, postPassword } = await setup();
    const cookie = await loginCookie();
    const [before] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'member@account.example.test'));
    for (const params of [
      { memoryKiB: 1024, iterations: 1, parallelism: 1 },
      { memoryKiB: 19 * 1024 },
      { iterations: 2, parallelism: 1 },
      {},
      'nonsense',
    ]) {
      const response = await postPassword(
        {
          currentDerivedKey: stretchedKey,
          algorithm: ARGON2ID_ALGORITHM,
          salt: makeVerifierSalt(),
          params,
          derivedKey: makeDerivedKey(),
        },
        cookie
      );
      expect(response.status, JSON.stringify(params)).toBe(400);
    }
    const [after] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'member@account.example.test'));
    expect(after).toEqual(before);
  });

  it('rejects malformed salt, algorithm and key shapes with 400', async () => {
    const { stretchedKey, loginCookie, postPassword } = await setup();
    const cookie = await loginCookie();
    for (const body of [
      {
        currentDerivedKey: stretchedKey,
        algorithm: ARGON2ID_ALGORITHM,
        salt: 'c2FsdA==', // 4 bytes, below the 128-bit floor
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      {
        currentDerivedKey: stretchedKey,
        algorithm: 'client-bcrypt-rails+sha256', // never a new enrollment shape
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      {
        currentDerivedKey: 'zz',
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      {
        currentDerivedKey: stretchedKey,
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: 'not-hex',
      },
    ]) {
      const response = await postPassword(body, cookie);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('issues a device-kind fresh session after a device-session password change', async () => {
    const { db, stretchedKey, loginCookie, postPassword } = await setup();
    const cookie = await loginCookie(true);
    const response = await postPassword(
      {
        currentDerivedKey: stretchedKey,
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      cookie
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=5184000');
    const rows = await db.select().from(sessionsSqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('device');
  });

  it('rejects unauthenticated requests', async () => {
    const { app, stretchedKey } = await setup();
    const response = await app.request('http://test/v2/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: '' },
      body: JSON.stringify({
        currentDerivedKey: stretchedKey,
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      }),
    });
    expect(response.status).toBe(401);
  });
});
