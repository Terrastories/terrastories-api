/**
 * Role-by-route matrix, part B (audit #145/#146 rows 76-79 and 87): sovereignty
 * writes (steward designation, withdrawal, erasure, cancel) and the super_admin
 * erasure listing. Every denied cell asserts the exact status and that the
 * stored state is unchanged after the denied write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  communityStewardsSqlite,
  communitySovereigntyRequestsSqlite,
} from '../../src/db/schema/community_sovereignty.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { normalizeSearchText } from '../../src/shared/utils/search-normalize.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';

const API_ORIGIN = 'https://api.example.test';

type Role =
  | 'anon'
  | 'viewer'
  | 'member'
  | 'editor'
  | 'steward'
  | 'admin'
  | 'super_admin'
  | 'foreign_admin';

type Creds = { derivedKey: string; salt: string; verifier: string };

async function makeCreds(): Promise<Creds> {
  const derivedKey = makeDerivedKey();
  return {
    derivedKey,
    salt: makeVerifierSalt(),
    verifier: await sha256Hex(derivedKey),
  };
}

async function setup() {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const currentNow = new Date('2026-11-21T10:00:00.000Z');

  const [alpha, foreign] = await db
    .insert(communitiesSqlite)
    .values([
      {
        name: 'Alpha Matrix',
        slug: 'alpha-matrix',
        locale: 'en',
        publicStories: true,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      },
      {
        name: 'Foreign Matrix',
        slug: 'foreign-matrix',
        locale: 'en',
        publicStories: true,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      },
    ])
    .returning();

  const insertUser = async (
    username: string,
    role: string,
    communityId: number | null
  ) => {
    const creds = await makeCreds();
    const email = `${username}@matrix.test`;
    const [row] = await db
      .insert(usersSqlite)
      .values({
        email,
        username,
        emailNormalized: normalizeSearchText(email),
        usernameNormalized: normalizeSearchText(username),
        firstName: username,
        lastName: 'User',
        ...(await argon2Seed(creds.derivedKey)),
        role,
        communityId,
        isActive: true,
        createdAt: currentNow,
        updatedAt: currentNow,
      })
      .returning();
    return { user: row!, creds };
  };

  const people = {
    admin: await insertUser('matrix_admin', 'admin', alpha!.id),
    viewer: await insertUser('matrix_viewer', 'viewer', alpha!.id),
    member: await insertUser('matrix_member', 'member', alpha!.id),
    steward: await insertUser('matrix_steward', 'member', alpha!.id),
    target: await insertUser('matrix_target', 'member', alpha!.id),
    editor: await insertUser('matrix_editor', 'editor', alpha!.id),
    super_admin: await insertUser('matrix_super', 'super_admin', null),
    foreign_admin: await insertUser('matrix_foreign', 'admin', foreign!.id),
  };

  const storage = {
    fenceCommunity: async () => {},
    read: async () => null,
    delete: async () => {},
    list: async () => ({ entries: [], truncated: false }),
  };
  const records = new Map<number, unknown>();
  const erasureStore = {
    list: async () => [...records.values()],
    write: async (r: { communityId: number }) => {
      records.set(r.communityId, structuredClone(r));
    },
  };
  const app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    storage,
    erasureStore,
    serverSecret: makeServerSecret(),
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    trustProxy: true,
    now: () => currentNow,
  } as never);

  const loginCookie = async (role: Exclude<Role, 'anon'>) => {
    const { user, creds } = people[role === 'steward' ? 'steward' : role];
    const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '198.51.100.10',
      },
      body: JSON.stringify({
        identifier: user.email,
        derivedKey: creds.derivedKey,
      }),
    });
    if (res.status !== 200) throw new Error(`login ${role} -> ${res.status}`);
    const match = /ts_session=([^;]+)/.exec(
      res.headers.get('set-cookie') ?? ''
    );
    return `ts_session=${match![1]}`;
  };

  const call = (
    method: string,
    path: string,
    cookie?: string,
    body?: unknown
  ) => {
    const headers: Record<string, string> = {
      'x-forwarded-for': '198.51.100.10',
    };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return app.request(`${API_ORIGIN}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  /** Admin designates the "steward" member, as the real flow requires. */
  const designateSteward = async () => {
    const res = await call(
      'PUT',
      '/v2/community/steward',
      await loginCookie('admin'),
      {
        stewardUserId: people.steward.user.id,
        currentDerivedKey: people.admin.creds.derivedKey,
      }
    );
    if (res.status !== 200) throw new Error(`designate -> ${res.status}`);
  };

  /** Stored state the denied writes must not change. */
  const snapshot = async () =>
    JSON.stringify({
      communities: (await db.select().from(communitiesSqlite)).map((c) => [
        c.id,
        c.isActive,
      ]),
      stewards: await db.select().from(communityStewardsSqlite),
      requests: await db.select().from(communitySovereigntyRequestsSqlite),
      records: [...records.entries()],
    });

  return {
    db,
    app,
    call,
    loginCookie,
    designateSteward,
    snapshot,
    people,
    alpha: alpha!,
    foreign: foreign!,
    records,
  };
}

type Cell = { status: number };
type RouteCase = {
  name: string;
  method: 'PUT' | 'POST' | 'GET';
  path: string;
  /** Extra setup run by the admin / steward before the matrix request. */
  prepare: (
    ctx: Awaited<ReturnType<typeof setup>>
  ) => Promise<{ requestId?: number }>;
  body?: (
    role: Role,
    key: string,
    ctx: Awaited<ReturnType<typeof setup>>,
    extra: { requestId?: number }
  ) => unknown;
  expect: Partial<Record<Role, Cell>>;
};

const noPrep = async () => ({});
const withSteward = async (ctx: Awaited<ReturnType<typeof setup>>) => {
  await ctx.designateSteward();
  return {};
};

const ROUTES: RouteCase[] = [
  {
    name: 'PUT /v2/community/steward',
    method: 'PUT',
    path: '/v2/community/steward',
    prepare: withSteward,
    body: (_role, key, ctx) => ({
      stewardUserId: ctx.people.target.user.id,
      currentDerivedKey: key,
    }),
    expect: {
      anon: { status: 401 },
      viewer: { status: 403 },
      member: { status: 403 },
      editor: { status: 403 },
      steward: { status: 403 },
      admin: { status: 200 },
      super_admin: { status: 403 },
      foreign_admin: { status: 404 },
    },
  },
  {
    name: 'POST /v2/community/withdrawal',
    method: 'POST',
    path: '/v2/community/withdrawal',
    prepare: withSteward,
    body: (role, key, ctx) =>
      role === 'super_admin'
        ? { communitySlug: ctx.alpha.slug, currentDerivedKey: key }
        : { currentDerivedKey: key },
    expect: {
      anon: { status: 401 },
      viewer: { status: 403 },
      member: { status: 403 },
      editor: { status: 403 },
      steward: { status: 202 },
      admin: { status: 200 },
      super_admin: { status: 403 },
    },
  },
  {
    name: 'POST /v2/community/erasure',
    method: 'POST',
    path: '/v2/community/erasure',
    prepare: withSteward,
    body: (role, key, ctx) =>
      role === 'super_admin'
        ? {
            communitySlug: ctx.alpha.slug,
            confirmFinality: true,
            currentDerivedKey: key,
          }
        : { confirmFinality: true, currentDerivedKey: key },
    expect: {
      anon: { status: 401 },
      viewer: { status: 403 },
      member: { status: 403 },
      editor: { status: 403 },
      steward: { status: 202 },
      admin: { status: 202 },
      super_admin: { status: 403 },
    },
  },
  {
    name: 'POST /v2/community/sovereignty/cancel',
    method: 'POST',
    path: '/v2/community/sovereignty/cancel',
    prepare: async (ctx) => {
      await ctx.designateSteward();
      const res = await ctx.call(
        'POST',
        '/v2/community/withdrawal',
        await ctx.loginCookie('steward'),
        { currentDerivedKey: ctx.people.steward.creds.derivedKey }
      );
      if (res.status !== 202) throw new Error(`notice -> ${res.status}`);
      const body = (await res.json()) as { data: { request: { id: number } } };
      return { requestId: body.data.request.id };
    },
    body: (_role, key, _ctx, extra) => ({
      requestId: extra.requestId,
      currentDerivedKey: key,
    }),
    expect: {
      anon: { status: 401 },
      viewer: { status: 403 },
      member: { status: 403 },
      editor: { status: 403 },
      steward: { status: 403 },
      admin: { status: 200 },
      super_admin: { status: 403 },
    },
  },
];

const ROLE_KEY: Record<
  Role,
  keyof Awaited<ReturnType<typeof setup>>['people'] | null
> = {
  anon: null,
  viewer: 'viewer',
  member: 'member',
  editor: 'editor',
  steward: 'steward',
  admin: 'admin',
  super_admin: 'super_admin',
  foreign_admin: 'foreign_admin',
};

const MATRIX = ROUTES.flatMap((route) =>
  (Object.keys(route.expect) as Role[]).map((role) => ({ route, role }))
);

describe('role matrix B: sovereignty writes', () => {
  const dbs: Sqlite.Database[] = [];
  afterEach(() => {
    while (dbs.length > 0) dbs.pop()?.close();
  });

  it.each(MATRIX.map((c) => [`${c.route.name} as ${c.role}`, c] as const))(
    '%s',
    async (_label, { route, role }) => {
      const ctx = await setup();
      const extra = await route.prepare(ctx);
      const key = ROLE_KEY[role]
        ? ctx.people[ROLE_KEY[role]!].creds.derivedKey
        : '';
      const cookie = role === 'anon' ? undefined : await ctx.loginCookie(role);
      const body = route.body ? route.body(role, key, ctx, extra) : undefined;
      const before = await ctx.snapshot();

      const res = await ctx.call(route.method, route.path, cookie, body);
      const expected = route.expect[role]!;
      expect(res.status).toBe(expected.status);

      if (expected.status >= 400) {
        // Denied: the stored state is byte-identical after the write.
        expect(await ctx.snapshot()).toBe(before);
        const json = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(json)).toEqual(['error']);
      }
    }
  );
});

describe('role matrix B: super_admin erasure listing', () => {
  const ROLES: Role[] = [
    'anon',
    'viewer',
    'member',
    'editor',
    'steward',
    'admin',
    'foreign_admin',
    'super_admin',
  ];
  it.each(ROLES.map((role) => [role, role] as const))(
    'GET /v2/admin/erasures as %s',
    async (_label, role) => {
      const ctx = await setup();
      await ctx.designateSteward();
      const cookie = role === 'anon' ? undefined : await ctx.loginCookie(role);
      const before = await ctx.snapshot();
      const res = await ctx.call('GET', '/v2/admin/erasures', cookie);
      const json = (await res.json()) as Record<string, unknown>;
      if (role === 'super_admin') {
        expect(res.status).toBe(200);
        expect(Array.isArray(json.data)).toBe(true);
        return;
      }
      expect(res.status).toBe(role === 'anon' ? 401 : 403);
      expect(json).not.toHaveProperty('data');
      expect(await ctx.snapshot()).toBe(before);
    }
  );
});
