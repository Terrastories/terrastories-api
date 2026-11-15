/**
 * Focused tests for POST /v2/auth/login (SPEC-V2 §6.2, §6.8, §7).
 *
 * Slice 10 item 3: the client-stretching login flow — resolution never takes
 * the first match, every rejection answers one identical 401 body, wrapped
 * Rails-bcrypt accounts upgrade atomically in the same request, and session
 * rows are established as `standard` or `device` sessions with only the
 * token digest at rest. bcrypt hashes, stretched keys and secrets are built
 * at runtime; nothing credential-shaped is a literal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { count, eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoAuthRepository } from '../../src/repositories/hono-auth.repository.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import {
  authThrottleSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  ARGON2ID_PARAMS_JSON,
  DEVICE_SESSION_ABSOLUTE_MS,
  RAILS_BCRYPT_ALGORITHM,
  STANDARD_SESSION_IDLE_MS,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeVerifierSalt,
} from './auth-test-utils.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';

const BCRYPT_ALPHABET =
  './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const bcryptSalt = (): string => {
  const bytes = new Uint8Array(22);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => BCRYPT_ALPHABET[byte % 64]).join('');
};

describe('POST /v2/auth/login (#137 item 3)', () => {
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
        name: 'Login Alpha',
        slug: 'login-alpha',
        publicStories: true,
        isActive: true,
      })
      .returning();
    const [beta] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Login Beta',
        slug: 'login-beta',
        publicStories: true,
        isActive: true,
      })
      .returning();

    const stretchedKey = makeDerivedKey();
    const upgradedSeed = await argon2Seed(stretchedKey);
    // A wrapped Rails-bcrypt account: the stored verifier is SHA-256 of the
    // bcrypt hash string, which plays the role of the client's `derivedKey`.
    const wrappedKey = makeDerivedKey();
    const wrappedVerifier = await sha256Hex(wrappedKey);
    const sharedEmail = 'shared@login.example.test';
    const base = {
      passwordHash,
      firstName: 'Login',
      lastName: 'Seed',
      isActive: true as const,
    };
    await db.insert(usersSqlite).values([
      {
        ...base,
        ...upgradedSeed,
        email: 'upgraded@login.example.test',
        username: 'upgraded_alpha',
        emailNormalized: normalizeSearchText('upgraded@login.example.test'),
        usernameNormalized: normalizeSearchText('upgraded_alpha'),
        role: 'member',
        communityId: alpha.id,
      },
      {
        ...base,
        email: 'wrapped@login.example.test',
        username: 'wrapped_alpha',
        emailNormalized: normalizeSearchText('wrapped@login.example.test'),
        usernameNormalized: normalizeSearchText('wrapped_alpha'),
        role: 'member',
        communityId: alpha.id,
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: bcryptSalt(),
        passwordParams: JSON.stringify({ cost: 12 }),
        passwordVerifier: wrappedVerifier,
      },
      {
        ...base,
        ...upgradedSeed,
        email: 'shared@login.example.test',
        username: 'shared_alpha',
        emailNormalized: normalizeSearchText('shared@login.example.test'),
        usernameNormalized: normalizeSearchText('shared_alpha'),
        role: 'member',
        communityId: alpha.id,
      },
      {
        ...base,
        ...upgradedSeed,
        email: sharedEmail,
        username: 'shared_beta',
        emailNormalized: normalizeSearchText(sharedEmail),
        usernameNormalized: normalizeSearchText('shared_beta'),
        role: 'member',
        communityId: beta.id,
      },
      {
        ...base,
        email: 'noverifier@login.example.test',
        username: 'noverifier_alpha',
        emailNormalized: normalizeSearchText('noverifier@login.example.test'),
        usernameNormalized: normalizeSearchText('noverifier_alpha'),
        role: 'member',
        communityId: alpha.id,
        // passwordAlgorithm/verifier columns deliberately absent.
      },
    ]);

    const secret = options.serverSecret ?? makeDerivedKey();
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: secret,
      secureCookies: false,
    });
    const postLogin = (body: unknown, headers: Record<string, string> = {}) =>
      app.request('http://test/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    return {
      app,
      db,
      alpha,
      beta,
      secret,
      stretchedKey,
      wrappedKey,
      sharedEmail,
      postLogin,
    };
  }

  const it200 = async (
    response: Response
  ): Promise<Record<string, unknown>> => {
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  const sessionRows = (db: ReturnType<typeof drizzle>) =>
    db.select().from(sessionsSqlite);

  it('authenticates an Argon2id account and establishes a standard session', async () => {
    const { db, postLogin, stretchedKey } = await setup();
    const response = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
    });
    const body = await it200(response);
    expect((body.user as { email: string }).email).toBe(
      'upgraded@login.example.test'
    );
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain(`Max-Age=${STANDARD_SESSION_IDLE_MS / 1000}`);
    const rows = await sessionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('standard');
    expect(rows[0]?.absoluteExpiresAt).toBeGreaterThan(
      rows[0]?.idleExpiresAt ?? 0
    );
    // Only the digest is at rest: the cookie token must not appear in the row.
    const cookieToken = (setCookie.split(';')[0] ?? '').split('=')[1] ?? '';
    expect(cookieToken).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.tokenHash).not.toBe(cookieToken);
    expect(rows[0]?.tokenHash).toBe(await sha256Hex(cookieToken));
  });

  it('authenticates via the normalized username identifier', async () => {
    const { postLogin, stretchedKey } = await setup();
    const response = await postLogin({
      identifier: 'upgraded_ALPHA',
      derivedKey: stretchedKey,
    });
    expect(response.status).toBe(200);
  });

  it('answers every rejection with one identical 401 body', async () => {
    const { postLogin, stretchedKey, sharedEmail } = await setup();
    const bodies: unknown[] = [];
    for (const body of [
      { identifier: 'nobody@login.example.test', derivedKey: stretchedKey },
      {
        identifier: 'upgraded@login.example.test',
        derivedKey: makeDerivedKey(),
      },
      { identifier: sharedEmail, derivedKey: stretchedKey },
      {
        identifier: 'upgraded@login.example.test',
        derivedKey: stretchedKey,
        communitySlug: 'no-such-community',
      },
    ]) {
      const response = await postLogin(body);
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }
    for (const body of bodies)
      expect(body).toEqual({ error: 'Invalid credentials' });
  });

  it('resolves an ambiguous email only with the communitySlug locator', async () => {
    const { postLogin, stretchedKey, sharedEmail, alpha, beta } = await setup();
    const unlocated = await postLogin({
      identifier: sharedEmail,
      derivedKey: stretchedKey,
    });
    expect(unlocated.status).toBe(401);
    const alphaLogin = await it200(
      await postLogin({
        identifier: sharedEmail,
        derivedKey: stretchedKey,
        communitySlug: 'login-alpha',
      })
    );
    expect((alphaLogin.user as { communityId: number }).communityId).toBe(
      alpha.id
    );
    const betaLogin = await it200(
      await postLogin({
        identifier: sharedEmail,
        derivedKey: stretchedKey,
        communitySlug: 'login-beta',
      })
    );
    expect((betaLogin.user as { communityId: number }).communityId).toBe(
      beta.id
    );
  });

  it('fails closed with one 401 for a stored row with no verifier', async () => {
    const { postLogin, stretchedKey } = await setup();
    const response = await postLogin({
      identifier: 'noverifier@login.example.test',
      derivedKey: stretchedKey,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('establishes a device session with no Max-Age and a 60-day absolute window', async () => {
    const { postLogin, stretchedKey, db } = await setup();
    const before = Date.now();
    const response = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
      deviceSession: true,
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('Max-Age=');
    const [row] = await db.select().from(sessionsSqlite);
    expect(row?.kind).toBe('device');
    expect(
      (row?.absoluteExpiresAt ?? 0) - (row?.createdAt ?? 0)
    ).toBeGreaterThanOrEqual(DEVICE_SESSION_ABSOLUTE_MS - 1000);
    expect(row?.absoluteExpiresAt ?? 0).toBeGreaterThan(
      before + DEVICE_SESSION_ABSOLUTE_MS - 60_000
    );
  });

  it('rotates a same-user session row in place and rejects the old cookie', async () => {
    const { app, db, postLogin, stretchedKey } = await setup();
    const first = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
    });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const second = await postLogin(
      { identifier: 'upgraded@login.example.test', derivedKey: stretchedKey },
      { cookie }
    );
    expect(second.status).toBe(200);
    const rows = await sessionRows(db);
    expect(rows).toHaveLength(1);
    const me = await app.request('http://test/v2/auth/me', {
      headers: { cookie },
    });
    expect(me.status).toBe(401);
  });

  it('binds a fresh session to a different user over a presented cookie', async () => {
    const { app, db, postLogin, stretchedKey } = await setup();
    const viewerLogin = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
    });
    const viewerCookie =
      (viewerLogin.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const adminLogin = await postLogin(
      {
        identifier: 'shared@login.example.test',
        derivedKey: stretchedKey,
        communitySlug: 'login-beta',
      },
      { cookie: viewerCookie }
    );
    expect(adminLogin.status).toBe(200);
    // The presented (other-user) cookie stops authenticating immediately.
    const me = await app.request('http://test/v2/auth/me', {
      headers: { cookie: viewerCookie },
    });
    expect(me.status).toBe(401);
    const rows = await sessionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(4); // shared_beta is the fourth seeded account
  });

  it('upgrades a wrapped bcrypt account atomically and deletes other sessions', async () => {
    const { postLogin, wrappedKey, db } = await setup();
    // A pre-existing session for the wrapped account (another device); the
    // verifier change fires the session-revocation trigger (SPEC-V2 §6.8).
    const foundation = new HonoFoundationRepository(db);
    const [wrappedUser] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    await foundation.createSession({
      tokenHash: 'c'.repeat(64),
      user: {
        id: wrappedUser!.id,
        email: wrappedUser!.email,
        username: wrappedUser!.username,
        displayName: wrappedUser!.displayName,
        passwordHash: wrappedUser!.passwordHash,
        role: 'member',
        communityId: wrappedUser!.communityId,
      },
      kind: 'standard',
      createdAt: new Date('2026-06-01T12:00:00.000Z'),
      idleExpiresAt: new Date('2026-06-02T12:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-01T12:00:00.000Z'),
    });
    const upgradedKey = makeDerivedKey();
    const upgrade = {
      algorithm: ARGON2ID_ALGORITHM,
      salt: makeVerifierSalt(),
      params: { ...ARGON2ID_PARAMS },
      derivedKey: upgradedKey,
    };
    const login = await postLogin({
      identifier: 'wrapped@login.example.test',
      derivedKey: wrappedKey,
      upgrade,
    });
    expect(login.status).toBe(200);
    const [row] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    expect(row?.passwordAlgorithm).toBe(ARGON2ID_ALGORITHM);
    expect(row?.passwordVerifier).toBe(await sha256Hex(upgradedKey));
    expect(row?.passwordSalt).toBe(upgrade.salt);
    expect(JSON.parse(row?.passwordParams ?? '{}')).toEqual(ARGON2ID_PARAMS);
    // The pre-existing session row is gone (trigger); the fresh one remains.
    const sessions = await db.select().from(sessionsSqlite);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.userId).toBe(wrappedUser!.id);
    expect(sessions[0]?.tokenHash).not.toBe('c'.repeat(64));
  });

  it('rejects a below-policy upgrade and leaves the wrapped row unchanged', async () => {
    const { postLogin, wrappedKey, db } = await setup();
    const [before] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    const login = await postLogin({
      identifier: 'wrapped@login.example.test',
      derivedKey: wrappedKey,
      upgrade: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { memoryKiB: 1024, iterations: 1, parallelism: 1 },
        derivedKey: makeDerivedKey(),
      },
    });
    expect(login.status).toBe(401);
    const [after] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    expect(after).toEqual(before);
    expect(
      (await db.select({ value: count() }).from(sessionsSqlite))[0]?.value
    ).toBe(0);
  });

  it('rejects a wrapped login that omits the upgrade and leaves the row unchanged', async () => {
    const { postLogin, wrappedKey, db } = await setup();
    const [before] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    const login = await postLogin({
      identifier: 'wrapped@login.example.test',
      derivedKey: wrappedKey,
    });
    expect(login.status).toBe(401);
    const [after] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    expect(after).toEqual(before);
  });

  it('fails the wrapped login closed without leaking which check failed', async () => {
    const { postLogin, wrappedKey } = await setup();
    for (const upgrade of [
      {
        algorithm: RAILS_BCRYPT_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      {
        algorithm: ARGON2ID_ALGORITHM,
        salt: '!!!',
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
    ]) {
      const response = await postLogin({
        identifier: 'wrapped@login.example.test',
        derivedKey: wrappedKey,
        upgrade,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Invalid credentials' });
    }
    // A wire-shape violation (derivedKey not 64 hex) is a 400 before the
    // service runs; the 401 registry checks happen on valid shapes.
    const malformed = await postLogin({
      identifier: 'wrapped@login.example.test',
      derivedKey: wrappedKey,
      upgrade: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: 'zz',
      },
    });
    expect(malformed.status).toBe(400);
  });

  it('records at most two throttle rows per failed login, one when unresolved', async () => {
    const { postLogin, stretchedKey, sharedEmail, db } = await setup();
    // Unknown identifier and ambiguous email both resolve to no account:
    // only the per-IP row is written, and it is updated in place.
    await postLogin({
      identifier: 'nobody@login.example.test',
      derivedKey: stretchedKey,
    });
    await postLogin({ identifier: sharedEmail, derivedKey: stretchedKey });
    expect(
      (await db.select({ value: count() }).from(authThrottleSqlite))[0]?.value
    ).toBe(1);
    // A resolved account adds its per-account row in the same round trip.
    await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: makeDerivedKey(),
    });
    const rows = await db.select().from(authThrottleSqlite);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind).sort()).toEqual(['account', 'ip']);
  });

  it('resets the throttle counters on a successful login', async () => {
    const { postLogin, stretchedKey, db } = await setup();
    await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: makeDerivedKey(),
    });
    const before = await db.select({ value: count() }).from(authThrottleSqlite);
    expect(before[0]?.value).toBe(2);
    const ok = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
    });
    expect(ok.status).toBe(200);
    const after = await db.select({ value: count() }).from(authThrottleSqlite);
    expect(after[0]?.value).toBe(0);
  });

  it('fails closed with 503 when the server secret is not configured', async () => {
    const { postLogin, stretchedKey } = await setup({ serverSecret: '' });
    const response = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service unavailable' });
  });

  it('pins the authority gate: a stale verifier write loses to a reset', async () => {
    const { db } = await setup();
    const repository = new HonoAuthRepository(db);
    const [account] = await db
      .select({
        id: usersSqlite.id,
        passwordHash: usersSqlite.passwordHash,
      })
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    // A verifier write pinned to a stale `password_hash` anchor is rejected.
    const wrote = await repository.writeVerifierAtomically(
      { id: account!.id, passwordHash: 'stale-anchor' },
      {
        passwordHash: 'stale-anchor',
        passwordVerifier: 'x'.repeat(64),
        passwordAlgorithm: ARGON2ID_ALGORITHM,
        passwordSalt: 'c2FsdA==',
        passwordParams: ARGON2ID_PARAMS_JSON,
      }
    );
    expect(wrote).toBe(false);
    const [unchanged] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    expect(unchanged?.passwordVerifier).not.toBe('x'.repeat(64));
  });

  it('pins the session gate: a session write with a stale anchor creates no row', async () => {
    const { db } = await setup();
    const foundation = new HonoFoundationRepository(db);
    const [user] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    const created = await foundation.createSession({
      tokenHash: 'b'.repeat(64),
      user: {
        id: user!.id,
        email: user!.email,
        username: user!.username,
        displayName: user!.displayName,
        passwordHash: 'stale-anchor',
        role: 'member',
        communityId: user!.communityId,
      },
      kind: 'standard',
      createdAt: new Date('2026-06-01T12:00:00.000Z'),
      idleExpiresAt: new Date('2026-06-01T20:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-01T12:00:00.000Z'),
    });
    expect(created).toBe(false);
    expect(
      (await db.select({ value: count() }).from(sessionsSqlite))[0]?.value
    ).toBe(0);
  });
});
