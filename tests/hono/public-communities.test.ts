/**
 * Focused contract & sovereignty tests for canonical V2 `/v2/public/communities`
 * and `/v2/public/communities/:slug` (#145, Slice 4) on SQLite in-memory.
 */
import { sanitizePublicStyleUrl } from '../../src/services/public-communities.service.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  argon2Seed,
  makeDerivedKey,
  makeServerSecret,
} from './auth-test-utils.js';
import { sql } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import { communityMediaSqlite } from '../../src/db/schema/sessions.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import {
  PUBLIC_COMMUNITY_FILTER_CATEGORIES,
  PublicCommunitiesListResponseSchema,
  PublicCommunityDetailResponseSchema,
  V2ErrorResponseSchema,
} from '../../src/shared/schemas/public-communities.js';
import {
  deriveTopicNormalized,
  deriveUserIdentityColumns,
} from '../../src/shared/utils/derived-columns.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-02-01T00:00:00.000Z');
const T2 = new Date('2026-03-01T00:00:00.000Z');
const T3 = new Date('2026-04-01T00:00:00.000Z');
const T4 = new Date('2026-05-01T00:00:00.000Z');

const VILA_SAO_BENTO_NFD = 'Vila São Bento'.normalize('NFD');

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys=ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

let app: ReturnType<typeof createHonoApp>;
let originApp: ReturnType<typeof createHonoApp>;

const ids: Record<string, number> = {};
const fileIds: Record<string, string> = {};
const TEST_DERIVED_KEY = makeDerivedKey();

const NEVER_EXPOSED = [
  'pk-secret-mapbox-token',
  'secret-cultural-settings',
  'Restricted Cove',
  'Secret Topic',
  'Hidden Speaker',
  'Members Story',
  'Members Place',
  'Members Topic',
  'Members Affiliation',
  'Editors Story',
  'Restricted File Token',
  'Private Village',
  'Disabled Village',
  'https://tiles.example.test/style.json?access_token=pk.leaked',
  // Built at runtime so secret scanners do not flag the fake userinfo URL.
  ['https://', 'user', ':', 'secret', '@tiles.example.test/style.json'].join(
    ''
  ),
  'mapbox://styles/private/style',
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
    description: 'Alpine community description',
    slug: 'public-alpha',
    locale: 'en',
    country: 'CA',
    publicStories: true,
    isActive: true,
    culturalSettings: 'secret-cultural-settings',
    createdAt: T0,
    updatedAt: T4,
  });
  const beta = await insertRow(tables.communities, {
    name: 'Public Beta 100% Real_Name',
    description: null,
    slug: 'public-beta',
    locale: 'pt',
    country: 'BR',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T3,
  });
  const saoJoao = await insertRow(tables.communities, {
    name: 'Comunidade São João ΑΣΑ',
    description: 'Diacritic and final-sigma fixture',
    slug: 'public-sao-joao',
    locale: 'pt',
    country: 'BR',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T2,
  });
  const vila = await insertRow(tables.communities, {
    name: VILA_SAO_BENTO_NFD,
    description: 'NFD stored fixture',
    slug: 'public-vila',
    locale: 'pt',
    country: null,
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T1,
  });
  const priv = await insertRow(tables.communities, {
    name: 'Private Village',
    slug: 'private-village',
    publicStories: false,
    isActive: true,
    createdAt: T0,
    updatedAt: T4,
  });
  const disabled = await insertRow(tables.communities, {
    name: 'Disabled Village',
    slug: 'disabled-village',
    publicStories: true,
    isActive: false,
    createdAt: T0,
    updatedAt: T4,
  });

  ids.alpha = alpha.id as number;
  ids.beta = beta.id as number;
  ids.saoJoao = saoJoao.id as number;
  ids.vila = vila.id as number;
  ids.priv = priv.id as number;
  ids.disabled = disabled.id as number;

  const seed = await argon2Seed(TEST_DERIVED_KEY);
  const createUser = async (
    key: string,
    email: string,
    role: string,
    communityId: number | null
  ) => {
    const row = await insertRow(tables.users, {
      email,
      username: key === 'super_admin' ? 'pub_super' : `pub_${key}`,
      ...deriveUserIdentityColumns({ email, username: `pub_${key}` }),
      ...seed,
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
  await createUser('editor', 'editor@alpha.test', 'editor', ids.alpha);
  await createUser('admin', 'admin@alpha.test', 'admin', ids.alpha);
  await createUser('other', 'viewer@beta.test', 'viewer', ids.beta);
  await createUser('super_admin', 'super@system.test', 'super_admin', null);

  // Legacy theme with secret mapbox token — must never appear anywhere.
  await insertRow(tables.themes, {
    name: 'Alpha legacy theme',
    mapboxStyleUrl: 'https://legacy-ignored.example.test/style.json',
    mapboxAccessToken: 'pk-secret-mapbox-token',
    active: true,
    communityId: ids.alpha,
    createdAt: T0,
    updatedAt: T0,
  });

  const createFile = async (
    key: string,
    communityId: number,
    overrides: Record<string, unknown> = {}
  ) => {
    const id = crypto.randomUUID();
    await insertRow(tables.files, {
      id,
      filename: `${key}.png`,
      originalName: `${key}.png`,
      path: `communities/${communityId}/${id}.png`,
      url: `/v2/media/${id}`,
      mimeType: 'image/png',
      size: 4,
      uploadedBy: ids.user_admin,
      communityId,
      culturalRestrictions: null,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    });
    fileIds[key] = id;
    return id;
  };

  await createFile('alphaDisplay', ids.alpha);
  await createFile('alphaBg', ids.alpha);
  await createFile('alphaLogo1', ids.alpha);
  await createFile('alphaLogo2', ids.alpha);
  await createFile('alphaStaticMap', ids.alpha);
  await createFile('alphaRestricted', ids.alpha, {
    culturalRestrictions: JSON.stringify({ accessLevel: 'family' }),
  });
  await createFile('alphaInactive', ids.alpha, { isActive: false });
  await createFile('betaFallback', ids.beta);
  await createFile('betaRestrictedStatic', ids.beta, {
    culturalRestrictions: JSON.stringify({ accessLevel: 'family' }),
  });
  await createFile('privDisplay', ids.priv);

  // Alpha uses canonical §6.7 attachments (display, bg, two ordered logos)
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.alphaLogo2,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'sponsor_logo',
    ordinal: 2,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.alphaLogo1,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'sponsor_logo',
    ordinal: 1,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.alphaDisplay,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'community_display_image',
    ordinal: 0,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.alphaBg,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'community_background_image',
    ordinal: 0,
    createdAt: T0,
  });
  // Restricted/inactive attachments must be ignored cleanly
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.alphaRestricted,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'sponsor_logo',
    ordinal: 0,
    createdAt: T0,
  });
  await insertRow(tables.attachments, {
    communityId: ids.alpha,
    fileId: fileIds.alphaInactive,
    ownerType: 'community',
    ownerId: ids.alpha,
    role: 'sponsor_logo',
    ordinal: 0,
    createdAt: T0,
  });

  // Beta uses legacy community_media fallback
  await db.insert(communityMediaSqlite).values({
    fileId: fileIds.betaFallback,
    communityId: ids.beta,
    kind: 'branding',
  });
  await db.insert(communityMediaSqlite).values({
    fileId: fileIds.privDisplay,
    communityId: ids.priv,
    kind: 'branding',
  });

  // Map configs across credential-safety variants:
  // Alpha: valid styleUrl + valid staticMapFileId
  await insertRow(tables.communityMapConfigs, {
    communityId: ids.alpha,
    styleUrl: 'https://tiles.example.test/alpha-style.json',
    basemapStyle: 'outdoors',
    centerLatitude: 10.5,
    centerLongitude: -20.25,
    southWestLatitude: 9.0,
    southWestLongitude: -21.0,
    northEastLatitude: 11.0,
    northEastLongitude: -19.0,
    zoom: 9,
    pitch: 20,
    bearing: 45,
    threeDimensional: true,
    projection: 'globe',
    staticMapFileId: fileIds.alphaStaticMap,
    createdAt: T1,
    updatedAt: T2,
  });
  // Beta: styleUrl with token query param + restricted staticMapFileId -> both nulled!
  await insertRow(tables.communityMapConfigs, {
    communityId: ids.beta,
    styleUrl: 'https://tiles.example.test/style.json?access_token=pk.leaked',
    basemapStyle: 'satellite',
    staticMapFileId: fileIds.betaRestrictedStatic,
    createdAt: T1,
    updatedAt: T2,
  });
  // Sao Joao: mapbox:// scheme -> styleUrl nulled
  await insertRow(tables.communityMapConfigs, {
    communityId: ids.saoJoao,
    styleUrl: 'mapbox://styles/private/style',
    basemapStyle: 'streets',
    createdAt: T1,
    updatedAt: T2,
  });
  // Vila has NO community_map_configs row -> mapConfig: null

  // Places for Alpha
  const pPublic1 = await insertRow(tables.places, {
    name: 'Cedar Creek',
    typeOfPlace: 'Waterway',
    region: 'North Valley',
    description: 'Public creek description',
    latitude: 10.1,
    longitude: -20.1,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pPublic2 = await insertRow(tables.places, {
    name: 'Moss Ridge',
    typeOfPlace: 'Lookout',
    region: 'East Ridge',
    description: null,
    latitude: 10.2,
    longitude: -20.2,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pRestricted = await insertRow(tables.places, {
    name: 'Restricted Cove',
    typeOfPlace: 'Sacred Site',
    region: 'Hidden Cove',
    latitude: 10.3,
    longitude: -20.3,
    communityId: ids.alpha,
    isRestricted: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const pStoryless = await insertRow(tables.places, {
    name: 'Storyless Meadow',
    typeOfPlace: 'Meadow',
    region: 'South Basin',
    latitude: 10.4,
    longitude: -20.4,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pMembersOnly = await insertRow(tables.places, {
    name: 'Members Place',
    typeOfPlace: 'Members Type',
    region: 'Members Region',
    latitude: 10.5,
    longitude: -20.5,
    communityId: ids.alpha,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const pBeta = await insertRow(tables.places, {
    name: 'Beta Harbor',
    typeOfPlace: 'Harbor',
    region: 'Coast',
    latitude: -2.5,
    longitude: -44.2,
    communityId: ids.beta,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.pPublic1 = pPublic1.id as number;
  ids.pPublic2 = pPublic2.id as number;
  ids.pRestricted = pRestricted.id as number;
  ids.pStoryless = pStoryless.id as number;
  ids.pMembersOnly = pMembersOnly.id as number;
  ids.pBeta = pBeta.id as number;

  // Speakers for Alpha & Beta
  const sPublic = await insertRow(tables.speakers, {
    name: 'Elder Marina',
    affiliation: 'River Council',
    communityId: ids.alpha,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const sInactive = await insertRow(tables.speakers, {
    name: 'Hidden Speaker',
    affiliation: 'Withdrawn Guild',
    communityId: ids.alpha,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });
  const sMembersOnly = await insertRow(tables.speakers, {
    name: 'Members Speaker',
    affiliation: 'Members Affiliation',
    communityId: ids.alpha,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  const sBeta = await insertRow(tables.speakers, {
    name: 'Beta Narrator',
    affiliation: 'Coast Association',
    communityId: ids.beta,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.sPublic = sPublic.id as number;
  ids.sInactive = sInactive.id as number;
  ids.sMembersOnly = sMembersOnly.id as number;
  ids.sBeta = sBeta.id as number;

  // Stories for Alpha (#162 option A test matrix)
  const addStory = async (key: string, overrides: Record<string, unknown>) => {
    const topic = (overrides.topic as string | undefined) ?? null;
    const row = await insertRow(tables.stories, {
      title: key,
      slug: key,
      communityId: ids.alpha,
      createdBy: ids.user_admin,
      privacyLevel: 'public',
      isRestricted: false,
      language: 'English',
      topic,
      topicNormalized: deriveTopicNormalized(topic),
      createdAt: T1,
      updatedAt: T1,
      ...overrides,
    });
    ids[`st_${key}`] = row.id as number;
    return row.id as number;
  };

  const stPub1 = await addStory('pub-1', {
    title: 'River Memory',
    topic: 'Fishing',
    language: 'English',
  });
  const stPub2 = await addStory('pub-2', {
    title: 'Ridge Song',
    topic: 'Botany',
    language: 'Portuguese',
  });
  const stRestricted = await addStory('restricted-1', {
    title: 'Restricted Tale',
    isRestricted: true,
    topic: 'Secret Topic',
    language: 'SecretLang',
  });
  const stUnknown = await addStory('unknown-1', {
    title: 'Unevidenced Tale',
    privacyLevel: 'unknown',
    topic: 'Secret Topic',
    language: 'UnknownLang',
  });
  const stMembers = await addStory('members-1', {
    title: 'Members Story',
    privacyLevel: 'members',
    topic: 'Members Topic',
    language: 'MembersLang',
  });
  const stEditors = await addStory('editors-1', {
    title: 'Editors Story',
    privacyLevel: 'editors',
    topic: 'Editors Topic',
    language: 'EditorsLang',
  });
  const stPrivComm = await addStory('priv-comm-1', {
    title: 'Private Village Story',
    communityId: ids.priv,
    privacyLevel: 'public',
  });

  const edgePlace = async (
    storyId: number,
    placeId: number,
    communityId: number
  ) =>
    insertRow(tables.storyPlaces, {
      communityId,
      storyId,
      placeId,
      createdAt: T0,
      updatedAt: T0,
    });
  const edgeSpeaker = async (
    storyId: number,
    speakerId: number,
    communityId: number
  ) =>
    insertRow(tables.storySpeakers, {
      communityId,
      storyId,
      speakerId,
      createdAt: T0,
      updatedAt: T0,
    });

  await edgePlace(stPub1, ids.pPublic1, ids.alpha);
  await edgePlace(stPub1, ids.pRestricted, ids.alpha);
  await edgePlace(stPub2, ids.pPublic2, ids.alpha);
  await edgePlace(stRestricted, ids.pPublic1, ids.alpha);
  await edgePlace(stUnknown, ids.pPublic1, ids.alpha);
  await edgePlace(stMembers, ids.pMembersOnly, ids.alpha);
  await edgePlace(stEditors, ids.pMembersOnly, ids.alpha);
  // Corrupt cross-community edge must never project pBeta under alpha
  sqlite.pragma('foreign_keys = OFF');
  try {
    await edgePlace(stPub1, ids.pBeta, ids.alpha);
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }

  await edgeSpeaker(stPub1, ids.sPublic, ids.alpha);
  await edgeSpeaker(stPub1, ids.sInactive, ids.alpha);
  await edgeSpeaker(stPub2, ids.sPublic, ids.alpha);
  await edgeSpeaker(stRestricted, ids.sPublic, ids.alpha);
  await edgeSpeaker(stUnknown, ids.sPublic, ids.alpha);
  await edgeSpeaker(stMembers, ids.sMembersOnly, ids.alpha);
  await edgeSpeaker(stEditors, ids.sMembersOnly, ids.alpha);
  expect(stPrivComm).toBeGreaterThan(0);
}

async function fetchJson(
  targetApp: ReturnType<typeof createHonoApp>,
  path: string,
  cookie?: string
) {
  const response = await targetApp.fetch(
    new Request(`http://localhost${path}`, {
      headers: cookie ? { Cookie: cookie } : undefined,
    })
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    headers: response.headers,
    json: JSON.parse(text) as unknown,
  };
}

async function loginCookie(email: string): Promise<string> {
  const res = await app.fetch(
    new Request('http://localhost/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, derivedKey: TEST_DERIVED_KEY }),
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
    secureCookies: false,
    storage: { read: async () => null },
    serverSecret: makeServerSecret(),
  };
  app = createHonoApp(options);
  originApp = createHonoApp({
    ...options,
    publicOrigin: 'https://api.example.test',
  });
});

afterAll(() => {
  sqlite.close();
});

describe('V2 public community endpoints (#145)', () => {
  it('lists active public communities with Zod contract, branding, credential-free mapConfig, and security headers', async () => {
    const res = await fetchJson(app, '/v2/public/communities');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox"
    );

    const parsed = PublicCommunitiesListResponseSchema.parse(res.json);
    expect(parsed.data.map((c) => c.slug)).toEqual([
      'public-alpha',
      'public-beta',
      'public-sao-joao',
      'public-vila',
    ]);

    const alpha = parsed.data[0];
    expect(alpha).toEqual({
      id: ids.alpha,
      slug: 'public-alpha',
      name: 'Public Alpha',
      description: 'Alpine community description',
      locale: 'en',
      country: 'CA',
      visibility: 'public',
      status: 'active',
      branding: {
        displayImage: {
          fileId: fileIds.alphaDisplay,
          url: `http://localhost/v2/public/communities/public-alpha/media/${fileIds.alphaDisplay}`,
        },
        backgroundImage: {
          fileId: fileIds.alphaBg,
          url: `http://localhost/v2/public/communities/public-alpha/media/${fileIds.alphaBg}`,
        },
        sponsorLogos: [
          {
            fileId: fileIds.alphaLogo1,
            ordinal: 1,
            url: `http://localhost/v2/public/communities/public-alpha/media/${fileIds.alphaLogo1}`,
          },
          {
            fileId: fileIds.alphaLogo2,
            ordinal: 2,
            url: `http://localhost/v2/public/communities/public-alpha/media/${fileIds.alphaLogo2}`,
          },
        ],
      },
      mapConfig: {
        styleUrl: 'https://tiles.example.test/alpha-style.json',
        basemapStyle: 'outdoors',
        centerLatitude: 10.5,
        centerLongitude: -20.25,
        southWestLatitude: 9,
        southWestLongitude: -21,
        northEastLatitude: 11,
        northEastLongitude: -19,
        zoom: 9,
        pitch: 20,
        bearing: 45,
        threeDimensional: true,
        projection: 'globe',
        staticMapFileId: fileIds.alphaStaticMap,
        staticMapUrl: `http://localhost/v2/public/communities/public-alpha/media/${fileIds.alphaStaticMap}`,
        createdAt: T1.toISOString(),
        updatedAt: T2.toISOString(),
      },
      createdAt: T0.toISOString(),
      updatedAt: T4.toISOString(),
    });

    // Beta tests legacy community_media fallback + token/restricted staticMap withholding
    const beta = parsed.data[1];
    expect(beta.branding.displayImage).toEqual({
      fileId: fileIds.betaFallback,
      url: `http://localhost/v2/public/communities/public-beta/media/${fileIds.betaFallback}`,
    });
    expect(beta.mapConfig?.styleUrl).toBeNull();
    expect(beta.mapConfig?.staticMapFileId).toBeNull();
    expect(beta.mapConfig?.staticMapUrl).toBeNull();

    // Sao Joao tests mapbox:// scheme withholding
    const sao = parsed.data[2];
    expect(sao.mapConfig?.styleUrl).toBeNull();

    // Vila has no community_map_configs row
    const vila = parsed.data[3];
    expect(vila.mapConfig).toBeNull();

    for (const secret of NEVER_EXPOSED) {
      expect(res.text).not.toContain(secret);
    }
    expect(res.text).not.toContain(fileIds.alphaRestricted);
    expect(res.text).not.toContain(fileIds.alphaInactive);
    expect(res.text).not.toContain(fileIds.betaRestrictedStatic);
  });

  it('uses configured publicOrigin for canonical media URLs', async () => {
    const res = await fetchJson(
      originApp,
      '/v2/public/communities/public-alpha'
    );
    expect(res.status).toBe(200);
    const parsed = PublicCommunityDetailResponseSchema.parse(res.json);
    expect(parsed.data.branding.displayImage?.url).toBe(
      `https://api.example.test/v2/public/communities/public-alpha/media/${fileIds.alphaDisplay}`
    );
    expect(parsed.data.mapConfig?.staticMapUrl).toBe(
      `https://api.example.test/v2/public/communities/public-alpha/media/${fileIds.alphaStaticMap}`
    );
  });

  it('applies the §6.3 NFC + lowercase + final-sigma search contract literally', async () => {
    // Case-variant diacritic
    const upperDiacritic = await fetchJson(
      app,
      `/v2/public/communities?search=${encodeURIComponent('SÃO JOÃO')}`
    );
    expect(upperDiacritic.status).toBe(200);
    expect(
      PublicCommunitiesListResponseSchema.parse(upperDiacritic.json).data.map(
        (c) => c.slug
      )
    ).toEqual(['public-sao-joao']);

    // Final sigma fold: needle 'ΑΣ' matches stored 'ΑΣΑ'
    const sigma = await fetchJson(
      app,
      `/v2/public/communities?search=${encodeURIComponent('ΑΣ')}`
    );
    expect(
      PublicCommunitiesListResponseSchema.parse(sigma.json).data.map(
        (c) => c.slug
      )
    ).toEqual(['public-sao-joao']);

    // Stored NFD matches composed NFC needle and preserves stored string
    const nfd = await fetchJson(
      app,
      `/v2/public/communities?search=${encodeURIComponent('Vila São Bento')}`
    );
    const nfdParsed = PublicCommunitiesListResponseSchema.parse(nfd.json);
    expect(nfdParsed.data.map((c) => c.slug)).toEqual(['public-vila']);
    expect(nfdParsed.data[0].name).toBe(VILA_SAO_BENTO_NFD);

    // Accent-sensitive rejection
    const ascii = await fetchJson(
      app,
      `/v2/public/communities?search=${encodeURIComponent('sao joao')}`
    );
    expect(PublicCommunitiesListResponseSchema.parse(ascii.json).data).toEqual(
      []
    );

    // Literal LIKE wildcards (% and _) never act as SQL wildcards
    const wildcardPercent = await fetchJson(
      app,
      `/v2/public/communities?search=${encodeURIComponent('100% Real_Name')}`
    );
    expect(
      PublicCommunitiesListResponseSchema.parse(wildcardPercent.json).data.map(
        (c) => c.slug
      )
    ).toEqual(['public-beta']);

    const justPercent = await fetchJson(
      app,
      `/v2/public/communities?search=${encodeURIComponent('___')}`
    );
    expect(
      PublicCommunitiesListResponseSchema.parse(justPercent.json).data
    ).toEqual([]);

    // Private/disabled communities stay invisible even on exact-name search
    for (const hiddenName of ['Private Village', 'Disabled Village']) {
      const hidden = await fetchJson(
        app,
        `/v2/public/communities?search=${encodeURIComponent(hiddenName)}`
      );
      expect(
        PublicCommunitiesListResponseSchema.parse(hidden.json).data
      ).toEqual([]);
    }

    // Oversized or duplicate ?search= fails with uniform 400
    const tooLong = await fetchJson(
      app,
      `/v2/public/communities?search=${'a'.repeat(501)}`
    );
    expect(tooLong.status).toBe(400);
    expect(V2ErrorResponseSchema.parse(tooLong.json)).toEqual({
      error: 'Invalid request',
    });

    const dupSearch = await fetchJson(
      app,
      '/v2/public/communities?search=a&search=b'
    );
    expect(dupSearch.status).toBe(400);
    expect(V2ErrorResponseSchema.parse(dupSearch.json)).toEqual({
      error: 'Invalid request',
    });
  });

  it('serves detail with #162 option A storiesCount, points, and all 7 filter categories', async () => {
    const res = await fetchJson(app, '/v2/public/communities/public-alpha');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox"
    );

    const parsed = PublicCommunityDetailResponseSchema.parse(res.json);
    expect(parsed.data.storiesCount).toBe(2);
    expect(parsed.data.categories).toEqual([
      ...PUBLIC_COMMUNITY_FILTER_CATEGORIES,
    ]);
    expect(parsed.data.points).toEqual([
      {
        type: 'Feature',
        id: ids.pPublic1,
        geometry: { type: 'Point', coordinates: [-20.1, 10.1] },
        properties: {
          name: 'Cedar Creek',
          description: 'Public creek description',
          region: 'North Valley',
          typeOfPlace: 'Waterway',
        },
      },
      {
        type: 'Feature',
        id: ids.pPublic2,
        geometry: { type: 'Point', coordinates: [-20.2, 10.2] },
        properties: {
          name: 'Moss Ridge',
          description: null,
          region: 'East Ridge',
          typeOfPlace: 'Lookout',
        },
      },
    ]);
    expect(parsed.data.filters).toEqual([
      { category: 'place', value: ids.pPublic1, label: 'Cedar Creek' },
      { category: 'place', value: ids.pPublic2, label: 'Moss Ridge' },
      { category: 'region', value: 'East Ridge', label: 'East Ridge' },
      { category: 'region', value: 'North Valley', label: 'North Valley' },
      { category: 'typeOfPlace', value: 'Lookout', label: 'Lookout' },
      { category: 'typeOfPlace', value: 'Waterway', label: 'Waterway' },
      { category: 'speaker', value: ids.sPublic, label: 'Elder Marina' },
      { category: 'topic', value: 'Botany', label: 'Botany' },
      { category: 'topic', value: 'Fishing', label: 'Fishing' },
      { category: 'language', value: 'English', label: 'English' },
      { category: 'language', value: 'Portuguese', label: 'Portuguese' },
      {
        category: 'affiliation',
        value: 'River Council',
        label: 'River Council',
      },
    ]);

    for (const secret of NEVER_EXPOSED) {
      expect(res.text).not.toContain(secret);
    }
    expect(res.text).not.toContain('Storyless Meadow');
    expect(res.text).not.toContain('Withdrawn Guild');
    expect(res.text).not.toContain('Beta Harbor');
  });

  it('answers identical 404 { error: "Not found" } for missing, private, and disabled slugs', async () => {
    const missing = await fetchJson(
      app,
      '/v2/public/communities/does-not-exist'
    );
    const priv = await fetchJson(app, '/v2/public/communities/private-village');
    const disabled = await fetchJson(
      app,
      '/v2/public/communities/disabled-village'
    );

    for (const res of [missing, priv, disabled]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(V2ErrorResponseSchema.parse(res.json)).toEqual({
        error: 'Not found',
      });
    }
    expect(priv.text).toBe(missing.text);
    expect(disabled.text).toBe(missing.text);
  });

  it('serves the identical anonymous projection to authenticated roles including super_admin', async () => {
    const anonList = await fetchJson(app, '/v2/public/communities');
    const anonDetail = await fetchJson(
      app,
      '/v2/public/communities/public-alpha'
    );
    const anonMissing = await fetchJson(
      app,
      '/v2/public/communities/private-village'
    );

    for (const email of [
      'member@alpha.test',
      'editor@alpha.test',
      'admin@alpha.test',
      'viewer@beta.test',
      'super@system.test',
    ]) {
      const cookie = await loginCookie(email);
      const list = await fetchJson(app, '/v2/public/communities', cookie);
      const detail = await fetchJson(
        app,
        '/v2/public/communities/public-alpha',
        cookie
      );
      const priv = await fetchJson(
        app,
        '/v2/public/communities/private-village',
        cookie
      );

      expect(list.status).toBe(200);
      expect(list.text).toBe(anonList.text);
      expect(detail.status).toBe(200);
      expect(detail.text).toBe(anonDetail.text);
      expect(priv.status).toBe(404);
      expect(priv.text).toBe(anonMissing.text);
    }

    // Even a bogus/forged session cookie gets the public projection cleanly
    const forged = await fetchJson(
      app,
      '/v2/public/communities/public-alpha',
      'ts_session=forged-token'
    );
    expect(forged.status).toBe(200);
    expect(forged.text).toBe(anonDetail.text);
  });
});

describe('sanitizePublicStyleUrl (SPEC-V2 §6.6 credential-free map config)', () => {
  const base = 'https://tiles.example.test/style.json';
  it.each([
    `${base}?accessToken=x`,
    `${base}?access-token=x`,
    `${base}?ACCESS_TOKEN=x`,
    `${base}?X-Amz-Signature=x`,
    `${base}?X-Amz-Credential=x`,
    `${base}?Signature=x&Key-Pair-Id=y`,
    `${base}?sig=x`,
    `${base}#access_token=x`,
    `${base}#anything`,
    ['https://', 'u', ':', 'p', '@tiles.example.test/style.json'].join(''),
    'mapbox://styles/private/style',
    'not a url',
  ])('withholds %s', (url) => {
    expect(sanitizePublicStyleUrl(url)).toBeNull();
  });

  it('keeps a credential-free https URL, including harmless query params', () => {
    expect(sanitizePublicStyleUrl(base)).toBe(base);
    expect(sanitizePublicStyleUrl(`${base}?lang=pt`)).toBe(`${base}?lang=pt`);
  });
});
