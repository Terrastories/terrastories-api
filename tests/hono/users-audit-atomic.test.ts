/**
 * Focused tests for Slice 11a audit atomicity (#188): the assisted-recovery
 * writes and their content-free audit rows commit in ONE unit — a D1 batch,
 * or a transaction on SQLite/PostgreSQL. An injected audit failure rolls the
 * issuance/reset back: no code row is left behind, the anchor is untouched,
 * and no session is revoked. SPEC-V2 §6.8, §7; route registry §6.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { ARGON2ID_PARAMS_JSON } from '../../src/shared/auth-policy.js';

const T0 = new Date('2026-06-01T12:00:00.000Z');
const TEST_DERIVED_KEY = makeDerivedKey();
const API_ORIGIN = 'https://api.example.test';

const verifierBody = (derivedKey: string) => ({
  algorithm: 'client-argon2id+sha256',
  salt: makeVerifierSalt(),
  params: JSON.parse(ARGON2ID_PARAMS_JSON),
  derivedKey,
});

function makeDb() {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  const tables = tablesFor(db);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  return { sqlite, db, tables };
}

const healthy = makeDb();
const broken = makeDb();

let healthyApp: ReturnType<typeof createHonoApp>;
let brokenApp: ReturnType<typeof createHonoApp>;
const healthyIds: Record<string, number> = {};
const brokenIds: Record<string, number> = {};
let healthyAdminCookie = '';
let brokenAdminCookie = '';

async function seedCommunity(ctx: {
  db: typeof healthy.db;
  tables: typeof healthy.tables;
  label: string;
}) {
  const { tables } = ctx;
  const [community] = await ctx.db
    .insert(tables.communities)
    .values({
      name: `${ctx.label} Nation`,
      slug: `${ctx.label.toLowerCase()}-nation-${Date.now()}`,
      locale: 'en',
      publicStories: false,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: tables.communities.id });
  const communityId = community.id;
  const seedUser = async (email: string, role: string, username: string) =>
    ctx.db
      .insert(tables.users)
      .values({
        email,
        username,
        ...deriveUserIdentityColumns({ email, username }),
        firstName: role,
        lastName: 'Tester',
        ...(await argon2Seed(TEST_DERIVED_KEY)),
        role,
        communityId,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: tables.users.id })
      .then((rows) => rows[0]!.id);
  const stamp = Date.now();
  const adminId = await seedUser(
    `${ctx.label.toLowerCase()}-admin-${stamp}@example.test`,
    'admin',
    `qa_${ctx.label.toLowerCase()}_admin_${stamp}`
  );
  const targetId = await seedUser(
    `${ctx.label.toLowerCase()}-target-${stamp}@example.test`,
    'editor',
    `qa_${ctx.label.toLowerCase()}_target_${stamp}`
  );
  return { communityId, adminId, targetId };
}

async function login(
  app: ReturnType<typeof createHonoApp>,
  db: typeof healthy.db,
  tables: typeof healthy.tables,
  communityId: number,
  email: string
): Promise<string> {
  const [row] = await db
    .select({ slug: tables.communities.slug })
    .from(tables.communities)
    .where(eq(tables.communities.id, communityId))
    .limit(1);
  const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey: TEST_DERIVED_KEY,
      communitySlug: row?.slug,
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function requestJson(
  app: ReturnType<typeof createHonoApp>,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = { cookie: options.cookie ?? '' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(`${API_ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

beforeAll(async () => {
  const healthyCommunity = await seedCommunity({
    db: healthy.db,
    tables: healthy.tables,
    label: 'Healthy',
  });
  healthyIds.community = healthyCommunity.communityId;
  healthyIds.admin = healthyCommunity.adminId;
  healthyIds.target = healthyCommunity.targetId;
  healthyApp = createHonoApp({
    repository: new HonoFoundationRepository(healthy.db),
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  });

  const brokenCommunity = await seedCommunity({
    db: broken.db,
    tables: broken.tables,
    label: 'Broken',
  });
  brokenIds.community = brokenCommunity.communityId;
  brokenIds.admin = brokenCommunity.adminId;
  brokenIds.target = brokenCommunity.targetId;

  const brokenAdminEmail = (
    await broken.db
      .select({ email: broken.tables.users.email })
      .from(broken.tables.users)
      .where(eq(broken.tables.users.id, brokenIds.admin))
      .limit(1)
  )[0]!.email;
  const brokenTargetEmail = (
    await broken.db
      .select({ email: broken.tables.users.email })
      .from(broken.tables.users)
      .where(eq(broken.tables.users.id, brokenIds.target))
      .limit(1)
  )[0]!.email;

  brokenApp = createHonoApp({
    repository: new HonoFoundationRepository(broken.db),
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  });
  brokenAdminCookie = await login(
    brokenApp,
    broken.db,
    broken.tables,
    brokenIds.community,
    brokenAdminEmail
  );
  // Establish a standard session for the target before the audit table is
  // dropped, so the rollback assertions can cover session revocation too.
  await login(
    brokenApp,
    broken.db,
    broken.tables,
    brokenIds.community,
    brokenTargetEmail
  );
  // Inject the audit failure: the audit sink is gone entirely.
  broken.sqlite.exec('DROP TABLE audit_entries');

  const healthyAdminEmail = (
    await healthy.db
      .select({ email: healthy.tables.users.email })
      .from(healthy.tables.users)
      .where(eq(healthy.tables.users.id, healthyIds.admin))
      .limit(1)
  )[0]!.email;
  healthyAdminCookie = await login(
    healthyApp,
    healthy.db,
    healthy.tables,
    healthyIds.community,
    healthyAdminEmail
  );
});

afterAll(() => {
  healthy.sqlite.close();
  broken.sqlite.close();
});

describe('audit row is atomic with the assisted-recovery write', () => {
  it('an issuance writes exactly one content-free audit entry', async () => {
    const before = await healthy.db
      .select({ id: healthy.tables.auditEntries.id })
      .from(healthy.tables.auditEntries)
      .where(eq(healthy.tables.auditEntries.action, 'user.login_code_issue'));
    const res = await requestJson(
      healthyApp,
      'POST',
      `/v2/users/${healthyIds.target}/login-codes`,
      { cookie: healthyAdminCookie }
    );
    expect(res.status).toBe(201);
    const rows = await healthy.db
      .select()
      .from(healthy.tables.auditEntries)
      .where(eq(healthy.tables.auditEntries.action, 'user.login_code_issue'));
    expect(rows.length).toBe(before.length + 1);
    const last = rows[rows.length - 1]!;
    expect(last.outcome).toBe('success');
    expect(last.resourceIds).toEqual([healthyIds.target]);
    expect(last.communityId).toBe(healthyIds.community);
    expect(last.actorId).toBe(healthyIds.admin);
  });

  it('a password reset writes exactly one content-free audit entry', async () => {
    const before = await healthy.db
      .select({ id: healthy.tables.auditEntries.id })
      .from(healthy.tables.auditEntries)
      .where(eq(healthy.tables.auditEntries.action, 'user.password_reset'));
    const res = await requestJson(
      healthyApp,
      'POST',
      `/v2/users/${healthyIds.target}/password-reset`,
      { cookie: healthyAdminCookie, body: verifierBody(makeDerivedKey()) }
    );
    expect(res.status).toBe(204);
    const rows = await healthy.db
      .select()
      .from(healthy.tables.auditEntries)
      .where(eq(healthy.tables.auditEntries.action, 'user.password_reset'));
    expect(rows.length).toBe(before.length + 1);
    const last = rows[rows.length - 1]!;
    expect(last.outcome).toBe('success');
    expect(last.resourceIds).toEqual([healthyIds.target]);
  });

  it('an injected audit failure leaves no LoginCode behind and resets nothing', async () => {
    const [targetRowBefore] = await broken.db
      .select({
        passwordVerifier: broken.tables.users.passwordVerifier,
        passwordSalt: broken.tables.users.passwordSalt,
      })
      .from(broken.tables.users)
      .where(eq(broken.tables.users.id, brokenIds.target))
      .limit(1);
    const sessionsBefore = await broken.db
      .select({ id: broken.tables.sessions.id })
      .from(broken.tables.sessions)
      .where(eq(broken.tables.sessions.userId, brokenIds.target));
    expect(sessionsBefore.length).toBeGreaterThan(0);

    const reset = await requestJson(
      brokenApp,
      'POST',
      `/v2/users/${brokenIds.target}/password-reset`,
      { cookie: brokenAdminCookie, body: verifierBody(makeDerivedKey()) }
    );
    expect(reset.status).toBe(503);

    const issue = await requestJson(
      brokenApp,
      'POST',
      `/v2/users/${brokenIds.target}/login-codes`,
      { cookie: brokenAdminCookie }
    );
    expect(issue.status).toBe(503);

    // The coupled write rolled back with the audit sink.
    const [targetRowAfter] = await broken.db
      .select({
        passwordVerifier: broken.tables.users.passwordVerifier,
        passwordSalt: broken.tables.users.passwordSalt,
      })
      .from(broken.tables.users)
      .where(eq(broken.tables.users.id, brokenIds.target))
      .limit(1);
    expect(targetRowAfter?.passwordVerifier).toBe(
      targetRowBefore?.passwordVerifier
    );
    expect(targetRowAfter?.passwordSalt).toBe(targetRowBefore?.passwordSalt);
    const sessionsAfter = await broken.db
      .select({ id: broken.tables.sessions.id })
      .from(broken.tables.sessions)
      .where(eq(broken.tables.sessions.userId, brokenIds.target));
    expect(sessionsAfter.length).toBe(sessionsBefore.length);

    const codeCount = await broken.db
      .select({ id: broken.tables.loginCodes.id })
      .from(broken.tables.loginCodes);
    expect(codeCount).toEqual([]);
  });
});
