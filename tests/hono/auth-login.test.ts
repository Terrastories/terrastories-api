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
  AUTH_THROTTLE_MAX_FAILURES,
  AuthLoginRejected,
  DEVICE_SESSION_ABSOLUTE_MS,
  DEVICE_SESSION_IDLE_MS,
  RAILS_BCRYPT_ALGORITHM,
  STANDARD_SESSION_IDLE_MS,
  authThrottleBackoffMs,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { HonoAuthService } from '../../src/services/hono-auth.service.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeVerifierSalt,
} from './auth-test-utils.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';

describe('POST /v2/auth/login (#137 item 3)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(
    options: { serverSecret?: string | undefined; now?: Date } = {}
  ) {
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
    // A wrapped Rails-bcrypt account: the client recomputes bcrypt with the
    // stored salt and cost and sends the resulting hash string as
    // `derivedKey` (SPEC-V2 §7 step 4), so the stored verifier is SHA-256 of a
    // real bcrypt hash — never of a synthetic 64-hex string.
    const wrappedKey = await hash('WrappedRailsPassword!', 10);
    const wrappedVerifier = await sha256Hex(wrappedKey);
    const wrappedSalt = wrappedKey.slice(7, 29);
    const wrappedCost = Number(wrappedKey.slice(4, 6));
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
        passwordSalt: wrappedSalt,
        passwordParams: JSON.stringify({ cost: wrappedCost }),
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
      ...(options.now === undefined ? {} : { now: () => options.now as Date }),
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
      wrappedSalt,
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

  it('establishes a device session with a Max-Age covering its idle window', async () => {
    const { postLogin, stretchedKey, db } = await setup();
    const before = Date.now();
    const response = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
      deviceSession: true,
    });
    expect(response.status).toBe(200);
    // A device login must survive a browser restart: the cookie carries the
    // 60-day idle Max-Age, and the session row is still the enforcement point.
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`Max-Age=${DEVICE_SESSION_IDLE_MS / 1000}`);
    expect(setCookie).not.toContain(
      `Max-Age=${STANDARD_SESSION_IDLE_MS / 1000}`
    );
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

  it('authenticates a wrapped account with the real bcrypt hash string it was seeded with', async () => {
    const { postLogin, wrappedKey, wrappedSalt, db } = await setup();
    // The regression this pins: the wire key is a bcrypt hash string, not a
    // 64-hex digest, and the schema must accept it (finding 1).
    expect(wrappedKey).toMatch(
      /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/
    );
    const upgradedKey = makeDerivedKey();
    const login = await postLogin({
      identifier: 'wrapped@login.example.test',
      derivedKey: wrappedKey,
      upgrade: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: upgradedKey,
      },
    });
    expect(login.status).toBe(200);
    const [row] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'wrapped@login.example.test'));
    // Atomic upgrade: verifier, algorithm, salt and params land together, and
    // the bcrypt hash string itself is never what is stored.
    expect(row?.passwordAlgorithm).toBe(ARGON2ID_ALGORITHM);
    expect(row?.passwordVerifier).toBe(await sha256Hex(upgradedKey));
    expect(row?.passwordVerifier).not.toBe(wrappedKey);
    expect(row?.passwordSalt).not.toBe(wrappedSalt);
  });

  it('answers a bcrypt-shaped key sent to an Argon2id account with the uniform 401', async () => {
    const { postLogin, wrappedKey } = await setup();
    // The wire shape is not the algorithm selector: a valid bcrypt-shaped key
    // presented to an Argon2id account is an ordinary rejected credential,
    // never a 400 that would reveal the account's algorithm (finding 1).
    const response = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: wrappedKey,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('answers a 64-hex key sent to a wrapped account with the uniform 401', async () => {
    const { postLogin } = await setup();
    const response = await postLogin({
      identifier: 'wrapped@login.example.test',
      derivedKey: makeDerivedKey(),
      upgrade: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects a derivedKey that is neither shape with a 400 before resolution', async () => {
    const { postLogin } = await setup();
    // The 400 is a wire-shape failure and must not depend on the account: the
    // same malformed value is rejected before any lookup for a real and for an
    // unknown identifier alike.
    for (const identifier of [
      'upgraded@login.example.test',
      'nobody@login.example.test',
    ]) {
      const response = await postLogin({ identifier, derivedKey: 'zz' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid request' });
    }
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
    // The upgrade material is always the Argon2id digest, so a non-hex
    // `upgrade.derivedKey` is a wire-shape 400 before the service runs; the
    // 401 registry checks happen on valid shapes.
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

  it('blocks the per-account counter at the backoff threshold and refuses the correct key', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { postLogin, stretchedKey, db, secret } = await setup({ now });
    const [account] = await db
      .select({ id: usersSqlite.id })
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    for (let attempt = 0; attempt < AUTH_THROTTLE_MAX_FAILURES; attempt += 1) {
      const response = await postLogin({
        identifier: 'upgraded@login.example.test',
        derivedKey: makeDerivedKey(),
      });
      expect(response.status).toBe(401);
    }
    const repository = new HonoAuthRepository(db);
    const state = await repository.throttleState(
      await repository.accountThrottleKey(account!.id, secret),
      now.getTime()
    );
    expect(state.failures).toBe(AUTH_THROTTLE_MAX_FAILURES);
    expect(state.blocked).toBe(true);
    expect(state.blockedUntil).toBe(
      now.getTime() + authThrottleBackoffMs(AUTH_THROTTLE_MAX_FAILURES)
    );
    // The correct key is now refused with the uniform 401, and no session is
    // established by the blocked attempt.
    const blocked = await postLogin({
      identifier: 'upgraded@login.example.test',
      derivedKey: stretchedKey,
    });
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ error: 'Invalid credentials' });
    expect(
      (await db.select({ value: count() }).from(sessionsSqlite))[0]?.value
    ).toBe(0);
  });

  it('blocks the per-IP counter for unknown identifiers and refuses a correct key from that address', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { postLogin, stretchedKey, db, secret } = await setup({ now });
    const clientIp = '198.51.100.10';
    for (let attempt = 0; attempt < AUTH_THROTTLE_MAX_FAILURES; attempt += 1) {
      const response = await postLogin(
        {
          // Every attempt is unresolved: the per-IP row is the only one that
          // may be written, and it must still bound the guessing.
          identifier: `nobody-${attempt}@login.example.test`,
          derivedKey: makeDerivedKey(),
        },
        { 'cf-connecting-ip': clientIp }
      );
      expect(response.status).toBe(401);
    }
    const repository = new HonoAuthRepository(db);
    const state = await repository.throttleState(
      await repository.ipThrottleKey(clientIp, secret),
      now.getTime()
    );
    expect(state.failures).toBe(AUTH_THROTTLE_MAX_FAILURES);
    expect(state.blocked).toBe(true);
    expect(state.blockedUntil).toBe(
      now.getTime() + authThrottleBackoffMs(AUTH_THROTTLE_MAX_FAILURES)
    );
    // Exactly one row: unresolved attempts never touch an account row.
    const rows = await db.select().from(authThrottleSqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('ip');
    // The blocked address cannot authenticate even with a real account and
    // the correct key.
    const blocked = await postLogin(
      {
        identifier: 'upgraded@login.example.test',
        derivedKey: stretchedKey,
      },
      { 'cf-connecting-ip': clientIp }
    );
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('reads the per-IP throttle before resolving the identifier', async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const { db, secret } = await setup({ now });
    const order: string[] = [];
    const ipKey = 'ip-throttle-key';
    const stub = {
      connection: db,
      ipThrottleKey: async () => {
        order.push('ipKey');
        return ipKey;
      },
      accountThrottleKey: async () => {
        order.push('accountKey');
        return 'account-throttle-key';
      },
      throttleState: async (key: string) => {
        order.push(`throttle:${key}`);
        return key === ipKey
          ? { blocked: true, failures: 10, blockedUntil: now.getTime() + 1 }
          : { blocked: false, failures: 0, blockedUntil: null };
      },
      communityIdBySlug: async () => {
        order.push('slug');
        return null;
      },
      loginCandidates: async () => {
        order.push('candidates');
        return [];
      },
      recordLoginFailure: async () => {
        order.push('record');
      },
    };
    const service = new HonoAuthService(
      stub as unknown as HonoAuthRepository,
      new HonoFoundationRepository(db),
      secret
    );
    await expect(
      service.login(
        {
          identifier: 'nobody@login.example.test',
          derivedKey: makeDerivedKey(),
        },
        '203.0.113.7',
        now
      )
    ).rejects.toBeInstanceOf(AuthLoginRejected);
    // The per-IP state is read first; a blocked address never reaches
    // resolution, so no account can be attributed to the attempt.
    expect(order.slice(0, 2)).toEqual(['ipKey', `throttle:${ipKey}`]);
    expect(order).not.toContain('candidates');
    expect(order).not.toContain('slug');
    expect(order).toContain('record');
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

  it('couples the verifier write and the session insert: a stale anchor leaves both undone', async () => {
    const { db } = await setup();
    const foundation = new HonoFoundationRepository(db);
    const [user] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    const base = {
      tokenHash: 'd'.repeat(64),
      user: {
        id: user!.id,
        email: user!.email,
        username: user!.username,
        displayName: user!.displayName,
        passwordHash: user!.passwordHash,
        role: 'member',
        communityId: user!.communityId,
      },
      kind: 'standard' as const,
      createdAt: new Date('2026-06-01T12:00:00.000Z'),
      idleExpiresAt: new Date('2026-06-01T20:00:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-01T12:00:00.000Z'),
      verifier: {
        passwordHash: user!.passwordHash,
        passwordVerifier: 'e'.repeat(64),
        passwordAlgorithm: ARGON2ID_ALGORITHM,
        passwordSalt: makeVerifierSalt(),
        passwordParams: ARGON2ID_PARAMS_JSON,
      },
    };
    // A lost authority race (the anchor moved between the read and the write)
    // must leave both writes undone — not a verifier change with no session.
    const lost = await foundation.createSessionWithVerifier({
      ...base,
      user: { ...base.user, passwordHash: 'stale-anchor' },
      verifier: { ...base.verifier, passwordHash: 'stale-anchor' },
    });
    expect(lost).toEqual({ established: false, verifierWritten: false });
    const [afterLoss] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    expect(afterLoss?.passwordVerifier).toBe(user!.passwordVerifier);
    expect(
      (await db.select({ value: count() }).from(sessionsSqlite))[0]?.value
    ).toBe(0);
    // With the authority intact both land together, and the verifier change's
    // revocation trigger does not delete the fresh session.
    const won = await foundation.createSessionWithVerifier(base);
    expect(won).toEqual({ established: true, verifierWritten: true });
    const [afterWin] = await db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.email, 'upgraded@login.example.test'));
    expect(afterWin?.passwordVerifier).toBe('e'.repeat(64));
    expect(
      (await db.select({ value: count() }).from(sessionsSqlite))[0]?.value
    ).toBe(1);
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
