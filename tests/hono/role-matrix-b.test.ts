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
import { tablesFor } from '../../src/db/dialect.js';
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

/** Every SQLite handle opened by setup(); closed after each test. */
const openDbs: Sqlite.Database[] = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

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
  openDbs.push(sqlite);
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

  const fenced: number[] = [];
  const objects = new Map<string, Uint8Array>();
  const storage = {
    fenceCommunity: async (communityId: number) => {
      fenced.push(communityId);
    },
    read: async () => null,
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async (options?: { prefix?: string; limit?: number }) => {
      const keys = [...objects.keys()]
        .filter((k) => k.startsWith(options?.prefix ?? ''))
        .sort();
      const limit = options?.limit ?? 20;
      return {
        entries: keys.slice(0, limit).map((key) => ({
          key,
          uploaded: new Date('2026-11-21T10:00:00.000Z'),
        })),
        truncated: keys.length > limit,
      };
    },
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
      objects: [...objects.keys()].sort(),
      fenced,
    });

  return {
    objects,
    fenced,
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
const seedThenSteward = async (ctx: Awaited<ReturnType<typeof setup>>) => {
  ctx.objects.set(
    `communities/${ctx.alpha.id}/media/test-object`,
    new Uint8Array([1])
  );
  ctx.objects.set(
    `communities/${ctx.foreign.id}/media/test-object`,
    new Uint8Array([2])
  );
  await ctx.db.insert(tablesFor(ctx.db).stories).values({
    title: 'Alpha Story',
    slug: 'alpha-story',
    privacyLevel: 'public',
    isRestricted: false,
    communityId: ctx.alpha.id,
    createdBy: ctx.people.admin.user.id,
    createdAt: new Date('2026-11-21T10:00:00.000Z'),
    updatedAt: new Date('2026-11-21T10:00:00.000Z'),
  });
  await ctx.designateSteward();
  return {};
};
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
    prepare: seedThenSteward,
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

type Ctx = Awaited<ReturnType<typeof setup>>;

const DENIED_BODY: Record<number, unknown> = {
  401: { error: 'Unauthorized' },
  403: { error: 'Forbidden' },
  404: { error: 'Not found' },
  409: { error: 'Conflict' },
};

/** A third community with its own admin; its erasure fences only itself. */
async function seedThirdAdmin(ctx: Ctx) {
  const now = new Date('2026-11-21T10:00:00.000Z');
  const [community] = await ctx.db
    .insert(communitiesSqlite)
    .values({
      name: 'Third Sov',
      slug: 'third-sov',
      locale: 'en',
      publicStories: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const key = makeDerivedKey();
  const email = 'admin@third.test';
  await ctx.db.insert(usersSqlite).values({
    email,
    username: 'third_admin',
    emailNormalized: normalizeSearchText(email),
    usernameNormalized: normalizeSearchText('third_admin'),
    firstName: 'third_admin',
    lastName: 'User',
    ...(await argon2Seed(key)),
    role: 'admin',
    communityId: community!.id,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  return { community: community!, email, key };
}

async function loginWith(
  ctx: Ctx,
  email: string,
  key: string
): Promise<string> {
  const res = await ctx.app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '198.51.100.10',
    },
    body: JSON.stringify({ identifier: email, derivedKey: key }),
  });
  expect(res.status).toBe(200);
  return `ts_session=${/ts_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`;
}

/** Alpha's stories: the relational content an erasure must purge. */
const alphaStories = async (ctx: Ctx) =>
  (await ctx.db.select().from(tablesFor(ctx.db).stories)).filter(
    (s) => s.communityId === ctx.alpha.id
  );

/** Read-back for each allowed cell: the stored effect of the write must be visible. */
const VERIFY: Record<
  string,
  (ctx: Ctx, extra: { requestId?: number }, role: Role) => Promise<void>
> = {
  'PUT /v2/community/steward': async (ctx) => {
    const rows = await ctx.db.select().from(communityStewardsSqlite);
    const row = rows.find((r) => r.userId === ctx.people.target.user.id);
    expect(row?.communityId).toBe(ctx.alpha.id);
  },
  'POST /v2/community/withdrawal': async (ctx, _extra, role) => {
    const [alpha] = (await ctx.db.select().from(communitiesSqlite)).filter(
      (c) => c.id === ctx.alpha.id
    );
    if (role === 'admin') {
      expect(alpha?.isActive).toBe(false);
      return;
    }
    expect(alpha?.isActive).toBe(true);
    const rows = (
      await ctx.db.select().from(communitySovereigntyRequestsSqlite)
    ).filter((r) => r.communityId === ctx.alpha.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'withdrawal', state: 'notice' });
  },
  'POST /v2/community/erasure': async (ctx, _extra, role) => {
    const alphaObjects = [...ctx.objects.keys()].filter((k) =>
      k.startsWith(`communities/${ctx.alpha.id}/`)
    );
    const foreignObjects = [...ctx.objects.keys()].filter((k) =>
      k.startsWith(`communities/${ctx.foreign.id}/`)
    );
    expect(foreignObjects).toHaveLength(1);
    if (role === 'admin') {
      expect(ctx.records.has(ctx.alpha.id)).toBe(true);
      expect(ctx.fenced).toEqual([ctx.alpha.id]);
      expect(alphaObjects).toHaveLength(0);
      return;
    }
    const rows = (
      await ctx.db.select().from(communitySovereigntyRequestsSqlite)
    ).filter((r) => r.communityId === ctx.alpha.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'erasure', state: 'notice' });
    expect(rows[0]?.noticeEndsAt).not.toBeNull();
    const [alpha] = (await ctx.db.select().from(communitiesSqlite)).filter(
      (c) => c.id === ctx.alpha.id
    );
    expect(alpha?.isActive).toBe(true);
    expect(ctx.fenced).toHaveLength(0);
    expect(alphaObjects).toHaveLength(1);
    expect(await alphaStories(ctx)).toHaveLength(1);
  },
  'POST /v2/community/sovereignty/cancel': async (ctx, extra) => {
    const rows = await ctx.db.select().from(communitySovereigntyRequestsSqlite);
    const row = rows.find((r) => r.id === extra.requestId);
    expect(row).toMatchObject({ state: 'cancelled' });
    expect(row?.cancelledAt).not.toBeNull();
  },
};

describe('role matrix B: sovereignty writes', () => {
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
        expect(json).toEqual(DENIED_BODY[expected.status]);
      } else {
        await VERIFY[route.name]?.(ctx, extra, role);
      }
    }
  );
});

describe('role matrix B: foreign admin acts only on own community', () => {
  /** Alpha's stored state; the foreign admin's writes must leave it untouched. */
  const alphaState = async (ctx: Awaited<ReturnType<typeof setup>>) => {
    const alphaId = ctx.alpha.id;
    const rows = <T extends { communityId?: number | null }>(all: T[]) =>
      all.filter((r) => r.communityId === alphaId);
    return JSON.stringify({
      community: (await ctx.db.select().from(communitiesSqlite)).filter(
        (c) => c.id === alphaId
      ),
      stewards: rows(await ctx.db.select().from(communityStewardsSqlite)),
      requests: rows(
        await ctx.db.select().from(communitySovereigntyRequestsSqlite)
      ),
      record: ctx.records.get(alphaId) ?? null,
    });
  };

  /** Alpha has a steward notice pending, so cancel has a real target. */
  async function alphaNotice() {
    const ctx = await setup();
    await ctx.designateSteward();
    const res = await ctx.call(
      'POST',
      '/v2/community/withdrawal',
      await ctx.loginCookie('steward'),
      {
        currentDerivedKey: ctx.people.steward.creds.derivedKey,
      }
    );
    expect(res.status).toBe(202);
    const requestId = (
      (await res.json()) as { data: { request: { id: number } } }
    ).data.request.id;
    return { ctx, requestId };
  }

  it('foreign admin withdrawal deactivates only the foreign community', async () => {
    const { ctx } = await alphaNotice();
    const before = await alphaState(ctx);
    const res = await ctx.call(
      'POST',
      '/v2/community/withdrawal',
      await ctx.loginCookie('foreign_admin'),
      {
        currentDerivedKey: ctx.people.foreign_admin.creds.derivedKey,
      }
    );
    expect(res.status).toBe(200);
    const foreign = (await ctx.db.select().from(communitiesSqlite)).find(
      (c) => c.id === ctx.foreign.id
    );
    expect(foreign?.isActive).toBe(false);
    expect(await alphaState(ctx)).toBe(before);
  });

  it('foreign admin erasure writes only the foreign community record', async () => {
    const { ctx } = await alphaNotice();
    const before = await alphaState(ctx);
    const res = await ctx.call(
      'POST',
      '/v2/community/erasure',
      await ctx.loginCookie('foreign_admin'),
      {
        confirmFinality: true,
        currentDerivedKey: ctx.people.foreign_admin.creds.derivedKey,
      }
    );
    expect(res.status).toBe(202);
    expect(ctx.records.has(ctx.foreign.id)).toBe(true);
    expect(await alphaState(ctx)).toBe(before);
  });

  it('foreign admin cannot cancel alpha notice and leaves it pending', async () => {
    const { ctx, requestId } = await alphaNotice();
    const before = await alphaState(ctx);
    const res = await ctx.call(
      'POST',
      '/v2/community/sovereignty/cancel',
      await ctx.loginCookie('foreign_admin'),
      {
        requestId,
        currentDerivedKey: ctx.people.foreign_admin.creds.derivedKey,
      }
    );
    // Nothing cancellable in the foreign community: 409, alpha untouched.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(DENIED_BODY[409]);
    expect(await alphaState(ctx)).toBe(before);
  });
});

describe('role matrix B: known erasure gap', () => {
  // Open bug: the sweep deletes objects and fences the community but leaves
  // relational content (stories) in place. src/services/community-erasure.service.ts:171.
  // it.fails keeps the gap visible; it turns red when the purge is fixed.
  it.fails(
    'admin erasure purges alpha stories (open: stories survive the sweep)',
    async () => {
      const ctx = await setup();
      await seedThenSteward(ctx);
      const res = await ctx.call(
        'POST',
        '/v2/community/erasure',
        await ctx.loginCookie('admin'),
        {
          confirmFinality: true,
          currentDerivedKey: ctx.people.admin.creds.derivedKey,
        }
      );
      expect(res.status).toBe(202);
      expect(await alphaStories(ctx)).toHaveLength(0);
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
      // A third community's admin seeds the record: its erasure fences only that
      // community, so the listed roles keep valid sessions and reach the role check.
      const third = await seedThirdAdmin(ctx);
      const cookie = role === 'anon' ? undefined : await ctx.loginCookie(role);
      const seeded = await ctx.call(
        'POST',
        '/v2/community/erasure',
        await loginWith(ctx, third.email, third.key),
        {
          confirmFinality: true,
          currentDerivedKey: third.key,
        }
      );
      expect(seeded.status).toBe(202);
      expect(ctx.records.has(third.community.id)).toBe(true);
      const before = await ctx.snapshot();
      const res = await ctx.call('GET', '/v2/admin/erasures', cookie);
      const json = (await res.json()) as Record<string, unknown>;
      if (role === 'super_admin') {
        expect(res.status).toBe(200);
        const listed = json.data as Array<{ communityId: number }>;
        expect(listed.length).toBeGreaterThan(0);
        expect(listed.some((r) => r.communityId === third.community.id)).toBe(
          true
        );
        return;
      }
      expect(res.status).toBe(role === 'anon' ? 401 : 403);
      expect(json).toEqual(DENIED_BODY[res.status]);
      expect(await ctx.snapshot()).toBe(before);
    }
  );
});
