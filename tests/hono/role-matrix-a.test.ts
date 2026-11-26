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
import { eq } from 'drizzle-orm';
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
      const url = '/v2/public/communities/own-nation' + path();
      const anon = await call('GET', url);
      const editor = await call('GET', url, { cookie: cookies.editor });
      expect(anon.status).toBe(200);
      expect(editor.status).toBe(200);
      expect(editor.text).toContain(needle);
      expect(editor.json).toEqual(anon.json);
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
  const roles = ['viewer', 'editor', 'admin', 'super_admin'];

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
    'POST %s without a session is 401',
    async (path) => {
      const res = await call('POST', path);
      expect(res.status).toBe(401);
    }
  );

  it.each(roles)(
    'POST /v2/auth/logout ends only the presented session for %s',
    async (role) => {
      const a = await fresh(role);
      const other = await loginOk(a.email, a.slug);
      expect(
        (await call('POST', '/v2/auth/logout', { cookie: a.cookie })).status
      ).toBe(204);
      expect(
        (await call('GET', '/v2/auth/me', { cookie: a.cookie })).status
      ).toBe(401);
      expect((await call('GET', '/v2/auth/me', { cookie: other })).status).toBe(
        200
      );
    }
  );

  it.each(roles)(
    'POST /v2/auth/revoke ends every session of %s',
    async (role) => {
      const a = await fresh(role);
      const other = await loginOk(a.email, a.slug);
      expect(
        (await call('POST', '/v2/auth/revoke', { cookie: a.cookie })).status
      ).toBe(204);
      expect(
        (await call('GET', '/v2/auth/me', { cookie: a.cookie })).status
      ).toBe(401);
      expect((await call('GET', '/v2/auth/me', { cookie: other })).status).toBe(
        401
      );
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

  it('POST /v2/auth/password with a wrong current key is 401 and keeps the old key', async () => {
    const a = await fresh('viewer');
    const res = await call('POST', '/v2/auth/password', {
      cookie: a.cookie,
      body: passwordBody(makeDerivedKey(), makeDerivedKey()),
    });
    expect(res.status).toBe(401);
    expect((await login(a.email, a.slug, KEY)).status).toBe(200);
  });
});

describe('row 7: recovery codes, steward allowed', () => {
  it('a designated steward may mint recovery codes (201)', async () => {
    const res = await call('POST', '/v2/auth/recovery-codes', {
      cookie: cookies.steward,
      body: { currentDerivedKey: KEY },
    });
    expect(res.status).toBe(201);
    expect(res.json.data.codes).toHaveLength(10);
  });
});

describe('rows 29-35: story writes, anonymous denied', () => {
  const cases: Array<[string, () => string, () => unknown]> = [
    [
      'PATCH',
      () => '/v2/stories/' + ids.ownStory,
      () => ({ title: 'Anon Title' }),
    ],
    ['DELETE', () => '/v2/stories/' + ids.ownStory, () => undefined],
    [
      'PUT',
      () => '/v2/stories/' + ids.ownStory + '/places',
      () => ({ placeIds: [ids.ownPlace] }),
    ],
    [
      'PUT',
      () => '/v2/stories/' + ids.ownStory + '/speakers',
      () => ({ speakerIds: [ids.ownSpeaker] }),
    ],
    [
      'POST',
      () => '/v2/stories/' + ids.ownStory + '/external-links',
      () => ({ url: 'https://anon.example.test/x' }),
    ],
    [
      'PATCH',
      () => '/v2/stories/' + ids.ownStory + '/external-links/reorder',
      () => ({ linkIds: [ids.ownLinkB, ids.ownLinkA] }),
    ],
    [
      'DELETE',
      () => '/v2/stories/' + ids.ownStory + '/external-links/' + ids.ownLinkA,
      () => undefined,
    ],
  ];
  it.each(cases)(
    '%s %s is 401 and changes nothing',
    async (method, path, body) => {
      const before = await ownSnapshot();
      const res = await call(method, path(), { body: body() });
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('Ownmark');
      expect(await ownSnapshot()).toBe(before);
    }
  );
});

describe('rows 21-45: other-community admin is confined to its own community', () => {
  it.each([
    '/v2/community',
    '/v2/community/map-config',
    '/v2/stories',
    '/v2/places',
    '/v2/speakers',
  ])(
    'GET %s answers from the caller community and leaks nothing of the other',
    async (path) => {
      const res = await call('GET', path, { cookie: cookies.foreignAdmin });
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/Ownmark|own-nation|Own Nation/);
    }
  );

  it.each([
    ['/v2/stories/', () => ids.ownStory],
    ['/v2/places/', () => ids.ownPlace],
    ['/v2/speakers/', () => ids.ownSpeaker],
  ])(
    'GET %s:id of the other community is 404 without a body leak',
    async (prefix, id) => {
      const res = await call('GET', prefix + id(), {
        cookie: cookies.foreignAdmin,
      });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('Ownmark');
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
    '%s %s on the other community is 404 and changes nothing',
    async (method, path, body) => {
      const before = await ownSnapshot();
      const res = await call(method, path(), {
        cookie: cookies.foreignAdmin,
        body: body(),
      });
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('Ownmark');
      expect(await ownSnapshot()).toBe(before);
    }
  );

  it('collection writes by the other admin land in its own community only', async () => {
    const before = await ownSnapshot();
    const patch = await call('PATCH', '/v2/community', {
      cookie: cookies.foreignAdmin,
      body: { name: 'Foreign Renamed' },
    });
    expect(patch.status).toBe(200);
    const created: Array<[string, unknown]> = [
      ['/v2/stories', { title: 'Foreign New Story', visibility: 'public' }],
      ['/v2/places', { name: 'Foreign New Place' }],
      ['/v2/speakers', { name: 'Foreign New Speaker' }],
    ];
    for (const [path, body] of created) {
      const res = await call('POST', path, {
        cookie: cookies.foreignAdmin,
        body,
      });
      expect(res.status).toBe(201);
    }
    expect(await ownSnapshot()).toBe(before);
    const foreign = await db
      .select()
      .from(tables.communities)
      .where(eq(tables.communities.id, ids.foreign!));
    expect(foreign[0]!.name).toBe('Foreign Renamed');
  });
});

describe('rows 34-35: admin allowed on external-link reorder and delete', () => {
  it('admin reorders then deletes a link on an own story', async () => {
    const base = '/v2/stories/' + ids.ownStory + '/external-links';
    const reorder = await call('PATCH', base + '/reorder', {
      cookie: cookies.admin,
      body: { linkIds: [ids.ownLinkB, ids.ownLinkA] },
    });
    expect(reorder.status).toBe(200);
    const rows = await db
      .select()
      .from(tables.externalMediaLinks)
      .where(eq(tables.externalMediaLinks.storyId, ids.ownStory!));
    const byId = new Map(rows.map((r) => [r.id, r.ordinal]));
    expect(byId.get(ids.ownLinkB!)).toBe(0);
    expect(byId.get(ids.ownLinkA!)).toBe(1);
    const del = await call('DELETE', base + '/' + ids.ownLinkA, {
      cookie: cookies.admin,
    });
    expect(del.status).toBe(204);
    const left = await db
      .select()
      .from(tables.externalMediaLinks)
      .where(eq(tables.externalMediaLinks.storyId, ids.ownStory!));
    expect(left.map((r) => r.id)).toEqual([ids.ownLinkB]);
  });
});
