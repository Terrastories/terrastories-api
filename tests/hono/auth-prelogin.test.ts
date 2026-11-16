import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { count, eq } from 'drizzle-orm';
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
  ARGON2ID_PARAMS,
  ARGON2ID_PARAMS_JSON,
  AUTH_PRELOGIN_MIX_TTL_MS,
  BCRYPT_RAILS_COSTS,
  RAILS_BCRYPT_ALGORITHM,
  isCanonicalArgon2idParams,
  isCanonicalVerifierSalt,
} from '../../src/shared/auth-policy.js';
import { HonoAuthRepository } from '../../src/repositories/hono-auth.repository.js';
import { deterministicPreloginFake } from '../../src/shared/prelogin.js';
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
    // The fake is slug-independent: an account-free community, a real
    // community and an unknown slug all answer an unknown identifier with the
    // same deployment-wide-mix shape. The old per-community mix let a real
    // slug answer differently from a fake one and enumerate slugs (finding 5).
    const gamma = await (
      await postPrelogin(app, {
        identifier: 'deterministic@prelogin.test',
        communitySlug: 'prelogin-gamma',
      })
    ).json();
    expect(gamma).toEqual(a);
    const alpha = await (
      await postPrelogin(app, {
        identifier: 'deterministic@prelogin.test',
        communitySlug: 'prelogin-alpha',
      })
    ).json();
    expect(alpha).toEqual(a);
    const unknownSlug = await (
      await postPrelogin(app, {
        identifier: 'deterministic@prelogin.test',
        communitySlug: 'no-such-community',
      })
    ).json();
    expect(unknownSlug).toEqual(a);
  });

  it('gives the fake and a real Argon2id account the same canonical shape', async () => {
    const { app } = await setup();
    const real = await (
      await postPrelogin(app, { identifier: 'upgraded@prelogin.test' })
    ).json();
    // The all-upgraded mix forces the Argon2id branch of the fake.
    const fake = await deterministicPreloginFake(
      'test-secret',
      'nobody@prelogin.test',
      { upgraded: 1000, total: 1000 }
    );
    // Shape parity on values, not just keys: one salt length and the named
    // policy params on both sides (finding 4).
    expect(fake.algorithm).toBe(ARGON2ID_ALGORITHM);
    expect(Buffer.from(fake.salt, 'base64').length).toBe(16);
    expect(isCanonicalVerifierSalt(fake.salt)).toBe(true);
    expect(isCanonicalArgon2idParams(fake.params)).toBe(true);
    expect(Buffer.from(String(real.salt), 'base64').length).toBe(16);
    expect(isCanonicalVerifierSalt(String(real.salt))).toBe(true);
    expect(real.params).toEqual(JSON.parse(ARGON2ID_PARAMS_JSON));
    expect(real.params).toEqual(ARGON2ID_PARAMS);
    expect(fake.params).toEqual(real.params);
  });

  it('draws fake bcrypt costs only from the deployment-observed costs', async () => {
    // A deployment whose migrated rows only carry cost 10 must never see a
    // fake claim cost 12 (finding C).
    for (const identifier of [
      'nobody-a@prelogin.test',
      'nobody-b@prelogin.test',
      'nobody-c@prelogin.test',
      'nobody-d@prelogin.test',
    ]) {
      const fake10 = await deterministicPreloginFake(
        'test-secret',
        identifier,
        { upgraded: 0, total: 1000 },
        [10]
      );
      expect(fake10.params).toEqual({ cost: 10 });
    }
    const fake12 = await deterministicPreloginFake(
      'test-secret',
      'nobody@prelogin.test',
      { upgraded: 0, total: 1000 },
      [12]
    );
    expect(fake12.params).toEqual({ cost: 12 });
    // With an empty observed list the fake falls back to the Rails 10/12 set.
    const fallback = await deterministicPreloginFake(
      'test-secret',
      'nobody@prelogin.test',
      { upgraded: 0, total: 1000 },
      []
    );
    expect(BCRYPT_RAILS_COSTS as readonly number[]).toContain(
      (fallback.params as { cost: number }).cost
    );
  });

  it('weights the fake bcrypt cost pick by the observed migrated cost distribution', async () => {
    // A 9:1 migrated population at cost 10/12 must draw cost 12 about as often
    // as it occurs, not half the time (item 6).
    const mix = {
      upgraded: 0,
      total: 100,
      costCounts: [
        { cost: 10, count: 90 },
        { cost: 12, count: 10 },
      ],
    };
    const counts = new Map<number, number>();
    const SAMPLES = 400;
    for (let index = 0; index < SAMPLES; index += 1) {
      const fake = await deterministicPreloginFake(
        'test-secret',
        `weighted-${index}@prelogin.test`,
        mix
      );
      counts.set(
        (fake.params as { cost: number }).cost,
        (counts.get((fake.params as { cost: number }).cost) ?? 0) + 1
      );
    }
    // Deterministic per identifier, so allow a wide margin: 12 must be
    // roughly 1/10th, never near half.
    expect(counts.get(12) ?? 0).toBeGreaterThan(0);
    expect(counts.get(12) ?? 0).toBeLessThan(SAMPLES * 0.3);
    expect(counts.get(10) ?? 0).toBeGreaterThan(SAMPLES * 0.7);
  });

  it('weights the fake argon2id params pick by the observed parameter distribution', async () => {
    const mix = {
      upgraded: 100,
      total: 100,
      params: [
        { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1, count: 90 },
        { memoryKiB: 64 * 1024, iterations: 3, parallelism: 2, count: 10 },
      ],
    };
    const counts = new Map<string, number>();
    const SAMPLES = 400;
    for (let index = 0; index < SAMPLES; index += 1) {
      const fake = await deterministicPreloginFake(
        'test-secret',
        `params-${index}@prelogin.test`,
        mix
      );
      const params = fake.params as {
        memoryKiB: number;
        iterations: number;
        parallelism: number;
      };
      const key = `${params.memoryKiB}:${params.iterations}:${params.parallelism}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.get(`${64 * 1024}:3:2`) ?? 0).toBeLessThan(SAMPLES * 0.3);
    expect(counts.get(`${19 * 1024}:2:1`) ?? 0).toBeGreaterThan(SAMPLES * 0.7);
  });

  it('answers an above-policy existing row with its stored shape (§7)', async () => {
    const { app, db } = await setup();
    const passwordSalt = base64(32);
    const passwordParams = JSON.stringify({
      memoryKiB: ARGON2ID_PARAMS.memoryKiB * 2,
      iterations: ARGON2ID_PARAMS.iterations + 1,
      parallelism: ARGON2ID_PARAMS.parallelism,
    });
    await db.insert(usersSqlite).values({
      passwordHash: (await hash('AbovePolicyPrelogin123!', 4)).replace(
        '$2b$',
        '$2a$'
      ),
      firstName: 'Above',
      lastName: 'Policy',
      isActive: true as const,
      email: 'above-policy@prelogin.test',
      username: 'above_policy_alpha',
      emailNormalized: normalizeSearchText('above-policy@prelogin.test'),
      usernameNormalized: normalizeSearchText('above_policy_alpha'),
      role: 'member',
      communityId: (
        await db
          .select({ id: communitiesSqlite.id })
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.slug, 'prelogin-alpha'))
      )[0]!.id,
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt,
      passwordParams,
      passwordVerifier: base64(32),
    });
    // The row must answer with its own shape, not a fake.
    const response = await postPrelogin(app, {
      identifier: 'above-policy@prelogin.test',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      algorithm: string;
      salt: string;
      params: { memoryKiB: number; iterations: number; parallelism: number };
    };
    expect(body.algorithm).toBe(ARGON2ID_ALGORITHM);
    expect(body.salt).toBe(passwordSalt);
    expect(body.params).toEqual(JSON.parse(passwordParams));
  });

  it('answers an existing below-policy Argon2id row with its stored shape, not a fake', async () => {
    // A future policy raise must not flip today's below-policy rows into
    // fakes: the row answers with its stored shape, so the client can react.
    const { app, db } = await setup();
    const passwordSalt = base64(16);
    const belowParams = { memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 };
    const passwordParams = JSON.stringify(belowParams);
    await db.insert(usersSqlite).values({
      passwordHash: (await hash('BelowPolicyPrelogin123!', 4)).replace(
        '$2b$',
        '$2a$'
      ),
      firstName: 'Below',
      lastName: 'Policy',
      isActive: true as const,
      email: 'below-policy@prelogin.test',
      username: 'below_policy_alpha',
      emailNormalized: normalizeSearchText('below-policy@prelogin.test'),
      usernameNormalized: normalizeSearchText('below_policy_alpha'),
      role: 'member',
      communityId: (
        await db
          .select({ id: communitiesSqlite.id })
          .from(communitiesSqlite)
          .where(eq(communitiesSqlite.slug, 'prelogin-alpha'))
      )[0]!.id,
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt,
      passwordParams,
      passwordVerifier: base64(32),
    });
    const response = await postPrelogin(app, {
      identifier: 'below-policy@prelogin.test',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      algorithm: string;
      salt: string;
      params: { memoryKiB: number; iterations: number; parallelism: number };
    };
    expect(body.algorithm).toBe(ARGON2ID_ALGORITHM);
    expect(body.salt).toBe(passwordSalt);
    expect(body.params).toEqual(belowParams);
  });

  it('gives every fake bcrypt salt a Rails-shaped 22nd character', async () => {
    // A real bcrypt salt ends in one of `.Oeu` — its last character carries
    // two significant bits (finding C). A fake must match that shape.
    for (const identifier of [
      'shape-a@prelogin.test',
      'shape-b@prelogin.test',
      'shape-c@prelogin.test',
      'shape-d@prelogin.test',
      'shape-e@prelogin.test',
      'shape-f@prelogin.test',
    ]) {
      const fake = await deterministicPreloginFake('test-secret', identifier, {
        upgraded: 0,
        total: 1000,
      });
      expect(fake.salt).toMatch(/^[./A-Za-z0-9]{21}[.Oeu]$/);
    }
    // Cross-check a runtime-generated real Rails salt obeys the same rule.
    const real = await hash('AnchorRealPassword!', 12);
    const realSalt = real.slice(7, 29);
    expect('.Oeu').toContain(realSalt[21]);
  });

  it('serves the population mix from a short-TTL cache on every prelogin path', async () => {
    const { app, db, secret } = await setup();
    const repository = new HonoAuthRepository(db);
    const first = await repository.preloginMix();
    // A migrated cost is observed in the mix: the seed carries cost 12.
    expect(first.costs).toEqual([12]);
    // A freshly seeded Argon2 account is invisible until the TTL lapses —
    // the mix is computed once and served from the cache in between.
    await db.insert(usersSqlite).values({
      passwordHash: await hash('CachedAnchorPassword123!', 4),
      firstName: 'Cached',
      lastName: 'Mix',
      isActive: true as const,
      email: 'cached-mix@prelogin.test',
      username: 'cached_mix',
      emailNormalized: normalizeSearchText('cached-mix@prelogin.test'),
      usernameNormalized: normalizeSearchText('cached_mix'),
      role: 'member',
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: base64(16),
      passwordParams: ARGON2ID_PARAMS_JSON,
      passwordVerifier: base64(32),
    });
    const cached = await repository.preloginMix();
    expect(cached).toEqual(first);
    // Once the TTL lapses the mix is recomputed and sees the new account.
    const refreshed = await repository.preloginMix(
      Date.now() + AUTH_PRELOGIN_MIX_TTL_MS + 1000
    );
    expect(refreshed.total).toBe(first.total + 1);
    expect(refreshed.upgraded).toBe(first.upgraded + 1);
    // And the service answers a fake prelogin from the very same cache.
    const response = await postPrelogin(app, {
      identifier: 'nobody@prelogin.test',
    });
    const body = await response.json();
    const mix = await repository.preloginMix();
    const expected = await deterministicPreloginFake(
      secret,
      normalizeSearchText('nobody@prelogin.test'),
      mix,
      mix.costs
    );
    expect(body).toEqual(expected);
  });

  it('gives the fake and a migrated row the same canonical bcrypt shape', async () => {
    // The all-migrated mix forces the bcrypt branch of the fake.
    const fake = await deterministicPreloginFake(
      'test-secret',
      'nobody@prelogin.test',
      { upgraded: 0, total: 1000 }
    );
    expect(fake.algorithm).toBe(RAILS_BCRYPT_ALGORITHM);
    // 22-character bcrypt salt, byte-exact with a Rails row, and a cost drawn
    // only from the set real Rails rows carry (finding 4).
    expect(fake.salt).toMatch(/^[./A-Za-z0-9]{22}$/);
    const params = fake.params as { cost: number };
    expect(BCRYPT_RAILS_COSTS as readonly number[]).toContain(params.cost);
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
