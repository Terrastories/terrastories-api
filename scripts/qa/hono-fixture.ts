/**
 * In-process Hono V2 persona fixture (#199 phase 2).
 *
 * Drives the Hono app (foundation routes plus the #198 Explore read adapter)
 * through `app.fetch` so every registered Hono endpoint is exercised by
 * persona journeys. Runs on isolated in-memory SQLite by default and on a
 * freshly migrated PostgreSQL when DATABASE_URL and the reset guard select
 * it (scripts/qa/qa-database.ts), with identical journeys and expectations.
 * The #191 fail-closed fixtures turn the V1 public-projection leaks into
 * journeys: a members-only story, a deactivated-but-public community, the
 * explicit publicStories=false surface, the #180 story serialization shapes,
 * and the exported cultural strings the in-process wrappers keep out of
 * captured console and stream output.
 * A caller may instead supply a backend (same journeys, same expectations)
 * whose database handle, media store and request handler come from elsewhere
 * — the Workers build (#199) seeds D1, stores media in R2 and dispatches to
 * bundled workerd. Whenever this fixture builds the Hono app in-process —
 * the default SQLite run and the in-process PostgreSQL run alike — coverage
 * is the route table of the app it actually serves (routeTableOf); a backend
 * instead states its coverage table explicitly (`routes`), and only a
 * backend whose app runs out of process (Workers/workerd, where
 * `app.routes` cannot be read from Node) uses the honoPersonaRouteTable()
 * reconstruction. Either way a newly registered concrete-method route (not
 * app.all) fails coverage until a journey reaches it. Mirrors sqlite-fixture.ts: refuses HTTP mode
 * because its isolated database cannot seed a deployed server.
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
import type { WidenedQaDatabase } from './qa-database.js';
import {
  readRuleOutcome,
  type ReadRuleOutcome,
  type ReadRulePrivacyEvidence,
} from '../../src/policy/read-rules.js';
import type { TestFixtures } from '../../tests/helpers/database.js';
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

/**
 * The shared persona password: every backend seeds the same credentials, so
 * the journeys and their expectations stay byte-identical across SQLite,
 * PostgreSQL and Workers.
 */
export const HONO_PERSONA_PASSWORD = 'QaHonoPassword123!';

/**
 * Seeded story titles, story descriptions, place names and speaker names
 * (#191): cultural content that must never appear in app log output — in
 * Indigenous storytelling data sovereignty, speaker identities (elders,
 * knowledge keepers) are protected cultural data like story text. The Hono
 * app has no logging seam (`src/hono-app.ts` answers errors silently and
 * the Explore adapter logs nothing), so the in-process wrappers (SQLite and
 * PostgreSQL) capture console methods and process stdout/stderr writes
 * during the journeys (scripts/qa/output-capture.ts) and assert none of
 * these strings appear in any captured line; the Workers wrapper runs the
 * app inside workerd, where console output is out of process and is not
 * captured.
 */
export const HONO_PERSONA_CULTURAL_STRINGS: readonly string[] = [
  'QA public story',
  'QA public story description',
  'QA restricted story',
  'QA unevidenced story',
  'QA unknown-privacy story',
  'QA foreign story',
  'QA foreign story description',
  'QA members-only story',
  'QA members-only story description',
  'QA inactive community story',
  'QA inactive community story description',
  'QA private community story',
  'QA private community story description',
  'QA public place',
  'QA restricted place',
  'QA unassociated place',
  'QA members-only place',
  'QA foreign place',
  'QA inactive community place',
  'QA private community place',
  'QA hono speaker',
  'QA members-only speaker',
  'QA foreign speaker',
  'QA inactive community speaker',
  'QA private community speaker',
];

/**
 * An alternative backend for the same persona journeys. `db` is a Drizzle
 * handle on an already-migrated database; `seedBaseline` provisions the
 * system + three communities + places baseline; `putMedia` stores media
 * bytes under the key the served app reads them back by; `handler` receives
 * the fixture's Set-Cookie tracker and returns the request handler the
 * runner drives; `routes` is the backend's coverage table, stated by the
 * backend rather than inferred from its presence — an in-process backend
 * derives it from the Hono app it actually serves (routeTableOf), while the
 * only out-of-process backend today (Workers/workerd, whose app runs where
 * Node cannot read `app.routes`) passes honoPersonaRouteTable();
 * `close` releases the backend even after a seeding failure.
 */
export interface HonoQaBackend {
  db: WidenedQaDatabase;
  seedBaseline: () => Promise<TestFixtures>;
  passwordHash: string;
  putMedia: (key: string, bytes: Uint8Array) => Promise<void>;
  handler: (observeResponseCookies: (response: Response) => void) => Handler;
  routes: Endpoint[];
  close: () => Promise<void>;
}

/**
 * The endpoint table of a Hono app's own `app.routes`: every method-`ALL`
 * registration is dropped — `app.use` middleware and any `app.all` handler
 * alike, since coverage is per concrete method and neither names one (src
 * currently registers no `app.all` routes, so only `app.use` middleware is
 * dropped today) — a concrete-method route stays in coverage even when its
 * path is a wildcard, and bodyLimit re-registers the login route, so keep
 * the first concrete entry. Exported so an in-process backend can derive
 * its `routes` from the app it serves with the same filtering.
 */
export function routeTableOf(
  app: ReturnType<typeof createHonoApp>
): Endpoint[] {
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
  return routes;
}

/**
 * The endpoint table the Workers backend states as its `routes`: the served
 * app runs inside workerd, where its `app.routes` cannot be read from Node,
 * so this reconstruction is derived from `createHonoApp` instead — the
 * factory `createWorker` in src/worker.ts composes. Route registration in
 * `createHonoApp` is unconditional, so the stub collaborators below cannot
 * change the table. That derivation is the table's only evidence: the
 * bundled worker's own route table is not independently checked, and a
 * worker-only route registered outside `createHonoApp` would be absent here
 * and escape coverage.
 */
export function honoPersonaRouteTable(): Endpoint[] {
  const app = createHonoApp({
    repository: { connection: null } as unknown as HonoFoundationRepository,
    verifier: {
      async verify() {
        return false;
      },
    },
    storage: {
      async read() {
        return null;
      },
    },
  });
  return routeTableOf(app);
}

export async function createFixture(
  options: {
    baseUrl?: string;
    backend?: HonoQaBackend;
  } = {}
) {
  if (options.baseUrl)
    throw new Error(
      'In-process persona fixtures support isolated in-process runs only'
    );
  // Isolated in-memory SQLite by default; the same journeys run against a
  // freshly migrated PostgreSQL when DATABASE_URL and the reset guard select
  // it (scripts/qa/qa-database.ts), or against a caller-supplied backend —
  // the Workers build seeds D1, stores media in R2 and dispatches to
  // workerd. Tables come from the repo's dialect helpers so seeding stays
  // identical across backends; communityMedia is picked the same way
  // HonoFoundationRepository picks it.
  const backend = options.backend;
  const qa = backend ? null : await openPersonaQaDatabase();
  const db = backend ? backend.db : qa!.db;
  // Media bytes through the injected store: in-memory for the in-process
  // fixture, the R2 bucket for the Workers build.
  const storage = new Map<string, Uint8Array>();
  const putMedia: (key: string, bytes: Uint8Array) => Promise<void> = backend
    ? backend.putMedia
    : async (key, bytes) => {
        storage.set(key, bytes);
      };
  const {
    communities,
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
    const fixtures = await (backend ? backend.seedBaseline() : qa!.seed());
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
    const password = HONO_PERSONA_PASSWORD;
    // bcrypt emits $2b$; the verifier accepts the Rails/Devise $2a$ encoding.
    // The Workers backend supplies its own Workers-verifiable encoding.
    const passwordHash = backend
      ? backend.passwordHash
      : (await hash(password, 4)).replace('$2b$', '$2a$');
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
    // Branding media through the injected media store (in-memory adapter for
    // the in-process fixture, the R2 bucket for the Workers build): readable
    // for the public community, withheld by cultural restrictions,
    // foreign+restricted or foreign+unrestricted; each withheld file fails
    // exactly one gate.
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
      await putMedia(path, mediaBytes);
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
    // property: every gated story is fully evidenced — the restricted and
    // unknown-privacy stories share the public story's edges, the
    // members-only story carries its own distinct edges (so a projection
    // leak of them changes the exact id sets instead of hiding inside rows
    // the public story already evidences), and the foreign story is
    // evidenced in its own public community — the unevidenced story alone
    // has no edges, and foreign ids answer the same 404 on another
    // community's slug.
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
    // #191: distinct edges for the members-only story, used by no visible
    // story — otherwise its place/speaker are the public story's rows
    // already present in every expected set, and a leak of members-only
    // edges into map points or filter options passes vacuously.
    const [membersPlace] = await db
      .insert(places)
      .values({
        name: 'QA members-only place',
        communityId,
        latitude: -3,
        longitude: -60,
      })
      .returning();
    const [membersSpeaker] = await db
      .insert(speakers)
      .values({
        name: 'QA members-only speaker',
        communityId,
        isActive: true,
      })
      .returning();
    // #191 fail-closed community gate: a community that is public but
    // DEACTIVATED (publicStories true, isActive false — the schema's names
    // for the SPEC §4/§6.1 publication and lifecycle flags). It owns a fully
    // evidenced public story, its own place and speaker, and an unrestricted
    // branding file, so every Explore surface under it 404s through the
    // isActive lifecycle gate alone; the private community (publicStories
    // false) isolates the publication gate the same way.
    const [inactiveCommunity] = await db
      .insert(communities)
      .values({
        name: 'QA inactive public community',
        description: 'Public but deactivated (#191 fail-closed fixture)',
        slug: `qa-inactive-public-${Date.now()}`,
        publicStories: true,
        isActive: false,
        // PostgreSQL deliberately has no database default for timestamps.
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    // Unrestricted branding in the inactive community: /explore/media
    // withholds it through the isActive lifecycle gate alone.
    const inactiveFileId = await brandingFile(inactiveCommunity.id, null);
    const [inactivePlace] = await db
      .insert(places)
      .values({
        name: 'QA inactive community place',
        communityId: inactiveCommunity.id,
        latitude: -3,
        longitude: -60,
      })
      .returning();
    const [inactiveSpeaker] = await db
      .insert(speakers)
      .values({
        name: 'QA inactive community speaker',
        communityId: inactiveCommunity.id,
        isActive: true,
      })
      .returning();
    // #191 publicStories=false fixtures: the private (Demo) community's OWN
    // fully publishable rows — a public, unrestricted, evidenced story with
    // its own place and speaker. A story id of another community 404s under
    // the private slug through community id scoping alone even without the
    // publication flag, so only these own rows make the 404s below prove the
    // publicStories=false gate itself.
    const [privatePlace] = await db
      .insert(places)
      .values({
        name: 'QA private community place',
        communityId: privateCommunityId,
        latitude: -3,
        longitude: -60,
      })
      .returning();
    const [privateSpeaker] = await db
      .insert(speakers)
      .values({
        name: 'QA private community speaker',
        communityId: privateCommunityId,
        isActive: true,
      })
      .returning();
    const [
      publicStory,
      restrictedStory,
      unevidencedStory,
      unknownStory,
      foreignStory,
      membersStory,
      inactiveStory,
      privateStory,
    ] = await db
      .insert(stories)
      .values([
        {
          title: 'QA public story',
          slug: 'qa-hono-public',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'public',
          description: 'QA public story description',
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
          description: 'QA foreign story description',
        },
        {
          // #191: V1's story service checked isRestricted but not
          // privacyLevel, so a members-only story was returned by id. Option
          // A (#162): Explore is a public surface; members-only content never
          // appears there for any persona. Fully evidenced through its OWN
          // distinct place and speaker (membersPlace/membersSpeaker above),
          // so its absence from list, count, points and filters is the
          // privacy gate alone — and a projection leak of its edges changes
          // the exact id sets instead of passing vacuously.
          title: 'QA members-only story',
          slug: 'qa-hono-members',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'members',
          description: 'QA members-only story description',
        },
        {
          // Genuinely public and fully evidenced, but its community is
          // deactivated: withheld through the community lifecycle gate alone.
          title: 'QA inactive community story',
          slug: 'qa-hono-inactive',
          communityId: inactiveCommunity.id,
          createdBy: creatorId,
          privacyLevel: 'public',
          description: 'QA inactive community story description',
        },
        {
          // The private community's own genuinely public row: unrestricted,
          // fully evidenced by its own place and speaker inside an active
          // community. Every withholding property is absent except
          // publicStories=false, so the 404s under the private slug below
          // isolate that flag (a foreign community's story id would 404
          // there through id scoping regardless of the flag).
          title: 'QA private community story',
          slug: 'qa-hono-private',
          communityId: privateCommunityId,
          createdBy: creatorId,
          privacyLevel: 'public',
          description: 'QA private community story description',
        },
      ])
      .returning();
    // Rails-shaped lists join places and speakers, so the public story stays
    // visible. The restricted place is evidenced by a public story too, so
    // its 404 is the restricted flag alone; the unassociated place has no
    // edge and is hidden by the §6.4a association rule alone.
    // #186: every join row carries the story's (and target's) community.
    await db.insert(storyPlaces).values([
      { communityId, storyId: publicStory.id, placeId: publicPlace.id },
      { communityId, storyId: restrictedStory.id, placeId: publicPlace.id },
      { communityId, storyId: unknownStory.id, placeId: publicPlace.id },
      {
        communityId: foreignCommunityId,
        storyId: foreignStory.id,
        placeId: foreignPlace.id,
      },
      { communityId, storyId: publicStory.id, placeId: restrictedPlace.id },
      // Distinct edge (#191): no visible story evidences membersPlace.
      { communityId, storyId: membersStory.id, placeId: membersPlace.id },
      {
        communityId: inactiveCommunity.id,
        storyId: inactiveStory.id,
        placeId: inactivePlace.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privateStory.id,
        placeId: privatePlace.id,
      },
    ]);
    await db.insert(storySpeakers).values([
      { communityId, storyId: publicStory.id, speakerId: speaker.id },
      { communityId, storyId: restrictedStory.id, speakerId: speaker.id },
      { communityId, storyId: unknownStory.id, speakerId: speaker.id },
      {
        communityId: foreignCommunityId,
        storyId: foreignStory.id,
        speakerId: foreignSpeaker.id,
      },
      // Distinct edge (#191): no visible story evidences membersSpeaker.
      { communityId, storyId: membersStory.id, speakerId: membersSpeaker.id },
      {
        communityId: inactiveCommunity.id,
        storyId: inactiveStory.id,
        speakerId: inactiveSpeaker.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privateStory.id,
        speakerId: privateSpeaker.id,
      },
    ]);
    // The runner hands checks the response body only; the handler tracks the
    // live ts_session cookie value (most recent non-empty Set-Cookie) so
    // auth body checks can prove the token itself never leaks into a body.
    let sessionCookieValue = '';
    const liveSessionCookie = () => sessionCookieValue;
    const observeResponseCookies = (response: Response) => {
      for (const setCookie of response.headers.getSetCookie()) {
        const setting = setCookie.split(';')[0].trim();
        if (setting.startsWith('ts_session=') && setting !== 'ts_session=')
          sessionCookieValue = setting.slice('ts_session='.length);
      }
    };
    let handler: Handler;
    let routes: Endpoint[];
    if (backend) {
      // The backend states its coverage table; the fixture does not infer
      // one from `backend` presence. Only Workers/workerd runs the served
      // app out of process (its `app.routes` cannot be read from Node) and
      // passes the honoPersonaRouteTable() reconstruction; an in-process
      // backend passes routeTableOf of the app it actually serves.
      routes = backend.routes;
      handler = backend.handler(observeResponseCookies);
    } else {
      const app = createHonoApp({
        repository: new HonoFoundationRepository(db),
        verifier: nodePasswordVerifier,
        secureCookies: false,
        storage: { read: async (key) => storage.get(key) ?? null },
      });
      // Coverage comes from the app this fixture actually serves — the
      // default SQLite run and the in-process PostgreSQL run alike (see
      // routeTableOf for the filtering).
      routes = routeTableOf(app);
      handler = async (request) => {
        const response = await app.fetch(request);
        observeResponseCookies(response);
        return response;
      };
    }
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
    /**
     * #180 regression: the story shapes docs/EXPLORE-ADAPTER.md fixes are
     * asserted as exact key sets — a route that serializes a story as `{}`,
     * drops a documented field or adds an undocumented one fails here.
     */
    const STORY_LIST_ROW_KEYS = [
      'createdAt',
      'desc',
      'id',
      'language',
      'title',
      'topic',
      'updatedAt',
    ];
    const STORY_DETAIL_KEYS = [
      'desc',
      'id',
      'language',
      'media',
      'places',
      'points',
      'speakers',
      'title',
      'topic',
    ];
    const STORY_SPEAKER_KEYS = ['birthdate', 'id', 'name', 'speakerCommunity'];
    const STORY_PLACE_KEYS = [
      'center',
      'description',
      'id',
      'name',
      'photoUrl',
      'placenameAudio',
      'region',
      'typeOfPlace',
    ];
    const POINT_FEATURE_KEYS = ['geometry', 'id', 'properties', 'type'];
    const keysExactly = (value: unknown, expected: string[]): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      return (
        JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...expected].sort())
      );
    };
    // A missing or non-array data.stories resolves to undefined so the id
    // check fails on a malformed response instead of throwing.
    const storyRows = (
      body: unknown
    ): ({ id?: number } & Record<string, unknown>)[] | undefined => {
      const stories = (body as { data?: { stories?: unknown } }).data?.stories;
      return Array.isArray(stories)
        ? (stories as ({ id?: number } & Record<string, unknown>)[])
        : undefined;
    };
    /**
     * #180 list contract: every row carries exactly the documented key set
     * with populated timestamp/language strings, and the seeded row carries
     * its title and description — never an empty object.
     */
    const storyListCarries = (
      rows: ({ id?: number } & Record<string, unknown>)[] | undefined,
      populated: { id: number; title: string; desc: string }
    ): boolean => {
      const list = rows ?? [];
      return (
        list.every(
          (row) =>
            keysExactly(row, STORY_LIST_ROW_KEYS) &&
            typeof row.createdAt === 'string' &&
            typeof row.language === 'string'
        ) &&
        list.some(
          (row) =>
            row.id === populated.id &&
            row.title === populated.title &&
            row.desc === populated.desc
        )
      );
    };
    // The list gate is shared by the anonymous and session'd journeys: the
    // response carries exactly the public story — same row, same order,
    // nothing extra, so any unexpected row fails, and each withheld fixture
    // fails exactly one condition (restriction, missing edges, unknown
    // privacy, members-only audience, community). meta.total counts the same
    // relation, so a leaked row or an inflated filter probe fails too.
    const storiesListCheck = (body: unknown): boolean =>
      idsExactlyAsSet(storyRows(body), [publicStory.id]) &&
      storyListCarries(storyRows(body), {
        id: publicStory.id,
        title: 'QA public story',
        desc: 'QA public story description',
      }) &&
      (body as { meta?: { total?: number } }).meta?.total === 1;
    /**
     * Story detail must embed exactly the visible relations: places carries
     * only unrestricted same-community places (the restricted place the
     * public story evidences stays out), speakers only active same-community
     * speakers, and points mirrors the same rows as places. #180: the
     * documented fields are asserted as exact key sets and the seeded
     * title/description populated — never `{}`.
     */
    const storyDetailCheck =
      (
        storyId: number,
        placeIds: number[],
        speakerIds: number[],
        populated: { title: string; desc: string }
      ) =>
      (body: unknown): boolean => {
        const data = (
          body as {
            data?: {
              id?: number;
              title?: unknown;
              desc?: unknown;
              topic?: unknown;
              media?: unknown;
              places?: ({ id?: number } & Record<string, unknown>)[];
              speakers?: ({ id?: number } & Record<string, unknown>)[];
              points?: ({ id?: number } & Record<string, unknown>)[];
            };
          }
        ).data;
        return (
          data?.id === storyId &&
          data?.title === populated.title &&
          data?.desc === populated.desc &&
          data?.topic === null &&
          Array.isArray(data?.media) &&
          data.media.length === 0 &&
          keysExactly(data, STORY_DETAIL_KEYS) &&
          idsExactlyAsSet(data?.places, placeIds) &&
          idsExactlyAsSet(data?.speakers, speakerIds) &&
          idsExactlyAsSet(data?.points, placeIds) &&
          (data?.speakers ?? []).every((row) =>
            keysExactly(row, STORY_SPEAKER_KEYS)
          ) &&
          (data?.places ?? []).every((row) =>
            keysExactly(row, STORY_PLACE_KEYS)
          ) &&
          (data?.points ?? []).every((row) =>
            keysExactly(row, POINT_FEATURE_KEYS)
          )
        );
      };
    // Shared by the anonymous and session'd journeys so both assert the same
    // exact projection: one visible place, one visible speaker.
    const publicStoryDetailCheck = storyDetailCheck(
      publicStory.id,
      [publicPlace.id],
      [speaker.id],
      { title: 'QA public story', desc: 'QA public story description' }
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
          JSON.stringify([communitySlug, foreignCommunitySlug].sort()) &&
        // #191: the exact set above already fails on any leak; this names the
        // deactivated-but-public community so the lifecycle-gate claim maps
        // to an assertion that mentions its fixture.
        !slugs.includes(inactiveCommunity.slug)
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
      const text = JSON.stringify(body) ?? '';
      // Null-safe read: a missing or non-string displayImage fails the check
      // below instead of throwing.
      const displayImage = (
        body as { data?: { details?: { displayImage?: unknown } } }
      ).data?.details?.displayImage;
      return (
        projection &&
        typeof displayImage === 'string' &&
        displayImage.endsWith(`/explore/media/${readableFileId}`) &&
        !text.includes(String(restrictedFileId)) &&
        // #191: the members-only story's own edges stay out even as filter
        // labels — the id-level leak is already pinned by the exact sets in
        // the projection above; this catches a serializer naming the rows.
        !text.includes('QA members-only place') &&
        !text.includes('QA members-only speaker')
      );
    };
    /**
     * §6.4a derivation (#190): expected outcome for the ANONYMOUS column
     * of one row — Explore is a public surface (#162), so every caller,
     * anonymous or any session, reads that column and none is ever the
     * record owner. Derived from src/policy/read-rules.ts (the
     * machine-readable §6.4a table) so spec and expectations cannot
     * drift. The privacyEvidence argument is REQUIRED: it carries the
     * row's #162 evidence (restricted / unevidenced / clear), so no call
     * site can inherit the permissive 'clear' as a silent default.
     */
    const exploreAnonymousOutcome = (
      resource: 'place' | 'story',
      association: string,
      privacyEvidence: ReadRulePrivacyEvidence
    ): ReadRuleOutcome =>
      readRuleOutcome({
        resource,
        association,
        viewer: 'anonymous-public',
        privacyEvidence,
        viewerIsOwner: false,
      });

    const exploreStatusOf = (outcome: ReadRuleOutcome): number =>
      outcome === 'hidden' ? 404 : 200;

    /** Place-row status derivation; the evidence argument is required. */
    const explorePlaceStatus = (
      association:
        | 'via-readable-story'
        | 'story-less'
        | 'via-unreadable-stories-only',
      privacyEvidence: ReadRulePrivacyEvidence
    ): number =>
      exploreStatusOf(
        exploreAnonymousOutcome('place', association, privacyEvidence)
      );

    /**
     * #162 regression guard, two-sided. The gated leg alone is a
     * constant: readRuleOutcome returns the #162 override outcome before
     * the table is consulted, so with restricted or unevidenced evidence
     * EVERY association of every table derives 404 and a one-sided pin
     * could not see a widened cell. Each pinned case therefore asserts
     * both legs against the literal maintainer ruling: the anonymous
     * CELL with clear evidence ('visible' for the public-audience story
     * row, 'with-readable-stories' for the readable-story place row) AND
     * the literal hidden outcome — 404 on the wire — under the row's
     * non-clear evidence. A widened or detached cell, a wrong evidence
     * label and a weakened override all fail here instead of the journey
     * silently expecting the wider status.
     */
    const pinnedExploreStatus = (
      resource: 'place' | 'story',
      association: string,
      cellOutcome: ReadRuleOutcome,
      gatedEvidence: ReadRulePrivacyEvidence,
      name: string
    ): number => {
      const cell = exploreAnonymousOutcome(resource, association, 'clear');
      const gated = exploreAnonymousOutcome(
        resource,
        association,
        gatedEvidence
      );
      if (cell !== cellOutcome || gated !== 'hidden') {
        throw new Error(
          `§6.4a/#162 guard on '${name}': the ${resource}/${association} anonymous cell is '${cell}' with clear evidence (the ruling pins '${cellOutcome}') and '${gated}' with '${gatedEvidence}' evidence (the ruling pins 'hidden')`
        );
      }
      return 404;
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
        // restricted, unknown-privacy, members-only (#191: V1 leaked
        // members-only content) and foreign stories stay out of the count,
        // the points and the place/speaker filter options.
        check: ownCommunityDetailCheck,
      },
      {
        name: 'hide private community',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}`,
        expected: 404,
      },
      {
        // #191 explicit publicStories=false surface: the private community
        // (publicStories false, isActive true) 404s on every Explore path
        // under its slug — including its OWN fully publishable rows (the
        // story and place below), so the 404s prove the publication flag,
        // not cross-community id scoping.
        name: 'hide private community stories',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}/stories`,
        expected: 404,
      },
      {
        name: 'hide private community story',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}/stories/${privateStory.id}`,
        expected: 404,
      },
      {
        name: 'hide private community place',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}/places/${privatePlace.id}`,
        expected: 404,
      },
      {
        // #191 fail-closed lifecycle gate: the community is publicStories
        // true but isActive false, so every surface under its slug 404s —
        // detail, stories, its own fully evidenced public story, its place
        // and (below) its unrestricted branding media.
        name: 'hide inactive community detail',
        method: 'GET',
        path: `/explore/communities/${inactiveCommunity.slug}`,
        expected: 404,
      },
      {
        name: 'hide inactive community stories',
        method: 'GET',
        path: `/explore/communities/${inactiveCommunity.slug}/stories`,
        expected: 404,
      },
      {
        name: 'hide inactive community story',
        method: 'GET',
        path: `/explore/communities/${inactiveCommunity.slug}/stories/${inactiveStory.id}`,
        expected: 404,
      },
      {
        name: 'hide inactive community place',
        method: 'GET',
        path: `/explore/communities/${inactiveCommunity.slug}/places/${inactivePlace.id}`,
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
        // so an unexpected row here fails like anywhere else, and it carries
        // the documented #180 row shape.
        name: 'explore foreign stories list',
        method: 'GET',
        path: `/explore/communities/${foreignCommunitySlug}/stories`,
        expected: 200,
        check: (body) =>
          idsExactlyAsSet(storyRows(body), [foreignStory.id]) &&
          storyListCarries(storyRows(body), {
            id: foreignStory.id,
            title: 'QA foreign story',
            desc: 'QA foreign story description',
          }) &&
          (body as { meta?: { total?: number } }).meta?.total === 1,
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
        // public story. #162 case, pinned two-sided: the anonymous cell
        // of the audience-public row with clear evidence ('visible') AND
        // the literal 404 under the restricted evidence.
        name: 'hide restricted story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${restrictedStory.id}`,
        expected: pinnedExploreStatus(
          'story',
          'audience-public',
          'visible',
          'restricted',
          'hide restricted story'
        ),
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
        // public story. #162 case, pinned two-sided: the anonymous cell
        // of the audience-public row with clear evidence ('visible') AND
        // the literal 404 under the unevidenced evidence.
        name: 'hide unknown-privacy story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${unknownStory.id}`,
        expected: pinnedExploreStatus(
          'story',
          'audience-public',
          'visible',
          'unevidenced',
          'hide unknown-privacy story'
        ),
      },
      {
        // #191: hidden by the privacy gate alone — privacyLevel 'members'
        // while fully evidenced through its own distinct edges. V1's story
        // service checked isRestricted but not privacyLevel and returned
        // members-only stories by id; option A (#162) keeps members-only
        // content off the public Explore surface for every persona.
        name: 'hide members-only story',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${membersStory.id}`,
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
        // embeds only its own place and its own speaker, with the #180
        // documented key sets and populated title/description.
        check: storyDetailCheck(
          foreignStory.id,
          [foreignPlace.id],
          [foreignSpeaker.id],
          { title: 'QA foreign story', desc: 'QA foreign story description' }
        ),
      },
      {
        // Place show embeds no story collection (checked against the service:
        // the Rails-shaped place card carries only its own point), so the
        // exact assertion pins the single embedded point to the place itself.
        name: 'explore place detail',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${publicPlace.id}`,
        // §6.4a cell: anonymous × place via a readable story.
        expected: explorePlaceStatus('via-readable-story', 'clear'),
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
        // §6.4a: the #162 override hides the readable-story cell. #162
        // case, pinned two-sided: the anonymous cell with clear evidence
        // ('with-readable-stories') AND the literal 404 under the
        // restricted evidence.
        name: 'hide restricted place',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${restrictedPlace.id}`,
        expected: pinnedExploreStatus(
          'place',
          'via-readable-story',
          'with-readable-stories',
          'restricted',
          'hide restricted place'
        ),
      },
      {
        // Hidden by the §6.4a association rule alone: unrestricted, valid
        // coordinates, same public community, but no story edge.
        name: 'hide unassociated place',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${unassociatedPlace.id}`,
        expected: explorePlaceStatus('story-less', 'clear'),
      },
      {
        // #191/§6.4a: the members-only place is unrestricted with valid
        // coordinates in the public community, but its only association is
        // the members-only story — with that story hidden, the place is
        // unreachable and 404s exactly like the unassociated place.
        name: 'hide members-only story place',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${membersPlace.id}`,
        expected: explorePlaceStatus('via-unreadable-stories-only', 'clear'),
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
        // §6.4a cell: anonymous × place via a readable story.
        expected: explorePlaceStatus('via-readable-story', 'clear'),
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
        // #191: hidden by the community lifecycle gate alone — unrestricted
        // branding in a community that is publicStories true but isActive
        // false.
        name: 'hide inactive community branding media',
        method: 'GET',
        path: `/explore/media/${inactiveFileId}`,
        expected: 404,
      },
      {
        name: 'reject malformed media id',
        method: 'GET',
        path: '/explore/media/not-a-uuid',
        expected: 404,
      },
    ];
    // Explore is anonymous-public (#162): with a session cookie, member,
    // editor, community admin and super_admin must see exactly the same
    // projection — every caller stays on the anonymous column — the
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
        // #162 case, pinned two-sided (see the guard above): the
        // audience-public anonymous cell AND the literal 404 under the
        // restricted evidence.
        name: 'hide restricted story while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${restrictedStory.id}`,
        expected: pinnedExploreStatus(
          'story',
          'audience-public',
          'visible',
          'restricted',
          'hide restricted story while authenticated'
        ),
      },
      {
        // #162 case, pinned two-sided (see the guard above): the
        // audience-public anonymous cell AND the literal 404 under the
        // unevidenced evidence.
        name: 'hide unknown-privacy story while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${unknownStory.id}`,
        expected: pinnedExploreStatus(
          'story',
          'audience-public',
          'visible',
          'unevidenced',
          'hide unknown-privacy story while authenticated'
        ),
      },
      {
        // #191 option A: a session never widens the public surface — the
        // members-only story stays 404 even for privileged personas.
        name: 'hide members-only story while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/${membersStory.id}`,
        expected: 404,
      },
      {
        // #191: the lifecycle gate holds for authenticated callers too; the
        // story is public and fully evidenced but its community is inactive.
        name: 'hide inactive community story while authenticated',
        method: 'GET',
        path: `/explore/communities/${inactiveCommunity.slug}/stories/${inactiveStory.id}`,
        expected: 404,
      },
      {
        // #162 case, pinned two-sided (see the guard above): the same
        // anonymous cell — Explore is a public surface no session widens
        // — AND the literal 404 under the restricted evidence.
        name: 'hide restricted place while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${restrictedPlace.id}`,
        expected: pinnedExploreStatus(
          'place',
          'via-readable-story',
          'with-readable-stories',
          'restricted',
          'hide restricted place while authenticated'
        ),
      },
      {
        // #162: Explore is a public surface — a session never moves the
        // caller off the anonymous column, so the story-less cell 404s.
        name: 'hide unassociated place while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${unassociatedPlace.id}`,
        expected: explorePlaceStatus('story-less', 'clear'),
      },
      {
        // #191/#162: the members-only story's own place stays unreachable
        // for authenticated personas too — Explore keeps every caller on
        // the anonymous column; privilege never widens §6.4a.
        name: 'hide members-only story place while authenticated',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/places/${membersPlace.id}`,
        expected: explorePlaceStatus('via-unreadable-stories-only', 'clear'),
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
          // #191 option A across the full claimed matrix: member — the
          // persona whose canonical role would grant the community audience —
          // joins editor and community admin in driving the authenticated
          // Explore steps, so the stories list (exact ids), community detail
          // (counts/points/filters) and the members-only 404 hold for every
          // role the README names, each while authenticated.
          ...(role === 'member' || role === 'editor' || role === 'admin'
            ? exploreWithSession
            : []),
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
        if (backend) await backend.close();
        else await qa!.close();
      },
    };
  } catch (error) {
    if (backend) await backend.close();
    else await qa!.close();
    throw error;
  }
}
