/**
 * Focused tests for content-free auth/security audit entries (#137 item 5,
 * SPEC-V2 §6.8, §7 "Audit logging").
 *
 * Login success/failure, wrapped-bcrypt upgrade, password change, logout and
 * explicit revoke each write one entry with actor/community/outcome and — on
 * auth events only — IP/user-agent. Entries never carry credentials, tokens,
 * identifiers or content. The 90-day network-metadata scrub nulls only
 * `ip_address`/`user_agent` and leaves every other column intact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { eq } from 'drizzle-orm';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { auditEntriesSqlite } from '../../src/db/schema/audit_entries.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  RAILS_BCRYPT_ALGORITHM,
} from '../../src/shared/auth-policy.js';
import {
  validateContentFreeAuditEntry,
  AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS,
} from '../../src/shared/utils/audit-entry.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import { scrubExpiredAuditNetworkMetadata } from '../../src/repositories/audit-entry.repository.js';

describe('Auth audit entries (#137 item 5)', () => {
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

    const passwordHash = await hash('LegacyAnchorPassword!', 4);
    const [alpha] = await db
      .insert(communitiesSqlite)
      .values({
        name: 'Audit Alpha',
        slug: 'audit-alpha',
        publicStories: true,
        isActive: true,
      })
      .returning();

    const upgradedKey = makeDerivedKey();
    const upgradedSeed = await argon2Seed(upgradedKey);
    const wrappedKey = makeDerivedKey();
    const wrappedVerifier = await sha256Hex(wrappedKey);
    const base = {
      passwordHash,
      firstName: 'Audit',
      lastName: 'Seed',
      isActive: true as const,
    };
    await db.insert(usersSqlite).values([
      {
        ...base,
        ...upgradedSeed,
        email: 'upgraded@audit.example.test',
        username: 'upgraded_alpha',
        emailNormalized: normalizeSearchText('upgraded@audit.example.test'),
        usernameNormalized: normalizeSearchText('upgraded_alpha'),
        role: 'member',
        communityId: alpha.id,
      },
      {
        ...base,
        email: 'wrapped@audit.example.test',
        username: 'wrapped_alpha',
        emailNormalized: normalizeSearchText('wrapped@audit.example.test'),
        usernameNormalized: normalizeSearchText('wrapped_alpha'),
        role: 'member',
        communityId: alpha.id,
        passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
        passwordSalt: makeVerifierSalt(),
        passwordParams: JSON.stringify({ cost: 12 }),
        passwordVerifier: wrappedVerifier,
      },
    ]);

    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      storage: { read: async () => null },
      serverSecret: makeServerSecret(),
      secureCookies: false,
    });
    const request = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {}
    ) =>
      app.request(`http://test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const login = (
      body: unknown,
      headers: Record<string, string> = {}
    ): Promise<Response> => request('/v2/auth/login', body, headers);
    const password = (
      body: unknown,
      cookie: string,
      headers: Record<string, string> = {}
    ): Promise<Response> =>
      app.request('http://test/v2/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie, ...headers },
        body: JSON.stringify(body),
      });
    const logout = (
      cookie: string,
      headers: Record<string, string> = {}
    ): Promise<Response> =>
      app.request('http://test/v2/auth/logout', {
        method: 'POST',
        headers: { cookie, ...headers },
      });
    const revoke = (
      cookie: string,
      headers: Record<string, string> = {}
    ): Promise<Response> =>
      app.request('http://test/v2/auth/revoke', {
        method: 'POST',
        headers: { cookie, ...headers },
      });
    const entries = () => db.select().from(auditEntriesSqlite);
    return {
      app,
      db,
      alpha,
      upgradedKey,
      wrappedKey,
      login,
      password,
      logout,
      revoke,
      entries,
    };
  }

  const validated = (rows: Array<Record<string, unknown>>) =>
    rows.map((row) =>
      validateContentFreeAuditEntry({
        communityId: row.communityId,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceIds: row.resourceIds,
        outcome: row.outcome,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
      })
    );

  it('writes a content-free auth.login success entry with IP and user-agent', async () => {
    const { alpha, login, entries, upgradedKey } = await setup();
    const response = await login(
      {
        identifier: 'upgraded@audit.example.test',
        derivedKey: upgradedKey,
      },
      {
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'Slice10-Agent/1.0',
      }
    );
    expect(response.status).toBe(200);
    const rows = await entries();
    expect(rows).toHaveLength(1);
    const [entry] = validated(rows);
    expect(entry).toMatchObject({
      communityId: alpha.id,
      actorId: 1,
      action: 'auth.login',
      outcome: 'success',
      resourceType: 'auth',
      resourceIds: [1],
      ipAddress: '203.0.113.7',
      userAgent: 'Slice10-Agent/1.0',
    });
    // No credential, key, identifier or content leaks into the serialized row.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(upgradedKey);
    expect(serialized).not.toContain('upgraded@audit.example.test');
  });

  it('writes an auth.login failure entry with no account for an unknown identifier', async () => {
    const { login, entries } = await setup();
    const response = await login({
      identifier: 'nobody@audit.example.test',
      derivedKey: makeDerivedKey(),
    });
    expect(response.status).toBe(401);
    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(validated(rows)[0]).toMatchObject({
      communityId: null,
      actorId: null,
      action: 'auth.login',
      outcome: 'failure',
      resourceType: 'auth',
      resourceIds: [],
    });
  });

  it('writes an auth.login failure entry bound to the resolved account', async () => {
    const { alpha, login, entries } = await setup();
    const response = await login({
      identifier: 'upgraded@audit.example.test',
      derivedKey: makeDerivedKey(),
    });
    expect(response.status).toBe(401);
    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(validated(rows)[0]).toMatchObject({
      communityId: alpha.id,
      actorId: 1,
      action: 'auth.login',
      outcome: 'failure',
      resourceIds: [1],
    });
  });

  it('writes an auth.upgrade entry when a wrapped bcrypt login upgrades atomically', async () => {
    const { alpha, login, entries, wrappedKey } = await setup();
    const upgradedKey = makeDerivedKey();
    const response = await login({
      identifier: 'wrapped@audit.example.test',
      derivedKey: wrappedKey,
      upgrade: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: upgradedKey,
      },
    });
    expect(response.status).toBe(200);
    const actions = (await entries()).map((row) => row.action).sort();
    expect(actions).toEqual(['auth.login', 'auth.upgrade']);
    const upgrade = validated(await entries()).find(
      (entry) => entry.action === 'auth.upgrade'
    );
    expect(upgrade).toMatchObject({
      communityId: alpha.id,
      actorId: 2,
      outcome: 'success',
      resourceIds: [2],
    });
    // A later plain Argon2id login does not emit another upgrade entry.
    const plain = await login({
      identifier: 'wrapped@audit.example.test',
      derivedKey: upgradedKey,
    });
    expect(plain.status).toBe(200);
    const actionsAfter = (await entries()).map((row) => row.action).sort();
    expect(actionsAfter).toEqual(['auth.login', 'auth.login', 'auth.upgrade']);
  });

  it('writes auth.password.change entries for success and wrong-key failure', async () => {
    const { alpha, login, password, entries, upgradedKey } = await setup();
    const first = await login({
      identifier: 'upgraded@audit.example.test',
      derivedKey: upgradedKey,
    });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const wrongKey = await password(
      {
        currentDerivedKey: makeDerivedKey(),
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      cookie,
      { 'user-agent': 'Audit-Agent/2.0' }
    );
    expect(wrongKey.status).toBe(401);
    const changed = await password(
      {
        currentDerivedKey: upgradedKey,
        algorithm: ARGON2ID_ALGORITHM,
        salt: makeVerifierSalt(),
        params: { ...ARGON2ID_PARAMS },
        derivedKey: makeDerivedKey(),
      },
      cookie,
      { 'user-agent': 'Audit-Agent/2.0' }
    );
    expect(changed.status).toBe(200);
    const rows = validated(await entries());
    const failures = rows.filter(
      (entry) =>
        entry.action === 'auth.password.change' && entry.outcome === 'failure'
    );
    const successes = rows.filter(
      (entry) =>
        entry.action === 'auth.password.change' && entry.outcome === 'success'
    );
    expect(failures).toHaveLength(1);
    expect(successes).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      communityId: alpha.id,
      actorId: 1,
      resourceIds: [1],
      userAgent: 'Audit-Agent/2.0',
    });
    expect(successes[0]).toMatchObject({
      communityId: alpha.id,
      actorId: 1,
      userAgent: 'Audit-Agent/2.0',
    });
  });

  it('writes auth.logout and auth.session.revoke entries with session resource type', async () => {
    const { alpha, login, logout, revoke, entries, upgradedKey } =
      await setup();
    const first = await login({
      identifier: 'upgraded@audit.example.test',
      derivedKey: upgradedKey,
    });
    const cookieA = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(
      (await logout(cookieA, { 'user-agent': 'Logout-Agent/1.0' })).status
    ).toBe(204);
    const second = await login({
      identifier: 'upgraded@audit.example.test',
      derivedKey: upgradedKey,
    });
    const cookieB =
      (second.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(
      (await revoke(cookieB, { 'user-agent': 'Revoke-Agent/1.0' })).status
    ).toBe(204);
    const rows = validated(await entries());
    const logoutEntry = rows.find((entry) => entry.action === 'auth.logout');
    const revokeEntry = rows.find(
      (entry) => entry.action === 'auth.session.revoke'
    );
    expect(logoutEntry).toMatchObject({
      communityId: alpha.id,
      actorId: 1,
      resourceType: 'session',
      outcome: 'success',
      userAgent: 'Logout-Agent/1.0',
    });
    expect(revokeEntry).toMatchObject({
      communityId: alpha.id,
      actorId: 1,
      resourceType: 'session',
      outcome: 'success',
      userAgent: 'Revoke-Agent/1.0',
    });
  });

  it('truncates an oversized user-agent instead of logging unbounded bytes', async () => {
    const { login, entries, upgradedKey } = await setup();
    const oversized = 'A'.repeat(600);
    const response = await login(
      {
        identifier: 'upgraded@audit.example.test',
        derivedKey: upgradedKey,
      },
      { 'user-agent': oversized }
    );
    expect(response.status).toBe(200);
    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userAgent?.length).toBe(512);
  });

  it('scrubs only ip_address and user_agent past the retention deadline', async () => {
    const { db, alpha } = await setup();
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const recent = new Date();
    await db.insert(auditEntriesSqlite).values([
      {
        communityId: alpha.id,
        actorId: 1,
        action: 'auth.login',
        resourceType: 'auth',
        resourceIds: [1],
        outcome: 'success',
        ipAddress: '203.0.113.9',
        userAgent: 'old-agent',
        createdAt: old,
      },
      {
        communityId: alpha.id,
        actorId: 1,
        action: 'auth.login',
        resourceType: 'auth',
        resourceIds: [1],
        outcome: 'failure',
        ipAddress: null,
        userAgent: 'old-agent-only',
        createdAt: old,
      },
      {
        communityId: alpha.id,
        actorId: 1,
        action: 'auth.login',
        resourceType: 'auth',
        resourceIds: [1],
        outcome: 'success',
        ipAddress: '203.0.113.10',
        userAgent: 'new-agent',
        createdAt: recent,
      },
    ]);
    const result = await scrubExpiredAuditNetworkMetadata(db);
    expect(result.scrubbedCount).toBe(2);
    const rows = await db.select().from(auditEntriesSqlite);
    // Both old entries are scrubbed; the recent one is untouched.
    expect(rows.filter((row) => row.ipAddress === null)).toHaveLength(2);
    expect(rows.filter((row) => row.userAgent === null)).toHaveLength(2);
    const recentRow = rows.find(
      (row) => row.createdAt.getTime() === recent.getTime()
    );
    expect(recentRow?.ipAddress).toBe('203.0.113.10');
    expect(recentRow?.userAgent).toBe('new-agent');
    // Action, actor, resource and outcome survive the scrub untouched.
    for (const row of rows) {
      expect(row.action).toBe('auth.login');
      expect(row.actorId).toBe(1);
      expect(row.resourceIds).toEqual([1]);
    }
  });

  it('names the retention constant explicitly', () => {
    expect(AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS).toBe(90);
  });
});
