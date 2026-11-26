/**
 * Role-by-route matrix, rows 0-47 of the #145/#146 audit (cells the existing
 * focused suites left open). Every case drives the Hono V2 app
 * (createHonoApp); denied cases assert the exact status and re-read the data
 * to prove nothing leaked or changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and } from 'drizzle-orm';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../src/shared/auth-policy.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from './auth-test-utils.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const KEY = makeDerivedKey();
const T0 = new Date('2026-06-01T12:00:00.000Z');
const ORIGIN = 'https://api.example.test';

let app: ReturnType<typeof createHonoApp>;
let seed: Awaited<ReturnType<typeof argon2Seed>>;
const ids: Record<string, number> = {};
const cookies: Record<string, string> = {};
let userSeq = 0;

async function insertRow(table: any, values: Record<string, unknown>) {
  const [row] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return row.id as number;
}

async function makeUser(
  role: string,
  communityId: number | null,
  label = role
): Promise<{ id: number; email: string }> {
  userSeq += 1;
  const email = label + '-' + userSeq + '@matrix-a.example.test';
  const username = 'u' + label.replace(/[^a-z]/g, '') + userSeq;
  const id = await insertRow(tables.users, {
    email,
    username,
    ...deriveUserIdentityColumns({ email, username }),
    ...seed,
    firstName: role,
    lastName: 'User',
    role,
    communityId,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  return { id, email };
}

async function login(
  email: string,
  slug?: string,
  derivedKey: string = KEY
): Promise<{ status: number; cookie: string }> {
  const res = await app.request(ORIGIN + '/v2/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey,
      ...(slug === undefined ? {} : { communitySlug: slug }),
    }),
  });
  return {
    status: res.status,
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
  };
}

async function loginOk(email: string, slug?: string): Promise<string> {
  const r = await login(email, slug);
  expect(r.status).toBe(200);
  expect(r.cookie).toMatch(/^ts_session=.+/);
  return r.cookie;
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(ORIGIN + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: text ? (JSON.parse(text) as any) : null,
  };
}

/** Every row the "own" community owns, for before/after comparison. */
async function ownSnapshot(): Promise<string> {
  const own = ids.own!;
  const byCommunity = async (t: any) =>
    (await db.select().from(t)).filter((r: any) => r.communityId === own);
  return JSON.stringify({
    community: (await db.select().from(tables.communities)).filter(
      (r: any) => r.id === own
    ),
    mapConfig: await byCommunity(tables.communityMapConfigs),
    stories: await byCommunity(tables.stories),
    places: await byCommunity(tables.places),
    speakers: await byCommunity(tables.speakers),
    links: await byCommunity(tables.externalMediaLinks),
    storyPlaces: await db.select().from(tables.storyPlaces),
    storySpeakers: await db.select().from(tables.storySpeakers),
  });
}

/** Every content row of every community: a denied write must change none. */
async function allSnapshot(): Promise<string> {
  return JSON.stringify({
    communities: await db.select().from(tables.communities),
    mapConfigs: await db.select().from(tables.communityMapConfigs),
    stories: await db.select().from(tables.stories),
    places: await db.select().from(tables.places),
    speakers: await db.select().from(tables.speakers),
    links: await db.select().from(tables.externalMediaLinks),
    storyPlaces: await db.select().from(tables.storyPlaces),
    storySpeakers: await db.select().from(tables.storySpeakers),
  });
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  seed = await argon2Seed(KEY);
  const community = (name: string, slug: string, active = true) =>
    insertRow(tables.communities, {
      name,
      slug,
      description: '<p>' + name + ' narrative</p>',
      descriptionPlain: name + ' narrative',
      locale: 'en',
      publicStories: true,
      isActive: active,
      createdAt: T0,
      updatedAt: T0,
    });
  ids.own = await community('Own Nation', 'own-nation');
  ids.foreign = await community('Foreign Nation', 'foreign-nation');
  ids.disabled = await community('Disabled Nation', 'disabled-nation', false);

  const users = {
    super: await makeUser('super_admin', null),
    admin: await makeUser('admin', ids.own!),
    editor: await makeUser('editor', ids.own!),
    member: await makeUser('member', ids.own!),
    viewer: await makeUser('viewer', ids.own!),
    foreignAdmin: await makeUser('admin', ids.foreign!, 'foreignadmin'),
    steward: await makeUser('member', ids.disabled!, 'steward'),
  };
  await db.insert(tables.communityStewards).values({
    communityId: ids.disabled!,
    userId: users.steward.id,
    designatedBy: null,
    designatedAt: T0.getTime(),
    updatedAt: T0.getTime(),
  });

  const content = async (communityId: number, tag: string) => {
    const story = await insertRow(tables.stories, {
      communityId,
      title: tag + ' Story',
      slug: tag.toLowerCase() + '-story',
      language: 'en',
      privacyLevel: 'public',
      isRestricted: false,
      createdAt: T0,
      updatedAt: T0,
    });
    const place = await insertRow(tables.places, {
      communityId,
      name: tag + ' Place',
      latitude: 10,
      longitude: 20,
      isRestricted: false,
      createdAt: T0,
      updatedAt: T0,
    });
    const speaker = await insertRow(tables.speakers, {
      communityId,
      name: tag + ' Speaker',
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const link = (suffix: string, ordinal: number) =>
      insertRow(tables.externalMediaLinks, {
        communityId,
        storyId: story,
        url: 'https://media.example.test/' + tag.toLowerCase() + '/' + suffix,
        ordinal,
        createdAt: T0,
      });
    return {
      story,
      place,
      speaker,
      linkA: await link('a', 0),
      linkB: await link('b', 1),
    };
  };
  const o = await content(ids.own!, 'Ownmark');
  Object.assign(ids, {
    ownStory: o.story,
    ownPlace: o.place,
    ownSpeaker: o.speaker,
    ownLinkA: o.linkA,
    ownLinkB: o.linkB,
  });
  await content(ids.foreign!, 'Foreignmark');
  // Own story with its own links: the admin success case mutates only these.
  const ok = await content(ids.own!, 'Okmark');
  Object.assign(ids, {
    okStory: ok.story,
    okLinkA: ok.linkA,
    okLinkB: ok.linkB,
  });
  // Rows that no public (or editor) caller may see on the public projection.
  ids.hiddenStory = await insertRow(tables.stories, {
    communityId: ids.own!,
    title: 'Hiddenmark Story',
    slug: 'hiddenmark-story',
    language: 'en',
    privacyLevel: 'editors',
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.hiddenPlace = await insertRow(tables.places, {
    communityId: ids.own!,
    name: 'Hiddenmark Place',
    latitude: 11,
    longitude: 21,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.hiddenSpeaker = await insertRow(tables.speakers, {
    communityId: ids.own!,
    name: 'Hiddenmark Speaker',
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  // Distinct map configs so a cross-tenant leak is detectable.
  for (const [communityId, tag, zoom] of [
    [ids.own!, 'ownmark', 4.25],
    [ids.foreign!, 'foreignmark', 8.5],
  ] as const) {
    await db.insert(tables.communityMapConfigs).values({
      communityId,
      styleUrl: 'https://tiles.example.test/' + tag + '/style.json',
      zoom,
      createdAt: T0,
      updatedAt: T0,
    } as any);
  }
  await db.insert(tables.storyPlaces).values({
    communityId: ids.own!,
    storyId: o.story,
    placeId: o.place,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(tables.storySpeakers).values({
    communityId: ids.own!,
    storyId: o.story,
    speakerId: o.speaker,
    createdAt: T0,
    updatedAt: T0,
  });

  app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    secureCookies: false,
    publicOrigin: ORIGIN,
    corsOrigins: ['https://app.example.test'],
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  });

  cookies.super = await loginOk(users.super.email);
  cookies.admin = await loginOk(users.admin.email, 'own-nation');
  cookies.editor = await loginOk(users.editor.email, 'own-nation');
  cookies.member = await loginOk(users.member.email, 'own-nation');
  cookies.viewer = await loginOk(users.viewer.email, 'own-nation');
  cookies.foreignAdmin = await loginOk(
    users.foreignAdmin.email,
    'foreign-nation'
  );
  cookies.steward = await loginOk(users.steward.email, 'disabled-nation');
});

afterAll(() => {
  sqlite.close();
});

describe('rows 15-20: public community content, editor allowed', () => {
  const base = '/v2/public/communities/own-nation';
  const routes: Array<[string, () => string, string]> = [
    ['stories list', () => '/stories', 'Ownmark Story'],
    ['story detail', () => '/stories/' + ids.ownStory, 'Ownmark Story'],
    ['places list', () => '/places', 'Ownmark Place'],
    ['place detail', () => '/places/' + ids.ownPlace, 'Ownmark Place'],
    ['speakers list', () => '/speakers', 'Ownmark Speaker'],
    ['speaker detail', () => '/speakers/' + ids.ownSpeaker, 'Ownmark Speaker'],
  ];
  it.each(routes)(
    'editor reads public %s like anonymous',
    async (_name, path, needle) => {
      const anon = await call('GET', base + path());
      const editor = await call('GET', base + path(), {
        cookie: cookies.editor,
      });
      expect(anon.status).toBe(200);
      expect(editor.status).toBe(200);
      expect(editor.text).toContain(needle);
      expect(editor.text).not.toContain('Hiddenmark');
      expect(editor.json).toEqual(anon.json);
    }
  );

  it.each([
    ['/stories/', () => ids.hiddenStory],
    ['/places/', () => ids.hiddenPlace],
    ['/speakers/', () => ids.hiddenSpeaker],
  ])(
    'editor gets the same 404 as anonymous for hidden %s:id',
    async (prefix, id) => {
      const anon = await call('GET', base + prefix + id());
      const editor = await call('GET', base + prefix + id(), {
        cookie: cookies.editor,
      });
      const missing = await call('GET', base + prefix + '999999', {
        cookie: cookies.editor,
      });
      expect(anon.status).toBe(404);
      expect(editor.status).toBe(404);
      expect(editor.json).toEqual(anon.json);
      expect(editor.json).toEqual(missing.json);
      expect(editor.text).not.toContain('Hiddenmark');
    }
  );
});

describe('rows 3-6: own-account routes', () => {
  const fresh = async (role: string) => {
    const cid = role === 'super_admin' ? null : ids.own!;
    const u = await makeUser(role, cid, 'fresh');
    const slug = cid === null ? undefined : 'own-nation';
    return { ...u, slug, cookie: await loginOk(u.email, slug) };
  };
  const meStatus = async (cookie: string) =>
    (await call('GET', '/v2/auth/me', { cookie })).status;
  const sessionRows = async () =>
    JSON.stringify(await db.select().from(tables.sessions));
  const userRow = async (id: number) =>
    JSON.stringify(
      await db.select().from(tables.users).where(eq(tables.users.id, id))
    );
  const roles = ['viewer', 'member', 'editor', 'admin', 'super_admin'];

  it.each(['viewer', 'admin'])(
    'PATCH /v2/auth/me lets %s edit displayName',
    async (role) => {
      const res = await call('PATCH', '/v2/auth/me', {
        cookie: cookies[role],
        body: { displayName: 'Renamed ' + role },
      });
      expect(res.status).toBe(200);
      const me = await call('GET', '/v2/auth/me', { cookie: cookies[role] });
      expect(me.json.user.displayName).toBe('Renamed ' + role);
    }
  );

  it.each(['/v2/auth/logout', '/v2/auth/revoke'])(
    'POST %s without a session is 401 and ends no session',
    async (path) => {
      const bystander = await fresh('viewer');
      const before = await sessionRows();
      const res = await call('POST', path);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: expect.any(String) });
      expect(res.text).not.toContain(bystander.email);
      expect(await sessionRows()).toBe(before);
      expect(await meStatus(bystander.cookie)).toBe(200);
    }
  );

  it.each(roles)(
    'POST /v2/auth/logout ends only the presented session for %s',
    async (role) => {
      const a = await fresh(role);
      const other = await loginOk(a.email, a.slug);
      const control = await fresh('viewer');
      expect(await meStatus(a.cookie)).toBe(200);
      expect(await meStatus(other)).toBe(200);
      expect(
        (await call('POST', '/v2/auth/logout', { cookie: a.cookie })).status
      ).toBe(204);
      expect(await meStatus(a.cookie)).toBe(401);
      expect(await meStatus(other)).toBe(200);
      expect(await meStatus(control.cookie)).toBe(200);
    }
  );

  it.each(roles)(
    'POST /v2/auth/revoke ends every session of %s and no one else',
    async (role) => {
      const a = await fresh(role);
      const other = await loginOk(a.email, a.slug);
      const control = await fresh('viewer');
      expect(a.cookie).not.toBe(other);
      expect(await meStatus(a.cookie)).toBe(200);
      expect(await meStatus(other)).toBe(200);
      expect(await meStatus(control.cookie)).toBe(200);
      expect(
        (await call('POST', '/v2/auth/revoke', { cookie: a.cookie })).status
      ).toBe(204);
      expect(await meStatus(a.cookie)).toBe(401);
      expect(await meStatus(other)).toBe(401);
      expect(await meStatus(control.cookie)).toBe(200);
    }
  );

  const passwordBody = (current: string, next: string) => ({
    currentDerivedKey: current,
    algorithm: ARGON2ID_ALGORITHM,
    salt: makeVerifierSalt(),
    params: { ...ARGON2ID_PARAMS },
    derivedKey: next,
  });

  it.each(['viewer', 'editor', 'admin'])(
    'POST /v2/auth/password lets %s rotate the key',
    async (role) => {
      const a = await fresh(role);
      const newKey = makeDerivedKey();
      const res = await call('POST', '/v2/auth/password', {
        cookie: a.cookie,
        body: passwordBody(KEY, newKey),
      });
      expect(res.status).toBe(200);
      expect((await login(a.email, a.slug, KEY)).status).toBe(401);
      expect((await login(a.email, a.slug, newKey)).status).toBe(200);
    }
  );

  it('POST /v2/auth/password with a wrong current key is 401 and changes nothing', async () => {
    const a = await fresh('viewer');
    const other = await loginOk(a.email, a.slug);
    const users = await userRow(a.id);
    const sessions = await sessionRows();
    const res = await call('POST', '/v2/auth/password', {
      cookie: a.cookie,
      body: passwordBody(makeDerivedKey(), makeDerivedKey()),
    });
    expect(res.status).toBe(401);
    expect(await userRow(a.id)).toBe(users);
    expect(await sessionRows()).toBe(sessions);
    expect(await meStatus(a.cookie)).toBe(200);
    expect(await meStatus(other)).toBe(200);
    expect((await login(a.email, a.slug, KEY)).status).toBe(200);
  });
});

describe('row 7: recovery codes, steward allowed', () => {
  it('a designated steward mints recovery codes that are stored for that account', async () => {
    const steward = await db
      .select()
      .from(tables.communityStewards)
      .where(eq(tables.communityStewards.communityId, ids.disabled!));
    const stewardId = steward[0]!.userId;
    const res = await call('POST', '/v2/auth/recovery-codes', {
      cookie: cookies.steward,
      body: { currentDerivedKey: KEY },
    });
    expect(res.status).toBe(201);
    const codes: string[] = res.json.data.codes;
    expect(new Set(codes).size).toBe(10);
    const rows = await db
      .select()
      .from(tables.loginCodes)
      .where(
        and(
          eq(tables.loginCodes.userId, stewardId),
          eq(tables.loginCodes.purpose, 'recovery')
        )
      );
    const live = rows.filter(
      (r) => r.usedAt === null && r.supersededAt === null
    );
    expect(live.map((r) => r.codeHash).sort()).toEqual(
      (await Promise.all(codes.map((c) => sha256Hex(c)))).sort()
    );
  });
});

describe('rows 29-35: story writes, anonymous denied', () => {
  const story = () => '/v2/stories/' + ids.ownStory;
  const cases: Array<[string, () => string, () => unknown]> = [
    ['PATCH', story, () => ({ title: 'Anon Title' })],
    ['DELETE', story, () => undefined],
    // Replacements that would observably change the existing edges.
    ['PUT', () => story() + '/places', () => ({ placeIds: [] })],
    ['PUT', () => story() + '/speakers', () => ({ speakerIds: [] })],
    [
      'POST',
      () => story() + '/external-links',
      () => ({ url: 'https://anon.example.test/x' }),
    ],
    [
      'PATCH',
      () => story() + '/external-links/reorder',
      () => ({ linkIds: [ids.ownLinkB, ids.ownLinkA] }),
    ],
    [
      'DELETE',
      () => story() + '/external-links/' + ids.ownLinkA,
      () => undefined,
    ],
  ];
  it.each(cases)(
    '%s %s is 401 and changes nothing',
    async (method, path, body) => {
      const before = await allSnapshot();
      const res = await call(method, path(), { body: body() });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: expect.any(String) });
      expect(res.text).not.toContain('Ownmark');
      expect(await allSnapshot()).toBe(before);
    }
  );
});

describe('rows 21-45: other-community admin is confined to its own community', () => {
  const noOwn = (text: string) =>
    expect(text).not.toMatch(
      /Ownmark|Okmark|Hiddenmark|own-nation|Own Nation|ownmark/
    );

  it('GET /v2/community answers with the caller community only', async () => {
    const res = await call('GET', '/v2/community', {
      cookie: cookies.foreignAdmin,
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('foreign-nation');
    noOwn(res.text);
  });

  it('GET /v2/community/map-config answers with the caller config only', async () => {
    const res = await call('GET', '/v2/community/map-config', {
      cookie: cookies.foreignAdmin,
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('tiles.example.test/foreignmark/style.json');
    noOwn(res.text);
  });

  it.each([
    ['/v2/stories', 'Foreignmark Story'],
    ['/v2/places', 'Foreignmark Place'],
    ['/v2/speakers', 'Foreignmark Speaker'],
  ])(
    'GET %s lists the caller records and none of the other',
    async (path, mark) => {
      const res = await call('GET', path, { cookie: cookies.foreignAdmin });
      expect(res.status).toBe(200);
      expect(res.text).toContain(mark);
      noOwn(res.text);
    }
  );

  it.each([
    ['/v2/stories/', () => ids.ownStory],
    ['/v2/places/', () => ids.ownPlace],
    ['/v2/speakers/', () => ids.ownSpeaker],
  ])(
    'GET %s:id of the other community is indistinguishable from a missing id',
    async (prefix, id) => {
      const before = await allSnapshot();
      const res = await call('GET', prefix + id(), {
        cookie: cookies.foreignAdmin,
      });
      const missing = await call('GET', prefix + '999999', {
        cookie: cookies.foreignAdmin,
      });
      expect(res.status).toBe(404);
      expect(res.json).toEqual(missing.json);
      noOwn(res.text);
      expect(await allSnapshot()).toBe(before);
    }
  );

  const story = () => '/v2/stories/' + ids.ownStory;
  const writes: Array<[string, () => string, () => unknown]> = [
    ['PATCH', story, () => ({ title: 'Hijack' })],
    ['DELETE', story, () => undefined],
    ['PUT', () => story() + '/places', () => ({ placeIds: [] })],
    ['PUT', () => story() + '/speakers', () => ({ speakerIds: [] })],
    [
      'POST',
      () => story() + '/external-links',
      () => ({ url: 'https://evil.example.test/x' }),
    ],
    [
      'PATCH',
      () => story() + '/external-links/reorder',
      () => ({ linkIds: [ids.ownLinkB, ids.ownLinkA] }),
    ],
    [
      'DELETE',
      () => story() + '/external-links/' + ids.ownLinkA,
      () => undefined,
    ],
    ['PATCH', () => '/v2/places/' + ids.ownPlace, () => ({ name: 'Hijack' })],
    ['DELETE', () => '/v2/places/' + ids.ownPlace, () => undefined],
    [
      'PATCH',
      () => '/v2/speakers/' + ids.ownSpeaker,
      () => ({ name: 'Hijack' }),
    ],
    ['DELETE', () => '/v2/speakers/' + ids.ownSpeaker, () => undefined],
  ];
  it.each(writes)(
    '%s %s on the other community is a plain 404 and changes nothing anywhere',
    async (method, path, body) => {
      const before = await allSnapshot();
      const res = await call(method, path(), {
        cookie: cookies.foreignAdmin,
        body: body(),
      });
      const missingPath = path()
        .replace('/stories/' + ids.ownStory, '/stories/999999')
        .replace('/places/' + ids.ownPlace, '/places/999999')
        .replace('/speakers/' + ids.ownSpeaker, '/speakers/999999');
      const missing = await call(method, missingPath, {
        cookie: cookies.foreignAdmin,
        body: body(),
      });
      expect(res.status).toBe(404);
      expect(res.json).toEqual(missing.json);
      noOwn(res.text);
      expect(await allSnapshot()).toBe(before);
    }
  );

  it('PATCH /v2/community and PUT /v2/community/map-config act on the caller community only', async () => {
    const own = await ownSnapshot();
    const patch = await call('PATCH', '/v2/community', {
      cookie: cookies.foreignAdmin,
      body: { name: 'Foreign Renamed' },
    });
    expect(patch.status).toBe(200);
    const put = await call('PUT', '/v2/community/map-config', {
      cookie: cookies.foreignAdmin,
      body: { styleUrl: 'https://tiles.example.test/foreign-put/style.json' },
    });
    expect(put.status).toBe(200);
    expect(await ownSnapshot()).toBe(own);
    const [foreign] = await db
      .select()
      .from(tables.communities)
      .where(eq(tables.communities.id, ids.foreign!));
    expect(foreign!.name).toBe('Foreign Renamed');
    const [cfg] = await db
      .select()
      .from(tables.communityMapConfigs)
      .where(eq(tables.communityMapConfigs.communityId, ids.foreign!));
    expect(cfg!.styleUrl).toBe(
      'https://tiles.example.test/foreign-put/style.json'
    );
  });

  it.each([
    [
      '/v2/stories',
      'stories',
      { title: 'Foreign New Story', visibility: 'public' },
      'title',
    ],
    ['/v2/places', 'places', { name: 'Foreign New Place' }, 'name'],
    ['/v2/speakers', 'speakers', { name: 'Foreign New Speaker' }, 'name'],
  ] as const)(
    'POST %s creates the row in the caller community only',
    async (path, table, body, field) => {
      const own = await ownSnapshot();
      const res = await call('POST', path, {
        cookie: cookies.foreignAdmin,
        body,
      });
      expect(res.status).toBe(201);
      const rows = (await db.select().from(tables[table])).filter(
        (r: any) => r[field] === (body as any)[field]
      );
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).communityId).toBe(ids.foreign);
      expect(await ownSnapshot()).toBe(own);
    }
  );
});

describe('rows 34-35: admin allowed on external-link reorder and delete', () => {
  it('admin reorders then deletes a link on a story of its own', async () => {
    const base = '/v2/stories/' + ids.okStory + '/external-links';
    const links = () =>
      db
        .select()
        .from(tables.externalMediaLinks)
        .where(eq(tables.externalMediaLinks.storyId, ids.okStory!));
    const reorder = await call('PATCH', base + '/reorder', {
      cookie: cookies.admin,
      body: { linkIds: [ids.okLinkB, ids.okLinkA] },
    });
    expect(reorder.status).toBe(200);
    const byId = new Map((await links()).map((r) => [r.id, r.ordinal]));
    expect(byId.get(ids.okLinkB!)).toBe(0);
    expect(byId.get(ids.okLinkA!)).toBe(1);
    const del = await call('DELETE', base + '/' + ids.okLinkA, {
      cookie: cookies.admin,
    });
    expect(del.status).toBe(204);
    expect((await links()).map((r) => r.id)).toEqual([ids.okLinkB]);
  });
});
