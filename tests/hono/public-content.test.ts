/**
 * Focused contract, sovereignty, filter, sorting, sanitisation, and media Range
 * tests for canonical V2 Slice 5 endpoints (#145):
 * - `/v2/public/communities/:slug/stories`
 * - `/v2/public/communities/:slug/stories/:storyId`
 * - `/v2/public/communities/:slug/places`
 * - `/v2/public/communities/:slug/places/:placeId`
 * - `/v2/public/communities/:slug/speakers`
 * - `/v2/public/communities/:slug/speakers/:speakerId`
 * - `/v2/public/communities/:slug/media/:fileId`
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hash } from 'bcrypt';
import { sql } from 'drizzle-orm';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { tablesFor } from '../../src/db/dialect.js';
import { communityMediaSqlite } from '../../src/db/schema/sessions.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { PublicContentRepository } from '../../src/repositories/public-content.repository.js';
import { PublicCommunitiesService } from '../../src/services/public-communities.service.js';
import { PublicContentService } from '../../src/services/public-content.service.js';
import {
  PublicCommunityDetailResponseSchema,
  V2ErrorResponseSchema,
} from '../../src/shared/schemas/public-communities.js';
import {
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
  PublicExternalMediaLinkSchema,
  PublicPlaceDetailResponseSchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakersListResponseSchema,
  PublicStoriesListResponseSchema,
  PublicStoryDetailResponseSchema,
} from '../../src/shared/schemas/public-content.js';
import {
  deriveTopicNormalized,
  deriveUserIdentityColumns,
} from '../../src/shared/utils/derived-columns.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-02-01T00:00:00.000Z');
const T2 = new Date('2026-03-01T00:00:00.000Z');

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys=ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

const storageBytes = new Map<string, Uint8Array>();
let app: ReturnType<typeof createHonoApp>;
let originApp: ReturnType<typeof createHonoApp>;

const ids: Record<string, number> = {};
const fileIds: Record<string, string> = {};
const PASSWORD = 'PublicContentTestPassword123!';

const NEVER_EXPOSED = [
  'Restricted Cove',
  'Restricted Secret Topic',
  'Withdrawn Speaker',
  'Members Only Story',
  'Members Secret Place',
  'Members Secret Speaker',
  'Editors Only Story',
  'Unknown Privacy Story',
  'Storyless Meadow',
  'Birthplace Only Valley',
  'Speaker Storyless Only',
  'Speaker Members Only',
  'Private Village',
  'Disabled Village',
  'User Avatar Secret',
  'Unattached Staging Secret',
  'Restricted Story File Secret',
  'alert(1)',
  'javascript:',
];

async function insertRow(
  table: unknown,
  values: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const [row] = await db
    .insert(table as never)
    .values(values as never)
    .returning();
  return row as Record<string, unknown>;
}

async function seed() {
  const alpha = await insertRow(tables.communities, {
    name: 'Public Alpha',
    description: 'Alpha description',
    slug: 'public-alpha',
    locale: 'en',
    country: 'Brazil',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T1,
  });
  const priv = await insertRow(tables.communities, {
    name: 'Private Village',
    slug: 'private-village',
    locale: 'en',
    publicStories: false,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const disabled = await insertRow(tables.communities, {
    name: 'Disabled Village',
    slug: 'disabled-village',
    locale: 'en',
    publicStories: true,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.alpha = alpha.id as number;
  ids.priv = priv.id as number;
  ids.disabled = disabled.id as number;

  const passwordHash = (await hash(PASSWORD, 4)).replace('$2b$', '$2a$');
  const createUser = async (
    key: string,
    email: string,
    role: string,
    communityId: number | null
  ) => {
    const row = await insertRow(tables.users, {
      email,
      username: `pubc_${key}`,
      ...deriveUserIdentityColumns({ email, username: `pubc_${key}` }),
      passwordHash,
      firstName: 'Pub',
      lastName: key,
      role: sql`${role}`,
      communityId,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
    ids[`user_${key}`] = row.id as number;
  };

  await createUser('member', 'member@alpha.test', 'member', ids.alpha);
  await createUser('admin', 'admin@alpha.test', 'admin', ids.alpha);
  await createUser('other', 'viewer@priv.test', 'viewer', ids.priv);
  await createUser('super_admin', 'super@system.test', 'super_admin', null);

  const createStoredFile = async (
    key: string,
    communityId: number,
    payloadText: string,
    mimeType = 'image/png',
    overrides: Record<string, unknown> = {}
  ) => {
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode(payloadText);
    const storageKey =
      (overrides.storageKey as string | undefined) ??
      `communities/${communityId}/${id}.bin`;
    await insertRow(tables.files, {
      id,
      filename: `${key}.bin`,
      originalName: `${key}.bin`,
      path: storageKey,
      storageKey,
      url: `/v2/media/${id}`,
      mimeType,
      size: bytes.byteLength,
      byteSize: bytes.byteLength,
      uploadedBy: ids.user_admin,
      communityId,
      culturalRestrictions: null,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });
    storageBytes.set(storageKey, bytes);
    fileIds[key] = id;
    return id;
  };

  // Community branding & static map files
  await createStoredFile('brandingDisplay', ids.alpha, 'DISPLAY_BYTES');
  await createStoredFile('brandingLegacy', ids.alpha, 'LEGACY_BRANDING');
  await createStoredFile('staticMap', ids.alpha, 'STATIC_MAP_BYTES');
  // Story, place, speaker authorized media
  await createStoredFile(
    'storyMedia1',
    ids.alpha,
    '0123456789ABCDEF',
    'audio/mpeg'
  );
  await createStoredFile(
    'storyMedia2',
    ids.alpha,
    'SECOND_STORY_MEDIA',
    'image/jpeg'
  );
  await createStoredFile('placePhoto1', ids.alpha, 'PLACE_PHOTO_1');
  await createStoredFile(
    'placeAudio1',
    ids.alpha,
    'PLACE_AUDIO_1',
    'audio/ogg'
  );
  await createStoredFile('speakerPhoto1', ids.alpha, 'SPEAKER_PHOTO_1');
  // Forbidden media scenarios
  await createStoredFile('userPhoto', ids.alpha, 'User Avatar Secret');
  await createStoredFile('unattached', ids.alpha, 'Unattached Staging Secret');
  await createStoredFile(
    'restrictedFile',
    ids.alpha,
    'Restricted Story File Secret',
    'image/png',
    {
      culturalRestrictions: JSON.stringify({ level: 'secret' }),
    }
  );
  await createStoredFile(
    'inactiveFile',
    ids.alpha,
    'INACTIVE_FILE',
    'image/png',
    {
      isActive: false,
    }
  );
  await createStoredFile(
    'storylessPlacePhoto',
    ids.alpha,
    'STORYLESS_PLACE_PHOTO'
  );
  await createStoredFile('membersStoryMedia', ids.alpha, 'MEMBERS_STORY_MEDIA');
  await createStoredFile('privateBranding', ids.priv, 'PRIVATE_BRANDING');
  await createStoredFile(
    'traversalKeyFile',
    ids.alpha,
    'BAD_KEY',
    'image/png',
    {
      storageKey: `communities/${ids.priv}/escape.png`,
    }
  );

  // Attach community branding & static map
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.brandingDisplay,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'community_display_image',
    ordinal: 0,
    createdAt: T0,
  });
  await insertRow(communityMediaSqlite, {
    communityId: ids.alpha,
    fileId: fileIds.brandingLegacy,
    kind: 'branding',
    createdAt: T0,
  });
  await insertRow(tables.communityMapConfigs, {
    communityId: ids.alpha,
    staticMapFileId: fileIds.staticMap,
    createdAt: T0,
    updatedAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.userPhoto,
    ownerType: 'user',
    ownerId: ids.user_member,
    role: 'user_photo',
    ordinal: 0,
    createdAt: T0,
  });

  // Places in Alpha
  const pRiver = await insertRow(tables.places, {
    name: 'Cedar Bend',
    description:
      '<p>Clean bend <strong>here</strong></p><script>alert(1)</script>',
    typeOfPlace: 'River',
    region: 'North',
    latitude: 1.5,
    longitude: -50.25,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pNoCoords = await insertRow(tables.places, {
    name: 'Cloud Archive Site',
    description: '<a href="javascript:evil()">Click</a> safely',
    typeOfPlace: 'Archive',
    region: 'South',
    latitude: null,
    longitude: null,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pInterviewLoc = await insertRow(tables.places, {
    name: 'Interview Clearing',
    typeOfPlace: 'Clearing',
    region: 'North',
    latitude: 2.0,
    longitude: -51.0,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pRestricted = await insertRow(tables.places, {
    name: 'Restricted Cove',
    typeOfPlace: 'Sacred',
    region: 'Restricted Region',
    latitude: 3.0,
    longitude: -52.0,
    communityId: ids.alpha,
    isRestricted: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const pStoryless = await insertRow(tables.places, {
    name: 'Storyless Meadow',
    typeOfPlace: 'Meadow',
    region: 'East',
    latitude: 4.0,
    longitude: -53.0,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pMembersOnly = await insertRow(tables.places, {
    name: 'Members Secret Place',
    typeOfPlace: 'Hall',
    region: 'Secret',
    latitude: 5.0,
    longitude: -54.0,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pBirthplaceOnly = await insertRow(tables.places, {
    name: 'Birthplace Only Valley',
    typeOfPlace: 'Valley',
    region: 'West',
    latitude: 6.0,
    longitude: -55.0,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.pRiver = pRiver.id as number;
  ids.pNoCoords = pNoCoords.id as number;
  ids.pInterviewLoc = pInterviewLoc.id as number;
  ids.pRestricted = pRestricted.id as number;
  ids.pStoryless = pStoryless.id as number;
  ids.pMembersOnly = pMembersOnly.id as number;
  ids.pBirthplaceOnly = pBirthplaceOnly.id as number;

  // Place attachments
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.placePhoto1,
    ownerType: 'place',
    ownerId: ids.pRiver,
    role: 'place_photo',
    ordinal: 0,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.placeAudio1,
    ownerType: 'place',
    ownerId: ids.pRiver,
    role: 'place_name_audio',
    ordinal: 0,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.storylessPlacePhoto,
    ownerType: 'place',
    ownerId: ids.pStoryless,
    role: 'place_photo',
    ordinal: 0,
    createdAt: T0,
  });

  // Speakers in Alpha
  const spMarina = await insertRow(tables.speakers, {
    name: 'Marina Silva',
    birthDate: '1950-04-12',
    birthplaceId: ids.pRiver, // readable place -> visible
    affiliation: 'River Council',
    communityId: ids.alpha,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const spInterviewer = await insertRow(tables.speakers, {
    name: 'Kauan Costa',
    birthplaceId: ids.pBirthplaceOnly, // non-readable place -> birthplace must project null
    affiliation: 'Oral History Collective',
    communityId: ids.alpha,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const spWithdrawn = await insertRow(tables.speakers, {
    name: 'Withdrawn Speaker',
    affiliation: 'Withdrawn Guild',
    communityId: ids.alpha,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const spStoryless = await insertRow(tables.speakers, {
    name: 'Speaker Storyless Only',
    affiliation: 'Unused Guild',
    communityId: ids.alpha,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const spMembersOnly = await insertRow(tables.speakers, {
    name: 'Speaker Members Only',
    affiliation: 'Members Guild',
    communityId: ids.alpha,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.spMarina = spMarina.id as number;
  ids.spInterviewer = spInterviewer.id as number;
  ids.spWithdrawn = spWithdrawn.id as number;
  ids.spStoryless = spStoryless.id as number;
  ids.spMembersOnly = spMembersOnly.id as number;

  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.speakerPhoto1,
    ownerType: 'speaker',
    ownerId: ids.spMarina,
    role: 'speaker_photo',
    ordinal: 0,
    createdAt: T0,
  });

  // Stories in Alpha: 3 public stories (2 share identical createdAt T2 + identical prefix or same title to test tiebreak)
  const addStory = async (key: string, overrides: Record<string, unknown>) => {
    const topic = (overrides.topic as string | undefined) ?? null;
    const row = await insertRow(tables.stories, {
      title: key,
      slug: key,
      communityId: ids.alpha,
      createdBy: ids.user_admin,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'en',
      topicNormalized: deriveTopicNormalized(topic),
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });
    ids[key] = row.id as number;
    return row.id as number;
  };

  // Three public stories: test title sort (`Alpha Tale` < `Beta Song` = `Beta Song`) & newest sort (`stA` T0, `stB1` T2, `stB2` T2)
  await addStory('stA', {
    title: 'Alpha Tale',
    description: '<p>Intro <em>story</em></p><script>alert(1)</script>',
    topic: 'Fishing',
    language: 'Portuguese',
    dateInterviewed: T1,
    interviewLocationId: ids.pInterviewLoc,
    interviewerId: ids.spInterviewer,
    createdAt: T0,
    updatedAt: T1,
  });
  await addStory('stB1', {
    title: 'Beta Song',
    description: 'Plain text description',
    topic: 'ΌΔΟΣ', // Greek NFC with final sigma test: normalizes to 'οδοσ' -> lowercase + final sigma 'οδος'? Wait: let's test NFC/sigma topic
    language: 'Spanish',
    createdAt: T2,
    updatedAt: T2,
  });
  await addStory('stB2', {
    title: 'Beta Song',
    description: null,
    topic: 'Watershed',
    language: 'English',
    createdAt: T2,
    updatedAt: T2,
  });
  await addStory('stRestricted', {
    title: 'Restricted Secret Story',
    isRestricted: true,
    topic: 'Restricted Secret Topic',
  });
  await addStory('stMembers', {
    title: 'Members Only Story',
    privacyLevel: 'members',
  });
  await addStory('stEditors', {
    title: 'Editors Only Story',
    privacyLevel: 'editors',
  });
  await addStory('stUnknown', {
    title: 'Unknown Privacy Story',
    privacyLevel: 'legacy_custom',
  });
  await addStory('stPrivateComm', {
    title: 'Private Community Story',
    communityId: ids.priv,
  });

  // Story edges
  const linkPlace = async (storyId: number, placeId: number) =>
    insertRow(tables.storyPlaces, {
      communityId: ids.alpha,
      storyId,
      placeId,
      createdAt: T0,
      updatedAt: T0,
    });
  const linkSpeaker = async (storyId: number, speakerId: number) =>
    insertRow(tables.storySpeakers, {
      communityId: ids.alpha,
      storyId,
      speakerId,
      createdAt: T0,
      updatedAt: T0,
    });

  await linkPlace(ids.stA, ids.pRiver);
  await linkPlace(ids.stA, ids.pNoCoords);
  await linkPlace(ids.stA, ids.pRestricted); // restricted place must never project
  await linkPlace(ids.stMembers, ids.pMembersOnly);

  await linkSpeaker(ids.stA, ids.spMarina);
  await linkSpeaker(ids.stA, ids.spWithdrawn); // inactive speaker must never project
  await linkSpeaker(ids.stMembers, ids.spMembersOnly);

  // Story attachments (ordinal 1 then 0 -> should return sorted [0, 1]) + invalid/restricted file skipped
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.storyMedia2,
    ownerType: 'story',
    ownerId: ids.stA,
    role: 'story_media',
    ordinal: 1,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.storyMedia1,
    ownerType: 'story',
    ownerId: ids.stA,
    role: 'story_media',
    ordinal: 0,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.restrictedFile,
    ownerType: 'story',
    ownerId: ids.stA,
    role: 'story_media',
    ordinal: 2,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.inactiveFile,
    ownerType: 'story',
    ownerId: ids.stA,
    role: 'story_media',
    ordinal: 3,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.membersStoryMedia,
    ownerType: 'story',
    ownerId: ids.stMembers,
    role: 'story_media',
    ordinal: 0,
    createdAt: T0,
  });

  // External media links ordered by ordinal
  await insertRow(tables.externalMediaLinks, {
    communityId: ids.alpha,
    storyId: ids.stA,
    url: 'https://video.example.test/second',
    ordinal: 1,
    createdAt: T0,
  });
  await insertRow(tables.externalMediaLinks, {
    communityId: ids.alpha,
    storyId: ids.stA,
    url: 'https://audio.example.test/first',
    ordinal: 0,
    createdAt: T0,
  });

  // Private community branding attachment
  await insertRow(tables.attachments, {
    communityId: ids.priv,
    fileId: fileIds.privateBranding,
    ownerType: 'community',
    ownerId: ids.priv,
    role: 'community_display_image',
    ordinal: 0,
    createdAt: T0,
  });
}

async function fetchJson(
  targetApp: ReturnType<typeof createHonoApp>,
  path: string,
  cookie?: string
) {
  const res = await targetApp.fetch(
    new Request(`http://localhost${path}`, {
      headers: cookie ? { Cookie: cookie } : undefined,
    })
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    headers: res.headers,
    json: JSON.parse(text) as unknown,
  };
}

async function loginCookie(email: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://localhost/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  );
  expect(res.status).toBe(200);
  const cookieHeader = res.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .find((entry) => entry.startsWith('ts_session='));
  expect(cookieHeader).toBeDefined();
  return cookieHeader!;
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  await seed();
  const options = {
    repository: new HonoFoundationRepository(db),
    verifier: nodePasswordVerifier,
    secureCookies: false,
    storage: {
      read: async (key: string, range?: { start: number; end: number }) => {
        const bytes = storageBytes.get(key);
        if (!bytes) return null;
        return range ? bytes.subarray(range.start, range.end + 1) : bytes;
      },
    },
  };
  app = createHonoApp(options);
  originApp = createHonoApp({
    ...options,
    publicOrigin: 'https://cdn.example.test',
  });
});

afterAll(() => {
  sqlite.close();
});

describe('V2 public story, place, speaker, and media endpoints (#145 Slice 5)', () => {
  it('lists public stories with Zod schema, deterministic sort + id tie-break, pagination, and sanitised HTML', async () => {
    const newest = await fetchJson(
      app,
      '/v2/public/communities/public-alpha/stories?sort=newest&limit=2&offset=0'
    );
    expect(newest.status).toBe(200);
    expect(newest.headers.get('Cache-Control')).toBe('no-store');
    expect(newest.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(newest.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox"
    );

    const parsed = PublicStoriesListResponseSchema.parse(newest.json);
    expect(parsed.meta).toEqual({
      total: 3,
      limit: 2,
      offset: 0,
      hasNextPage: true,
    });
    // stB1 and stB2 share T2: desc id tie-break orders stB2 before stB1
    expect(parsed.data.stories.map((s) => s.id)).toEqual([ids.stB2, ids.stB1]);
    // points include only valid-coord readable places across matching stories
    expect(parsed.data.points.map((p) => p.id)).toEqual([
      ids.pRiver,
      ids.pInterviewLoc,
    ]);
    for (const secret of NEVER_EXPOSED) {
      expect(newest.text).not.toContain(secret);
    }

    // Page 2 with offset=2
    const page2 = await fetchJson(
      app,
      '/v2/public/communities/public-alpha/stories?sort=newest&limit=2&offset=2'
    );
    const parsedPage2 = PublicStoriesListResponseSchema.parse(page2.json);
    expect(parsedPage2.meta).toEqual({
      total: 3,
      limit: 2,
      offset: 2,
      hasNextPage: false,
    });
    expect(parsedPage2.data.stories.map((s) => s.id)).toEqual([ids.stA]);
    const stA = parsedPage2.data.stories[0]!;
    expect(stA.description).toBe('<p>Intro <em>story</em></p>');
    expect(stA.places.map((p) => p.id)).toEqual([ids.pRiver, ids.pNoCoords]);
    expect(stA.places[1]!.latitude).toBeNull();
    expect(stA.places[1]!.longitude).toBeNull();
    expect(stA.speakers.map((sp) => sp.id)).toEqual([ids.spMarina]);
    expect(stA.speakers[0]!.birthplace?.id).toBe(ids.pRiver);
    expect(stA.interviewer?.id).toBe(ids.spInterviewer);
    expect(stA.interviewer?.birthplace).toBeNull(); // pBirthplaceOnly is NOT readable
    expect(stA.interviewLocation?.id).toBe(ids.pInterviewLoc);
    expect(stA.attachments.map((a) => a.fileId)).toEqual([
      fileIds.storyMedia1,
      fileIds.storyMedia2,
    ]);
    expect(stA.externalMediaLinks.map((l) => l.ordinal)).toEqual([0, 1]);

    // Title asc + id tie-break vs title desc + id tie-break
    const titleAsc = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          '/v2/public/communities/public-alpha/stories?sort=title_asc'
        )
      ).json
    );
    expect(titleAsc.data.stories.map((s) => s.id)).toEqual([
      ids.stA,
      ids.stB1,
      ids.stB2,
    ]);

    const titleDesc = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          '/v2/public/communities/public-alpha/stories?sort=title_desc'
        )
      ).json
    );
    expect(titleDesc.data.stories.map((s) => s.id)).toEqual([
      ids.stB2,
      ids.stB1,
      ids.stA,
    ]);
  });

  it('filters stories across all 7 categories including topicNormalized Unicode NFC + final sigma', async () => {
    const byPlace = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          `/v2/public/communities/public-alpha/stories?place=${ids.pRiver}`
        )
      ).json
    );
    expect(byPlace.data.stories.map((s) => s.id)).toEqual([ids.stA]);

    const byInterviewLoc = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          `/v2/public/communities/public-alpha/stories?place[]=${ids.pInterviewLoc}`
        )
      ).json
    );
    expect(byInterviewLoc.data.stories.map((s) => s.id)).toEqual([ids.stA]);

    const byRegion = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          '/v2/public/communities/public-alpha/stories?region=South'
        )
      ).json
    );
    expect(byRegion.data.stories.map((s) => s.id)).toEqual([ids.stA]);

    const byType = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          '/v2/public/communities/public-alpha/stories?typeOfPlace=Clearing'
        )
      ).json
    );
    expect(byType.data.stories.map((s) => s.id)).toEqual([ids.stA]);

    // Greek NFC (NFD -> NFC) + lowercase + final sigma matches stored 'ΌΔΟΣ'
    const decomposedTopic = 'Ο\u0301δοΣ';
    const byTopicSigma = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          `/v2/public/communities/public-alpha/stories?topic=${encodeURIComponent(decomposedTopic)}`
        )
      ).json
    );
    expect(byTopicSigma.data.stories.map((s) => s.id)).toEqual([ids.stB1]);

    const byLanguage = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          '/v2/public/communities/public-alpha/stories?language=English'
        )
      ).json
    );
    expect(byLanguage.data.stories.map((s) => s.id)).toEqual([ids.stB2]);

    const bySpeaker = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          `/v2/public/communities/public-alpha/stories?speaker=${ids.spInterviewer}`
        )
      ).json
    );
    expect(bySpeaker.data.stories.map((s) => s.id)).toEqual([ids.stA]);

    const byAffiliation = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          '/v2/public/communities/public-alpha/stories?affiliation=River%20Council'
        )
      ).json
    );
    expect(byAffiliation.data.stories.map((s) => s.id)).toEqual([ids.stA]);

    // Restricted/withdrawn filter probes never reveal hidden rows
    const probeRestricted = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          `/v2/public/communities/public-alpha/stories?place=${ids.pRestricted}`
        )
      ).json
    );
    expect(probeRestricted.data.stories).toEqual([]);
    expect(probeRestricted.meta.total).toBe(0);

    const probeWithdrawn = PublicStoriesListResponseSchema.parse(
      (
        await fetchJson(
          app,
          `/v2/public/communities/public-alpha/stories?speaker=${ids.spWithdrawn}`
        )
      ).json
    );
    expect(probeWithdrawn.data.stories).toEqual([]);
  });

  it('rejects malformed query bounds with 400 and hidden communities with 404', async () => {
    for (const badPath of [
      '/v2/public/communities/public-alpha/stories?limit=0',
      '/v2/public/communities/public-alpha/stories?limit=101',
      '/v2/public/communities/public-alpha/stories?offset=-1',
      '/v2/public/communities/public-alpha/stories?sort=popularity',
      '/v2/public/communities/public-alpha/stories?place=abc',
      '/v2/public/communities/public-alpha/places?limit=notanint',
      '/v2/public/communities/public-alpha/speakers?offset=bad',
    ]) {
      const res = await fetchJson(app, badPath);
      expect(res.status).toBe(400);
      expect(V2ErrorResponseSchema.parse(res.json)).toEqual({
        error: 'Invalid request',
      });
    }

    for (const missingPath of [
      '/v2/public/communities/private-village/stories',
      '/v2/public/communities/disabled-village/stories',
      '/v2/public/communities/nonexistent/stories',
      '/v2/public/communities/private-village/places',
      '/v2/public/communities/disabled-village/speakers',
    ]) {
      const res = await fetchJson(app, missingPath);
      expect(res.status).toBe(404);
      expect(V2ErrorResponseSchema.parse(res.json)).toEqual({
        error: 'Not found',
      });
    }
  });

  it('serves public story detail and matches missing 404s for #162 restricted/non-public rows', async () => {
    const res = await fetchJson(
      originApp,
      `/v2/public/communities/public-alpha/stories/${ids.stA}`
    );
    expect(res.status).toBe(200);
    const parsed = PublicStoryDetailResponseSchema.parse(res.json);
    expect(parsed.data.id).toBe(ids.stA);
    expect(parsed.data.attachments[0]!.url).toBe(
      `https://cdn.example.test/v2/public/communities/public-alpha/media/${fileIds.storyMedia1}`
    );
    expect(parsed.data.points.map((p) => p.id)).toEqual([
      ids.pRiver,
      ids.pInterviewLoc,
    ]);

    for (const hiddenId of [
      ids.stRestricted,
      ids.stMembers,
      ids.stEditors,
      ids.stUnknown,
      ids.stPrivateComm,
      9999999,
      'not-an-id',
      '99999999999999',
    ]) {
      const hidden = await fetchJson(
        app,
        `/v2/public/communities/public-alpha/stories/${hiddenId}`
      );
      expect(hidden.status).toBe(404);
      expect(hidden.json).toEqual({ error: 'Not found' });
    }
  });

  it('enforces with-readable-stories gating on places and speakers including birthplace gating', async () => {
    const placesList = await fetchJson(
      originApp,
      '/v2/public/communities/public-alpha/places'
    );
    expect(placesList.status).toBe(200);
    const parsedPlaces = PublicPlacesListResponseSchema.parse(placesList.json);
    // pRiver (edge), pNoCoords (edge, null coords ok), pInterviewLoc (interviewLocationId)
    expect(parsedPlaces.data.map((p) => p.id)).toEqual([
      ids.pRiver,
      ids.pNoCoords,
      ids.pInterviewLoc,
    ]);
    const river = parsedPlaces.data[0]!;
    expect(river.description).toBe('<p>Clean bend <strong>here</strong></p>');
    expect(river.photos).toEqual([
      {
        fileId: fileIds.placePhoto1,
        url: `https://cdn.example.test/v2/public/communities/public-alpha/media/${fileIds.placePhoto1}`,
      },
    ]);
    expect(river.placenameAudio).toEqual({
      fileId: fileIds.placeAudio1,
      url: `https://cdn.example.test/v2/public/communities/public-alpha/media/${fileIds.placeAudio1}`,
    });

    const placeDetail = await fetchJson(
      app,
      `/v2/public/communities/public-alpha/places/${ids.pInterviewLoc}`
    );
    expect(placeDetail.status).toBe(200);
    expect(
      PublicPlaceDetailResponseSchema.parse(placeDetail.json).data.id
    ).toBe(ids.pInterviewLoc);

    for (const hiddenPlaceId of [
      ids.pRestricted,
      ids.pStoryless,
      ids.pMembersOnly,
      ids.pBirthplaceOnly, // birthplaceId alone never exposes a place
      9999999,
      'bad',
    ]) {
      const hidden = await fetchJson(
        app,
        `/v2/public/communities/public-alpha/places/${hiddenPlaceId}`
      );
      expect(hidden.status).toBe(404);
      expect(hidden.json).toEqual({ error: 'Not found' });
    }

    const speakersList = await fetchJson(
      originApp,
      '/v2/public/communities/public-alpha/speakers'
    );
    expect(speakersList.status).toBe(200);
    const parsedSpeakers = PublicSpeakersListResponseSchema.parse(
      speakersList.json
    );
    expect(parsedSpeakers.data.map((s) => s.id)).toEqual([
      ids.spMarina,
      ids.spInterviewer,
    ]);
    expect(parsedSpeakers.data[0]!.birthplace?.id).toBe(ids.pRiver);
    expect(parsedSpeakers.data[0]!.photo?.fileId).toBe(fileIds.speakerPhoto1);
    // pBirthplaceOnly is not readable -> birthplace must project null
    expect(parsedSpeakers.data[1]!.birthplace).toBeNull();

    const speakerDetail = await fetchJson(
      app,
      `/v2/public/communities/public-alpha/speakers/${ids.spInterviewer}`
    );
    expect(speakerDetail.status).toBe(200);
    expect(
      PublicSpeakerDetailResponseSchema.parse(speakerDetail.json).data.id
    ).toBe(ids.spInterviewer);

    for (const hiddenSpeakerId of [
      ids.spWithdrawn,
      ids.spStoryless,
      ids.spMembersOnly,
      9999999,
      'bad',
    ]) {
      const hidden = await fetchJson(
        app,
        `/v2/public/communities/public-alpha/speakers/${hiddenSpeakerId}`
      );
      expect(hidden.status).toBe(404);
      expect(hidden.json).toEqual({ error: 'Not found' });
    }
  });

  it('streams authorized public media with Range, attachment disposition, and denies private/unattached files', async () => {
    for (const [key, expectedText, expectedMime] of [
      ['brandingDisplay', 'DISPLAY_BYTES', 'image/png'],
      ['brandingLegacy', 'LEGACY_BRANDING', 'image/png'],
      ['staticMap', 'STATIC_MAP_BYTES', 'image/png'],
      ['storyMedia1', '0123456789ABCDEF', 'audio/mpeg'],
      ['placePhoto1', 'PLACE_PHOTO_1', 'image/png'],
      ['placeAudio1', 'PLACE_AUDIO_1', 'audio/ogg'],
      ['speakerPhoto1', 'SPEAKER_PHOTO_1', 'image/png'],
    ] as const) {
      const res = await app.fetch(
        new Request(
          `http://localhost/v2/public/communities/public-alpha/media/${fileIds[key]}`
        )
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(expectedMime);
      expect(res.headers.get('Content-Disposition')).toBe('attachment');
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; sandbox"
      );
      expect(await res.text()).toBe(expectedText);
    }

    // Range 206 partial requests
    const r1 = await app.fetch(
      new Request(
        `http://localhost/v2/public/communities/public-alpha/media/${fileIds.storyMedia1}`,
        { headers: { Range: 'bytes=2-5' } }
      )
    );
    expect(r1.status).toBe(206);
    expect(r1.headers.get('Content-Range')).toBe('bytes 2-5/16');
    expect(r1.headers.get('Content-Length')).toBe('4');
    expect(r1.headers.get('Content-Disposition')).toBe('attachment');
    expect(await r1.text()).toBe('2345');

    const rSuffix = await app.fetch(
      new Request(
        `http://localhost/v2/public/communities/public-alpha/media/${fileIds.storyMedia1}`,
        { headers: { Range: 'bytes=-4' } }
      )
    );
    expect(rSuffix.status).toBe(206);
    expect(rSuffix.headers.get('Content-Range')).toBe('bytes 12-15/16');
    expect(await rSuffix.text()).toBe('CDEF');

    const rOpenEnd = await app.fetch(
      new Request(
        `http://localhost/v2/public/communities/public-alpha/media/${fileIds.storyMedia1}`,
        { headers: { Range: 'bytes=12-' } }
      )
    );
    expect(rOpenEnd.status).toBe(206);
    expect(rOpenEnd.headers.get('Content-Range')).toBe('bytes 12-15/16');
    expect(await rOpenEnd.text()).toBe('CDEF');

    // Range 416 unsatisfiable
    for (const badRange of [
      'bytes=99-120',
      'bytes=8-3',
      'bytes=-0',
      'bytes=bad',
    ]) {
      const r416 = await app.fetch(
        new Request(
          `http://localhost/v2/public/communities/public-alpha/media/${fileIds.storyMedia1}`,
          { headers: { Range: badRange } }
        )
      );
      expect(r416.status).toBe(416);
      expect(r416.headers.get('Content-Range')).toBe('bytes */16');
      expect(r416.headers.get('Accept-Ranges')).toBe('bytes');
    }

    // Forbidden / unauthorized / invalid media IDs answer identical 404
    for (const forbiddenId of [
      fileIds.userPhoto,
      fileIds.unattached,
      fileIds.restrictedFile,
      fileIds.inactiveFile,
      fileIds.storylessPlacePhoto,
      fileIds.membersStoryMedia,
      fileIds.privateBranding,
      fileIds.traversalKeyFile,
      crypto.randomUUID(),
      'not-a-uuid',
    ]) {
      const denied = await fetchJson(
        app,
        `/v2/public/communities/public-alpha/media/${forbiddenId}`
      );
      expect(denied.status).toBe(404);
      expect(denied.json).toEqual({ error: 'Not found' });
    }
  });

  it('never widens projection for authenticated member, admin, cross-community viewer, super_admin, or forged cookie', async () => {
    const cookies = await Promise.all([
      loginCookie('member@alpha.test'),
      loginCookie('admin@alpha.test'),
      loginCookie('viewer@priv.test'),
      loginCookie('super@system.test'),
    ]);
    cookies.push('ts_session=forged-invalid-cookie-value');

    const paths = [
      '/v2/public/communities/public-alpha/stories',
      `/v2/public/communities/public-alpha/stories/${ids.stA}`,
      '/v2/public/communities/public-alpha/places',
      `/v2/public/communities/public-alpha/places/${ids.pRiver}`,
      '/v2/public/communities/public-alpha/speakers',
      `/v2/public/communities/public-alpha/speakers/${ids.spMarina}`,
      `/v2/public/communities/public-alpha/stories/${ids.stRestricted}`,
      '/v2/public/communities/private-village/stories',
    ];

    for (const path of paths) {
      const baseline = await fetchJson(app, path);
      for (const cookie of cookies) {
        const authed = await fetchJson(app, path, cookie);
        expect(authed.status).toBe(baseline.status);
        expect(authed.json).toEqual(baseline.json);
      }
    }
  });
});

describe('PR #243 Slice 5 review fixes', () => {
  it('bounds SQL parameters at <= 100 per query under MAX_PUBLIC_FILTER_VALUES and MAX_PUBLIC_TOTAL_FILTER_VALUES', async () => {
    const paramCounts: Array<{ sql: string; count: number }> = [];
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
          paramCounts.push({ sql: source, count });
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
      // 1) 50 places + 10 speakers = 60 total
      const capParams = new URLSearchParams();
      capParams.append('place', String(ids.pRiver));
      for (let i = 1; i < MAX_PUBLIC_FILTER_VALUES; i++) {
        capParams.append('place', String(900000 + i));
      }
      capParams.append('speaker', String(ids.spMarina));
      for (
        let i = 1;
        i < MAX_PUBLIC_TOTAL_FILTER_VALUES - MAX_PUBLIC_FILTER_VALUES;
        i++
      ) {
        capParams.append('speaker', String(950000 + i));
      }

      const capRes = await fetchJson(
        app,
        `/v2/public/communities/public-alpha/stories?${capParams.toString()}`
      );
      expect(capRes.status).toBe(200);
      const capParsed = PublicStoriesListResponseSchema.parse(capRes.json);
      expect(capParsed.data.stories.map((s) => s.id)).toEqual([ids.stA]);

      // 2) All 7 filter categories populated up to MAX_PUBLIC_TOTAL_FILTER_VALUES (60)
      const sevenParams = new URLSearchParams();
      for (let i = 0; i < 10; i++) {
        sevenParams.append('place', String(i === 0 ? ids.pRiver : 910000 + i));
        sevenParams.append('region', i === 0 ? 'South' : `OtherRegion${i}`);
      }
      for (let i = 0; i < 8; i++) {
        sevenParams.append(
          'typeOfPlace',
          i === 0 ? 'Clearing' : `OtherType${i}`
        );
        sevenParams.append('topic', i === 0 ? 'Fishing' : `OtherTopic${i}`);
        sevenParams.append('language', i === 0 ? 'Portuguese' : `lang${i}`);
        sevenParams.append(
          'speaker',
          String(i === 0 ? ids.spMarina : 960000 + i)
        );
        sevenParams.append(
          'affiliation',
          i === 0 ? 'River Council' : `OtherAff${i}`
        );
      }
      const sevenRes = await fetchJson(
        app,
        `/v2/public/communities/public-alpha/stories?${sevenParams.toString()}`
      );
      expect(sevenRes.status).toBe(200);
      const sevenParsed = PublicStoriesListResponseSchema.parse(sevenRes.json);
      expect(sevenParsed.meta.total).toBe(1);
      expect(sevenParsed.data.stories[0]?.id).toBe(ids.stA);

      expect(paramCounts.length).toBeGreaterThan(0);
      const maxObserved = Math.max(...paramCounts.map((entry) => entry.count));
      expect(maxObserved).toBeLessThanOrEqual(100);
    } finally {
      sqlite.prepare = origPrepare;
    }
  });

  it('streams 200 without whole-object buffering, uses ranged read for 206, 200 for multi-range, and 416 without storage reads', async () => {
    const mediaId = '11111111-1111-4111-8111-111111111111';
    const fullPayload = new TextEncoder().encode('0123456789ABCDEF');
    const calls: Array<{
      key: string;
      range: { start: number; end: number } | undefined;
    }> = [];
    let chunksPulledOnResponse = 0;

    const fakeRepo = {
      async getAuthorizedPublicMediaFile() {
        return {
          id: mediaId,
          communityId: 1,
          storageKey: 'communities/1/streamed.bin',
          mimeType: 'application/octet-stream',
          byteSize: fullPayload.byteLength,
          originalName: 'streamed.bin',
        };
      },
    } as unknown as PublicContentRepository;

    const service = new PublicContentService(fakeRepo, {
      async read(key, range) {
        calls.push({ key, range });
        if (range) {
          const slice = fullPayload.subarray(range.start, range.end + 1);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          });
        }
        let sent = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            chunksPulledOnResponse += 1;
            if (sent === 0) {
              controller.enqueue(fullPayload.subarray(0, 8));
              sent = 1;
            } else {
              controller.enqueue(fullPayload.subarray(8));
              controller.close();
            }
          },
        });
      },
    });

    // 200 full stream: response returns before full stream is drained
    const res200 = await service.serveMedia('alpha', mediaId, undefined);
    expect(res200?.status).toBe(200);
    expect(res200?.headers.get('Content-Length')).toBe('16');
    expect(chunksPulledOnResponse).toBeLessThanOrEqual(1);
    expect(calls[0]).toEqual({
      key: 'communities/1/streamed.bin',
      range: undefined,
    });
    expect(await res200?.text()).toBe('0123456789ABCDEF');
    expect(chunksPulledOnResponse).toBeGreaterThanOrEqual(2);

    // 206 single range: forwards exact inclusive { start, end } to storage.read
    calls.length = 0;
    const res206 = await service.serveMedia('alpha', mediaId, 'bytes=2-5');
    expect(res206?.status).toBe(206);
    expect(res206?.headers.get('Content-Length')).toBe('4');
    expect(res206?.headers.get('Content-Range')).toBe('bytes 2-5/16');
    expect(calls).toEqual([
      { key: 'communities/1/streamed.bin', range: { start: 2, end: 5 } },
    ]);
    expect(await res206?.text()).toBe('2345');

    // Multi-range returns 200 full response (RFC 9110 §14.2 may-ignore), not 416
    calls.length = 0;
    const resMulti = await service.serveMedia(
      'alpha',
      mediaId,
      'bytes=0-1,4-5'
    );
    expect(resMulti?.status).toBe(200);
    expect(resMulti?.headers.get('Content-Length')).toBe('16');
    expect(calls).toEqual([
      { key: 'communities/1/streamed.bin', range: undefined },
    ]);
    expect(await resMulti?.text()).toBe('0123456789ABCDEF');

    // 416 unsatisfiable returns before touching storage
    calls.length = 0;
    const res416 = await service.serveMedia('alpha', mediaId, 'bytes=99-');
    expect(res416?.status).toBe(416);
    expect(res416?.headers.get('Content-Range')).toBe('bytes */16');
    expect(calls).toHaveLength(0);
  });

  it('omits non-http/https externalMediaLinks and returns 500 without logging content on Zod validation failure', async () => {
    expect(
      PublicExternalMediaLinkSchema.safeParse({
        id: 1,
        url: 'javascript:alert(1)',
        ordinal: 0,
        createdAt: T0.toISOString(),
      }).success
    ).toBe(false);
    expect(
      PublicExternalMediaLinkSchema.safeParse({
        id: 1,
        url: 'ftp://files.example.test/clip.mp4',
        ordinal: 0,
        createdAt: T0.toISOString(),
      }).success
    ).toBe(false);
    expect(
      PublicExternalMediaLinkSchema.safeParse({
        id: 1,
        url: 'https://watch.example.test/clip',
        ordinal: 0,
        createdAt: T0.toISOString(),
      }).success
    ).toBe(true);

    const secretTitle = 'SENSITIVE_ZOD_FAILURE_TITLE_NEVER_LOG';
    const secretDesc = 'SENSITIVE_ZOD_FAILURE_DESC_NEVER_LOG';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // 1) Non-http/https external links omitted; valid http/https passes Zod
      const filteredService = new PublicContentService(
        {
          async getStoryById() {
            return {
              community: {
                id: 1,
                name: 'Alpha',
                description: null,
                slug: 'alpha',
                locale: 'en',
                country: null,
                publicStories: true,
                isActive: true,
                createdAt: T0,
                updatedAt: T0,
              },
              story: {
                id: 1,
                communityId: 1,
                title: 'Valid Story',
                description: '<p>Clean</p>',
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
              externalLinks: [
                {
                  id: 1,
                  storyId: 1,
                  url: 'javascript:alert(1)',
                  ordinal: 0,
                  createdAt: T0,
                },
                {
                  id: 2,
                  storyId: 1,
                  url: 'ftp://example.com/clip.mp4',
                  ordinal: 1,
                  createdAt: T0,
                },
                {
                  id: 3,
                  storyId: 1,
                  url: '/relative/path',
                  ordinal: 2,
                  createdAt: T0,
                },
                {
                  id: 4,
                  storyId: 1,
                  url: 'https://watch.example.test/valid',
                  ordinal: 3,
                  createdAt: T0,
                },
              ],
            };
          },
        } as unknown as PublicContentRepository,
        {
          async read() {
            return null;
          },
        }
      );
      const validOut = await filteredService.getStoryById(
        'alpha',
        '1',
        'http://localhost'
      );
      expect(validOut.status).toBe(200);
      if (validOut.status === 200) {
        expect(validOut.body.data.externalMediaLinks).toEqual([
          {
            id: 4,
            url: 'https://watch.example.test/valid',
            ordinal: 3,
            createdAt: T0.toISOString(),
          },
        ]);
      }

      // 2) Malformed row failing Zod schema -> 500 with zero logged content
      const invalidService = new PublicContentService(
        {
          async getStoryById() {
            return {
              community: {
                id: 1,
                name: 'Alpha',
                description: null,
                slug: 'alpha',
                locale: 'en',
                country: null,
                publicStories: true,
                isActive: true,
                createdAt: T0,
                updatedAt: T0,
              },
              story: {
                id: -1, // violates positive() in PublicStorySummarySchema
                communityId: 1,
                title: secretTitle,
                description: secretDesc,
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
        } as unknown as PublicContentRepository,
        {
          async read() {
            return null;
          },
        }
      );

      const errRes = await invalidService.getStoryById(
        'alpha',
        '1',
        'http://localhost'
      );
      expect(errRes).toEqual({
        status: 500,
        body: { error: 'Internal server error' },
      });

      const commService = new PublicCommunitiesService({
        async publicCommunities() {
          return [
            {
              id: 1,
              name: secretTitle,
              description: secretDesc,
              slug: '', // violates min(1) in PublicCommunitySummarySchema
              locale: 'en',
              country: null,
              publicStories: true,
              isActive: true,
              createdAt: T0,
              updatedAt: T0,
            },
          ];
        },
        async publicCommunityMapConfigs() {
          return new Map();
        },
        async publicCommunityBrandings() {
          return new Map();
        },
      } as never);
      const commErr = await commService.listCommunities(
        undefined,
        'http://localhost'
      );
      expect(commErr).toEqual({
        status: 500,
        body: { error: 'Internal server error' },
      });

      for (const spy of [errSpy, warnSpy, logSpy]) {
        const logged = JSON.stringify(spy.mock.calls);
        expect(logged).not.toContain(secretTitle);
        expect(logged).not.toContain(secretDesc);
      }
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('derives story visibility from canonical-state.ts rather than hardcoding public', async () => {
    const nonPublicService = new PublicContentService(
      {
        async getStoryById() {
          return {
            community: {
              id: 1,
              name: 'Alpha',
              description: null,
              slug: 'alpha',
              locale: 'en',
              country: null,
              publicStories: true,
              isActive: true,
              createdAt: T0,
              updatedAt: T0,
            },
            story: {
              id: 1,
              communityId: 1,
              title: 'Hidden',
              description: null,
              topic: null,
              language: 'en',
              privacyLevel: 'members_only',
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
      } as unknown as PublicContentRepository,
      {
        async read() {
          return null;
        },
      }
    );
    await expect(
      nonPublicService.getStoryById('alpha', '1', 'http://localhost')
    ).rejects.toThrow('Non-public story reached public summary');
  });

  it('preserves edge multiplicity in (sortOrder, id) order, shares Slice 4/5 visibility, and serves >20k sanitised legacy descriptions cleanly', async () => {
    const isoSqlite = new Sqlite(':memory:');
    isoSqlite.pragma('foreign_keys=ON');
    const isoDb = drizzle(isoSqlite);
    const isoTables = tablesFor(isoDb);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      migrate(isoDb, { migrationsFolder: 'src/db/migrations' });
      const longPrefix = 'Z'.repeat(20_500);
      const longDesc = `${longPrefix}<p>Safe tail</p><script>alert(1)</script>`;

      const [comm] = await isoDb
        .insert(isoTables.communities)
        .values({
          name: 'Parity Village',
          description: longDesc,
          slug: 'parity-village',
          locale: 'en',
          publicStories: true,
          isActive: true,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning();

      const [placeA, placeB, interviewOnlyPlace] = await isoDb
        .insert(isoTables.places)
        .values([
          {
            name: 'First Place',
            latitude: 1,
            longitude: 2,
            communityId: comm!.id,
            isRestricted: false,
            createdAt: T0,
            updatedAt: T0,
          },
          {
            name: 'Second Place',
            latitude: 3,
            longitude: 4,
            communityId: comm!.id,
            isRestricted: false,
            createdAt: T0,
            updatedAt: T0,
          },
          {
            name: 'Interview Only Place',
            region: 'Interview Valley',
            typeOfPlace: 'Clearing',
            latitude: 5,
            longitude: 6,
            communityId: comm!.id,
            isRestricted: false,
            createdAt: T0,
            updatedAt: T0,
          },
        ])
        .returning();

      const [speakerA, speakerB, interviewerOnly] = await isoDb
        .insert(isoTables.speakers)
        .values([
          {
            name: 'Speaker One',
            affiliation: 'Guild One',
            communityId: comm!.id,
            isActive: true,
            createdAt: T0,
            updatedAt: T0,
          },
          {
            name: 'Speaker Two',
            communityId: comm!.id,
            isActive: true,
            createdAt: T0,
            updatedAt: T0,
          },
          {
            name: 'Interviewer Only',
            affiliation: 'Interviewer Guild',
            communityId: comm!.id,
            isActive: true,
            createdAt: T0,
            updatedAt: T0,
          },
        ])
        .returning();

      const [story] = await isoDb
        .insert(isoTables.stories)
        .values({
          title: 'Multi Edge Story',
          slug: 'multi-edge-story',
          description: longDesc,
          language: 'en',
          privacyLevel: 'public',
          isRestricted: false,
          interviewLocationId: interviewOnlyPlace!.id,
          interviewerId: interviewerOnly!.id,
          communityId: comm!.id,
          createdAt: T0,
          updatedAt: T0,
        })
        .returning();

      // Insert duplicated edges out of placeId/speakerId order to test (sortOrder, id)
      await isoDb.insert(isoTables.storyPlaces).values([
        {
          communityId: comm!.id,
          storyId: story!.id,
          placeId: placeA!.id,
          sortOrder: 2,
        },
        {
          communityId: comm!.id,
          storyId: story!.id,
          placeId: placeB!.id,
          sortOrder: 1,
        },
        {
          communityId: comm!.id,
          storyId: story!.id,
          placeId: placeA!.id,
          sortOrder: 0,
        },
      ]);
      await isoDb.insert(isoTables.storySpeakers).values([
        {
          communityId: comm!.id,
          storyId: story!.id,
          speakerId: speakerA!.id,
          sortOrder: 2,
        },
        {
          communityId: comm!.id,
          storyId: story!.id,
          speakerId: speakerB!.id,
          sortOrder: 1,
        },
        {
          communityId: comm!.id,
          storyId: story!.id,
          speakerId: speakerA!.id,
          sortOrder: 0,
        },
      ]);

      const isoApp = createHonoApp({
        repository: new HonoFoundationRepository(isoDb),
        verifier: nodePasswordVerifier,
        secureCookies: false,
        storage: {
          async read() {
            return null;
          },
        },
      });

      // 1) Duplicated edges preserved in (sortOrder, id) order + >20k description served sanitised
      const detail = await fetchJson(
        isoApp,
        `/v2/public/communities/parity-village/stories/${story!.id}`
      );
      expect(detail.status).toBe(200);
      const parsedDetail = PublicStoryDetailResponseSchema.parse(detail.json);
      expect(parsedDetail.data.places.map((p) => p.id)).toEqual([
        placeA!.id,
        placeB!.id,
        placeA!.id,
      ]);
      expect(parsedDetail.data.speakers.map((s) => s.id)).toEqual([
        speakerA!.id,
        speakerB!.id,
        speakerA!.id,
      ]);
      expect(parsedDetail.data.description).toBe(
        `${longPrefix}<p>Safe tail</p>`
      );
      expect(detail.text).not.toContain('alert(1)');

      const list = await fetchJson(
        isoApp,
        '/v2/public/communities/parity-village/stories'
      );
      expect(list.status).toBe(200);
      const parsedList = PublicStoriesListResponseSchema.parse(list.json);
      expect(parsedList.data.stories[0]?.places.map((p) => p.id)).toEqual([
        placeA!.id,
        placeB!.id,
        placeA!.id,
      ]);
      expect(parsedList.data.stories[0]?.speakers.map((s) => s.id)).toEqual([
        speakerA!.id,
        speakerB!.id,
        speakerA!.id,
      ]);

      // 2) Slice 4 detail and Slice 5 share identical place/speaker visibility
      //    (including interviewLocationId & interviewerId) + sanitised >20k community desc
      const commDetail = await fetchJson(
        isoApp,
        '/v2/public/communities/parity-village'
      );
      expect(commDetail.status).toBe(200);
      const parsedComm = PublicCommunityDetailResponseSchema.parse(
        commDetail.json
      );
      expect(parsedComm.data.description).toBe(`${longPrefix}<p>Safe tail</p>`);
      expect(parsedComm.data.points.map((p) => p.id)).toEqual([
        placeA!.id,
        placeB!.id,
        interviewOnlyPlace!.id,
      ]);
      expect(
        parsedComm.data.filters
          .filter((f) => f.category === 'place')
          .map((f) => f.value)
      ).toEqual([placeA!.id, placeB!.id, interviewOnlyPlace!.id]);
      expect(
        parsedComm.data.filters
          .filter((f) => f.category === 'speaker')
          .map((f) => f.value)
      ).toEqual([speakerA!.id, speakerB!.id, interviewerOnly!.id]);
      expect(parsedList.data.points.map((p) => p.id)).toEqual([
        placeA!.id,
        placeB!.id,
        interviewOnlyPlace!.id,
      ]);

      const allLogs = JSON.stringify([
        ...errSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...logSpy.mock.calls,
      ]);
      expect(allLogs).not.toContain(longPrefix);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
      isoSqlite.close();
    }
  });
});
