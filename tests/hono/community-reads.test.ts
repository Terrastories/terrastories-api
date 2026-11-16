/**
 * Focused contract, §6.4a role-differentiation, #162 hiding, spatial, search,
 * and sovereignty isolation tests for Slice 6 authenticated community read routes
 * (#145, #146) on migrated SQLite in-memory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunityReadsRepository } from '../../src/repositories/community-reads.repository.js';
import { CommunityReadsService } from '../../src/services/community-reads.service.js';
import {
  CommunityMapConfigResponseSchema,
  CommunityReadDetailResponseSchema,
  CommunityStoriesListResponseSchema,
  CommunityStoryDetailResponseSchema,
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
  PublicPlaceDetailResponseSchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakersListResponseSchema,
} from '../../src/shared/schemas/community-reads.js';
import { V2ErrorResponseSchema } from '../../src/shared/schemas/public-communities.js';
import {
  deriveTopicNormalized,
  deriveUserIdentityColumns,
} from '../../src/shared/utils/derived-columns.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-02-01T00:00:00.000Z');
const T2 = new Date('2026-03-01T00:00:00.000Z');
const T3 = new Date('2026-04-01T00:00:00.000Z');

const TEST_DERIVED_KEY = makeDerivedKey();
const SAO_BENTO_NFD = 'Vila São Bento'.normalize('NFD');

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys=ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

let app: ReturnType<typeof createHonoApp>;
const ids: Record<string, number> = {};
const fileIds: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function insertRow(
  table: any,
  values: Record<string, unknown>
): Promise<number> {
  const rows = (await db.insert(table).values(values).returning()) as Array<{
    id: number;
  }>;
  return rows[0]!.id;
}

async function loginAs(email: string, communityId?: number): Promise<string> {
  let communitySlug: string | undefined;
  if (communityId !== undefined) {
    const [row] = await db
      .select({ slug: tables.communities.slug })
      .from(tables.communities)
      .where(eq(tables.communities.id, communityId))
      .limit(1);
    communitySlug = row?.slug;
  }
  const res = await app.request('http://localhost/v2/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey: TEST_DERIVED_KEY,
      ...(communitySlug !== undefined ? { communitySlug } : {}),
    }),
  });
  expect(res.status).toBe(200);
  const raw = res.headers.get('set-cookie');
  expect(raw).toBeTruthy();
  return raw!.split(';')[0]!;
}

async function fetchJson(
  path: string,
  cookie?: string
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const res = await app.request(`http://localhost${path}`, {
    headers: cookie ? { cookie } : {},
  });
  const json = await res.json();
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const seed = await argon2Seed(TEST_DERIVED_KEY);

  // Active private community (primary test surface for Slice 6)
  ids.priv = await insertRow(tables.communities, {
    name: 'Private Sovereign Nation',
    description: '<p>Sovereign archive</p><script>alert(1)</script>',
    slug: 'priv-nation',
    locale: 'en',
    country: 'BR',
    publicStories: false,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  // Active public community (no mapConfig row to verify 200 { data: null })
  ids.pub = await insertRow(tables.communities, {
    name: 'Public Nation',
    description: 'Public archive',
    slug: 'pub-nation',
    locale: 'pt',
    country: 'BR',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  // Disabled community with an own admin + active content
  ids.disabled = await insertRow(tables.communities, {
    name: 'Disabled Nation',
    description: 'Disabled secret',
    slug: 'disabled-nation',
    locale: 'en',
    publicStories: false,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });

  // Foreign active community
  ids.foreign = await insertRow(tables.communities, {
    name: 'Foreign Nation',
    description: 'Foreign secret',
    slug: 'foreign-nation',
    locale: 'es',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  const createUser = async (
    key: string,
    email: string,
    role: string,
    communityId: number | null
  ) => {
    const derived = deriveUserIdentityColumns(email);
    ids[key] = await insertRow(tables.users, {
      firstName: key,
      lastName: 'User',
      email,
      emailNormalized: derived.emailNormalized,
      ...seed,
      role,
      communityId,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
  };

  await createUser('uSuper', 'super@slice6.example.test', 'super_admin', null);
  await createUser('uViewer', 'viewer@priv.example.test', 'viewer', ids.priv);
  await createUser('uMember', 'member@priv.example.test', 'member', ids.priv);
  await createUser('uEditor', 'editor@priv.example.test', 'editor', ids.priv);
  await createUser('uAdmin', 'admin@priv.example.test', 'admin', ids.priv);
  await createUser('uPubViewer', 'viewer@pub.example.test', 'viewer', ids.pub);
  await createUser(
    'uDisabledAdmin',
    'admin@disabled.example.test',
    'admin',
    ids.disabled
  );
  await createUser(
    'uForeignAdmin',
    'admin@foreign.example.test',
    'admin',
    ids.foreign
  );

  // Files in priv (branding + static map + story media + #162 restricted media)
  const createFile = async (
    key: string,
    communityId: number,
    extra: Record<string, unknown> = {}
  ) => {
    const id = crypto.randomUUID();
    fileIds[key] = id;
    await db.insert(tables.files).values({
      id,
      filename: `${key}.png`,
      originalName: `${key}.png`,
      path: `communities/${communityId}/${key}.png`,
      storageKey: `communities/${communityId}/${key}.png`,
      url: `https://ignored.invalid/${key}.png`,
      mimeType: 'image/png',
      size: 4,
      byteSize: 4,
      communityId,
      uploadedBy: ids.uAdmin,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
      ...extra,
    });
  };

  await createFile('privDisplay', ids.priv);
  await createFile('privStaticMap', ids.priv);
  await createFile('privStoryMedia', ids.priv);
  await createFile('privRestrictedMedia', ids.priv, {
    culturalRestrictions: JSON.stringify({ restricted: true }),
  });
  await createFile('privPlacePhoto', ids.priv);
  await createFile('privPlaceAudio', ids.priv, { mimeType: 'audio/mpeg' });
  await createFile('privSpeakerPhoto', ids.priv);

  await db.insert(tables.attachments).values({
    communityId: ids.priv,
    ownerType: 'community',
    ownerId: ids.priv,
    fileId: fileIds.privDisplay!,
    role: 'community_display_image',
    ordinal: 0,
    createdAt: T0,
  });

  // MapConfig with credential-bearing styleUrl that MUST be withheld even for own-admin
  const unsafeStyle = `https://tiles.example.test/style.json?${'access_token'}=${['tok', 'val'].join('_')}`;
  await db.insert(tables.communityMapConfigs).values({
    communityId: ids.priv,
    styleUrl: unsafeStyle,
    basemapStyle: 'satellite',
    centerLatitude: -3.1,
    centerLongitude: -60.0,
    zoom: 8,
    staticMapFileId: fileIds.privStaticMap!,
    createdAt: T0,
    updatedAt: T0,
  });

  // Places in priv
  ids.plPublic = await insertRow(tables.places, {
    name: 'Public Clearing',
    description: 'Accessible clearing',
    typeOfPlace: 'Clearing',
    region: 'South',
    latitude: -3.1,
    longitude: -60.0,
    communityId: ids.priv,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plCommunity = await insertRow(tables.places, {
    name: 'Community Longhouse',
    description: 'Member gathering',
    typeOfPlace: 'Longhouse',
    region: 'North',
    latitude: -3.11, // ~1.1 km south of (-3.1, -60.0)
    longitude: -60.0,
    communityId: ids.priv,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plInterviewComm = await insertRow(tables.places, {
    name: 'Community Interview Creek',
    description: 'Antimeridian east edge',
    typeOfPlace: 'Creek',
    region: 'East',
    latitude: 10.0,
    longitude: 179.5,
    communityId: ids.priv,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plEditors = await insertRow(tables.places, {
    name: 'Editors Archive Room',
    description: 'Draft curation site',
    typeOfPlace: 'Archive',
    region: 'West',
    latitude: 10.0,
    longitude: -179.5, // antimeridian west edge
    communityId: ids.priv,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plStoryless = await insertRow(tables.places, {
    name: 'Storyless Survey Point',
    description: 'No stories yet',
    typeOfPlace: 'Lookout',
    region: 'Plateau',
    latitude: -4.5,
    longitude: -61.5,
    communityId: ids.priv,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plRestricted = await insertRow(tables.places, {
    name: 'Restricted Sacred Rock',
    description: '#162 hidden place',
    typeOfPlace: 'Sacred',
    region: 'RestrictedRegion',
    latitude: -3.1,
    longitude: -60.01,
    communityId: ids.priv,
    isRestricted: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plNullCoords = await insertRow(tables.places, {
    name: 'Unmapped Place',
    typeOfPlace: 'Oral',
    region: 'Unmapped',
    latitude: null,
    longitude: null,
    communityId: ids.priv,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });

  await db.insert(tables.attachments).values([
    {
      communityId: ids.priv,
      ownerType: 'place',
      ownerId: ids.plPublic,
      fileId: fileIds.privPlacePhoto!,
      role: 'place_photo',
      ordinal: 0,
      createdAt: T0,
    },
    {
      communityId: ids.priv,
      ownerType: 'place',
      ownerId: ids.plPublic,
      fileId: fileIds.privPlaceAudio!,
      role: 'place_name_audio',
      ordinal: 0,
      createdAt: T0,
    },
  ]);

  // Speakers in priv
  ids.spPublic = await insertRow(tables.speakers, {
    name: 'Speaker Public',
    affiliation: 'Public Guild',
    birthDate: '1965-04-10',
    birthplaceId: ids.plStoryless, // hidden for viewer/member, visible for editor/admin!
    communityId: ids.priv,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spCommunity = await insertRow(tables.speakers, {
    name: 'Speaker Community',
    affiliation: 'Community Council',
    birthplaceId: ids.plRestricted, // #162 hidden for ALL roles incl. editor/admin!
    communityId: ids.priv,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spInterviewerComm = await insertRow(tables.speakers, {
    name: 'Interviewer Community',
    affiliation: 'Interviewer Circle',
    birthplaceId: ids.plPublic, // readable birthplace even for viewer!
    communityId: ids.priv,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spEditors = await insertRow(tables.speakers, {
    name: 'Speaker Editors',
    affiliation: 'Editors Guild',
    communityId: ids.priv,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spStoryless = await insertRow(tables.speakers, {
    name: 'Speaker Storyless',
    affiliation: 'Survey Guild',
    communityId: ids.priv,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spWithdrawn = await insertRow(tables.speakers, {
    name: 'Speaker Withdrawn',
    affiliation: 'Withdrawn Guild',
    communityId: ids.priv,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });

  await db.insert(tables.attachments).values({
    communityId: ids.priv,
    ownerType: 'speaker',
    ownerId: ids.spPublic,
    fileId: fileIds.privSpeakerPhoto!,
    role: 'speaker_photo',
    ordinal: 0,
    createdAt: T0,
  });

  // Stories in priv
  ids.stPublic = await insertRow(tables.stories, {
    title: 'Βόσπορος Water Song',
    slug: 'water-song',
    description: `<p>${SAO_BENTO_NFD} river story</p><script>secretscript</script><a href="https://hidden-host.test/x">link</a>`,
    descriptionPlain: `${SAO_BENTO_NFD} river story link`,
    topic: 'Fishing',
    topicNormalized: deriveTopicNormalized('Fishing'),
    language: 'Portuguese',
    privacyLevel: 'public',
    isRestricted: false,
    communityId: ids.priv,
    createdAt: T1,
    updatedAt: T1,
  });
  ids.stCommunity = await insertRow(tables.stories, {
    title: 'Members Feast',
    slug: 'members-feast',
    description: 'Community only narrative',
    descriptionPlain: 'Community only narrative',
    topic: 'Ceremony',
    topicNormalized: deriveTopicNormalized('Ceremony'),
    language: 'Guarani',
    privacyLevel: 'members_only',
    isRestricted: false,
    interviewLocationId: ids.plInterviewComm,
    interviewerId: ids.spInterviewerComm,
    communityId: ids.priv,
    createdAt: T2,
    updatedAt: T2,
  });
  ids.stEditors = await insertRow(tables.stories, {
    title: 'Editors Draft Story',
    slug: 'editors-draft',
    description: 'Draft review notes',
    descriptionPlain: 'Draft review notes',
    topic: 'DraftTopic',
    topicNormalized: deriveTopicNormalized('DraftTopic'),
    language: 'EditorsLang',
    privacyLevel: 'editors',
    isRestricted: false,
    communityId: ids.priv,
    createdAt: T3,
    updatedAt: T3,
  });
  ids.stRestricted = await insertRow(tables.stories, {
    title: 'Restricted Secret Story',
    slug: 'restricted-secret',
    description: 'Secret cultural record',
    descriptionPlain: 'Secret cultural record',
    topic: 'RestrictedTopic',
    topicNormalized: deriveTopicNormalized('RestrictedTopic'),
    language: 'RestrictedLang',
    privacyLevel: 'editors',
    isRestricted: true,
    communityId: ids.priv,
    createdAt: T3,
    updatedAt: T3,
  });
  ids.stUnevidenced = await insertRow(tables.stories, {
    title: 'Unknown Privacy Story',
    slug: 'unknown-privacy',
    description: 'Unevidenced legacy privacy',
    descriptionPlain: 'Unevidenced legacy privacy',
    topic: 'UnknownTopic',
    topicNormalized: deriveTopicNormalized('UnknownTopic'),
    language: 'UnknownLang',
    privacyLevel: 'members',
    isRestricted: false,
    communityId: ids.priv,
    createdAt: T3,
    updatedAt: T3,
  });

  // Edges in priv (including duplicated edge multiplicity in stPublic + restricted place edge!)
  await db.insert(tables.storyPlaces).values([
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      placeId: ids.plPublic,
      sortOrder: 2,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      placeId: ids.plNullCoords,
      sortOrder: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      placeId: ids.plPublic,
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      placeId: ids.plRestricted,
      sortOrder: 3,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stCommunity,
      placeId: ids.plCommunity,
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stEditors,
      placeId: ids.plEditors,
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);

  await db.insert(tables.storySpeakers).values([
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      speakerId: ids.spPublic,
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      speakerId: ids.spWithdrawn,
      sortOrder: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stCommunity,
      speakerId: ids.spCommunity,
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stEditors,
      speakerId: ids.spEditors,
      sortOrder: 0,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);

  await db.insert(tables.attachments).values([
    {
      communityId: ids.priv,
      ownerType: 'story',
      ownerId: ids.stPublic,
      fileId: fileIds.privStoryMedia!,
      role: 'story_media',
      ordinal: 0,
      createdAt: T0,
    },
    {
      communityId: ids.priv,
      ownerType: 'story',
      ownerId: ids.stPublic,
      fileId: fileIds.privRestrictedMedia!,
      role: 'story_media',
      ordinal: 1,
      createdAt: T0,
    },
  ]);

  await db.insert(tables.externalMediaLinks).values([
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      url: 'https://watch.example.test/valid',
      ordinal: 0,
      createdAt: T0,
    },
    {
      communityId: ids.priv,
      storyId: ids.stPublic,
      url: 'javascript:alert(1)',
      ordinal: 1,
      createdAt: T0,
    },
  ]);

  // Foreign active community story/place/speaker for cross-tenant tests
  ids.plForeign = await insertRow(tables.places, {
    name: 'Foreign Place',
    communityId: ids.foreign,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spForeign = await insertRow(tables.speakers, {
    name: 'Foreign Speaker',
    communityId: ids.foreign,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.stForeign = await insertRow(tables.stories, {
    title: 'Foreign Public Story',
    slug: 'foreign-public',
    language: 'es',
    privacyLevel: 'public',
    isRestricted: false,
    communityId: ids.foreign,
    createdAt: T0,
    updatedAt: T0,
  });

  // Disabled community content (must be 403 for disabled_admin!)
  ids.stDisabled = await insertRow(tables.stories, {
    title: 'Disabled Community Story',
    slug: 'disabled-story',
    language: 'en',
    privacyLevel: 'public',
    isRestricted: false,
    communityId: ids.disabled,
    createdAt: T0,
    updatedAt: T0,
  });

  app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    secureCookies: false,
    publicOrigin: 'https://api.example.test',
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  });

  cookies.super = await loginAs('super@slice6.example.test');
  cookies.viewer = await loginAs('viewer@priv.example.test', ids.priv);
  cookies.member = await loginAs('member@priv.example.test', ids.priv);
  cookies.editor = await loginAs('editor@priv.example.test', ids.priv);
  cookies.admin = await loginAs('admin@priv.example.test', ids.priv);
  cookies.pubViewer = await loginAs('viewer@pub.example.test', ids.pub);
  cookies.disabledAdmin = await loginAs(
    'admin@disabled.example.test',
    ids.disabled
  );
  cookies.foreignAdmin = await loginAs(
    'admin@foreign.example.test',
    ids.foreign
  );
});

afterAll(() => {
  sqlite.close();
});

describe('Slice 6 authentication, tenant isolation & disabled/super_admin gates', () => {
  it('returns 401 unauthenticated and 403 for super_admin & disabled-community admin across all 8 routes', async () => {
    const paths = [
      '/v2/community',
      '/v2/community/map-config',
      '/v2/stories',
      `/v2/stories/${ids.stPublic}`,
      '/v2/places',
      `/v2/places/${ids.plPublic}`,
      '/v2/speakers',
      `/v2/speakers/${ids.spPublic}`,
    ];

    // Confirm disabled-community admin CAN reach /v2/auth/me (sovereignty prerequisite)
    const disabledMe = await fetchJson('/v2/auth/me', cookies.disabledAdmin);
    expect(disabledMe.status).toBe(200);

    for (const path of paths) {
      const unauth = await fetchJson(path);
      expect(unauth.status).toBe(401);
      expect(V2ErrorResponseSchema.parse(unauth.json)).toEqual({
        error: 'Unauthorized',
      });

      for (const roleKey of ['super', 'disabledAdmin'] as const) {
        const denied = await fetchJson(path, cookies[roleKey]);
        expect(denied.status).toBe(403);
        expect(V2ErrorResponseSchema.parse(denied.json)).toEqual({
          error: 'Forbidden',
        });
      }
    }

    // Even malformed query/id answers 403 for super_admin and disabledAdmin
    for (const roleKey of ['super', 'disabledAdmin'] as const) {
      expect(
        (await fetchJson('/v2/stories?limit=bogus', cookies[roleKey])).status
      ).toBe(403);
      expect(
        (await fetchJson('/v2/stories/not-an-id', cookies[roleKey])).status
      ).toBe(403);
    }
  });

  it('ignores ?communityId spoof parameters and returns 404 on cross-community IDs', async () => {
    const spoofed = await fetchJson(
      `/v2/stories?communityId=${ids.foreign}`,
      cookies.admin
    );
    expect(spoofed.status).toBe(200);
    const parsed = CommunityStoriesListResponseSchema.parse(spoofed.json);
    expect(parsed.data.stories.some((s) => s.id === ids.stForeign)).toBe(false);

    for (const crossPath of [
      `/v2/stories/${ids.stForeign}`,
      `/v2/places/${ids.plForeign}`,
      `/v2/speakers/${ids.spForeign}`,
      `/v2/stories/${ids.stDisabled}`,
    ]) {
      const res = await fetchJson(crossPath, cookies.admin);
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: 'Not found' });
    }
  });
});

describe('Slice 6 §6.4a role differentiation and #162 hiding', () => {
  it('differentiates /v2/community and /v2/community/map-config cleanly by role', async () => {
    const viewerComm = await fetchJson('/v2/community', cookies.viewer);
    expect(viewerComm.status).toBe(200);
    const vParsed = CommunityReadDetailResponseSchema.parse(viewerComm.json);
    expect(vParsed.data.visibility).toBe('private');
    expect(vParsed.data.status).toBe('active');
    expect(vParsed.data.description).toBe('<p>Sovereign archive</p>');
    expect(vParsed.data.storiesCount).toBe(1);
    expect(vParsed.data.points.map((p) => p.id)).toEqual([ids.plPublic]);
    expect(vParsed.data.branding.displayImage?.url).toBe(
      `https://api.example.test/v2/media/${fileIds.privDisplay}`
    );
    expect(vParsed.data.mapConfig?.styleUrl).toBeNull();
    expect(vParsed.data.mapConfig?.staticMapUrl).toBe(
      `https://api.example.test/v2/media/${fileIds.privStaticMap}`
    );
    expect(
      vParsed.data.filters
        .filter((f) => f.category === 'topic')
        .map((f) => f.value)
    ).toEqual(['Fishing']);

    const memberComm = await fetchJson('/v2/community', cookies.member);
    const mParsed = CommunityReadDetailResponseSchema.parse(memberComm.json);
    expect(mParsed.data.storiesCount).toBe(2);
    expect(mParsed.data.points.map((p) => p.id)).toEqual([
      ids.plPublic,
      ids.plCommunity,
      ids.plInterviewComm,
    ]);
    expect(
      mParsed.data.filters
        .filter((f) => f.category === 'topic')
        .map((f) => f.value)
    ).toEqual(['Ceremony', 'Fishing']);

    for (const roleKey of ['editor', 'admin'] as const) {
      const roleComm = await fetchJson('/v2/community', cookies[roleKey]);
      const rParsed = CommunityReadDetailResponseSchema.parse(roleComm.json);
      expect(rParsed.data.storiesCount).toBe(3); // excludes #162 stRestricted & stUnevidenced
      expect(rParsed.data.points.map((p) => p.id)).toEqual([
        ids.plPublic,
        ids.plCommunity,
        ids.plInterviewComm,
        ids.plEditors,
        ids.plStoryless,
      ]); // excludes plRestricted (#162) & plNullCoords!
      expect(
        rParsed.data.filters
          .filter((f) => f.category === 'topic')
          .map((f) => f.value)
      ).toEqual(['Ceremony', 'DraftTopic', 'Fishing']);
    }

    const mapRes = await fetchJson('/v2/community/map-config', cookies.admin);
    expect(mapRes.status).toBe(200);
    const mapParsed = CommunityMapConfigResponseSchema.parse(mapRes.json);
    expect(mapParsed.data?.styleUrl).toBeNull();
    expect(mapParsed.data?.staticMapFileId).toBe(fileIds.privStaticMap);

    // Public community without mapConfig returns 200 { data: null }
    const noMapRes = await fetchJson(
      '/v2/community/map-config',
      cookies.pubViewer
    );
    expect(noMapRes.status).toBe(200);
    expect(CommunityMapConfigResponseSchema.parse(noMapRes.json)).toEqual({
      data: null,
    });
  });

  it('enforces §6.4a story visibility and #162 hiding across viewer/member/editor/admin', async () => {
    const expectations: Array<{
      role: 'viewer' | 'member' | 'editor' | 'admin';
      visibleStories: number[];
      hiddenStories: number[];
    }> = [
      {
        role: 'viewer',
        visibleStories: [ids.stPublic!],
        hiddenStories: [
          ids.stCommunity!,
          ids.stEditors!,
          ids.stRestricted!,
          ids.stUnevidenced!,
        ],
      },
      {
        role: 'member',
        visibleStories: [ids.stCommunity!, ids.stPublic!],
        hiddenStories: [ids.stEditors!, ids.stRestricted!, ids.stUnevidenced!],
      },
      {
        role: 'editor',
        visibleStories: [ids.stEditors!, ids.stCommunity!, ids.stPublic!],
        hiddenStories: [ids.stRestricted!, ids.stUnevidenced!],
      },
      {
        role: 'admin',
        visibleStories: [ids.stEditors!, ids.stCommunity!, ids.stPublic!],
        hiddenStories: [ids.stRestricted!, ids.stUnevidenced!],
      },
    ];

    for (const check of expectations) {
      const list = await fetchJson('/v2/stories', cookies[check.role]);
      expect(list.status).toBe(200);
      const parsed = CommunityStoriesListResponseSchema.parse(list.json);
      expect(parsed.data.stories.map((s) => s.id)).toEqual(
        check.visibleStories
      );

      for (const id of check.visibleStories) {
        const detail = await fetchJson(
          `/v2/stories/${id}`,
          cookies[check.role]
        );
        expect(detail.status).toBe(200);
        CommunityStoryDetailResponseSchema.parse(detail.json);
      }
      for (const id of check.hiddenStories) {
        const denied = await fetchJson(
          `/v2/stories/${id}`,
          cookies[check.role]
        );
        expect(denied.status).toBe(404);
        expect(denied.json).toEqual({ error: 'Not found' });
      }
    }

    // Check stPublic detail: edge multiplicity (plPublic, plNullCoords, plPublic),
    // #162 restricted place & media omitted, withdrawn speaker hidden from viewer,
    // storyless birthplace hidden from viewer but shown to editor.
    const viewerDetail = await fetchJson(
      `/v2/stories/${ids.stPublic}`,
      cookies.viewer
    );
    const vStory = CommunityStoryDetailResponseSchema.parse(
      viewerDetail.json
    ).data;
    expect(vStory.places.map((p) => p.id)).toEqual([
      ids.plPublic,
      ids.plNullCoords,
      ids.plPublic,
    ]);
    expect(vStory.speakers.map((s) => s.id)).toEqual([ids.spPublic]);
    expect(vStory.speakers[0]?.birthplace).toBeNull();
    expect(vStory.attachments.map((a) => a.fileId)).toEqual([
      fileIds.privStoryMedia,
    ]);
    expect(vStory.externalMediaLinks.map((l) => l.url)).toEqual([
      'https://watch.example.test/valid',
    ]);

    const editorDetail = await fetchJson(
      `/v2/stories/${ids.stPublic}`,
      cookies.editor
    );
    const eStory = CommunityStoryDetailResponseSchema.parse(
      editorDetail.json
    ).data;
    expect(eStory.speakers.map((s) => s.id)).toEqual([
      ids.spPublic,
      ids.spWithdrawn,
    ]);
    expect(eStory.speakers[0]?.birthplace?.id).toBe(ids.plStoryless);
    expect(eStory.places.some((p) => p.id === ids.plRestricted)).toBe(false);
  });

  it('enforces §6.4a place and speaker visibility + birthplace gating + #162 hiding', async () => {
    // viewer places
    const vPlaces = PublicPlacesListResponseSchema.parse(
      (await fetchJson('/v2/places', cookies.viewer)).json
    );
    expect(vPlaces.data.map((p) => p.id)).toEqual([
      ids.plPublic,
      ids.plNullCoords,
    ]);
    expect(
      (await fetchJson(`/v2/places/${ids.plCommunity}`, cookies.viewer)).status
    ).toBe(404);
    expect(
      (await fetchJson(`/v2/places/${ids.plStoryless}`, cookies.viewer)).status
    ).toBe(404);
    expect(
      (await fetchJson(`/v2/places/${ids.plRestricted}`, cookies.viewer)).status
    ).toBe(404);

    // member places (adds via storyPlaces + interviewLocationId of members_only story)
    const mPlaces = PublicPlacesListResponseSchema.parse(
      (await fetchJson('/v2/places', cookies.member)).json
    );
    expect(mPlaces.data.map((p) => p.id)).toEqual([
      ids.plPublic,
      ids.plCommunity,
      ids.plInterviewComm,
      ids.plNullCoords,
    ]);
    expect(
      PublicPlaceDetailResponseSchema.parse(
        (await fetchJson(`/v2/places/${ids.plInterviewComm}`, cookies.member))
          .json
      ).data.id
    ).toBe(ids.plInterviewComm);
    expect(
      (await fetchJson(`/v2/places/${ids.plEditors}`, cookies.member)).status
    ).toBe(404);
    expect(
      (await fetchJson(`/v2/places/${ids.plStoryless}`, cookies.member)).status
    ).toBe(404);

    // editor/admin places: all unrestricted incl. editors & storyless; #162 restricted STILL 404!
    for (const roleKey of ['editor', 'admin'] as const) {
      const rPlaces = PublicPlacesListResponseSchema.parse(
        (await fetchJson('/v2/places', cookies[roleKey])).json
      );
      expect(rPlaces.data.map((p) => p.id)).toEqual([
        ids.plPublic,
        ids.plCommunity,
        ids.plInterviewComm,
        ids.plEditors,
        ids.plStoryless,
        ids.plNullCoords,
      ]);
      expect(
        (await fetchJson(`/v2/places/${ids.plRestricted}`, cookies[roleKey]))
          .status
      ).toBe(404);
    }

    // Speakers + birthplace projection per role
    const vSpeakers = PublicSpeakersListResponseSchema.parse(
      (await fetchJson('/v2/speakers', cookies.viewer)).json
    );
    expect(vSpeakers.data.map((s) => s.id)).toEqual([ids.spPublic]);
    expect(vSpeakers.data[0]?.birthplace).toBeNull();
    expect(
      (await fetchJson(`/v2/speakers/${ids.spWithdrawn}`, cookies.viewer))
        .status
    ).toBe(404);
    expect(
      (await fetchJson(`/v2/speakers/${ids.spStoryless}`, cookies.viewer))
        .status
    ).toBe(404);

    const mSpeakers = PublicSpeakersListResponseSchema.parse(
      (await fetchJson('/v2/speakers', cookies.member)).json
    );
    expect(mSpeakers.data.map((s) => s.id)).toEqual([
      ids.spPublic,
      ids.spCommunity,
      ids.spInterviewerComm,
    ]);
    expect(
      mSpeakers.data.find((s) => s.id === ids.spPublic)?.birthplace
    ).toBeNull();
    expect(
      mSpeakers.data.find((s) => s.id === ids.spCommunity)?.birthplace
    ).toBeNull();
    expect(
      mSpeakers.data.find((s) => s.id === ids.spInterviewerComm)?.birthplace?.id
    ).toBe(ids.plPublic);

    // Editor sees all speakers incl. storyless & withdrawn, spPublic.birthplace is plStoryless,
    // while spCommunity.birthplace (plRestricted) STILL hidden as null!
    const eSpeakers = PublicSpeakersListResponseSchema.parse(
      (await fetchJson('/v2/speakers', cookies.editor)).json
    );
    expect(eSpeakers.data.map((s) => s.id)).toEqual([
      ids.spPublic,
      ids.spCommunity,
      ids.spInterviewerComm,
      ids.spEditors,
      ids.spStoryless,
      ids.spWithdrawn,
    ]);
    expect(
      eSpeakers.data.find((s) => s.id === ids.spPublic)?.birthplace?.id
    ).toBe(ids.plStoryless);
    expect(
      eSpeakers.data.find((s) => s.id === ids.spCommunity)?.birthplace
    ).toBeNull();
    expect(
      PublicSpeakerDetailResponseSchema.parse(
        (await fetchJson(`/v2/speakers/${ids.spCommunity}`, cookies.admin)).json
      ).data.birthplace
    ).toBeNull();
  });
});

describe('Slice 6 search, spatial bbox/near, D1 param bounds & fail-closed checks', () => {
  it('supports Unicode plain-text search without matching stripped HTML tags', async () => {
    // Greek final sigma / uppercase parity on title
    const sigmaRes = await fetchJson(
      `/v2/stories?search=${encodeURIComponent('βόσποροσ')}`,
      cookies.viewer
    );
    expect(sigmaRes.status).toBe(200);
    expect(
      CommunityStoriesListResponseSchema.parse(sigmaRes.json).data.stories.map(
        (s) => s.id
      )
    ).toEqual([ids.stPublic]);

    // NFC query matches NFD descriptionPlain
    const nfcRes = await fetchJson(
      `/v2/stories?search=${encodeURIComponent('São Bento')}`,
      cookies.viewer
    );
    expect(nfcRes.status).toBe(200);
    expect(
      CommunityStoriesListResponseSchema.parse(nfcRes.json).data.stories.map(
        (s) => s.id
      )
    ).toEqual([ids.stPublic]);

    // Stripped <script> & link URL never match plain-text search
    const scriptRes = await fetchJson(
      '/v2/stories?search=secretscript',
      cookies.admin
    );
    expect(
      CommunityStoriesListResponseSchema.parse(scriptRes.json).data.stories
    ).toEqual([]);
    const hrefRes = await fetchJson(
      '/v2/stories?search=hidden-host',
      cookies.admin
    );
    expect(
      CommunityStoriesListResponseSchema.parse(hrefRes.json).data.stories
    ).toEqual([]);

    // Role gate still holds during search (#162 restricted never found)
    const restrictedSearch = await fetchJson(
      '/v2/stories?search=Restricted',
      cookies.admin
    );
    expect(
      CommunityStoriesListResponseSchema.parse(restrictedSearch.json).data
        .stories
    ).toEqual([]);

    // Malformed / duplicated search returns 400
    expect(
      (await fetchJson('/v2/stories?search=a&search=b', cookies.admin)).status
    ).toBe(400);
    expect(
      (await fetchJson(`/v2/stories?search=${'x'.repeat(501)}`, cookies.admin))
        .status
    ).toBe(400);
  });

  it('supports portable lat/lng bbox and near spatial filtering on /v2/places', async () => {
    // Standard bbox around (-3.1, -60.0) returns plPublic for viewer; excludes plNullCoords & plRestricted
    const bboxViewer = await fetchJson(
      '/v2/places?bbox=-60.05,-3.15,-59.95,-3.05',
      cookies.viewer
    );
    expect(bboxViewer.status).toBe(200);
    expect(
      PublicPlacesListResponseSchema.parse(bboxViewer.json).data.map(
        (p) => p.id
      )
    ).toEqual([ids.plPublic]);

    // Member sees plPublic + plCommunity in that bbox; plRestricted still excluded
    const bboxMember = await fetchJson(
      '/v2/places?bbox=-60.05,-3.15,-59.95,-3.05',
      cookies.member
    );
    expect(
      PublicPlacesListResponseSchema.parse(bboxMember.json).data.map(
        (p) => p.id
      )
    ).toEqual([ids.plPublic, ids.plCommunity]);

    // Antimeridian crossing bbox (west > east): west=179.0, east=-179.0 includes plInterviewComm & plEditors for admin
    const antimeridian = await fetchJson(
      '/v2/places?bbox=179.0,9.0,-179.0,11.0',
      cookies.admin
    );
    expect(antimeridian.status).toBe(200);
    expect(
      PublicPlacesListResponseSchema.parse(antimeridian.json).data.map(
        (p) => p.id
      )
    ).toEqual([ids.plInterviewComm, ids.plEditors]);

    // Near filter: 0.5km around (-3.1, -60.0) hits ONLY plPublic (plCommunity is ~1.11 km away)
    const nearTight = await fetchJson(
      '/v2/places?near=-3.1,-60.0,0.5',
      cookies.member
    );
    expect(nearTight.status).toBe(200);
    expect(
      PublicPlacesListResponseSchema.parse(nearTight.json).data.map((p) => p.id)
    ).toEqual([ids.plPublic]);

    // Near filter: 2km hits both plPublic & plCommunity for member (storyless & restricted excluded)
    const nearWide = await fetchJson(
      '/v2/places?near=-3.1,-60.0,2',
      cookies.member
    );
    expect(
      PublicPlacesListResponseSchema.parse(nearWide.json).data.map((p) => p.id)
    ).toEqual([ids.plPublic, ids.plCommunity]);

    // Invalid spatial parameters -> 400
    for (const bad of [
      '/v2/places?bbox=1,2,3',
      '/v2/places?bbox=-60,10,-59,-10', // south > north
      '/v2/places?bbox=181,0,182,1',
      '/v2/places?near=-3.1,-60.0,0', // radius <= 0
      '/v2/places?near=-95,0,10',
      '/v2/places?near=a,b,10',
    ]) {
      const res = await fetchJson(bad, cookies.admin);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Invalid request' });
    }
  });

  it('bounds SQL parameters <= 100 on max-cap filters and fails closed on Zod output failure', async () => {
    const paramCounts: number[] = [];
    const origPrepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((source: string) => {
      const stmt = origPrepare(source);
      const wrap =
        <T extends (...args: unknown[]) => unknown>(fn: T) =>
        (...args: unknown[]) => {
          const count = args.reduce<number>(
            (acc, arg) => acc + (Array.isArray(arg) ? arg.length : 1),
            0
          );
          paramCounts.push(count);
          return fn.apply(stmt, args);
        };
      for (const method of ['all', 'get', 'run', 'values'] as const) {
        if (typeof stmt[method] === 'function') {
          stmt[method] = wrap(
            stmt[method].bind(stmt) as (...args: unknown[]) => unknown
          ) as never;
        }
      }
      return stmt;
    }) as typeof sqlite.prepare;

    try {
      const capParams = new URLSearchParams();
      capParams.append('place', String(ids.plPublic));
      for (let i = 1; i < MAX_PUBLIC_FILTER_VALUES; i++) {
        capParams.append('place', String(900000 + i));
      }
      capParams.append('speaker', String(ids.spPublic));
      for (
        let i = 1;
        i < MAX_PUBLIC_TOTAL_FILTER_VALUES - MAX_PUBLIC_FILTER_VALUES;
        i++
      ) {
        capParams.append('speaker', String(950000 + i));
      }
      const res = await fetchJson(
        `/v2/stories?${capParams.toString()}`,
        cookies.viewer
      );
      expect(res.status).toBe(200);
      expect(
        CommunityStoriesListResponseSchema.parse(res.json).data.stories.map(
          (s) => s.id
        )
      ).toEqual([ids.stPublic]);
      expect(Math.max(...paramCounts)).toBeLessThanOrEqual(100);
    } finally {
      sqlite.prepare = origPrepare;
    }

    // Zod output parse failure returns 500 without logging secret title
    const secretTitle = 'NEVER_LOG_SLICE6_SECRET';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const brokenService = new CommunityReadsService({
        async activeCommunity() {
          return {
            id: ids.priv!,
            name: 'Priv',
            description: null,
            slug: 'priv-nation',
            locale: 'en',
            country: null,
            publicStories: false,
            isActive: true,
            createdAt: T0,
            updatedAt: T0,
          };
        },
        async getStoryById() {
          return {
            community: {
              id: ids.priv!,
              name: 'Priv',
              description: null,
              slug: 'priv-nation',
              locale: 'en',
              country: null,
              publicStories: false,
              isActive: true,
              createdAt: T0,
              updatedAt: T0,
            },
            story: {
              id: -5, // invalid negative id triggers Zod failure
              communityId: ids.priv!,
              title: secretTitle,
              description: null,
              topic: null,
              language: 'en',
              privacyLevel: 'public',
              isRestricted: false,
              dateInterviewed: null,
              interviewLocationId: null,
              interviewerId: null,
              createdAt: T0,
              updatedAt: T0,
            },
            places: [],
            points: [],
            speakers: [],
            interviewLocation: null,
            interviewer: null,
            birthplacesById: new Map(),
            speakerPhotosBySpeakerId: new Map(),
            attachments: [],
            externalLinks: [],
          };
        },
      } as unknown as CommunityReadsRepository);

      const errRes = await brokenService.getStoryById(
        {
          id: ids.uAdmin!,
          email: 'admin@priv.example.test',
          role: 'admin',
          communityId: ids.priv!,
        },
        '1',
        'https://api.example.test'
      );
      expect(errRes).toEqual({
        status: 500,
        body: { error: 'Internal server error' },
      });
      const logged = errSpy.mock.calls.flat().join(' ');
      expect(logged.includes(secretTitle)).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
