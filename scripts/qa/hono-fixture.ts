/**
 * In-process Hono V2 persona fixture (#199 phase 2).
 *
 * Drives the Hono app (foundation routes plus the #198 Explore read adapter)
 * through `app.fetch` so every registered Hono endpoint is exercised by
 * persona journeys. Runs on isolated in-memory SQLite by default and on a
 * freshly migrated PostgreSQL when DATABASE_URL and the reset guard select
 * it (scripts/qa/qa-database.ts), with identical journeys and expectations.
 * The route table is derived from `app.routes`, so a newly registered route
 * fails coverage until a journey reaches it. Mirrors sqlite-fixture.ts:
 * refuses HTTP mode because its isolated database cannot seed a deployed
 * server.
 */
import { sql } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { nodePasswordVerifier } from '../../src/node-password.js';
import { dialectOf, tablesFor } from '../../src/db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../../src/db/schema/sessions.js';
import { openPersonaQaDatabase } from './qa-database.js';
import type { Endpoint, Handler, Journey, Step } from './runner.js';

type Role = 'viewer' | 'member' | 'editor' | 'admin' | 'super_admin';

/** The public projection /v2/auth/me and login may ever return. */
const publicUserKeys = 'communityId,email,id,role';

/** Wrong password and unknown user must answer the same body. */
const invalidCredentials = (body: unknown): boolean =>
  (body as { error?: string }).error === 'Invalid credentials' &&
  Object.keys(body as object).length === 1;

/**
 * Serialized secrets an auth body must never carry: the live session cookie
 * value (supplied by the fixture's response wrapper) and password-hash
 * fragments (bcrypt `$2`, argon2, pbkdf2). The cookie value is compared in
 * its JSON-escaped form so an echoed token fails even with escapes.
 */
const leaksSecret = (body: unknown, cookieValue: () => string): boolean => {
  const text = JSON.stringify(body);
  const cookie = JSON.stringify(cookieValue()).slice(1, -1);
  return (
    text.includes('passwordHash') ||
    text.includes('$2') ||
    text.includes('$argon') ||
    text.includes('pbkdf2') ||
    (cookie !== '' && text.includes(cookie))
  );
};

const ownUser =
  (email: string, role: Role, cookieValue: () => string) =>
  (body: unknown): boolean => {
    const user = (body as { user?: Record<string, unknown> }).user;
    return (
      !!user &&
      Object.keys(user).sort().join(',') === publicUserKeys &&
      user.email === email &&
      user.role === role &&
      typeof user.id === 'number' &&
      !leaksSecret(body, cookieValue)
    );
  };

export async function createFixture({ baseUrl }: { baseUrl?: string } = {}) {
  if (baseUrl)
    throw new Error(
      'In-process persona fixtures support isolated in-process runs only'
    );
  // Isolated in-memory SQLite by default; the same journeys run against a
  // freshly migrated PostgreSQL when DATABASE_URL and the reset guard select
  // it (scripts/qa/qa-database.ts). Tables come from the repo's dialect
  // helpers so seeding stays identical across backends; communityMedia is
  // picked the same way HonoFoundationRepository picks it.
  const qa = await openPersonaQaDatabase();
  const db = qa.db;
  const {
    users,
    places,
    speakers,
    stories,
    storyPlaces,
    storySpeakers,
    files,
  } = tablesFor(db);
  const communityMedia =
    dialectOf(db) === 'postgresql' ? communityMediaPg : communityMediaSqlite;
  try {
    const fixtures = await qa.seed();
    // Public active community for Explore; Demo community stays private.
    const communityId = fixtures.communities[0].id;
    const communitySlug = fixtures.communities[0].slug;
    const privateCommunityId = fixtures.communities[1].id;
    const privateCommunitySlug = fixtures.communities[1].slug;
    // A second PUBLIC community owns the foreign fixtures: its rows are
    // publishable, so a 404 elsewhere is community scoping alone, and its
    // own Explore surface serves as the positive control.
    const foreignCommunityId = fixtures.communities[2].id;
    const foreignCommunitySlug = fixtures.communities[2].slug;
    const password = 'QaHonoPassword123!';
    // bcrypt emits $2b$; the verifier accepts the Rails/Devise $2a$ encoding.
    const passwordHash = (await hash(password, 4)).replace('$2b$', '$2a$');
    const credentials: Record<Role, { email: string; password: string }> = {
      viewer: { email: 'qa-hono-viewer@example.test', password },
      member: { email: 'qa-hono-member@example.test', password },
      editor: { email: 'qa-hono-editor@example.test', password },
      admin: { email: 'qa-hono-admin@example.test', password },
      super_admin: { email: 'qa-hono-super@example.test', password },
    };
    // The schema enum predates the V2 member role; the raw binding stores it.
    let creatorId = 0;
    for (const role of Object.keys(credentials) as Role[]) {
      const [user] = await db
        .insert(users)
        .values({
          email: credentials[role].email,
          passwordHash,
          firstName: 'QA',
          lastName: 'Hono',
          role: sql`${role}`,
          communityId:
            role === 'super_admin' ? fixtures.systemCommunity.id : communityId,
          isActive: true,
        })
        .returning();
      if (role === 'admin') creatorId = user.id;
    }
    // A viewer of the foreign public community: proves the foreign media
    // fixture is servable to its own community on /v2/media, so the 404 for
    // community personas is attributable to community scoping.
    const foreignViewerCredentials = {
      email: 'qa-hono-foreign-viewer@example.test',
      password,
    };
    // Same raw role binding as the loop above (the schema enum predates the
    // V2 member role); the interpolated value binds as a string parameter.
    const foreignViewerRole: Role = 'viewer';
    await db
      .insert(users)
      .values({
        email: foreignViewerCredentials.email,
        passwordHash,
        firstName: 'QA',
        lastName: 'Hono',
        role: sql`${foreignViewerRole}`,
        communityId: foreignCommunityId,
        isActive: true,
      })
      .returning();
    // Branding media through the injected storage adapter: readable for the
    // public community, withheld by cultural restrictions, foreign+restricted
    // or foreign+unrestricted; each withheld file fails exactly one gate.
    const storage = new Map<string, Uint8Array>();
    const mediaBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const brandingFile = async (
      ownerCommunityId: number,
      culturalRestrictions: string | null
    ) => {
      const id = crypto.randomUUID();
      const path = `communities/${ownerCommunityId}/${id}.png`;
      await db.insert(files).values({
        id,
        filename: `${id}.png`,
        originalName: 'qa-branding.png',
        path,
        url: `/v2/media/${id}`,
        mimeType: 'image/png',
        size: mediaBytes.length,
        uploadedBy: creatorId,
        communityId: ownerCommunityId,
        culturalRestrictions,
        // PostgreSQL deliberately has no database default for these
        // columns; supply the same instant SQLite's JS default would.
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(communityMedia).values({
        fileId: id,
        communityId: ownerCommunityId,
        kind: 'branding',
      });
      storage.set(path, mediaBytes);
      return id;
    };
    const readableFileId = await brandingFile(communityId, null);
    // CulturalRestrictionsSchema-shaped, clearly non-empty metadata: the
    // gates below prove the cultural-restriction condition itself, not the
    // empty-'{}' edge.
    const restrictedFileId = await brandingFile(
      communityId,
      JSON.stringify({ accessLevel: 'family' })
    );
    // Foreign AND unrestricted, in the public foreign community: publicly
    // servable there (its Explore surface and its own users get 200), so a
    // 404 for community personas is community scoping, not restrictions.
    const foreignFileId = await brandingFile(foreignCommunityId, null);
    // Foreign AND unrestricted in the private community: /explore/media
    // withholds it through the community publication gate alone.
    const foreignPrivateFileId = await brandingFile(privateCommunityId, null);
    // Restricted branding in the SUPER ADMIN's own system community: the
    // highest role still gets 404 on /v2/media, so that gate below is the
    // cultural-restriction condition alone (scoping matches because the file
    // is in the super admin's own community; the community is also private,
    // keeping this file off every Explore surface).
    const superAdminRestrictedFileId = await brandingFile(
      fixtures.systemCommunity.id,
      JSON.stringify({ accessLevel: 'family' })
    );
    // Explore gates (#162 option A), each fixture withholding exactly one
    // property: every gated story carries the same evidence edges as the
    // public story (restricted/unknown-privacy in this community, foreign in
    // its own public community), the unevidenced story alone has no edges,
    // and foreign ids answer the same 404 on another community's slug.
    const [publicPlace, restrictedPlace, unassociatedPlace] = await db
      .insert(places)
      .values([
        {
          name: 'QA public place',
          communityId,
          latitude: -3,
          longitude: -60,
        },
        {
          name: 'QA restricted place',
          communityId,
          latitude: -3,
          longitude: -60,
          isRestricted: true,
        },
        {
          name: 'QA unassociated place',
          communityId,
          latitude: -3,
          longitude: -60,
        },
      ])
      .returning();
    const [foreignPlace] = await db
      .insert(places)
      .values({
        name: 'QA foreign place',
        communityId: foreignCommunityId,
        latitude: -3,
        longitude: -60,
      })
      .returning();
    const [speaker] = await db
      .insert(speakers)
      .values({ name: 'QA hono speaker', communityId, isActive: true })
      .returning();
    const [foreignSpeaker] = await db
      .insert(speakers)
      .values({
        name: 'QA foreign speaker',
        communityId: foreignCommunityId,
        isActive: true,
      })
      .returning();
    const [
      publicStory,
      restrictedStory,
      unevidencedStory,
      unknownStory,
      foreignStory,
    ] = await db
      .insert(stories)
      .values([
        {
          title: 'QA public story',
          slug: 'qa-hono-public',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'public',
        },
        {
          title: 'QA restricted story',
          slug: 'qa-hono-restricted',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'public',
          isRestricted: true,
        },
        {
          title: 'QA unevidenced story',
          slug: 'qa-hono-unevidenced',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'public',
        },
        {
          title: 'QA unknown-privacy story',
          slug: 'qa-hono-unknown',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'unknown',
        },
        {
          title: 'QA foreign story',
          slug: 'qa-hono-foreign',
          communityId: foreignCommunityId,
          createdBy: creatorId,
          privacyLevel: 'public',
        },
      ])
      .returning();
    // Rails-shaped lists join places and speakers, so the public story stays
    // visible. The restricted place is evidenced by a public story too, so
    // its 404 is the restricted flag alone; the unassociated place has no
    // edge and is hidden by the §6.4a association rule alone.
    await db.insert(storyPlaces).values([
      { storyId: publicStory.id, placeId: publicPlace.id },
      { storyId: restrictedStory.id, placeId: publicPlace.id },
      { storyId: unknownStory.id, placeId: publicPlace.id },
      { storyId: foreignStory.id, placeId: foreignPlace.id },
      { storyId: publicStory.id, placeId: restrictedPlace.id },
    ]);
    await db.insert(storySpeakers).values([
      { storyId: publicStory.id, speakerId: speaker.id },
      { storyId: restrictedStory.id, speakerId: speaker.id },
      { storyId: unknownStory.id, speakerId: speaker.id },
      { storyId: foreignStory.id, speakerId: foreignSpeaker.id },
    ]);
    const app = createHonoApp({
      repository: new HonoFoundationRepository(db),
      verifier: nodePasswordVerifier,
      secureCookies: false,
      storage: { read: async (key) => storage.get(key) ?? null },
    });
    // Derive the endpoint table from the app itself: only method-ALL
    // middleware registrations are dropped (they are not callable
    // endpoints) — a concrete-method route stays in coverage even when its
    // path is a wildcard — and bodyLimit re-registers the login route, so
    // keep the first concrete entry.
    const routes: Endpoint[] = [];
    const registered = new Set<string>();
    for (const route of app.routes) {
      if (route.method === 'ALL') continue;
      const key = `${route.method} ${route.path}`;
      if (registered.has(key)) continue;
      registered.add(key);
      routes.push({ method: route.method, path: route.path });
    }
    if (routes.length === 0)
      throw new Error('Hono app registered no persona endpoints');
    // The runner hands checks the response body only; wrap the app to track
    // the live ts_session cookie value (most recent non-empty Set-Cookie) so
    // auth body checks can prove the token itself never leaks into a body.
    let sessionCookieValue = '';
    const liveSessionCookie = () => sessionCookieValue;
    const handler: Handler = async (request) => {
      const response = await app.fetch(request);
      for (const setCookie of response.headers.getSetCookie()) {
        const setting = setCookie.split(';')[0].trim();
        if (setting.startsWith('ts_session=') && setting !== 'ts_session=')
          sessionCookieValue = setting.slice('ts_session='.length);
      }
      return response;
    };
    /**
     * Exact id-set equality: same rows in any order, nothing extra, missing
     * or duplicated. Order-insensitive because multi-row responses can share
     * same-tick timestamps, so their order is not a stable contract.
     */
    const idsExactlyAsSet = (
      rows: { id?: number }[] | undefined,
      expected: number[]
    ): boolean => {
      const actual = (Array.isArray(rows) ? rows : [])
        .map((row) => row.id)
        .sort((a, b) => Number(a ?? 0) - Number(b ?? 0));
      const wanted = [...expected].sort((a, b) => a - b);
      return JSON.stringify(actual) === JSON.stringify(wanted);
    };
    // A missing or non-array data.stories resolves to undefined so the id
    // check fails on a malformed response instead of throwing.
    const storyRows = (body: unknown): { id?: number }[] | undefined => {
      const stories = (body as { data?: { stories?: unknown } }).data?.stories;
      return Array.isArray(stories)
        ? (stories as { id?: number }[])
        : undefined;
    };
    // The list gate is shared by the anonymous and session'd journeys: the
    // response carries exactly the public story — same row, same order,
    // nothing extra — so any unexpected row fails, and each withheld fixture
    // fails exactly one condition (restriction, missing edges, unknown
    // privacy, community).
    const storiesListCheck = (body: unknown): boolean =>
      idsExactlyAsSet(storyRows(body), [publicStory.id]);
    /**
     * Story detail must embed exactly the visible relations: places carries
     * only unrestricted same-community places (the restricted place the
     * public story evidences stays out), speakers only active same-community
     * speakers, and points mirrors the same rows as places.
     */
    const storyDetailCheck =
      (storyId: number, placeIds: number[], speakerIds: number[]) =>
      (body: unknown): boolean => {
        const data = (
          body as {
            data?: {
              id?: number;
              places?: { id?: number }[];
              speakers?: { id?: number }[];
              points?: { id?: number }[];
            };
          }
        ).data;
        return (
          data?.id === storyId &&
          idsExactlyAsSet(data?.places, placeIds) &&
          idsExactlyAsSet(data?.speakers, speakerIds) &&
          idsExactlyAsSet(data?.points, placeIds)
        );
      };
    // Shared by the anonymous and session'd journeys so both assert the same
    // exact projection: one visible place, one visible speaker.
    const publicStoryDetailCheck = storyDetailCheck(
      publicStory.id,
      [publicPlace.id],
      [speaker.id]
    );
    /**
     * Community detail embeds a story count and projection collections; each
     * must carry exactly the visible rows: storiesCount counts only publicly
     * readable stories, map points only publishable associated places, and
     * the place/speaker filter options never confirm a hidden row.
     */
    const communityDetailCheck =
      (
        slug: string,
        expected: {
          storiesCount: number;
          placeIds: number[];
          speakerIds: number[];
        }
      ) =>
      (body: unknown): boolean => {
        const data = (
          body as {
            data?: {
              slug?: string;
              storiesCount?: number;
              points?: { id?: number }[];
              filters?: { category?: string; value?: number | string }[];
            };
          }
        ).data;
        const optionValues = (category: string): (number | string)[] =>
          (data?.filters ?? [])
            .filter((option) => option.category === category)
            .map((option) => option.value);
        return (
          data?.slug === slug &&
          data?.storiesCount === expected.storiesCount &&
          idsExactlyAsSet(data?.points, expected.placeIds) &&
          JSON.stringify(optionValues('places')) ===
            JSON.stringify(expected.placeIds) &&
          JSON.stringify(optionValues('speakers')) ===
            JSON.stringify(expected.speakerIds)
        );
      };
    // Shared by the anonymous and session'd journeys: the list carries
    // exactly the two seeded public communities as a slug set — the private
    // demo and system communities stay absent, and any unexpected row fails.
    // Set comparison (not order): the index sorts newest-update-first, and
    // the seeded rows share same-tick timestamps.
    const communitiesListCheck = (body: unknown): boolean => {
      const slugs =
        (body as { data?: { slug?: string }[] }).data?.map(
          (community) => community.slug
        ) ?? [];
      return (
        JSON.stringify([...slugs].sort()) ===
        JSON.stringify([communitySlug, foreignCommunitySlug].sort())
      );
    };
    /**
     * Shared by the anonymous and session'd journeys: the exact community
     * projection plus a positive displayImage — the community's readable
     * branding file must surface as /explore/media/<readableFileId> — and
     * the restricted file id must never appear anywhere in the serialized
     * body.
     */
    const ownCommunityDetailCheck = (body: unknown): boolean => {
      const projection = communityDetailCheck(communitySlug, {
        storiesCount: 2,
        placeIds: [publicPlace.id],
        speakerIds: [speaker.id],
      })(body);
      // Null-safe read: a missing or non-string displayImage fails the check
      // below instead of throwing.
      const displayImage = (
        body as { data?: { details?: { displayImage?: unknown } } }
      ).data?.details?.displayImage;
      return (
        projection &&
        typeof displayImage === 'string' &&
        displayImage.endsWith(`/explore/media/${readableFileId}`) &&
        !(JSON.stringify(body) ?? '').includes(String(restrictedFileId))
      );
    };
    const explore: Step[] = [
      {
        name: 'explore communities list',
        method: 'GET',
        path: '/explore/communities',
        expected: 200,
        check: communitiesListCheck,
      },
      {
        name: 'explore community detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}`,
        expected: 200,
        // storiesCount 2 = the public story plus the edge-less unevidenced
        // story (both publicly readable; Rails counts without joins); the
        // restricted, unknown-privacy and foreign stories stay out of the
        // count, the points and the place/speaker filter options.
        check: ownCommunityDetailCheck,
      },
      {
        name: 'hide private community',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}`,
        expected: 404,
      },
      {
        name: 'hide unknown community',
        method: 'GET',
        path: '/explore/communities/no-such-community',
        expected: 404,
      },
      {
        // Positive control: the foreign community publishes its own Explore
        // surface with the same exact projection over its own rows (one
        // public story, its own place and speaker), and that surface points
        // at its own unrestricted file.
        name: 'explore foreign community detail',
        method: 'GET',
        path: `/explore/communities/${foreignCommunitySlug}`,
        expected: 200,
        check: (body) => {
          const projection = communityDetailCheck(foreignCommunitySlug, {
            storiesCount: 1,
            placeIds: [foreignPlace.id],
            speakerIds: [foreignSpeaker.id],
          })(body);
          // Null-safe like the own-community check: a non-string
          // displayImage fails instead of throwing.
          const displayImage = (
            body as { data?: { details?: { displayImage?: unknown } } }
          ).data?.details?.displayImage;
          return (
            projection &&
            typeof displayImage === 'string' &&
            displayImage.endsWith(`/explore/media/${foreignFileId}`)
          );
        },
      },
      {
        // Positive control for /explore/media: the foreign unrestricted file
        // IS publicly served through its own community's Explore surface, so
        // the /v2/media 404s for community personas are community scoping.
        name: 'explore foreign community branding media',
        method: 'GET',
        path: `/explore/media/${foreignFileId}`,
        expected: 200,
      },
      {
        name: 'explore stories list',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories`,
        expected: 200,
        check: storiesListCheck,
      },
      {
        // Positive control: the foreign story (evidenced, public,
        // unrestricted) is listable on its own community slug — exactly it,
        // so an unexpected row here fails like anywhere else.
        name: 'explore foreign stories list',
        method: 'GET',
        path: `/explore/communities/${foreignCommunitySlug}/stories`,
        expected: 200,
        check: (body) => idsExactlyAsSet(storyRows(body), [foreignStory.id]),
      },
      {
        name: 'explore story detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${publicStory.id}`,
        expected: 200,
        check: publicStoryDetailCheck,
      },
      {
        // Hidden by isRestricted alone: it carries the same edges as the
        // public story.
        name: 'hide restricted story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${restrictedStory.id}`,
        expected: 404,
      },
      {
        // The unevidenced story is public and unrestricted but carries no
        // edges: the list gate hides it (storiesListCheck), while story show
        // has no join requirement (Rails parity) and serves it with empty
        // relations — pinning that only the evidence rule withholds it.
        name: 'serve unevidenced story detail without relations',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${unevidencedStory.id}`,
        expected: 200,
        check: (body) => {
          const data = (
            body as {
              data?: { id?: number; places?: unknown[]; speakers?: unknown[] };
            }
          ).data;
          return (
            data?.id === unevidencedStory.id &&
            data?.places?.length === 0 &&
            data?.speakers?.length === 0
          );
        },
      },
      {
        // Hidden by the privacy gate alone: it carries the same edges as the
        // public story.
        name: 'hide unknown-privacy story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${unknownStory.id}`,
        expected: 404,
      },
      {
        name: 'reject malformed story id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/not-an-id`,
        expected: 404,
      },
      {
        // Hidden by community scoping alone: it is public, evidenced in its
        // own public community (see the foreign detail positive control).
        name: 'reject cross-community story id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${foreignStory.id}`,
        expected: 404,
      },
      {
        name: 'explore foreign story detail',
        method: 'GET',
        path: `/explore/communities/${foreignCommunitySlug}/stories/${foreignStory.id}`,
        expected: 200,
        // Same exact-projection contract on the foreign community: its story
        // embeds only its own place and its own speaker.
        check: storyDetailCheck(
          foreignStory.id,
          [foreignPlace.id],
          [foreignSpeaker.id]
        ),
      },
      {
        // Place show embeds no story collection (checked against the service:
        // the Rails-shaped place card carries only its own point), so the
        // exact assertion pins the single embedded point to the place itself.
        name: 'explore place detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${publicPlace.id}`,
        expected: 200,
        check: (body) => {
          const data = (
            body as { data?: { id?: number; points?: { id?: number }[] } }
          ).data;
          return (
            data?.id === publicPlace.id &&
            idsExactlyAsSet(data?.points, [publicPlace.id])
          );
        },
      },
      {
        // Hidden by the restricted flag alone: a public story evidences it.
        name: 'hide restricted place',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${restrictedPlace.id}`,
        expected: 404,
      },
      {
        // Hidden by the §6.4a association rule alone: unrestricted, valid
        // coordinates, same public community, but no story edge.
        name: 'hide unassociated place',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${unassociatedPlace.id}`,
        expected: 404,
      },
      {
        name: 'reject cross-community place id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${foreignPlace.id}`,
        expected: 404,
      },
      {
        // Positive control: the foreign place is served on its own community
        // slug through its edge to the foreign story, with the same exact
        // single-point projection.
        name: 'explore foreign place detail',
        method: 'GET',
        path: `/explore/communities/${foreignCommunitySlug}/places/${foreignPlace.id}`,
        expected: 200,
        check: (body) => {
          const data = (
            body as { data?: { id?: number; points?: { id?: number }[] } }
          ).data;
          return (
            data?.id === foreignPlace.id &&
            idsExactlyAsSet(data?.points, [foreignPlace.id])
          );
        },
      },
      {
        name: 'reject malformed place id',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/not-a-place`,
        expected: 404,
      },
      {
        name: 'explore branding media',
        method: 'GET',
        path: `/explore/media/${readableFileId}`,
        expected: 200,
      },
      {
        name: 'hide restricted branding media',
        method: 'GET',
        path: `/explore/media/${restrictedFileId}`,
        expected: 404,
      },
      {
        // Hidden by the community publication gate alone: this foreign file
        // is unrestricted, but its community is private (the public foreign
        // community's file above is the positive control).
        name: 'hide foreign branding media',
        method: 'GET',
        path: `/explore/media/${foreignPrivateFileId}`,
        expected: 404,
      },
      {
        name: 'reject malformed media id',
        method: 'GET',
        path: '/explore/media/not-a-uuid',
        expected: 404,
      },
    ];
    // Explore is anonymous-public: with a session cookie, editor, community
    // admin and super_admin must see exactly the same projection — the
    // community list (exact slug set, private community absent) and detail
    // (exact counts, points, filters and displayImage) included; withheld
    // rows stay 404 and nothing already public narrows.
    const exploreWithSession: Step[] = [
      {
        name: 'explore communities list while authenticated',
        method: 'GET',
        path: '/explore/communities',
        expected: 200,
        check: communitiesListCheck,
      },
      {
        name: 'explore community detail while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}`,
        expected: 200,
        check: ownCommunityDetailCheck,
      },
      {
        name: 'explore stories list while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories`,
        expected: 200,
        check: storiesListCheck,
      },
      {
        name: 'explore story detail while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${publicStory.id}`,
        expected: 200,
        check: publicStoryDetailCheck,
      },
      {
        name: 'hide restricted story while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${restrictedStory.id}`,
        expected: 404,
      },
      {
        name: 'hide unknown-privacy story while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${unknownStory.id}`,
        expected: 404,
      },
      {
        name: 'hide restricted place while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${restrictedPlace.id}`,
        expected: 404,
      },
      {
        name: 'hide unassociated place while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${unassociatedPlace.id}`,
        expected: 404,
      },
      {
        name: 'reject cross-community story id while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${foreignStory.id}`,
        expected: 404,
      },
      {
        name: 'reject cross-community place id while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${foreignPlace.id}`,
        expected: 404,
      },
      {
        name: 'hide restricted branding media while authenticated',
        method: 'GET',
        path: `/explore/media/${restrictedFileId}`,
        expected: 404,
      },
      {
        name: 'hide foreign branding media while authenticated',
        method: 'GET',
        path: `/explore/media/${foreignPrivateFileId}`,
        expected: 404,
      },
    ];
    const journeys: Journey[] = [
      {
        persona: 'anonymous',
        steps: [
          {
            name: 'health',
            method: 'GET',
            path: '/health',
            expected: 200,
            check: (body) => (body as { status?: string }).status === 'ok',
          },
          {
            name: 'ready',
            method: 'GET',
            path: '/ready',
            expected: 200,
            check: (body) => (body as { status?: string }).status === 'ready',
          },
          ...explore,
          {
            name: 'require authentication',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
          },
          {
            name: 'reject wrong password',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            body: {
              email: credentials.admin.email,
              password: 'QaWrongPassword123!',
            },
            check: invalidCredentials,
          },
          {
            name: 'reject unknown user identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            body: {
              email: 'qa-hono-nobody@example.test',
              password: 'QaWrongPassword123!',
            },
            check: invalidCredentials,
          },
        ],
      },
      ...(['viewer', 'member', 'editor', 'admin'] as const).map((role) => ({
        persona: role,
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: credentials[role],
            check: ownUser(credentials[role].email, role, liveSessionCookie),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownUser(credentials[role].email, role, liveSessionCookie),
          },
          // Explore with a session: editor and community admin must see the
          // same anonymous projection (no widening, no narrowing).
          ...(role === 'editor' || role === 'admin' ? exploreWithSession : []),
          {
            name: 'read own community media',
            method: 'GET',
            path: `/v2/media/${readableFileId}`,
            expected: 200,
          },
          {
            // Foreign AND unrestricted media: the 404 is community scoping
            // alone (its own users and its community's Explore surface get
            // this exact file with 200).
            name: 'reject other community media',
            method: 'GET',
            path: `/v2/media/${foreignFileId}`,
            expected: 404,
          },
          {
            name: 'reject restricted media',
            method: 'GET',
            path: `/v2/media/${restrictedFileId}`,
            expected: 404,
          },
          {
            name: 'reject malformed media id',
            method: 'GET',
            path: '/v2/media/not-a-uuid',
            expected: 404,
          },
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            saveCookieAs: 'pre-logout',
          },
          {
            name: 'reject replayed cookie after logout',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'pre-logout',
          },
          {
            name: 'login again',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: credentials[role],
          },
          {
            name: 'revoke every session',
            method: 'POST',
            path: '/v2/auth/revoke',
            expected: 204,
            saveCookieAs: 'pre-revoke',
          },
          {
            name: 'reject revoked session',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'pre-revoke',
          },
        ],
      })),
      {
        persona: 'super_admin',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: credentials.super_admin,
            check: ownUser(
              credentials.super_admin.email,
              'super_admin',
              liveSessionCookie
            ),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownUser(
              credentials.super_admin.email,
              'super_admin',
              liveSessionCookie
            ),
          },
          // Explore with a session: super_admin sees the same anonymous
          // projection; privilege never widens the public surface.
          ...exploreWithSession,
          {
            // Cultural restrictions withhold this file even from the highest
            // role, inside the super admin's OWN system community.
            name: 'reject restricted media of own community',
            method: 'GET',
            path: `/v2/media/${superAdminRestrictedFileId}`,
            expected: 404,
          },
          {
            name: 'deny media of another community',
            method: 'GET',
            path: `/v2/media/${foreignFileId}`,
            expected: 404,
          },
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ],
      },
      {
        // Own-community reader of the foreign public community: positive
        // control proving the foreign media fixture is servable on /v2/media
        // to a user of its own community, so community personas' 404s above
        // are community scoping — and scoping holds in the reverse direction.
        persona: 'foreign_viewer',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: foreignViewerCredentials,
            check: ownUser(
              foreignViewerCredentials.email,
              'viewer',
              liveSessionCookie
            ),
          },
          {
            name: 'read own community media',
            method: 'GET',
            path: `/v2/media/${foreignFileId}`,
            expected: 200,
          },
          {
            name: 'reject other community media',
            method: 'GET',
            path: `/v2/media/${readableFileId}`,
            expected: 404,
          },
        ],
      },
      {
        persona: 'field-kit',
        steps: [],
        skipped:
          'Phase 2: disconnected browser and recovery-code proof belongs to #147.',
      },
    ];
    return {
      handler,
      routes,
      journeys,
      exclusions: [],
      sessionCookieName: 'ts_session',
      close: async () => {
        await qa.close();
      },
    };
  } catch (error) {
    await qa.close();
    throw error;
  }
}
