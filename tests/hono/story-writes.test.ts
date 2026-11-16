/**
 * Focused contract, validation, security, audit, D1-batch-atomicity, and
 * tenant-isolation tests for Slice 8 V2 story write routes (#145).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, asc, and } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { tablesFor } from '../../src/db/dialect.js';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { StoryWritesRepository } from '../../src/repositories/story-writes.repository.js';
import { V2ValidationErrorResponseSchema } from '../../src/shared/schemas/community-writes.js';
import {
  ExternalMediaLinksListResponseSchema,
  ExternalMediaLinkWriteResponseSchema,
  MAX_EXTERNAL_LINKS_PER_STORY,
  MAX_STORY_EDGE_IDS,
  StoryWriteResponseSchema,
} from '../../src/shared/schemas/story-writes.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);

// Build test secret values at runtime so no static credential-shaped literals exist.
const TEST_PASS = ['Slice8', 'StoryTest', '2026!'].join('-');
const T0 = new Date('2026-06-01T12:00:00.000Z');

const API_ORIGIN = 'https://api.example.test';
const CLIENT_ORIGIN = 'https://app.example.test';
const FOREIGN_ORIGIN = 'https://evil.invalid';

let app: ReturnType<typeof createHonoApp>;
const ids: Record<string, number> = {};
const fileIds = {
  ownStoryFile: '88888888-8888-4888-8888-888888888801',
  restrictedStoryFile: '88888888-8888-4888-8888-888888888802',
};
const cookies: Record<string, string> = {};

async function insertRow<T extends { $inferInsert: Record<string, unknown> }>(
  table: any,
  values: T['$inferInsert']
): Promise<number> {
  const [inserted] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return inserted.id as number;
}

async function loginAs(email: string, communityId?: number): Promise<string> {
  const res = await app.request(`${API_ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: TEST_PASS,
      ...(communityId === undefined ? {} : { communityId }),
    }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

async function requestJson(
  method: string,
  path: string,
  options: {
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
    originUrl?: string;
  } = {}
) {
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (
    options.body !== undefined &&
    !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  ) {
    headers['content-type'] = 'application/json';
  }
  const base = options.originUrl ?? API_ORIGIN;
  const res = await app.request(`${base}${path}`, {
    method,
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: 'src/db/migrations' });
  const passwordHash = await hash(TEST_PASS, 4);

  ids.own = await insertRow(tables.communities, {
    name: 'Own Nation',
    slug: 'own-nation',
    description: '<p>Initial narrative</p>',
    descriptionPlain: 'Initial narrative',
    locale: 'en',
    country: 'CA',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.foreign = await insertRow(tables.communities, {
    name: 'Foreign Nation',
    slug: 'foreign-nation',
    description: '<p>Foreign narrative</p>',
    descriptionPlain: 'Foreign narrative',
    locale: 'en',
    country: 'NZ',
    publicStories: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.disabled = await insertRow(tables.communities, {
    name: 'Disabled Nation',
    slug: 'disabled-nation',
    locale: 'en',
    publicStories: false,
    isActive: false,
    createdAt: T0,
    updatedAt: T0,
  });

  const makeUser = async (
    email: string,
    role: string,
    communityId: number | null
  ) => {
    const username = email.replace('@', '-').split('.')[0]!;
    return insertRow(tables.users, {
      email,
      username,
      ...deriveUserIdentityColumns({ email, username }),
      passwordHash,
      firstName: role,
      lastName: 'User',
      role,
      communityId,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    });
  };

  ids.uSuper = await makeUser('super@slice8.example.test', 'super_admin', null);
  ids.uAdmin = await makeUser('admin@own.example.test', 'admin', ids.own!);
  ids.uEditor = await makeUser('editor@own.example.test', 'editor', ids.own!);
  ids.uMember = await makeUser('member@own.example.test', 'member', ids.own!);
  ids.uViewer = await makeUser('viewer@own.example.test', 'viewer', ids.own!);
  ids.uDisabledAdmin = await makeUser(
    'admin@disabled.example.test',
    'admin',
    ids.disabled!
  );
  ids.uForeignAdmin = await makeUser(
    'admin@foreign.example.test',
    'admin',
    ids.foreign!
  );

  ids.plOwnA = await insertRow(tables.places, {
    communityId: ids.own!,
    name: 'River Bend',
    latitude: 49.1,
    longitude: -123.1,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plOwnB = await insertRow(tables.places, {
    communityId: ids.own!,
    name: 'Cedar Ridge',
    latitude: 49.2,
    longitude: -123.2,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plOwnRestricted = await insertRow(tables.places, {
    communityId: ids.own!,
    name: 'Restricted Place',
    latitude: 49.3,
    longitude: -123.3,
    isRestricted: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.plForeign = await insertRow(tables.places, {
    communityId: ids.foreign!,
    name: 'Foreign Place',
    latitude: -41.2,
    longitude: 174.7,
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.spOwnA = await insertRow(tables.speakers, {
    communityId: ids.own!,
    name: 'Speaker One',
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spOwnB = await insertRow(tables.speakers, {
    communityId: ids.own!,
    name: 'Speaker Two',
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.spForeign = await insertRow(tables.speakers, {
    communityId: ids.foreign!,
    name: 'Foreign Speaker',
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });

  ids.stRestrictedFlag = await insertRow(tables.stories, {
    communityId: ids.own!,
    title: 'Restricted By Flag',
    slug: 'restricted-by-flag',
    language: 'en',
    privacyLevel: 'editors',
    isRestricted: true,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.stRestrictedLevel = await insertRow(tables.stories, {
    communityId: ids.own!,
    title: 'Restricted By Level',
    slug: 'restricted-by-level',
    language: 'en',
    privacyLevel: 'restricted',
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });
  ids.stForeign = await insertRow(tables.stories, {
    communityId: ids.foreign!,
    title: 'Foreign Story',
    slug: 'foreign-story',
    language: 'en',
    privacyLevel: 'public',
    isRestricted: false,
    createdAt: T0,
    updatedAt: T0,
  });

  await db.insert(tables.files).values([
    {
      id: fileIds.ownStoryFile,
      filename: 'story.png',
      originalName: 'story.png',
      path: `communities/${ids.own}/story.png`,
      storageKey: `communities/${ids.own}/story.png`,
      url: 'https://storage.invalid/story.png',
      mimeType: 'image/png',
      size: 64,
      byteSize: 64,
      communityId: ids.own!,
      uploadedBy: ids.uAdmin!,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: fileIds.restrictedStoryFile,
      filename: 'restricted.png',
      originalName: 'restricted.png',
      path: `communities/${ids.own}/restricted.png`,
      storageKey: `communities/${ids.own}/restricted.png`,
      url: 'https://storage.invalid/restricted.png',
      mimeType: 'image/png',
      size: 64,
      byteSize: 64,
      communityId: ids.own!,
      uploadedBy: ids.uAdmin!,
      isActive: true,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);

  await db.insert(tables.attachments).values({
    communityId: ids.own!,
    ownerType: 'story',
    ownerId: ids.stRestrictedFlag!,
    fileId: fileIds.restrictedStoryFile,
    role: 'media',
    ordinal: 0,
    isActive: true,
    createdAt: T0,
  });

  app = createHonoApp({
    repository: new HonoFoundationRepository(db),
    verifier: nodePasswordVerifier,
    secureCookies: false,
    publicOrigin: API_ORIGIN,
    corsOrigins: [CLIENT_ORIGIN],
    storage: { read: async () => null },
  });

  cookies.super = await loginAs('super@slice8.example.test');
  cookies.admin = await loginAs('admin@own.example.test', ids.own);
  cookies.editor = await loginAs('editor@own.example.test', ids.own);
  cookies.member = await loginAs('member@own.example.test', ids.own);
  cookies.viewer = await loginAs('viewer@own.example.test', ids.own);
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

describe('Slice 8 story CRUD routes', () => {
  it('allows editor to create a public story with sanitized description, derived columns, initial edges with multiplicity, and audit entry', async () => {
    const res = await requestJson('POST', '/v2/stories', {
      cookie: cookies.editor,
      body: {
        title: '  Cedar Harvest Song  ',
        description: '<p>Shared along the <strong>river</strong>.</p>',
        visibility: 'public',
        topic: '  École River Traditions  ',
        language: 'fr-CA',
        dateInterviewed: '2026-05-15T10:30:00.000Z',
        interviewLocationId: ids.plOwnA,
        interviewerId: ids.spOwnA,
        placeIds: [ids.plOwnB, ids.plOwnA, ids.plOwnB],
        speakerIds: [ids.spOwnB, ids.spOwnA, ids.spOwnB],
      },
    });

    expect(res.status).toBe(201);
    const parsed = StoryWriteResponseSchema.safeParse(res.json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const story = parsed.data.data;
    expect(story.title).toBe('Cedar Harvest Song');
    expect(story.description).toBe(
      '<p>Shared along the <strong>river</strong>.</p>'
    );
    expect(story.visibility).toBe('public');
    expect(story.topic).toBe('École River Traditions');
    expect(story.language).toBe('fr-CA');
    expect(story.dateInterviewed).toBe('2026-05-15T10:30:00.000Z');
    expect(story.interviewLocation?.id).toBe(ids.plOwnA);
    expect(story.interviewer?.id).toBe(ids.spOwnA);
    expect(story.places.map((p) => p.id)).toEqual([
      ids.plOwnB,
      ids.plOwnA,
      ids.plOwnB,
    ]);
    expect(story.speakers.map((s) => s.id)).toEqual([
      ids.spOwnB,
      ids.spOwnA,
      ids.spOwnB,
    ]);

    const [dbStory] = await db
      .select()
      .from(tables.stories)
      .where(eq(tables.stories.id, story.id))
      .limit(1);
    expect(dbStory?.createdBy).toBe(ids.uEditor);
    expect(dbStory?.descriptionPlain).toBe('Shared along the river.');
    expect(dbStory?.topicNormalized).toBe('école river traditions');
    expect(dbStory?.isRestricted).toBe(false);
    expect(dbStory?.privacyLevel).toBe('public');

    const audits = await db
      .select()
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.communityId, ids.own!),
          eq(tables.auditEntries.resourceType, 'story')
        )
      )
      .orderBy(asc(tables.auditEntries.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('story.visibility.public');
    expect(audits[0]!.actorId).toBe(ids.uEditor);
    expect(audits[0]!.resourceIds).toEqual([story.id]);
    expect(audits[0]!.ipAddress).toBeNull();
    expect(audits[0]!.userAgent).toBeNull();

    // Immediately visible on public projections
    const publicStories = await requestJson(
      'GET',
      '/v2/public/communities/own-nation/stories'
    );
    expect(publicStories.status).toBe(200);
    const pubIds = (
      publicStories.json as { data: { stories: Array<{ id: number }> } }
    ).data.stories.map((s) => s.id);
    expect(pubIds).toContain(story.id);

    const exploreListRes = await requestJson(
      'GET',
      '/explore/communities/own-nation/stories'
    );
    expect(exploreListRes.status).toBe(200);
    expect(
      (
        exploreListRes.json as {
          data: { stories: Array<{ id: number }> };
        }
      ).data.stories.map((s) => s.id)
    ).toContain(story.id);
    const exploreStoryRes = await requestJson(
      'GET',
      `/explore/communities/own-nation/stories/${story.id}`
    );
    expect(exploreStoryRes.status).toBe(200);

    ids.createdPublicStory = story.id;
  });

  it('allows admin to create minimal editors-only story without audit entry', async () => {
    const auditsBefore = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.resourceType, 'story'));

    const res = await requestJson('POST', '/v2/stories', {
      cookie: cookies.admin,
      body: { title: 'Draft Story' },
    });
    expect(res.status).toBe(201);
    const parsed = StoryWriteResponseSchema.parse(res.json);
    expect(parsed.data.visibility).toBe('editors');
    expect(parsed.data.language).toBe('en');
    expect(parsed.data.places).toEqual([]);
    expect(parsed.data.speakers).toEqual([]);

    const auditsAfter = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.resourceType, 'story'));
    expect(auditsAfter).toHaveLength(auditsBefore.length);

    ids.createdDraftStory = parsed.data.id;
  });

  it('rejects disallowed callers, cross-origin CSRF, non-JSON, restricted visibility, unsafe description without echoing input, and cross-community/restricted targets atomically', async () => {
    // Role / auth / disabled / CSRF checks
    expect(
      (await requestJson('POST', '/v2/stories', { body: { title: 'A' } }))
        .status
    ).toBe(401);
    for (const badCookie of [
      cookies.viewer,
      cookies.member,
      cookies.super,
      cookies.disabledAdmin,
    ]) {
      const r = await requestJson('POST', '/v2/stories', {
        cookie: badCookie,
        body: { title: 'A' },
      });
      expect(r.status).toBe(403);
    }
    const csrfRes = await requestJson('POST', '/v2/stories', {
      cookie: cookies.editor,
      headers: { origin: FOREIGN_ORIGIN },
      body: { title: 'A' },
    });
    expect(csrfRes.status).toBe(403);
    const nonJsonRes = await requestJson('POST', '/v2/stories', {
      cookie: cookies.editor,
      headers: { 'content-type': 'text/plain' },
      body: 'title=A',
    });
    expect(nonJsonRes.status).toBe(415);

    // Schema validation checks
    const restrictedVisRes = await requestJson('POST', '/v2/stories', {
      cookie: cookies.editor,
      body: { title: 'A', visibility: 'restricted' },
    });
    expect(restrictedVisRes.status).toBe(400);
    expect(
      V2ValidationErrorResponseSchema.safeParse(restrictedVisRes.json).success
    ).toBe(true);

    const secretMarker = 'CANARY_UNSAFE_HTML_SECRET';
    const badDescRes = await requestJson('POST', '/v2/stories', {
      cookie: cookies.editor,
      body: {
        title: 'A',
        description: `<p>${secretMarker}</p><a href="javascript:alert('${secretMarker}')">bad</a>`,
      },
    });
    expect(badDescRes.status).toBe(400);
    expect(JSON.stringify(badDescRes.json)).not.toContain(secretMarker);

    const overCapRes = await requestJson('POST', '/v2/stories', {
      cookie: cookies.editor,
      body: {
        title: 'A',
        placeIds: Array.from(
          { length: MAX_STORY_EDGE_IDS + 1 },
          () => ids.plOwnA!
        ),
      },
    });
    expect(overCapRes.status).toBe(400);

    // Reference rejections must not insert partial story rows
    const countBefore = (await db.select().from(tables.stories)).length;
    for (const badBody of [
      { title: 'CrossLoc', interviewLocationId: ids.plForeign },
      { title: 'RestrictedLoc', interviewLocationId: ids.plOwnRestricted },
      { title: 'CrossInterviewer', interviewerId: ids.spForeign },
      {
        title: 'CrossPlaceEdge',
        placeIds: [ids.plOwnA, ids.plForeign],
      },
      {
        title: 'RestrictedPlaceEdge',
        placeIds: [ids.plOwnRestricted],
      },
      {
        title: 'CrossSpeakerEdge',
        speakerIds: [ids.spForeign],
      },
      {
        title: 'MissingPlaceEdge',
        placeIds: [9999999],
      },
    ]) {
      const res = await requestJson('POST', '/v2/stories', {
        cookie: cookies.editor,
        body: badBody,
      });
      expect(res.status).toBe(400);
      expect(V2ValidationErrorResponseSchema.safeParse(res.json).success).toBe(
        true
      );
    }
    const countAfter = (await db.select().from(tables.stories)).length;
    expect(countAfter).toBe(countBefore);
  });

  it('updates story fields, derived columns, and reflects visibility toggles immediately on /v2/public and /explore with exact audit trail', async () => {
    const storyId = ids.createdDraftStory!;

    // Update metadata + flip editors -> public
    const patch1 = await requestJson('PATCH', `/v2/stories/${storyId}`, {
      cookie: cookies.editor,
      body: {
        title: 'Published Draft',
        description: '<p>Updated <em>notes</em></p>',
        topic: '  Héritage Audio  ',
        visibility: 'public',
        interviewLocationId: ids.plOwnB,
        interviewerId: ids.spOwnB,
      },
    });
    expect(patch1.status).toBe(200);
    const body1 = StoryWriteResponseSchema.parse(patch1.json);
    expect(body1.data.title).toBe('Published Draft');
    expect(body1.data.visibility).toBe('public');
    expect(body1.data.topic).toBe('Héritage Audio');
    expect(body1.data.interviewLocation?.id).toBe(ids.plOwnB);
    expect(body1.data.interviewer?.id).toBe(ids.spOwnB);

    const [dbAfter1] = await db
      .select()
      .from(tables.stories)
      .where(eq(tables.stories.id, storyId))
      .limit(1);
    expect(dbAfter1?.descriptionPlain).toBe('Updated notes');
    expect(dbAfter1?.topicNormalized).toBe('héritage audio');

    const pub1 = await requestJson(
      'GET',
      '/v2/public/communities/own-nation/stories'
    );
    expect(
      (
        pub1.json as { data: { stories: Array<{ id: number }> } }
      ).data.stories.map((s) => s.id)
    ).toContain(storyId);

    // No-op visibility update (public -> public) does not add an audit entry
    const auditsBeforeNoop = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.resourceType, 'story'));
    const patchNoop = await requestJson('PATCH', `/v2/stories/${storyId}`, {
      cookie: cookies.admin,
      body: { visibility: 'public' },
    });
    expect(patchNoop.status).toBe(200);
    const auditsAfterNoop = await db
      .select()
      .from(tables.auditEntries)
      .where(eq(tables.auditEntries.resourceType, 'story'));
    expect(auditsAfterNoop).toHaveLength(auditsBeforeNoop.length);

    // Flip public -> editors: immediately disappears from /v2/public and /explore
    const patch2 = await requestJson('PATCH', `/v2/stories/${storyId}`, {
      cookie: cookies.admin,
      body: {
        visibility: 'editors',
        topic: null,
        description: null,
        interviewLocationId: null,
        interviewerId: null,
      },
    });
    expect(patch2.status).toBe(200);
    const body2 = StoryWriteResponseSchema.parse(patch2.json);
    expect(body2.data.visibility).toBe('editors');
    expect(body2.data.topic).toBeNull();
    expect(body2.data.description).toBeNull();
    expect(body2.data.interviewLocation).toBeNull();
    expect(body2.data.interviewer).toBeNull();

    const [dbAfter2] = await db
      .select()
      .from(tables.stories)
      .where(eq(tables.stories.id, storyId))
      .limit(1);
    expect(dbAfter2?.descriptionPlain).toBeNull();
    expect(dbAfter2?.topicNormalized).toBeNull();

    const pub2 = await requestJson(
      'GET',
      '/v2/public/communities/own-nation/stories'
    );
    expect(
      (
        pub2.json as { data: { stories: Array<{ id: number }> } }
      ).data.stories.map((s) => s.id)
    ).not.toContain(storyId);
    const explore2 = await requestJson(
      'GET',
      `/explore/communities/own-nation/stories/${storyId}`
    );
    expect(explore2.status).toBe(404);

    const storyAudits = await db
      .select()
      .from(tables.auditEntries)
      .where(
        and(
          eq(tables.auditEntries.communityId, ids.own!),
          eq(tables.auditEntries.resourceType, 'story')
        )
      )
      .orderBy(asc(tables.auditEntries.id));
    // Initial createdPublicStory + editors->public + public->editors
    expect(storyAudits.map((a) => a.action)).toEqual([
      'story.visibility.public',
      'story.visibility.public',
      'story.visibility.editors',
    ]);
  });

  it('rejects PATCH on restricted, foreign, or invalid stories without oracle and rejects disallowed roles', async () => {
    for (const badCookie of [cookies.viewer, cookies.member, cookies.super]) {
      expect(
        (
          await requestJson('PATCH', `/v2/stories/${ids.createdDraftStory}`, {
            cookie: badCookie,
            body: { title: 'Nope' },
          })
        ).status
      ).toBe(403);
    }

    // Restricted / foreign stories return identical 404 even with bad target IDs (no oracle)
    for (const hiddenId of [
      ids.stRestrictedFlag!,
      ids.stRestrictedLevel!,
      ids.stForeign!,
      9999999,
    ]) {
      const r = await requestJson('PATCH', `/v2/stories/${hiddenId}`, {
        cookie: cookies.admin,
        body: { title: 'Bypass', interviewLocationId: ids.plForeign },
      });
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: 'Not found' });
    }

    expect(
      (
        await requestJson('PATCH', '/v2/stories/not-an-id', {
          cookie: cookies.admin,
          body: { title: 'A' },
        })
      ).status
    ).toBe(400);

    expect(
      (
        await requestJson('PATCH', `/v2/stories/${ids.createdDraftStory}`, {
          cookie: cookies.admin,
          body: {},
        })
      ).status
    ).toBe(400);

    expect(
      (
        await requestJson('PATCH', `/v2/stories/${ids.createdDraftStory}`, {
          cookie: cookies.admin,
          body: { visibility: 'restricted' },
        })
      ).status
    ).toBe(400);

    expect(
      (
        await requestJson('PATCH', `/v2/stories/${ids.createdDraftStory}`, {
          cookie: cookies.admin,
          body: { placeIds: [ids.plOwnA] },
        })
      ).status
    ).toBe(400);
  });

  it('deletes own-community story with cascading edges/links/attachments while leaving restricted/foreign stories untouched', async () => {
    const storyId = ids.createdPublicStory!;
    await db.insert(tables.externalMediaLinks).values({
      communityId: ids.own!,
      storyId,
      url: 'https://media.example.test/watch/1',
      ordinal: 0,
      createdAt: T0,
    });
    await db.insert(tables.attachments).values({
      communityId: ids.own!,
      ownerType: 'story',
      ownerId: storyId,
      fileId: fileIds.ownStoryFile,
      role: 'media',
      ordinal: 0,
      isActive: true,
      createdAt: T0,
    });

    for (const badCookie of [cookies.viewer, cookies.member, cookies.super]) {
      expect(
        (
          await requestJson('DELETE', `/v2/stories/${storyId}`, {
            cookie: badCookie,
          })
        ).status
      ).toBe(403);
    }

    for (const hiddenId of [
      ids.stRestrictedFlag!,
      ids.stRestrictedLevel!,
      ids.stForeign!,
      9999999,
    ]) {
      expect(
        (
          await requestJson('DELETE', `/v2/stories/${hiddenId}`, {
            cookie: cookies.admin,
          })
        ).status
      ).toBe(404);
    }

    // Restricted story and its attachment must still exist
    const restrictedAtts = await db
      .select()
      .from(tables.attachments)
      .where(
        and(
          eq(tables.attachments.ownerType, 'story'),
          eq(tables.attachments.ownerId, ids.stRestrictedFlag!)
        )
      );
    expect(restrictedAtts).toHaveLength(1);

    const delRes = await requestJson('DELETE', `/v2/stories/${storyId}`, {
      cookie: cookies.editor,
    });
    expect(delRes.status).toBe(204);
    expect(delRes.json).toBeNull();

    expect(
      await db
        .select()
        .from(tables.stories)
        .where(eq(tables.stories.id, storyId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(tables.storyPlaces)
        .where(eq(tables.storyPlaces.storyId, storyId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(tables.storySpeakers)
        .where(eq(tables.storySpeakers.storyId, storyId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(tables.externalMediaLinks)
        .where(eq(tables.externalMediaLinks.storyId, storyId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(tables.attachments)
        .where(
          and(
            eq(tables.attachments.ownerType, 'story'),
            eq(tables.attachments.ownerId, storyId)
          )
        )
    ).toEqual([]);

    // The files row whose only reference was the deleted attachment is gone.
    expect(
      await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, fileIds.ownStoryFile))
    ).toHaveLength(0);
    // A still-referenced files row (the restricted story's file) is kept.
    expect(
      await db
        .select()
        .from(tables.files)
        .where(eq(tables.files.id, fileIds.restrictedStoryFile))
    ).toHaveLength(1);

    // Referenced places & speakers still exist
    expect(
      await db
        .select()
        .from(tables.places)
        .where(eq(tables.places.id, ids.plOwnA!))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(tables.speakers)
        .where(eq(tables.speakers.id, ids.spOwnA!))
    ).toHaveLength(1);
  });
});

describe('Slice 8 StoryPlace and StorySpeaker edge routes', () => {
  it('replaces places and speakers atomically preserving multiplicity, exact order, empty clear, and D1 cap', async () => {
    const storyId = ids.createdDraftStory!;

    const putPlaces1 = await requestJson(
      'PUT',
      `/v2/stories/${storyId}/places`,
      {
        cookie: cookies.editor,
        body: { placeIds: [ids.plOwnB, ids.plOwnA, ids.plOwnB] },
      }
    );
    expect(putPlaces1.status).toBe(200);
    const bodyPlaces1 = StoryWriteResponseSchema.parse(putPlaces1.json);
    expect(bodyPlaces1.data.places.map((p) => p.id)).toEqual([
      ids.plOwnB,
      ids.plOwnA,
      ids.plOwnB,
    ]);

    const dbPlaceEdges1 = await db
      .select()
      .from(tables.storyPlaces)
      .where(eq(tables.storyPlaces.storyId, storyId))
      .orderBy(asc(tables.storyPlaces.sortOrder), asc(tables.storyPlaces.id));
    expect(dbPlaceEdges1.map((e) => [e.placeId, e.sortOrder])).toEqual([
      [ids.plOwnB!, 0],
      [ids.plOwnA!, 1],
      [ids.plOwnB!, 2],
    ]);

    const putSpeakers1 = await requestJson(
      'PUT',
      `/v2/stories/${storyId}/speakers`,
      {
        cookie: cookies.admin,
        body: { speakerIds: [ids.spOwnA, ids.spOwnB, ids.spOwnA] },
      }
    );
    expect(putSpeakers1.status).toBe(200);
    const bodySpeakers1 = StoryWriteResponseSchema.parse(putSpeakers1.json);
    expect(bodySpeakers1.data.speakers.map((s) => s.id)).toEqual([
      ids.spOwnA,
      ids.spOwnB,
      ids.spOwnA,
    ]);

    // Supports the exact MAX_STORY_EDGE_IDS cap (100 entries)
    const maxPlaces = Array.from({ length: MAX_STORY_EDGE_IDS }, (_, idx) =>
      idx % 2 === 0 ? ids.plOwnA! : ids.plOwnB!
    );
    const putPlacesMax = await requestJson(
      'PUT',
      `/v2/stories/${storyId}/places`,
      {
        cookie: cookies.editor,
        body: { placeIds: maxPlaces },
      }
    );
    expect(putPlacesMax.status).toBe(200);
    expect(
      StoryWriteResponseSchema.parse(putPlacesMax.json).data.places.map(
        (p) => p.id
      )
    ).toEqual(maxPlaces);

    // Clear edges cleanly with []
    const clearPlaces = await requestJson(
      'PUT',
      `/v2/stories/${storyId}/places`,
      {
        cookie: cookies.editor,
        body: { placeIds: [] },
      }
    );
    expect(clearPlaces.status).toBe(200);
    expect(
      StoryWriteResponseSchema.parse(clearPlaces.json).data.places
    ).toEqual([]);

    const clearSpeakers = await requestJson(
      'PUT',
      `/v2/stories/${storyId}/speakers`,
      {
        cookie: cookies.admin,
        body: { speakerIds: [] },
      }
    );
    expect(clearSpeakers.status).toBe(200);
    expect(
      StoryWriteResponseSchema.parse(clearSpeakers.json).data.speakers
    ).toEqual([]);
  });

  it('rejects cross-community, restricted targets, restricted stories (no oracle), over-cap lists, and disallowed roles while keeping existing edges', async () => {
    const storyId = ids.createdDraftStory!;
    expect(
      (
        await requestJson('PUT', `/v2/stories/${storyId}/places`, {
          cookie: cookies.editor,
          body: { placeIds: [ids.plOwnA] },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await requestJson('PUT', `/v2/stories/${storyId}/speakers`, {
          cookie: cookies.editor,
          body: { speakerIds: [ids.spOwnA] },
        })
      ).status
    ).toBe(200);

    for (const badCookie of [
      cookies.viewer,
      cookies.member,
      cookies.super,
      cookies.disabledAdmin,
    ]) {
      expect(
        (
          await requestJson('PUT', `/v2/stories/${storyId}/places`, {
            cookie: badCookie,
            body: { placeIds: [ids.plOwnB] },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await requestJson('PUT', `/v2/stories/${storyId}/speakers`, {
            cookie: badCookie,
            body: { speakerIds: [ids.spOwnB] },
          })
        ).status
      ).toBe(403);
    }

    // Cross-origin CSRF & non-JSON
    expect(
      (
        await requestJson('PUT', `/v2/stories/${storyId}/places`, {
          cookie: cookies.editor,
          headers: { origin: FOREIGN_ORIGIN },
          body: { placeIds: [ids.plOwnB] },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await requestJson('PUT', `/v2/stories/${storyId}/speakers`, {
          cookie: cookies.editor,
          headers: { 'content-type': 'text/plain' },
          body: 'speakerIds=[]',
        })
      ).status
    ).toBe(415);

    // Over cap (101 items) & invalid shapes
    expect(
      (
        await requestJson('PUT', `/v2/stories/${storyId}/places`, {
          cookie: cookies.editor,
          body: {
            placeIds: Array.from(
              { length: MAX_STORY_EDGE_IDS + 1 },
              () => ids.plOwnA!
            ),
          },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await requestJson('PUT', `/v2/stories/${storyId}/speakers`, {
          cookie: cookies.editor,
          body: {
            speakerIds: Array.from(
              { length: MAX_STORY_EDGE_IDS + 1 },
              () => ids.spOwnA!
            ),
          },
        })
      ).status
    ).toBe(400);

    // Bad story ID
    expect(
      (
        await requestJson('PUT', '/v2/stories/abc/places', {
          cookie: cookies.editor,
          body: { placeIds: [] },
        })
      ).status
    ).toBe(400);

    // Cross-community / restricted / missing targets return 400 and leave prior edges intact
    for (const badPlaceIds of [
      [ids.plForeign!],
      [ids.plOwnA!, ids.plOwnRestricted!],
      [9999999],
    ]) {
      const r = await requestJson('PUT', `/v2/stories/${storyId}/places`, {
        cookie: cookies.editor,
        body: { placeIds: badPlaceIds },
      });
      expect(r.status).toBe(400);
      expect(V2ValidationErrorResponseSchema.safeParse(r.json).success).toBe(
        true
      );
    }
    for (const badSpeakerIds of [[ids.spForeign!], [9999999]]) {
      const r = await requestJson('PUT', `/v2/stories/${storyId}/speakers`, {
        cookie: cookies.editor,
        body: { speakerIds: badSpeakerIds },
      });
      expect(r.status).toBe(400);
      expect(V2ValidationErrorResponseSchema.safeParse(r.json).success).toBe(
        true
      );
    }

    // Restricted / foreign / missing stories return 404 even with bad targets (no oracle)
    for (const hiddenId of [
      ids.stRestrictedFlag!,
      ids.stRestrictedLevel!,
      ids.stForeign!,
      9999999,
    ]) {
      const rp = await requestJson('PUT', `/v2/stories/${hiddenId}/places`, {
        cookie: cookies.admin,
        body: { placeIds: [ids.plForeign] },
      });
      expect(rp.status).toBe(404);
      expect(rp.json).toEqual({ error: 'Not found' });

      const rs = await requestJson('PUT', `/v2/stories/${hiddenId}/speakers`, {
        cookie: cookies.admin,
        body: { speakerIds: [ids.spForeign] },
      });
      expect(rs.status).toBe(404);
      expect(rs.json).toEqual({ error: 'Not found' });
    }

    // Original edges survived every invalid request
    const storyAfter = await requestJson('GET', `/v2/stories/${storyId}`, {
      cookie: cookies.editor,
    });
    expect(storyAfter.status).toBe(200);
    const parsedAfter = StoryWriteResponseSchema.parse(storyAfter.json);
    expect(parsedAfter.data.places.map((p) => p.id)).toEqual([ids.plOwnA]);
    expect(parsedAfter.data.speakers.map((s) => s.id)).toEqual([ids.spOwnA]);
  });
});

describe('Slice 8 ExternalMediaLink routes', () => {
  it('adds http/https links with deterministic ordinals, reorders atomically as a permutation, and deletes cleanly', async () => {
    const storyId = ids.createdDraftStory!;
    // Empty reorder succeeds on empty list
    const emptyReorder = await requestJson(
      'PATCH',
      `/v2/stories/${storyId}/external-links/reorder`,
      {
        cookie: cookies.editor,
        body: { linkIds: [] },
      }
    );
    expect(emptyReorder.status).toBe(200);
    expect(
      ExternalMediaLinksListResponseSchema.parse(emptyReorder.json).data
    ).toEqual([]);

    const add1 = await requestJson(
      'POST',
      `/v2/stories/${storyId}/external-links`,
      {
        cookie: cookies.editor,
        body: { url: 'https://video.example.test/watch/alpha' },
      }
    );
    expect(add1.status).toBe(201);
    const link1 = ExternalMediaLinkWriteResponseSchema.parse(add1.json).data;
    expect(link1.url).toBe('https://video.example.test/watch/alpha');
    expect(link1.ordinal).toBe(0);

    const add2 = await requestJson(
      'POST',
      `/v2/stories/${storyId}/external-links`,
      {
        cookie: cookies.admin,
        body: { url: 'http://audio.example.test/track/beta' },
      }
    );
    expect(add2.status).toBe(201);
    const link2 = ExternalMediaLinkWriteResponseSchema.parse(add2.json).data;
    expect(link2.ordinal).toBe(1);

    const add3 = await requestJson(
      'POST',
      `/v2/stories/${storyId}/external-links`,
      {
        cookie: cookies.editor,
        body: { url: 'https://archive.example.test/doc/gamma', ordinal: 5 },
      }
    );
    expect(add3.status).toBe(201);
    const link3 = ExternalMediaLinkWriteResponseSchema.parse(add3.json).data;
    expect(link3.ordinal).toBe(5);

    const reorderRes = await requestJson(
      'PATCH',
      `/v2/stories/${storyId}/external-links/reorder`,
      {
        cookie: cookies.editor,
        body: { linkIds: [link3.id, link1.id, link2.id] },
      }
    );
    expect(reorderRes.status).toBe(200);
    const reordered = ExternalMediaLinksListResponseSchema.parse(
      reorderRes.json
    ).data;
    expect(reordered.map((l) => [l.id, l.ordinal])).toEqual([
      [link3.id, 0],
      [link1.id, 1],
      [link2.id, 2],
    ]);

    // Reflected in story detail readback
    const readRes = await requestJson('GET', `/v2/stories/${storyId}`, {
      cookie: cookies.editor,
    });
    expect(
      StoryWriteResponseSchema.parse(readRes.json).data.externalMediaLinks.map(
        (l) => l.id
      )
    ).toEqual([link3.id, link1.id, link2.id]);

    // Delete middle link
    const delRes = await requestJson(
      'DELETE',
      `/v2/stories/${storyId}/external-links/${link1.id}`,
      { cookie: cookies.admin }
    );
    expect(delRes.status).toBe(204);
    expect(delRes.json).toBeNull();

    const readAfterDel = await requestJson('GET', `/v2/stories/${storyId}`, {
      cookie: cookies.editor,
    });
    expect(
      StoryWriteResponseSchema.parse(
        readAfterDel.json
      ).data.externalMediaLinks.map((l) => l.id)
    ).toEqual([link3.id, link2.id]);

    ids.remainingLinkA = link3.id;
    ids.remainingLinkB = link2.id;
  });

  it('rejects non-http(s) URLs without echo, invalid permutations, foreign/restricted stories, and disallowed callers', async () => {
    const storyId = ids.createdDraftStory!;
    const foreignLink = await db
      .insert(tables.externalMediaLinks)
      .values({
        communityId: ids.foreign!,
        storyId: ids.stForeign!,
        url: 'https://foreign.example.test/media',
        ordinal: 0,
        createdAt: T0,
      })
      .returning({ id: tables.externalMediaLinks.id });
    const foreignLinkId = foreignLink[0]!.id;

    // Restricted story link for cross-story delete isolation test
    const restrictedLink = await db
      .insert(tables.externalMediaLinks)
      .values({
        communityId: ids.own!,
        storyId: ids.stRestrictedFlag!,
        url: 'https://own.example.test/restricted-link',
        ordinal: 0,
        createdAt: T0,
      })
      .returning({ id: tables.externalMediaLinks.id });
    const restrictedLinkId = restrictedLink[0]!.id;

    for (const badCookie of [
      cookies.viewer,
      cookies.member,
      cookies.super,
      cookies.disabledAdmin,
    ]) {
      expect(
        (
          await requestJson('POST', `/v2/stories/${storyId}/external-links`, {
            cookie: badCookie,
            body: { url: 'https://ok.example.test/a' },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await requestJson(
            'PATCH',
            `/v2/stories/${storyId}/external-links/reorder`,
            {
              cookie: badCookie,
              body: { linkIds: [ids.remainingLinkA, ids.remainingLinkB] },
            }
          )
        ).status
      ).toBe(403);
      expect(
        (
          await requestJson(
            'DELETE',
            `/v2/stories/${storyId}/external-links/${ids.remainingLinkA}`,
            { cookie: badCookie }
          )
        ).status
      ).toBe(403);
    }

    // Invalid URL schemes and relative URLs rejected with 400 and never echoed
    const secretUrlCanary = 'CANARY_BAD_URL_TOKEN';
    for (const badUrl of [
      `javascript:alert('${secretUrlCanary}')`,
      `data:text/html,<p>${secretUrlCanary}</p>`,
      `file:///etc/${secretUrlCanary}`,
      `ftp://files.example.test/${secretUrlCanary}`,
      `/relative/${secretUrlCanary}.mp4`,
      '',
    ]) {
      const r = await requestJson(
        'POST',
        `/v2/stories/${storyId}/external-links`,
        {
          cookie: cookies.editor,
          body: { url: badUrl },
        }
      );
      expect(r.status).toBe(400);
      expect(V2ValidationErrorResponseSchema.safeParse(r.json).success).toBe(
        true
      );
      expect(JSON.stringify(r.json)).not.toContain(secretUrlCanary);
    }

    // Reorder permutation rejections
    for (const badPermutation of [
      [],
      [ids.remainingLinkA!],
      [ids.remainingLinkA!, ids.remainingLinkA!],
      [ids.remainingLinkA!, ids.remainingLinkB!, 9999999],
      [ids.remainingLinkA!, foreignLinkId],
      [ids.remainingLinkA!, restrictedLinkId],
    ]) {
      const r = await requestJson(
        'PATCH',
        `/v2/stories/${storyId}/external-links/reorder`,
        {
          cookie: cookies.editor,
          body: { linkIds: badPermutation },
        }
      );
      expect(r.status).toBe(400);
    }

    // Cross-story / restricted story / foreign story delete/add/reorder return 404
    expect(
      (
        await requestJson(
          'DELETE',
          `/v2/stories/${storyId}/external-links/${foreignLinkId}`,
          { cookie: cookies.admin }
        )
      ).status
    ).toBe(404);
    expect(
      (
        await requestJson(
          'DELETE',
          `/v2/stories/${storyId}/external-links/${restrictedLinkId}`,
          { cookie: cookies.admin }
        )
      ).status
    ).toBe(404);

    for (const hiddenStoryId of [
      ids.stRestrictedFlag!,
      ids.stRestrictedLevel!,
      ids.stForeign!,
      9999999,
    ]) {
      expect(
        (
          await requestJson(
            'POST',
            `/v2/stories/${hiddenStoryId}/external-links`,
            {
              cookie: cookies.admin,
              body: { url: 'https://ok.example.test/x' },
            }
          )
        ).status
      ).toBe(404);
      expect(
        (
          await requestJson(
            'PATCH',
            `/v2/stories/${hiddenStoryId}/external-links/reorder`,
            {
              cookie: cookies.admin,
              body: { linkIds: [restrictedLinkId] },
            }
          )
        ).status
      ).toBe(404);
      expect(
        (
          await requestJson(
            'DELETE',
            `/v2/stories/${hiddenStoryId}/external-links/${restrictedLinkId}`,
            { cookie: cookies.admin }
          )
        ).status
      ).toBe(404);
    }

    // Bad route param IDs
    expect(
      (
        await requestJson(
          'DELETE',
          `/v2/stories/${storyId}/external-links/not-an-id`,
          { cookie: cookies.admin }
        )
      ).status
    ).toBe(400);

    // Restricted link was NOT deleted
    expect(
      await db
        .select()
        .from(tables.externalMediaLinks)
        .where(eq(tables.externalMediaLinks.id, restrictedLinkId))
    ).toHaveLength(1);
  });
});

describe('Slice 8 D1 batch atomicity and race safety', () => {
  it('rolls back D1 batch atomically on concurrent target restriction and avoids stale audits', async () => {
    const batchSqlite = new Sqlite(':memory:');
    batchSqlite.pragma('foreign_keys = ON');
    const batchDb = drizzle(batchSqlite);
    const batchTables = tablesFor(batchDb);
    migrate(batchDb, { migrationsFolder: 'src/db/migrations' });

    const [comm] = await batchDb
      .insert(batchTables.communities)
      .values({
        name: 'Batch Nation',
        slug: 'batch-nation',
        locale: 'en',
        publicStories: true,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: batchTables.communities.id });

    const identity = deriveUserIdentityColumns({
      email: 'batch@example.test',
      username: 'batch-editor',
    });
    const [actor] = await batchDb
      .insert(batchTables.users)
      .values({
        email: 'batch@example.test',
        username: 'batch-editor',
        ...identity,
        passwordHash: 'hash',
        firstName: 'Batch',
        lastName: 'User',
        role: 'editor',
        communityId: comm!.id,
        isActive: true,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: batchTables.users.id });

    const [place] = await batchDb
      .insert(batchTables.places)
      .values({
        communityId: comm!.id,
        name: 'Batch Place',
        latitude: 10,
        longitude: 20,
        isRestricted: false,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: batchTables.places.id });

    const d1Like = Object.create(batchDb) as typeof batchDb & {
      batch: (
        stmts: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
      ) => Promise<unknown[]>;
    };
    let beforeNextBatch: (() => void) | null = null;
    const recordedBatches: Array<Array<{ sql: string; params: unknown[] }>> =
      [];
    d1Like.batch = async (stmts) => {
      if (beforeNextBatch) {
        const hook = beforeNextBatch;
        beforeNextBatch = null;
        hook();
      }
      const queries = stmts.map((s) => s.toSQL());
      recordedBatches.push(queries);
      return batchSqlite.transaction(() =>
        queries.map(({ sql: querySql, params }) => {
          const stmt = batchSqlite.prepare(querySql);
          return stmt.reader ? stmt.all(...params) : stmt.run(...params);
        })
      )();
    };

    try {
      const repo = new StoryWritesRepository(d1Like as never);

      // 1. Create succeeds cleanly with edge + audit
      const ok = await repo.createStory(
        comm!.id,
        actor!.id,
        {
          title: 'D1 Story',
          description: null,
          descriptionPlain: null,
          visibility: 'public',
          topic: null,
          topicNormalized: null,
          language: 'en',
          dateInterviewed: null,
          interviewLocationId: place!.id,
          interviewerId: null,
          placeIds: [place!.id, place!.id],
          speakerIds: [],
        },
        T0
      );
      expect(ok.status).toBe('created');
      if (ok.status !== 'created') return;
      const createQueries = recordedBatches[0]!;
      expect(createQueries[1]!.sql).toContain('s.created_by =');
      expect(createQueries[1]!.sql).toContain('s.created_at =');
      expect(createQueries[1]!.params).toContain(actor!.id);
      expect(createQueries[1]!.params).toContain(T0.getTime());
      expect(createQueries[2]!.sql).toContain('"created_by" =');
      expect(createQueries[2]!.sql).toContain('"created_at" =');
      expect(createQueries[2]!.params).toContain(actor!.id);
      expect(createQueries[2]!.params).toContain(T0.getTime());

      expect(await batchDb.select().from(batchTables.storyPlaces)).toHaveLength(
        2
      );
      expect(
        await batchDb.select().from(batchTables.auditEntries)
      ).toHaveLength(1);

      // 2. Concurrent place restriction before batch runs aborts entire createStory batch
      beforeNextBatch = () => {
        batchSqlite
          .prepare('UPDATE places SET is_restricted = 1 WHERE id = ?')
          .run(place!.id);
      };
      await expect(
        repo.createStory(
          comm!.id,
          actor!.id,
          {
            title: 'Should Rollback',
            description: null,
            descriptionPlain: null,
            visibility: 'public',
            topic: null,
            topicNormalized: null,
            language: 'en',
            dateInterviewed: null,
            interviewLocationId: null,
            interviewerId: null,
            placeIds: [place!.id],
            speakerIds: [],
          },
          T0
        )
      ).rejects.toThrow(/NOT NULL/);
      expect(await batchDb.select().from(batchTables.stories)).toHaveLength(1);
      expect(
        await batchDb.select().from(batchTables.auditEntries)
      ).toHaveLength(1);

      // 3. Concurrent visibility flip before updateStory batch avoids duplicate audit
      beforeNextBatch = () => {
        batchSqlite
          .prepare("UPDATE stories SET privacy_level = 'editors' WHERE id = ?")
          .run(ok.id);
      };
      const upd = await repo.updateStory(
        comm!.id,
        actor!.id,
        ok.id,
        { visibility: 'editors' },
        T0
      );
      expect(upd).toBe('updated');
      expect(
        await batchDb.select().from(batchTables.auditEntries)
      ).toHaveLength(1);

      // 4. Chunked 100-item replaceStoryPlaces succeeds and concurrent restriction rolls back DELETE+INSERT atomically
      batchSqlite
        .prepare('UPDATE places SET is_restricted = 0 WHERE id = ?')
        .run(place!.id);
      const maxEdgeList = Array.from(
        { length: MAX_STORY_EDGE_IDS },
        () => place!.id
      );
      const replaceOk = await repo.replaceStoryPlaces(
        comm!.id,
        ok.id,
        maxEdgeList,
        T0
      );
      expect(replaceOk).toBe('updated');
      expect(await batchDb.select().from(batchTables.storyPlaces)).toHaveLength(
        MAX_STORY_EDGE_IDS
      );

      beforeNextBatch = () => {
        batchSqlite
          .prepare('UPDATE places SET is_restricted = 1 WHERE id = ?')
          .run(place!.id);
      };
      await expect(
        repo.replaceStoryPlaces(comm!.id, ok.id, [place!.id], T0)
      ).rejects.toThrow(/NOT NULL/);
      // Previous 100 edges were NOT deleted because the D1 batch rolled back
      expect(await batchDb.select().from(batchTables.storyPlaces)).toHaveLength(
        MAX_STORY_EDGE_IDS
      );

      // 5. ExternalMediaLink add, cap, race-safe reorder, and restricted delete guard in D1
      const addA = await repo.addExternalLink(
        comm!.id,
        ok.id,
        { url: 'https://media.example.test/1' },
        MAX_EXTERNAL_LINKS_PER_STORY,
        T0
      );
      const addB = await repo.addExternalLink(
        comm!.id,
        ok.id,
        { url: 'https://media.example.test/2' },
        MAX_EXTERNAL_LINKS_PER_STORY,
        T0
      );
      expect(addA.status).toBe('created');
      expect(addB.status).toBe('created');
      if (addA.status !== 'created' || addB.status !== 'created') return;
      expect(addA.link.ordinal).toBe(0);
      expect(addB.link.ordinal).toBe(1);

      const capBlocked = await repo.addExternalLink(
        comm!.id,
        ok.id,
        { url: 'https://media.example.test/over-cap' },
        2,
        T0
      );
      expect(capBlocked.status).toBe('limit_exceeded');

      // Concurrent add during reorder aborts all ordinal updates -> conflict, original ordinals preserved
      beforeNextBatch = () => {
        batchSqlite
          .prepare(
            'INSERT INTO external_media_links (community_id, story_id, url, ordinal, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run(
            comm!.id,
            ok.id,
            'https://media.example.test/3',
            2,
            T0.getTime()
          );
      };
      const reorderRace = await repo.reorderExternalLinks(
        comm!.id,
        ok.id,
        [addB.link.id, addA.link.id],
        T0
      );
      expect(reorderRace.status).toBe('conflict');
      const linksAfterRace = await batchDb
        .select()
        .from(batchTables.externalMediaLinks)
        .orderBy(asc(batchTables.externalMediaLinks.ordinal));
      expect(linksAfterRace.map((l) => [l.url, l.ordinal])).toEqual([
        ['https://media.example.test/1', 0],
        ['https://media.example.test/2', 1],
        ['https://media.example.test/3', 2],
      ]);

      // 6. Restricted story guards both deleteStory and deleteExternalLink in D1
      batchSqlite
        .prepare('UPDATE stories SET is_restricted = 1 WHERE id = ?')
        .run(ok.id);
      expect(
        await repo.deleteExternalLink(comm!.id, ok.id, addA.link.id, T0)
      ).toBe(false);
      const delRestricted = await repo.deleteStory(comm!.id, ok.id);
      expect(delRestricted).toBe(false);
      expect(await batchDb.select().from(batchTables.stories)).toHaveLength(1);
    } finally {
      batchSqlite.close();
    }
  });
});

describe('Slice 9 D1 owner-delete follow-up purge failure (#140)', () => {
  it('still yields 204 when the files purge batch throws after the delete committed', async () => {
    const purgeSqlite = new Sqlite(':memory:');
    purgeSqlite.pragma('foreign_keys = ON');
    const purgeDb = drizzle(purgeSqlite);
    migrate(purgeDb, { migrationsFolder: './src/db/migrations' });
    const t = tablesFor(purgeDb);
    const now = T0;
    const [comm] = await purgeDb
      .insert(t.communities)
      .values({
        name: 'Purge Nation',
        slug: 'purge-nation',
        publicStories: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const passwordHash = await hash(TEST_PASS, 4);
    const email = 'purge-editor@example.test';
    const username = 'purge-editor';
    const [actor] = await purgeDb
      .insert(t.users)
      .values({
        email,
        username,
        ...deriveUserIdentityColumns({ email, username }),
        passwordHash,
        firstName: 'Purge',
        lastName: 'Editor',
        role: 'editor',
        communityId: comm!.id,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const fileId = crypto.randomUUID();
    await purgeDb.insert(t.files).values({
      id: fileId,
      filename: fileId,
      originalName: 'purge.png',
      path: `communities/${comm!.id}/media/${fileId}`,
      storageKey: `communities/${comm!.id}/media/${fileId}`,
      url: 'https://storage.invalid/purge.png',
      mimeType: 'image/png',
      size: 1,
      byteSize: 1,
      communityId: comm!.id,
      uploadedBy: actor!.id,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    const [story] = await purgeDb
      .insert(t.stories)
      .values({
        communityId: comm!.id,
        title: 'Purge Story',
        slug: 'purge-story',
        language: 'en',
        privacyLevel: 'public',
        isRestricted: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await purgeDb.insert(t.attachments).values({
      communityId: comm!.id,
      ownerType: 'story',
      ownerId: story!.id,
      fileId,
      role: 'story_media',
      ordinal: 0,
      createdAt: now,
    });

    // D1-like connection whose `.batch` throws when a statement deletes from
    // files; every other batch behaves like the D1 driver.
    const d1Like = Object.create(purgeDb) as typeof purgeDb & {
      batch: (
        stmts: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
      ) => Promise<unknown[]>;
    };
    d1Like.batch = async (stmts) => {
      const queries = stmts.map((s) => s.toSQL());
      if (queries.some(({ sql }) => /delete\s+from\s+"files"/i.test(sql))) {
        throw new Error('simulated D1 failure in the files purge batch');
      }
      return purgeSqlite.transaction(() =>
        queries.map(({ sql: querySql, params }) => {
          const stmt = purgeSqlite.prepare(querySql);
          return stmt.reader ? stmt.all(...params) : stmt.run(...params);
        })
      )();
    };

    const d1App = createHonoApp({
      repository: new HonoFoundationRepository(d1Like as never),
      verifier: nodePasswordVerifier,
      secureCookies: false,
      publicOrigin: API_ORIGIN,
      corsOrigins: [CLIENT_ORIGIN],
      storage: { read: async () => null },
    });
    const loginRes = await d1App.request(`${API_ORIGIN}/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: TEST_PASS,
        communityId: comm!.id,
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const delRes = await d1App.request(
      `${API_ORIGIN}/v2/stories/${story!.id}`,
      {
        method: 'DELETE',
        headers: { cookie },
      }
    );
    expect(delRes.status).toBe(204);
    // The story and its attachments are gone — only the purge failed.
    expect(
      await purgeDb.select().from(t.stories).where(eq(t.stories.id, story!.id))
    ).toHaveLength(0);
    expect(
      await purgeDb
        .select()
        .from(t.attachments)
        .where(eq(t.attachments.ownerId, story!.id))
    ).toHaveLength(0);
    // The leftover files row keeps the key referenced: no reclaim by the
    // orphan sweeper, consistent with the 204 committed delete.
    expect(
      await purgeDb.select().from(t.files).where(eq(t.files.id, fileId))
    ).toHaveLength(1);
    purgeSqlite.close();
  });
});
