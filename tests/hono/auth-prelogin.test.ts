import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { count } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import {
  authThrottleSqlite,
  sessionsSqlite,
} from '../../src/db/schema/sessions.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
  RAILS_BCRYPT_ALGORITHM,
} from '../../src/shared/auth-policy.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';

const BCRYPT_ALPHABET =
  './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const bcryptSalt = (): string => {
  const bytes = new Uint8Array(22);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => BCRYPT_ALPHABET[byte % 64]).join('');
};
const base64 = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
};

describe('POST /v2/auth/prelogin (#137 item 2)', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  async function setup(options: { serverSecret?: string } = {}): Promise<{
    app: ReturnType<typeof createHonoApp>;
    db: ReturnType<typeof drizzle>;
    secret: string;
  }> {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });

    const passwordHash = (await hash('PreloginSeedPassword123!', 4)).replace(
      '$2b$',
      '$2a$'
    );

    const [alpha] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Prelogin Alpha',
        slug: 'prelogin-alpha',
        publicStories: true,
        isActive: true,
      })
      .returning();
    const [beta] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Prelogin Beta',
        slug: 'prelogin-beta',
        publicStories: true,
        isActive: true,
      })
      .returning();
    // A community with no accounts exercises the new-password mix.
    await db.insert(communitiesSqlite).values({
      name: 'Prelogin Gamma',
      slug: 'prelogin-gamma',
      publicStories: true,
      isActive: true,
    });

    const base = {
      passwordHash,
      firstName: 'Prelogin',
      lastName: 'Seed',
      isActive: true as const,
    };
    await db.insert(usersSqlite).values([
      {
        ...base,
        email: 'upgraded@prelogin.test',
        username: 'upgraded_alpha',
        emailNormalized: normalizeSearchText('upgraded@prelogin.test'),
        usernameNormalized: normalizeSearchText('upgraded_alpha'),
        role: 'member',
        communityId: alpha.id,
        passwordAlgorithm: ARGON2ID_ALGORITHM,
        passwordSalt: base64(16),
        passwordParams: ARGON2ID_PARAMS_JSON,
        passwordVerifier: base64(32),
      },
      {
        ...base,
        email: 'shared@prelogin.test',
        username: 'shared_alpha',
        emailNormalized: normalizeSearchText('shared@prelogin.test'),
        usernameNormalized: normalizeSearchText('shared_alpha'),
        role: 'member',
        communityId: alpha.id,
        passwordAlgorithm: ARGON2ID_ALGORITHM,
        passwordSalt: base64(16),
        passwordParams: ARGON2ID_PARAMS_JSON,
        passwordVerifier: base64(32),
      },
      {
        ...base,
        email: 'migrated@prelogin.test',
        username: 'migrated_alpha',
        emailNormalized: normalizeSearchText('migrated@prelogin.test'),
        usernameNormalized: normalizeSearchText('migrated_alpha'),
        role: 'member',
        communityId: alpha.id,
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: bcryptSalt(),
        passwordParams: JSON.stringify({ cost: 12 }),
        passwordVerifier: base64(32),
      },
      {
        ...base,
        email: 'broken@prelogin.test',
        username: 'broken_alpha',
        emailNormalized: normalizeSearchText('broken@prelogin.test'),
        usernameNormalized: normalizeSearchText('broken_alpha'),
        role: 'member',
        communityId: alpha.id,
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: bcryptSalt(),
        // Malformed stored params: the row must fall back to the fake.
        passwordParams: '{not-json',
        passwordVerifier: base64(32),
      },
      {
        ...base,
        email: 'shared@prelogin.test',
        username: 'shared_beta',
        emailNormalized: normalizeSearchText('shared@prelogin.test'),
        usernameNormalized: normalizeSearchText('shared_beta'),
        role: 'member',
        communityId: beta.id,
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: bcryptSalt(),
        passwordParams: JSON.stringify({ cost: 12 }),
        passwordVerifier: base64(32),
      },
    ]);

    const secret = options.serverSecret ?? base64(32);
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      verifier: { verify: async () => false },
      serverSecret: secret,
      secureCookies: false,
    });
    return { app, db, secret };
  }

  const postPrelogin = (
    app: ReturnType<typeof createHonoApp>,
    body: unknown
  ): Promise<Response> =>
    app.request('http://test/v2/auth/prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns the stored Argon2id shape for an upgraded account', async () => {
    const { app } = await setup();
    const response = await postPrelogin(app, {
      identifier: 'Upgraded@Prelogin.TEST',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.algorithm).toBe(ARGON2ID_ALGORITHM);
    expect(body.params).toEqual(JSON.parse(ARGON2ID_PARAMS_JSON));
    expect(typeof body.salt).toBe('string');
    expect(body.salt.length).toBeGreaterThan(0);
  });

  it('returns the stored bcrypt shape for a migrated account (username identifier)', async () => {
    const { app } = await setup();
    const response = await postPrelogin(app, { identifier: 'migrated_alpha' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.algorithm).toBe(RAILS_BCRYPT_ALGORITHM);
    expect(body.params).toEqual({ cost: 12 });
  });

  it('returns the identical shape keys for real accounts and unknown identifiers', async () => {
    const { app } = await setup();
    const real = await (
      await postPrelogin(app, { identifier: 'upgraded@prelogin.test' })
    ).json();
    const fake = await (
      await postPrelogin(app, { identifier: 'nobody@prelogin.test' })
    ).json();
    expect(Object.keys(fake).sort()).toEqual(Object.keys(real).sort());
    expect(Object.keys(fake).sort()).toEqual(['algorithm', 'params', 'salt']);
  });

  it('answers unknown identifiers with a deterministic fake', async () => {
    const { app } = await setup();
    const first = await postPrelogin(app, {
      identifier: 'deterministic@prelogin.test',
    });
    const second = await postPrelogin(app, {
      identifier: 'deterministic@prelogin.test',
    });
    const a = await first.json();
    const b = await second.json();
    expect(a).toEqual(b);
    // An account-free community must answer with the new-password mix only.
    const gamma = await (
      await postPrelogin(app, {
        identifier: 'deterministic@prelogin.test',
        communitySlug: 'prelogin-gamma',
      })
    ).json();
    expect(gamma.algorithm).toBe(ARGON2ID_ALGORITHM);
    expect(gamma.params).toEqual(JSON.parse(ARGON2ID_PARAMS_JSON));
    expect(Buffer.from(gamma.salt, 'base64').length).toBeGreaterThanOrEqual(16);
  });

  it('does not reveal an ambiguous email without a locator, and resolves with one', async () => {
    const { app } = await setup();
    const ambiguous = await postPrelogin(app, {
      identifier: 'shared@prelogin.test',
    });
    const fake = await ambiguous.json();
    expect(ambiguous.status).toBe(200);
    // Deterministic fake: the same answer every time, never the stored shape.
    const repeated = await (
      await postPrelogin(app, { identifier: 'shared@prelogin.test' })
    ).json();
    expect(repeated).toEqual(fake);
    const alpha = await (
      await postPrelogin(app, {
        identifier: 'shared@prelogin.test',
        communitySlug: 'prelogin-alpha',
      })
    ).json();
    expect(alpha.algorithm).toBe(ARGON2ID_ALGORITHM);
    const beta = await (
      await postPrelogin(app, {
        identifier: 'shared@prelogin.test',
        communitySlug: 'prelogin-beta',
      })
    ).json();
    expect(beta.algorithm).toBe(RAILS_BCRYPT_ALGORITHM);
    expect(beta.params).toEqual({ cost: 12 });
  });

  it('answers an unknown community slug with a fake, never an error', async () => {
    const { app } = await setup();
    const response = await postPrelogin(app, {
      identifier: 'upgraded@prelogin.test',
      communitySlug: 'no-such-community',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['algorithm', 'params', 'salt']);
  });

  it('falls back to the fake when the stored verifier is unusable', async () => {
    const { app } = await setup();
    const response = await postPrelogin(app, {
      identifier: 'broken@prelogin.test',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.algorithm).toBe('string');
    expect(body.salt).not.toHaveLength(0);
  });

  it('writes nothing (no audit, throttle or session rows)', async () => {
    const { app, db } = await setup();
    const before = async () => ({
      audit: (await db.select({ value: count() }).from(auditEntriesSqlite))[0]
        ?.value,
      throttle: (
        await db.select({ value: count() }).from(authThrottleSqlite)
      )[0]?.value,
      sessions: (await db.select({ value: count() }).from(sessionsSqlite))[0]
        ?.value,
    });
    for (const identifier of [
      'upgraded@prelogin.test',
      'nobody@prelogin.test',
      'broken@prelogin.test',
      'shared@prelogin.test',
    ]) {
      const response = await postPrelogin(app, { identifier });
      expect(response.status).toBe(200);
    }
    const counts = await before();
    expect(counts).toEqual({ audit: 0, throttle: 0, sessions: 0 });
  });

  it('fails closed with 503 when the server secret is not configured', async () => {
    // An empty secret is treated as unconfigured, so the service fails
    // closed instead of keying fakes with a predictable value.
    const { app } = await setup({ serverSecret: '' });
    const response = await postPrelogin(app, {
      identifier: 'upgraded@prelogin.test',
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service unavailable' });
  });

  it('rejects malformed requests uniformly', async () => {
    const { app } = await setup();
    const wrongType = await app.request('http://test/v2/auth/prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'identifier=x',
    });
    expect(wrongType.status).toBe(415);
    const invalidJson = await app.request('http://test/v2/auth/prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    for (const body of [
      {},
      { identifier: '' },
      { identifier: 'a'.repeat(255) },
      { identifier: 42 },
      { identifier: 'ok@prelogin.test', extra: 'nope' },
      { identifier: 'ok@prelogin.test', communitySlug: 7 },
    ]) {
      const response = await postPrelogin(app, body);
      expect(response.status).toBe(400);
    }
  });

  it('never echoes the identifier or any account data', async () => {
    const { app } = await setup();
    const response = await postPrelogin(app, {
      identifier: 'upgraded@prelogin.test',
    });
    const text = await response.text();
    expect(text).not.toContain('upgraded@prelogin.test');
    expect(text).not.toContain('upgraded_alpha');
    expect(text).not.toContain('password_verifier');
  });
});
