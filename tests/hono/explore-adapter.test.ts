/**
 * Explore read adapter contract (#198): the Rails-shaped JSON the current
 * Explore client requests, mapped from V2 data on the Hono app, on SQLite.
 *
 * Request shapes are recorded from the Explore client
 * (explore-terrastories/src/api/*): GET /communities?search=,
 * GET /communities/:slug, GET /communities/:slug/stories with the Rails
 * story_params query, GET /communities/:slug/stories/:storyId,
 * GET /communities/:slug/places/:placeId, plus the adapter media URL.
 *
 * Sovereignty gates asserted throughout: public+active communities only;
 * isRestricted and unknown-privacy rows never exposed and answering the
 * same 404 as missing ids; place/speaker visibility per SPEC-V2 §6.4a;
 * provider credentials and cultural metadata never in any response.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  communityMediaSqlite,
} from '../../src/db/schema/sessions.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { ExploreAdapterRepository } from '../../src/repositories/explore-adapter.repository.js';

const t = (seconds: string) => new Date(seconds);
const T0 = t('2026-01-01T00:00:00Z');
const T1 = t('2026-02-01T00:00:00Z');
const T2 = t('2026-03-01T00:00:00Z');
const T3 = t('2026-04-01T00:00:00Z');
const T4 = t('2026-05-01T00:00:00Z');
const T5 = t('2026-06-01T00:00:00Z');

const neverExposed = [
  'pk-secret-token-a',
  'secret-ceremony-settings',
  'Sacred Cave',
  'Secrets',
  'Hidden Hana',
  'Silent Sam',
  'Members Only Tale',
  'Restricted River',
  'Unknown Privacy',
  'Edge To Restricted',
];

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys=ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);
const storage = new Map<string, Uint8Array>([
  ['bytes/a', new Uint8Array([1, 2, 3])],
]);
let storageReads = 0;
let app: ReturnType<typeof createHonoApp>;
let originApp: ReturnType<typeof createHonoApp>;
let ids: Record<string, number> = {};
let fileIds: Record<string, string> = {};

const seed = async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insert = async (table: unknown, values: Record<string, unknown>) => {
    const [row] = await db
      .insert(table as never)
      .values(values as never)
      .returning();
    return row as Record<string, unknown>;
  };
  const communityA = await insert(tables.communities, {
    name: 'Public Alpha',
    description: 'Alpine stories',
    slug: 'public-alpha',
    publicStories: true,
    isActive: true,
    culturalSettings: 'secret-ceremony-settings',
    createdAt: T0,
    updatedAt: T4,
  });
  const communityB = await insert(tables.communities, {
    name: 'Public Beta',
    description: null,
    slug: 'public-beta',
    publicStories: true,
    isActive: true,
    createdAt: T1,
    updatedAt: T2,
  });
  const communityC = await insert(tables.communities, {
    name: 'Private Gamma',
    slug: 'private-gamma',
    publicStories: false,
    isActive: true,
    createdAt: T1,
    updatedAt: T2,
  });
  await insert(tables.communities, {
    name: 'Disabled Delta',
    slug: 'disabled-delta',
    publicStories: true,
    isActive: false,
    createdAt: T1,
    updatedAt: T2,
  });
  ids.a = communityA.id as number;
  ids.b = communityB.id as number;
  ids.c = communityC.id as number;

  const user = await insert(tables.users, {
    email: 'explore@example.test',
    passwordHash: 'irrelevant',
    firstName: 'Explore',
    lastName: 'Seeder',
    role: 'viewer',
    communityId: ids.a,
    createdAt: T0,
    updatedAt: T0,
  });

  await insert(tables.themes, {
    name: 'Alpha theme',
    mapboxStyleUrl: 'https://tiles.example.test/style.json',
    mapboxAccessToken: 'pk-secret-token-a',
    centerLat: 10.5,
    centerLong: -20.25,
    swBoundaryLat: 9.0,
    swBoundaryLong: -21.0,
    neBoundaryLat: 11.0,
    neBoundaryLong: -19.0,
    active: true,
    communityId: ids.a,
    createdAt: T0,
    updatedAt: T0,
  });
  await insert(tables.themes, {
    name: 'Alpha unused',
    mapboxStyleUrl: 'mapbox://styles/unused',
    active: false,
    communityId: ids.a,
    createdAt: T0,
    updatedAt: T0,
  });
  await insert(tables.themes, {
    name: 'Beta theme',
    mapboxStyleUrl: 'mapbox://styles/beta',
    active: true,
    communityId: ids.b,
    createdAt: T0,
    updatedAt: T0,
  });

  const file = async (
    key: string,
    overrides: Record<string, unknown>
  ): Promise<string> => {
    const id = crypto.randomUUID();
    const path = `communities/${overrides.communityId}/${key}`;
    await insert(tables.files, {
      id,
      filename: key,
      originalName: key,
      path,
      url: 'https://ignored.invalid/legacy',
      mimeType: 'image/png',
      size: 3,
      uploadedBy: user.id,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });
    storage.set(path, new Uint8Array([1, 2, 3]));
    return id;
  };
  fileIds.a = await file('display.png', { communityId: ids.a });
  fileIds.aInactive = await file('inactive.png', {
    communityId: ids.a,
    isActive: false,
  });
  fileIds.aRestricted = await file('restricted.png', {
    communityId: ids.a,
    culturalRestrictions: '{}',
  });
  fileIds.cross = await file('cross.png', { communityId: ids.a });
  fileIds.b = await file('beta.png', { communityId: ids.b });
  fileIds.c = await file('gamma.png', { communityId: ids.c });
  for (const [fileId, communityId] of [
    [fileIds.a, ids.a],
    [fileIds.aInactive, ids.a],
    [fileIds.aRestricted, ids.a],
    [fileIds.cross, ids.b],
    [fileIds.b, ids.b],
    [fileIds.c, ids.c],
  ] as const)
    await db
      .insert(communityMediaSqlite)
      .values({ fileId, communityId, kind: 'branding' });

  const place = (values: Record<string, unknown>) =>
    insert(tables.places, {
      createdAt: T0,
      updatedAt: T0,
      ...values,
    });
  ids.p1 = (
    (await place({
      name: 'River Bend',
      description: 'Cold waters',
      communityId: ids.a,
      latitude: 10.1,
      longitude: -20.2,
      region: 'North',
      culturalSignificance: 'secret-place-significance',
    })) as Record<string, unknown>
  ).id as number;
  ids.p2 = (
    (await place({
      name: 'Sacred Cave',
      communityId: ids.a,
      latitude: 10.3,
      longitude: -20.4,
      region: 'Secrets',
      isRestricted: true,
    })) as Record<string, unknown>
  ).id as number;
  ids.p3 = (
    (await place({
      name: 'Far Ridge',
      communityId: ids.a,
      latitude: 10.7,
      longitude: -20.9,
      region: 'South',
    })) as Record<string, unknown>
  ).id as number;
  ids.p4 = (
    (await place({
      name: 'Meeting Point',
      communityId: ids.a,
      latitude: 10.5,
      longitude: -20.5,
      region: 'North',
    })) as Record<string, unknown>
  ).id as number;
  ids.p5 = (
    (await place({
      name: 'Sky Mark',
      communityId: ids.a,
      latitude: 999,
      longitude: -20.0,
    })) as Record<string, unknown>
  ).id as number;
  ids.pB = (
    (await place({
      name: 'Beta Spot',
      communityId: ids.b,
      latitude: 1.5,
      longitude: 1.5,
    })) as Record<string, unknown>
  ).id as number;

  const speaker = (values: Record<string, unknown>) =>
    insert(tables.speakers, { createdAt: T0, updatedAt: T0, ...values });
  ids.s1 = (
    (await speaker({ name: 'Elder Ana', communityId: ids.a, isActive: true })) as Record<string, unknown>
  ).id as number;
  ids.s2 = (
    (await speaker({ name: 'Silent Sam', communityId: ids.a, isActive: false })) as Record<string, unknown>
  ).id as number;
  ids.s3 = (
    (await speaker({ name: 'Hidden Hana', communityId: ids.a, isActive: true })) as Record<string, unknown>
  ).id as number;
  ids.s4 = (
    (await speaker({ name: 'Interviewer Ivo', communityId: ids.a, isActive: true })) as Record<string, unknown>
  ).id as number;
  ids.s5 = (
    (await speaker({ name: 'Retired Rex', communityId: ids.a, isActive: false })) as Record<string, unknown>
  ).id as number;
  ids.sB = (
    (await speaker({ name: 'Beta Speaker', communityId: ids.b, isActive: true })) as Record<string, unknown>
  ).id as number;

  const story = (values: Record<string, unknown>) =>
    insert(tables.stories, {
      slug: `slug-${crypto.randomUUID()}`,
      createdBy: user.id,
      createdAt: T0,
      updatedAt: T0,
      ...values,
    });
  ids.st1 = (
    (await story({
      title: 'River Song',
      description: 'River Song description',
      communityId: ids.a,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'en',
      interviewerId: ids.s4,
      interviewLocationId: ids.p4,
      createdAt: T1,
      updatedAt: T3,
    })) as Record<string, unknown>
  ).id as number;
  ids.st2 = (
    (await story({
      title: 'A Story of the Valley',
      description: null,
      communityId: ids.a,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'es',
      interviewerId: ids.s5,
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;
  ids.st3 = (
    (await story({
      title: 'Members Only Tale',
      communityId: ids.a,
      privacyLevel: 'members_only',
      isRestricted: false,
      language: 'en',
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;
  ids.st4 = (
    (await story({
      title: 'Restricted River',
      communityId: ids.a,
      privacyLevel: 'public',
      isRestricted: true,
      language: 'en',
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;
  ids.st5 = (
    (await story({
      title: 'Unknown Privacy',
      communityId: ids.a,
      privacyLevel: 'restricted',
      isRestricted: false,
      language: 'en',
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;
  ids.st6 = (
    (await story({
      title: 'No Speaker Story',
      communityId: ids.a,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'en',
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;
  ids.stB = (
    (await story({
      title: 'Beta Story',
      communityId: ids.b,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'en',
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;
  // Public story whose ONLY place edge points at the restricted place: it
  // must never surface through the joined public relation.
  ids.st7 = (
    (await story({
      title: 'Edge To Restricted',
      communityId: ids.a,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'en',
      createdAt: T2,
      updatedAt: T2,
    })) as Record<string, unknown>
  ).id as number;

  const edge = async (storyId: number, placeId: number) => {
    await insert(tables.storyPlaces, {
      storyId,
      placeId,
      culturalContext: 'secret-context',
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    });
  };
  const voice = async (storyId: number, speakerId: number) => {
    await insert(tables.storySpeakers, {
      storyId,
      speakerId,
      storyRole: 'narrator',
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    });
  };
  for (const placeId of [ids.p1, ids.p2, ids.p5]) await edge(ids.st1, placeId);
  await edge(ids.st2, ids.p1);
  await edge(ids.st3, ids.p3);
  await edge(ids.st4, ids.p1);
  await edge(ids.st5, ids.p1);
  await edge(ids.st6, ids.p1);
  await edge(ids.stB, ids.pB);
  await edge(ids.st7, ids.p2);
  // Cross-tenant edge: community A's story pointing at community B's place.
  await edge(ids.st2, ids.pB);
  for (const speakerId of [ids.s1, ids.s2]) await voice(ids.st1, speakerId);
  await voice(ids.st2, ids.s1);
  await voice(ids.st3, ids.s3);
  await voice(ids.st4, ids.s1);
  await voice(ids.st5, ids.s1);
  await voice(ids.stB, ids.sB);
  await voice(ids.st7, ids.s1);
};

const get = async (path: string) =>
  app.request(new Request(`http://localhost${path}`));
// The response body can be read once: parse JSON from the consumed text.
const body = async (path: string) => {
  const response = await get(path);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, headers: response.headers, json };
};

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  await seed();
  const options = {
    repository: new HonoFoundationRepository(db),
    verifier: { verify: async () => false },
    secureCookies: false,
    storage: {
      read: async (key: string) => {
        storageReads++;
        return storage.get(key) ?? null;
      },
    },
  };
  app = createHonoApp(options);
  originApp = createHonoApp({ ...options, publicOrigin: 'https://api.example.test' });
});

afterAll(() => {
  sqlite.close();
});

it('serves the Rails communities index envelope for public active communities only', async () => {
  const page = await body('/explore/communities');
  expect(page.status).toBe(200);
  const cards = page.json.data;
  expect(cards.map((c: { slug: string }) => c.slug)).toEqual([
    'public-alpha',
    'public-beta',
  ]);
  const alpha = cards[0];
  expect(alpha).toMatchObject({
    name: 'Public Alpha',
    description: 'Alpine stories',
    slug: 'public-alpha',
    createdAt: T0.toISOString(),
    updatedAt: T4.toISOString(),
    displayImage: `http://localhost/explore/media/${fileIds.a}`,
    mapConfig: {
      mapboxAccessToken: null,
      mapboxStyle: 'https://tiles.example.test/style.json',
      mapbox3dEnabled: false,
      mapProjection: null,
      center: [-20.25, 10.5],
      zoom: null,
      pitch: null,
      bearing: null,
    },
  });
  expect(Object.keys(alpha)).toEqual([
    'name',
    'description',
    'slug',
    'createdAt',
    'updatedAt',
    'displayImage',
    'mapConfig',
  ]);
  expect(cards[1].mapConfig.mapboxStyle).toBeNull();
  expect(cards[1].mapConfig.center).toEqual([null, null]);
  for (const secret of neverExposed) expect(page.text).not.toContain(secret);
  expect(page.headers.get('cache-control')).toBe('no-store');
});

it('narrows the communities index by name search', async () => {
  const found = await body('/explore/communities?search=alpha');
  expect(found.json.data.map((c: { slug: string }) => c.slug)).toEqual([
    'public-alpha',
  ]);
  expect((await body('/explore/communities?search=zzz')).json.data).toEqual([]);
  expect(
    (await body('/explore/communities?search=')).json.data
  ).toHaveLength(2);
});

it('answers community show with the Rails detail shape', async () => {
  const page = await body('/explore/communities/public-alpha');
  expect(page.status).toBe(200);
  const data = page.json.data;
  expect(data.name).toBe('Public Alpha');
  expect(data.slug).toBe('public-alpha');
  expect(data.description).toBe('Alpine stories');
  expect(data.details).toEqual({
    name: 'Public Alpha',
    description: 'Alpine stories',
    sponsorLogos: [],
    displayImage: `http://localhost/explore/media/${fileIds.a}`,
  });
  // All four public stories count (no place/speaker join requirement).
  expect(data.storiesCount).toBe(4);
  // Points come from public stories' place edges: restricted and
  // invalid-coordinate places are absent.
  expect(data.points.map((p: { id: number }) => p.id)).toEqual([ids.p1]);
  expect(data.points[0]).toEqual({
    type: 'Feature',
    id: ids.p1,
    geometry: { type: 'Point', coordinates: [-20.2, 10.1] },
    properties: {
      name: 'River Bend',
      description: 'Cold waters',
      placenameAudio: null,
      photo: null,
      thumbnail: null,
      region: 'North',
      typeOfPlace: null,
    },
  });
  expect(data.categories).toEqual([
    'places',
    'region',
    'type_of_place',
    'speakers',
    'topic',
    'language',
    'speaker_community',
  ]);
  expect(data.filters).toEqual([
    { label: 'River Bend', value: ids.p1, category: 'places' },
    { label: 'Sky Mark', value: ids.p5, category: 'places' },
    { label: 'North', value: 'North', category: 'region' },
    { label: 'en', value: 'en', category: 'language' },
    { label: 'es', value: 'es', category: 'language' },
    { value: ids.s1, label: 'Elder Ana', category: 'speakers' },
  ]);
  expect(data.mapConfig).toMatchObject({
    mapboxAccessToken: null,
    mapboxStyle: 'https://tiles.example.test/style.json',
    centerLat: 10.5,
    centerLong: -20.25,
    swBoundaryLat: 9.0,
    swBoundaryLong: -21.0,
    neBoundaryLat: 11.0,
    neBoundaryLong: -19.0,
    maxBounds: [
      [-21.0, 9.0],
      [-19.0, 11.0],
    ],
    center: [-20.25, 10.5],
    zoom: null,
    pitch: null,
    bearing: null,
  });
  for (const secret of neverExposed) expect(page.text).not.toContain(secret);
  expect(page.text).not.toContain('secret-place-significance');
  expect(page.text).not.toContain('secret-context');
});

it('hides private, disabled, and unknown communities from show', async () => {
  for (const slug of ['private-gamma', 'disabled-delta', 'no-such']) {
    const page = await body(`/explore/communities/${slug}`);
    expect(page.status).toBe(404);
    expect(page.json).toEqual({ error: 'Community Not Found' });
  }
});

it('serves the paginated Rails stories index with filters and sort', async () => {
  const page = await body('/explore/communities/public-alpha/stories');
  expect(page.status).toBe(200);
  expect(page.json.data.stories).toEqual([
    {
      id: ids.st2,
      title: 'A Story of the Valley',
      topic: null,
      desc: null,
      language: 'es',
      createdAt: T2.toISOString(),
      updatedAt: T2.toISOString(),
    },
    {
      id: ids.st1,
      title: 'River Song',
      topic: null,
      desc: 'River Song description',
      language: 'en',
      createdAt: T1.toISOString(),
      updatedAt: T3.toISOString(),
    },
  ]);
  expect(page.json.data.points.map((p: { id: number }) => p.id)).toEqual([ids.p1]);
  expect(page.json.meta).toEqual({
    total: 2,
    hasNextPage: false,
    nextPageMeta: {
      sort_by: 'created_at',
      sort_dir: 'desc',
      limit: 10,
      offset: null,
    },
  });
  for (const secret of neverExposed) expect(page.text).not.toContain(secret);
});

it('paginates, sorts, and filters the stories index', async () => {
  const asc = await body(
    '/explore/communities/public-alpha/stories?sort_by=created_at&sort_dir=asc'
  );
  expect(asc.json.data.stories.map((s: { id: number }) => s.id)).toEqual([
    ids.st1,
    ids.st2,
  ]);
  const first = await body(
    '/explore/communities/public-alpha/stories?limit=1'
  );
  expect(first.json.data.stories.map((s: { id: number }) => s.id)).toEqual([
    ids.st2,
  ]);
  expect(first.json.meta).toEqual({
    total: 2,
    hasNextPage: true,
    nextPageMeta: {
      sort_by: 'created_at',
      sort_dir: 'desc',
      limit: 1,
      offset: 1,
    },
  });
  const second = await body(
    '/explore/communities/public-alpha/stories?limit=1&offset=1'
  );
  expect(second.json.data.stories.map((s: { id: number }) => s.id)).toEqual([
    ids.st1,
  ]);
  expect(second.json.meta.hasNextPage).toBe(false);
  expect(second.json.meta.nextPageMeta.offset).toBeNull();
  const spanish = await body(
    '/explore/communities/public-alpha/stories?language[]=es'
  );
  expect(spanish.json.data.stories.map((s: { id: number }) => s.id)).toEqual([
    ids.st2,
  ]);
  expect(spanish.json.meta.nextPageMeta).toMatchObject({ language: ['es'] });
  const unbracketed = await body(
    `/explore/communities/public-alpha/stories?places=${ids.p1}`
  );
  expect(unbracketed.json.meta.total).toBe(2);
  for (const query of [
    `places[]=${ids.p1}`,
    'region[]=North',
    `speakers[]=${ids.s1}`,
  ]) {
    const filtered = await body(
      `/explore/communities/public-alpha/stories?${query}`
    );
    expect(filtered.json.meta.total).toBe(2);
  }
  const bySpeaker = await body(
    `/explore/communities/public-alpha/stories?speakers[]=${ids.s3}`
  );
  expect(bySpeaker.json.data.stories).toEqual([]);
  expect(bySpeaker.json.meta.total).toBe(0);
});

it('matches nothing for filter categories with no V2 representation', async () => {
  for (const query of ['topic[]=x', 'type_of_place[]=cave', 'speaker_community[]=y']) {
    const page = await body(`/explore/communities/public-alpha/stories?${query}`);
    expect(page.json.data).toEqual({ points: [], stories: [] });
    expect(page.json.meta.total).toBe(0);
    expect(page.json.meta.hasNextPage).toBe(false);
  }
  const echoed = await body(
    '/explore/communities/public-alpha/stories?topic[]=x&language[]=en'
  );
  expect(echoed.json.meta.nextPageMeta).toMatchObject({ topic: ['x'] });
});

it('reveals nothing about hidden rows through filter probing', async () => {
  // Each probe names an id/region that only a restricted place, an inactive
  // speaker, or another community's row could satisfy. None may match, and
  // no response text may confirm the hidden row exists.
  const probes = [
    `places[]=${ids.p2}`,
    'region[]=Secrets',
    `speakers[]=${ids.s2}`,
    `places[]=${ids.pB}`,
    `speakers[]=${ids.sB}`,
  ];
  for (const probe of probes) {
    const page = await body(
      `/explore/communities/public-alpha/stories?${probe}`
    );
    expect(page.status, probe).toBe(200);
    expect(page.json.data, probe).toEqual({ points: [], stories: [] });
    expect(page.json.meta.total, probe).toBe(0);
    expect(page.text, probe).not.toContain('Sacred Cave');
    expect(page.text, probe).not.toContain('Silent Sam');
    expect(page.text, probe).not.toContain('Beta Spot');
  }
  // A visible id probed alongside a withheld id matches exactly what the
  // visible id matches alone: the combined probe adds no information.
  const combined = await body(
    `/explore/communities/public-alpha/stories?places[]=${ids.p1}&places[]=${ids.p2}`
  );
  expect(combined.json.meta.total).toBe(2);
  expect(
    combined.json.data.stories.map((s: { id: number }) => s.id).sort()
  ).toEqual([ids.st1, ids.st2].sort());
});

it('drops stories whose only associations are hidden rows', async () => {
  // st7 is a public story, but its only place edge is the restricted place:
  // it never reaches the list, its points, or meta.total (which therefore
  // counts visible rows only).
  const page = await body('/explore/communities/public-alpha/stories');
  expect(page.json.meta.total).toBe(2);
  expect(page.json.data.stories).toHaveLength(2);
  expect(page.text).not.toContain('Edge To Restricted');
  // Its detail stays readable (the story itself is public) while the
  // restricted place never leaks into places or points.
  const detail = await body(
    `/explore/communities/public-alpha/stories/${ids.st7}`
  );
  expect(detail.status).toBe(200);
  expect(detail.json.data.places).toEqual([]);
  expect(detail.json.data.points).toEqual([]);
  expect(detail.text).not.toContain('Sacred Cave');
});

it('never projects another community through a cross-tenant story edge', async () => {
  // st2 (community A) carries a story_places edge to community B's place.
  const show = await body('/explore/communities/public-alpha');
  expect(show.json.data.points.map((p: { id: number }) => p.id)).toEqual([
    ids.p1,
  ]);
  expect(show.text).not.toContain('Beta Spot');
  const list = await body('/explore/communities/public-alpha/stories');
  expect(list.json.data.points.map((p: { id: number }) => p.id)).toEqual([
    ids.p1,
  ]);
  expect(list.text).not.toContain('Beta Spot');
});

it('rejects out-of-range filter ids and oversized filter lists', async () => {
  for (const query of [
    'places[]=0',
    'places[]=2147483648',
    'speakers[]=4294967296',
    `places[]=${Array.from({ length: 51 }, (_, i) => i + 1).join('&places[]=')}`,
    `region[]=${Array.from({ length: 51 }, (_, i) => `r${i}`).join('&region[]=')}`,
  ]) {
    const page = await body(
      `/explore/communities/public-alpha/stories?${query}`
    );
    expect(page.status, query).toBe(400);
    expect(page.json).toEqual({ error: 'Invalid request' });
  }
  // Exactly at the cap parses normally.
  const atCap = await body(
    `/explore/communities/public-alpha/stories?places[]=${Array.from(
      { length: 50 },
      (_, i) => i + 1000
    ).join('&places[]=')}`
  );
  expect(atCap.status).toBe(200);
  expect(atCap.json.meta.total).toBe(0);
});

it('withholds branding from private communities at the query level', async () => {
  // The repository gate itself (not just the 404 in front of it) refuses a
  // private community's branding file.
  const repository = new ExploreAdapterRepository(db);
  expect(await repository.brandingFileForCommunity(ids.c)).toBeNull();
  expect(await repository.brandingFileForCommunity(ids.a)).toEqual({
    fileId: fileIds.a,
  });
});

it('rejects invalid story queries with 400', async () => {
  for (const query of [
    'limit=abc',
    'limit=0',
    'limit=101',
    'offset=-1',
    'offset=1.5',
    'sort_by=bogus',
    'sort_dir=up',
    'places[]=abc',
    'speakers[]=1;2',
  ]) {
    const page = await body(`/explore/communities/public-alpha/stories?${query}`);
    expect(page.status, query).toBe(400);
    expect(page.json).toEqual({ error: 'Invalid request' });
  }
});

it('answers the Rails base 404 for stories of withheld communities', async () => {
  for (const slug of ['private-gamma', 'disabled-delta', 'no-such']) {
    const page = await body(`/explore/communities/${slug}/stories`);
    expect(page.status).toBe(404);
    expect(page.json).toEqual({
      error: 'Not Found',
      message: 'The requested resource could not be found.',
    });
  }
});

it('serves the Rails story show shape with place and speaker visibility', async () => {
  const page = await body(`/explore/communities/public-alpha/stories/${ids.st1}`);
  expect(page.status).toBe(200);
  expect(page.json.data).toEqual({
    id: ids.st1,
    title: 'River Song',
    desc: 'River Song description',
    topic: null,
    language: 'en',
    media: [],
    interviewer: { name: 'Interviewer Ivo' },
    interviewLocation: { name: 'Meeting Point' },
    speakers: [
      { id: ids.s1, name: 'Elder Ana', speakerCommunity: null, birthdate: null },
    ],
    places: [
      {
        id: ids.p1,
        name: 'River Bend',
        description: 'Cold waters',
        region: 'North',
        placenameAudio: null,
        photoUrl: null,
        typeOfPlace: null,
        center: {
          type: 'Feature',
          id: ids.p1,
          geometry: { type: 'Point', coordinates: [-20.2, 10.1] },
          properties: null,
        },
      },
    ],
    points: [
      {
        type: 'Feature',
        id: ids.p1,
        geometry: { type: 'Point', coordinates: [-20.2, 10.1] },
        properties: {
          name: 'River Bend',
          description: 'Cold waters',
          placenameAudio: null,
          photo: null,
          thumbnail: null,
          region: 'North',
          typeOfPlace: null,
        },
      },
    ],
  });
  // A withdrawn interviewer is absent, not null.
  const second = await body(
    `/explore/communities/public-alpha/stories/${ids.st2}`
  );
  expect(second.json.data.interviewer).toBeUndefined();
  expect(second.json.data.interviewLocation).toBeUndefined();
  for (const secret of neverExposed) expect(page.text).not.toContain(secret);
});

it('answers the identical 404 for withheld, unknown, and malformed story ids', async () => {
  const missing = await body('/explore/communities/public-alpha/stories/999999');
  expect(missing.status).toBe(404);
  for (const storyId of [ids.st3, ids.st4, ids.st5]) {
    const withheld = await body(
      `/explore/communities/public-alpha/stories/${storyId}`
    );
    expect(withheld.status).toBe(404);
    expect(withheld.text).toBe(missing.text);
  }
  // A story of another community is withheld under this slug too.
  const foreign = await body(
    `/explore/communities/public-alpha/stories/${ids.stB}`
  );
  expect(foreign.text).toBe(missing.text);
  for (const storyId of ['abc', '0', '2147483648', '-1']) {
    const malformed = await body(
      `/explore/communities/public-alpha/stories/${storyId}`
    );
    expect(malformed.status).toBe(404);
    expect(malformed.text).toBe(missing.text);
  }
});

it('serves the Rails place show shape and hides unassociated or restricted places', async () => {
  const page = await body(`/explore/communities/public-alpha/places/${ids.p1}`);
  expect(page.status).toBe(200);
  expect(page.json.data).toEqual({
    id: ids.p1,
    name: 'River Bend',
    description: 'Cold waters',
    region: 'North',
    placenameAudio: null,
    typeOfPlace: null,
    points: [
      {
        type: 'Feature',
        id: ids.p1,
        geometry: { type: 'Point', coordinates: [-20.2, 10.1] },
        properties: {
          name: 'River Bend',
          description: 'Cold waters',
          placenameAudio: null,
          photo: null,
          thumbnail: null,
          region: 'North',
          typeOfPlace: null,
        },
      },
    ],
  });
  // A place associated only as a public story's interview location is
  // readable per SPEC-V2 §6.4a.
  const meeting = await body(
    `/explore/communities/public-alpha/places/${ids.p4}`
  );
  expect(meeting.status).toBe(200);
  expect(meeting.json.data.name).toBe('Meeting Point');
  const missing = await body('/explore/communities/public-alpha/places/999999');
  expect(missing.status).toBe(404);
  // p3 is only associated with a members_only story; p2 is restricted;
  // pB belongs to another community. All answer the identical 404.
  for (const placeId of [ids.p3, ids.p2, ids.pB]) {
    const withheld = await body(
      `/explore/communities/public-alpha/places/${placeId}`
    );
    expect(withheld.status).toBe(404);
    expect(withheld.text).toBe(missing.text);
  }
  // Places of private/disabled communities are unreachable through any slug.
  for (const slug of ['private-gamma', 'disabled-delta', 'no-such']) {
    const gone = await body(`/explore/communities/${slug}/places/${ids.p1}`);
    expect(gone.status).toBe(404);
    expect(gone.json).toEqual({
      error: 'Not Found',
      message: 'The requested resource could not be found.',
    });
  }
});

it('serves public branding media and withholds every other file', async () => {
  const media = await get(`/explore/media/${fileIds.a}`);
  expect(media.status).toBe(200);
  expect(new Uint8Array(await media.arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3])
  );
  expect(media.headers.get('content-type')).toBe('image/png');
  expect(media.headers.get('content-disposition')).toBe('attachment');
  expect(media.headers.get('cache-control')).toBe('no-store');
  const missing = await get(`/explore/media/${crypto.randomUUID()}`);
  expect(missing.status).toBe(404);
  for (const key of [
    'aInactive',
    'aRestricted',
    'cross',
    'c',
  ] as const) {
    const withheld = await get(`/explore/media/${fileIds[key]}`);
    expect(withheld.status, key).toBe(404);
    expect(await withheld.json()).toEqual({
      error: 'Not Found',
      message: 'The requested resource could not be found.',
    });
  }
  const malformed = await get('/explore/media/not-a-uuid');
  expect(malformed.status).toBe(404);
  // A path-traversal storage key never reaches storage.
  await db
    .update(tables.files)
    .set({ path: `communities/${ids.a}/../secret` })
    .where(eq(tables.files.id, fileIds.a));
  const readsBefore = storageReads;
  expect((await get(`/explore/media/${fileIds.a}`)).status).toBe(404);
  expect(storageReads).toBe(readsBefore);
  await db
    .update(tables.files)
    .set({ path: `communities/${ids.a}/display.png` })
    .where(eq(tables.files.id, fileIds.a));
  // Withheld media and the missing id answer identically.
  expect(
    (await get(`/explore/media/${fileIds.aInactive}`)).status
  ).toBe((await get(`/explore/media/${crypto.randomUUID()}`)).status);
});

it('generates media URLs from the configured public origin', async () => {
  const page = await originApp.request(
    new Request('http://localhost/explore/communities/public-alpha')
  );
  const data = (await page.json()).data;
  expect(data.details.displayImage).toBe(
    `https://api.example.test/explore/media/${fileIds.a}`
  );
});

it('answers 404 for non-GET methods on the adapter namespace', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await app.request(
      new Request('http://localhost/explore/communities', { method })
    );
    expect(response.status, method).toBe(404);
  }
});
