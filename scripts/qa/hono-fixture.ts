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
 * app.all) fails coverage until a journey reaches it. Supports both the
 * default in-process `app.fetch` handler and `{ transport: 'http' }` (serving
 * the same app via `@hono/node-server` on `127.0.0.1` port 0); refuses
 * external `--base-url` because its isolated database cannot seed a remote
 * server.
 */
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { hash } from 'bcrypt';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { toBase64Url, toHex } from '../../src/shared/auth-crypto.js';
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
import {
  deriveTopicNormalized,
  deriveUserIdentityColumns,
} from '../../src/shared/utils/derived-columns.js';
import {
  PUBLIC_COMMUNITY_FILTER_CATEGORIES,
  PublicCommunitiesListResponseSchema,
  PublicCommunityDetailResponseSchema,
} from '../../src/shared/schemas/public-communities.js';
import {
  MAX_PUBLIC_FILTER_VALUES,
  MAX_PUBLIC_TOTAL_FILTER_VALUES,
  PublicPlaceDetailResponseSchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakersListResponseSchema,
  PublicStoriesListResponseSchema,
  PublicStoryDetailResponseSchema,
} from '../../src/shared/schemas/public-content.js';
import {
  CommunityMapConfigResponseSchema,
  CommunityReadDetailResponseSchema,
  CommunityStoriesListResponseSchema,
  CommunityStoryDetailResponseSchema,
} from '../../src/shared/schemas/community-reads.js';
import {
  PutCommunityMapConfigResponseSchema,
  V2ValidationErrorResponseSchema,
} from '../../src/shared/schemas/community-writes.js';
import {
  ExternalMediaLinksListResponseSchema,
  ExternalMediaLinkWriteResponseSchema,
  StoryWriteResponseSchema,
} from '../../src/shared/schemas/story-writes.js';
import {
  AttachmentListResponseSchema,
  AttachmentResponseSchema,
  MediaMetadataResponseSchema,
  MediaUploadResponseSchema,
} from '../../src/shared/schemas/media-v2.js';
import { DESCRIPTION_MAX_LENGTH } from '../../src/shared/utils/safe-description.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
  AUTH_THROTTLE_MAX_FAILURES,
  RAILS_BCRYPT_ALGORITHM,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import type { Endpoint, Handler, Journey, Step } from './runner.js';

type Role = 'viewer' | 'member' | 'editor' | 'admin' | 'super_admin';

/** The public projection login and profile-update responses may ever return. */
const publicUserKeys = 'communityId,displayName,email,id,role,username';
/** The /v2/auth/me projection adds the recovery-code confirmation flag. */
const meUserKeys =
  'communityId,displayName,email,id,recoveryCodesConfirmed,role,username';

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
  (
    email: string,
    role: Role,
    cookieValue: () => string,
    expectedCommunityId?: number | null
  ) =>
  (body: unknown): boolean => {
    const user = (body as { user?: Record<string, unknown> }).user;
    return (
      !!user &&
      Object.keys(user).sort().join(',') === publicUserKeys &&
      user.email === email &&
      user.role === role &&
      typeof user.id === 'number' &&
      (user.username === null || typeof user.username === 'string') &&
      (user.displayName === null || typeof user.displayName === 'string') &&
      (expectedCommunityId === undefined ||
        user.communityId === expectedCommunityId) &&
      !leaksSecret(body, cookieValue)
    );
  };

const ownMeUser =
  (
    email: string,
    role: Role,
    cookieValue: () => string,
    expectedCommunityId?: number | null,
    expectedRecoveryCodesConfirmed?: boolean
  ) =>
  (body: unknown): boolean => {
    const user = (body as { user?: Record<string, unknown> }).user;
    return (
      !!user &&
      Object.keys(user).sort().join(',') === meUserKeys &&
      user.email === email &&
      user.role === role &&
      typeof user.id === 'number' &&
      (user.username === null || typeof user.username === 'string') &&
      (user.displayName === null || typeof user.displayName === 'string') &&
      typeof user.recoveryCodesConfirmed === 'boolean' &&
      (expectedRecoveryCodesConfirmed === undefined ||
        user.recoveryCodesConfirmed === expectedRecoveryCodesConfirmed) &&
      (expectedCommunityId === undefined ||
        user.communityId === expectedCommunityId) &&
      !leaksSecret(body, cookieValue)
    );
  };

/**
 * The shared persona identity material: every backend seeds the same
 * Argon2id verifier, so the journeys and their expectations stay
 * byte-identical across SQLite, PostgreSQL and Workers. No password crosses
 * the wire — journeys present `derivedKey` exactly as the browser would
 * (SPEC-V2 §7).
 */
export const HONO_PERSONA_DERIVED_KEY = toHex(
  crypto.getRandomValues(new Uint8Array(32))
);

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
  'QA members-only topic',
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
  'QA members-only affiliation',
  'QA storyless speaker',
  'QA withdrawn speaker',
  'QA community story',
  'QA community story description',
  'QA community topic',
  'QA community story place',
  'QA community story speaker',
  'QA community affiliation',
  'QA restricted birthplace speaker',
  'QA editors story',
  'QA editors story description',
  'QA editors story place',
  'QA editors story speaker',
  'QA private member story',
  'QA private member story description',
  'QA private editors story',
  'QA private editors story description',
  'QA private restricted story',
  'QA private unknown-privacy story',
  'QA private community-level place',
  'QA private editors place',
  'QA private storyless place',
  'QA private restricted place',
  'QA private community-level speaker',
  'QA private editors speaker',
  'QA private storyless speaker',
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
  /**
   * Runtime HMAC key for prelogin/login throttling (AUTH_SERVER_SECRET),
   * shared with the served app. Every backend builds its own; never a literal.
   */
  serverSecret: string;
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
    storage: {
      async read() {
        return null;
      },
    },
  });
  return routeTableOf(app);
}

export interface ClosableHttpServer {
  listening?: boolean;
  closeIdleConnections?: () => void;
  close: (callback?: (error?: Error) => void) => unknown;
}

/**
 * Close an HTTP persona server without masking setup errors when the server
 * never started listening or is already stopped.
 */
export async function closeServer(
  activeServer: ClosableHttpServer | undefined
): Promise<void> {
  if (!activeServer || !activeServer.listening) return;
  // Close idle keep-alive sockets so Node fetch keep-alive does not
  // delay server.close().
  activeServer.closeIdleConnections?.();
  await new Promise<void>((resolve, reject) =>
    activeServer.close((error) => {
      if (
        !error ||
        (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
      ) {
        resolve();
      } else {
        reject(error);
      }
    })
  );
}

export async function createFixture(
  options: {
    baseUrl?: string;
    backend?: HonoQaBackend;
    transport?: 'in-process' | 'http';
  } = {}
) {
  if (options.baseUrl)
    throw new Error(
      'In-process persona fixtures support isolated in-process runs only'
    );
  const transport = options.transport ?? 'in-process';
  if (options.backend && transport === 'http')
    throw new Error('HTTP transport cannot be combined with a custom backend');
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
    attachments,
    auditEntries,
    communities,
    communityMapConfigs,
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
  let server: ReturnType<typeof serve> | undefined;
  const closeActiveServer = async () => {
    const activeServer = server;
    server = undefined;
    await closeServer(activeServer);
  };
  try {
    const fixtures = await (backend ? backend.seedBaseline() : qa!.seed());
    // Public active community for Explore; Demo community stays private.
    const communityId = fixtures.communities[0].id;
    const communitySlug = fixtures.communities[0].slug;
    const privateCommunityId = fixtures.communities[1].id;
    const privateCommunitySlug = fixtures.communities[1].slug;
    const privateCommunityName = fixtures.communities[1].name;
    const qaCredentialKey = ['access', 'token'].join('_');
    const qaCredentialVal = ['tok', 'qa', 'check'].join('.');
    const qaSecretDescMarker = 'QA_SECRET_DESC_DO_NOT_ECHO';
    // A second PUBLIC community owns the foreign fixtures: its rows are
    // publishable, so a 404 elsewhere is community scoping alone, and its
    // own Explore surface serves as the positive control.
    const foreignCommunityId = fixtures.communities[2].id;
    const foreignCommunitySlug = fixtures.communities[2].slug;
    // Client-stretching (SPEC-V2 §7): every backend seeds the same Argon2id
    // verifier — the journeys present the derived key and only that derived
    // key ever crosses the wire. `password_hash` stays as the NOT NULL legacy
    // anchor the session write re-reads for authority; it is never verified,
    // so a runtime bcrypt hash of a random value is enough.
    const passwordHash = await hash(
      toHex(crypto.getRandomValues(new Uint8Array(16))),
      4
    );
    const derivedKey = HONO_PERSONA_DERIVED_KEY;
    // The replacement verifier material for the password-change steps:
    // generated at runtime and shared by the change request and the follow-up
    // login so both agree on every backend.
    const superAdminNewKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const verifierSalt = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    const verifier = {
      passwordHash,
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: verifierSalt,
      passwordParams: ARGON2ID_PARAMS_JSON,
      passwordVerifier: await sha256Hex(derivedKey),
    };
    // The wire body of a login journey (identical shape for every backend).
    const loginBody = (email: string) => ({ identifier: email, derivedKey });
    const credentials: Record<Role, { email: string }> = {
      viewer: { email: 'qa-hono-viewer@example.test' },
      member: { email: 'qa-hono-member@example.test' },
      editor: { email: 'qa-hono-editor@example.test' },
      admin: { email: 'qa-hono-admin@example.test' },
      super_admin: { email: 'qa-hono-super@example.test' },
    };
    // The schema enum predates the V2 member role; the raw binding stores it.
    // Canonical V2 super_admin carries null communityId (§6.2).
    let creatorId = 0;
    const communityUserIds: Partial<Record<Role, number>> = {};
    for (const role of Object.keys(credentials) as Role[]) {
      // Every persona carries a stable username so the username-identifier
      // login journey resolves exactly one account (§6.2). Usernames are
      // globally unique; the normalized column is derived with the email.
      const username = `qa_hono_${role}`;
      const displayName = role === 'super_admin' ? 'QA Super Admin' : 'QA Hono';
      const [user] = await db
        .insert(users)
        .values({
          email: credentials[role].email,
          username,
          displayName,
          ...deriveUserIdentityColumns({
            email: credentials[role].email,
            username,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: 'Hono',
          role: sql`${role}`,
          communityId: role === 'super_admin' ? null : communityId,
          isActive: true,
        })
        .returning();
      if (role === 'admin') creatorId = user.id;
      communityUserIds[role] = user.id;
    }
    // Legacy V1 elder role in the active community: V2 boundary must reject
    // login with the same uniform 401 failure (SPEC-V2 §6.2).
    const elderCredentials = { email: 'qa-hono-elder@example.test' };
    await db.insert(users).values({
      email: elderCredentials.email,
      ...deriveUserIdentityColumns({ email: elderCredentials.email }),
      ...verifier,
      firstName: 'QA',
      lastName: 'Elder',
      role: sql`${'elder'}`,
      communityId,
      isActive: true,
    });
    // A viewer of the foreign public community: proves the foreign media
    // fixture is servable to its own community on /v2/media, so the 404 for
    // community personas is attributable to community scoping.
    const foreignViewerCredentials = {
      email: 'qa-hono-foreign-viewer@example.test',
    };
    // Same raw role binding as the loop above (the schema enum predates the
    // V2 member role); the interpolated value binds as a string parameter.
    const foreignViewerRole: Role = 'viewer';
    await db
      .insert(users)
      .values({
        email: foreignViewerCredentials.email,
        ...deriveUserIdentityColumns({ email: foreignViewerCredentials.email }),
        ...verifier,
        firstName: 'QA',
        lastName: 'Hono',
        role: sql`${foreignViewerRole}`,
        communityId: foreignCommunityId,
        isActive: true,
      })
      .returning();
    // #137 Slice 10: an email shared by accounts in two communities. Login
    // must refuse to pick one: without a `communitySlug` the answer is the
    // uniform 401, and with the locator it resolves the named community's
    // account (SPEC-V2 §6.2).
    // #137 Slice 10 (finding 1): a wrapped Rails-bcrypt account. The client
    // recomputes bcrypt with the stored salt and cost and sends the hash
    // string as `derivedKey`; the stored verifier is SHA-256 of that real
    // hash, and the first successful login upgrades it to Argon2id atomically.
    const wrappedPasswordHash = await hash(
      toHex(crypto.getRandomValues(new Uint8Array(24))),
      10
    );
    const wrappedCredentials = { email: 'qa-hono-wrapped@example.test' };
    await db.insert(users).values({
      email: wrappedCredentials.email,
      username: 'qa_hono_wrapped',
      ...deriveUserIdentityColumns({
        email: wrappedCredentials.email,
        username: 'qa_hono_wrapped',
      }),
      firstName: 'QA',
      lastName: 'Wrapped',
      role: 'viewer',
      communityId,
      isActive: true,
      passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
      passwordSalt: wrappedPasswordHash.slice(7, 29),
      passwordParams: JSON.stringify({
        cost: Number(wrappedPasswordHash.slice(4, 6)),
      }),
      passwordVerifier: await sha256Hex(wrappedPasswordHash),
      passwordHash,
    });
    // #137 Slice 10 (finding H): an account whose per-account counter is
    // driven to the block threshold by the journey below.
    const throttledCredentials = { email: 'qa-hono-throttled@example.test' };
    const throttledIp = '203.0.113.42';
    await db.insert(users).values({
      email: throttledCredentials.email,
      username: 'qa_hono_throttled',
      ...deriveUserIdentityColumns({
        email: throttledCredentials.email,
        username: 'qa_hono_throttled',
      }),
      ...verifier,
      firstName: 'QA',
      lastName: 'Throttled',
      role: 'viewer',
      communityId,
      isActive: true,
    });
    const qaSharedEmail = 'qa-hono-shared@example.test';
    await db.insert(users).values([
      {
        email: qaSharedEmail,
        ...deriveUserIdentityColumns({ email: qaSharedEmail }),
        ...verifier,
        firstName: 'QA',
        lastName: 'SharedAlpha',
        role: 'viewer',
        communityId,
        isActive: true,
      },
      {
        email: qaSharedEmail,
        ...deriveUserIdentityColumns({ email: qaSharedEmail }),
        ...verifier,
        firstName: 'QA',
        lastName: 'SharedBeta',
        role: 'viewer',
        communityId: foreignCommunityId,
        isActive: true,
      },
    ]);
    type CommunityRole = 'viewer' | 'member' | 'editor' | 'admin';
    const privateCredentials: Record<CommunityRole, { email: string }> = {
      viewer: { email: 'qa-hono-priv-viewer@example.test' },
      member: { email: 'qa-hono-priv-member@example.test' },
      editor: { email: 'qa-hono-priv-editor@example.test' },
      admin: { email: 'qa-hono-priv-admin@example.test' },
    };
    let privateCreatorId = creatorId;
    for (const role of Object.keys(privateCredentials) as CommunityRole[]) {
      const [privUser] = await db
        .insert(users)
        .values({
          email: privateCredentials[role].email,
          ...deriveUserIdentityColumns({
            email: privateCredentials[role].email,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: `Priv${role}`,
          role: sql`${role}`,
          communityId: privateCommunityId,
          isActive: true,
        })
        .returning();
      if (role === 'admin') privateCreatorId = privUser.id;
    }
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
    const sponsorLogoFileId = crypto.randomUUID();
    const sponsorLogoPath = `communities/${communityId}/${sponsorLogoFileId}.png`;
    await db.insert(files).values({
      id: sponsorLogoFileId,
      filename: `${sponsorLogoFileId}.png`,
      originalName: 'qa-sponsor-logo.png',
      path: sponsorLogoPath,
      url: `/v2/media/${sponsorLogoFileId}`,
      mimeType: 'image/png',
      size: mediaBytes.length,
      uploadedBy: creatorId,
      communityId,
      culturalRestrictions: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(attachments).values({
      communityId,
      fileId: sponsorLogoFileId,
      ownerType: 'community',
      ownerId: communityId,
      role: 'sponsor_logo',
      ordinal: 0,
      createdAt: new Date(),
    });
    await putMedia(sponsorLogoPath, mediaBytes);
    const mapConfigTimestamp = new Date();
    await db.insert(communityMapConfigs).values({
      communityId,
      styleUrl: 'https://tiles.example.test/style.json',
      basemapStyle: 'terrain',
      centerLatitude: -3.1,
      centerLongitude: -60.02,
      southWestLatitude: -4,
      southWestLongitude: -61,
      northEastLatitude: -2,
      northEastLongitude: -59,
      zoom: 8,
      pitch: 15,
      bearing: 0,
      threeDimensional: true,
      projection: 'mercator',
      staticMapFileId: readableFileId,
      createdAt: mapConfigTimestamp,
      updatedAt: mapConfigTimestamp,
    });
    await db.insert(communityMapConfigs).values({
      communityId: privateCommunityId,
      styleUrl: 'https://tiles.example.test/private-style.json',
      basemapStyle: 'satellite',
      centerLatitude: -3.15,
      centerLongitude: -60.15,
      southWestLatitude: -4,
      southWestLongitude: -61,
      northEastLatitude: -2,
      northEastLongitude: -59,
      zoom: 9,
      pitch: 0,
      bearing: 0,
      threeDimensional: false,
      projection: 'mercator',
      staticMapFileId: null,
      createdAt: mapConfigTimestamp,
      updatedAt: mapConfigTimestamp,
    });
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
          typeOfPlace: 'QA public place type',
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
        affiliation: 'QA members-only affiliation',
        communityId,
        isActive: true,
      })
      .returning();
    const [storylessSpeaker, withdrawnSpeaker] = await db
      .insert(speakers)
      .values([
        {
          name: 'QA storyless speaker',
          communityId,
          isActive: true,
        },
        {
          name: 'QA withdrawn speaker',
          communityId,
          isActive: false,
        },
      ])
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
    // Disabled community users (#137 Slice 3b / SPEC-V2 §6.2, §7): own-admin
    // may authenticate and reach /v2/auth/me (sovereignty surface) while
    // community-content/media reads still fail closed; viewer/member/editor
    // are rejected 401.
    const disabledAdminCredentials = {
      email: 'qa-hono-disabled-admin@example.test',
    };
    const disabledViewerCredentials = {
      email: 'qa-hono-disabled-viewer@example.test',
    };
    const disabledMemberCredentials = {
      email: 'qa-hono-disabled-member@example.test',
    };
    const disabledEditorCredentials = {
      email: 'qa-hono-disabled-editor@example.test',
    };
    const [
      disabledSeededAdmin,
      disabledSeededViewer,
      disabledSeededMember,
      disabledSeededEditor,
    ] = await db
      .insert(users)
      .values([
        {
          email: disabledAdminCredentials.email,
          username: 'qa_hono_disabled_admin',
          displayName: 'QA Disabled Admin',
          ...deriveUserIdentityColumns({
            email: disabledAdminCredentials.email,
            username: 'qa_hono_disabled_admin',
          }),
          ...verifier,
          firstName: 'QA',
          lastName: 'DisabledAdmin',
          role: 'admin',
          communityId: inactiveCommunity.id,
          isActive: true,
        },
        {
          email: disabledViewerCredentials.email,
          ...deriveUserIdentityColumns({
            email: disabledViewerCredentials.email,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: 'DisabledViewer',
          role: 'viewer',
          communityId: inactiveCommunity.id,
          isActive: true,
        },
        {
          email: disabledMemberCredentials.email,
          ...deriveUserIdentityColumns({
            email: disabledMemberCredentials.email,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: 'DisabledMember',
          role: 'member',
          communityId: inactiveCommunity.id,
          isActive: true,
        },
        {
          email: disabledEditorCredentials.email,
          ...deriveUserIdentityColumns({
            email: disabledEditorCredentials.email,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: 'DisabledEditor',
          role: 'editor',
          communityId: inactiveCommunity.id,
          isActive: true,
        },
      ])
      .returning();
    void disabledSeededAdmin;
    void disabledSeededViewer;
    void disabledSeededEditor;
    const disabledMemberId = disabledSeededMember!.id;
    // #192: one more public ACTIVE community whose name carries composed
    // diacritics, exercising the Unicode-correct Explore name search on the
    // persona gates: SQLite/D1 lower() folds ASCII only, so only the
    // application-normalized contract can match a case-variant needle. No
    // branding or stories: this fixture exists for the community list and
    // its search narrowing alone.
    const [saoCommunity] = await db
      .insert(communities)
      .values({
        name: 'QA Comunidade São João ΑΣΑ',
        description: 'Unicode-correct name search fixture (#192)',
        slug: `qa-sao-joao-${Date.now()}`,
        publicStories: true,
        isActive: true,
        // PostgreSQL deliberately has no database default for timestamps.
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
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
          language: 'qa-members-lang',
          topic: 'QA members-only topic',
          topicNormalized: deriveTopicNormalized('QA members-only topic'),
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
      { communityId, storyId: publicStory.id, speakerId: withdrawnSpeaker.id },
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
    // Slice 6 authenticated community read fixtures (SPEC-V2 §6.4a, #162):
    // kept completely disjoint from anonymous-public stories so existing Explore
    // and /v2/public/* assertions retain their exact counts/points/filters.
    const [communityPlace, editorsPlace] = await db
      .insert(places)
      .values([
        {
          name: 'QA community story place',
          communityId,
          latitude: -3.05,
          longitude: -60.05,
          region: 'Manaus',
          typeOfPlace: 'village',
        },
        {
          name: 'QA editors story place',
          communityId,
          latitude: -3.25,
          longitude: -60.25,
          region: 'Negro',
          typeOfPlace: 'sacred_grove',
        },
      ])
      .returning();
    const [communitySpeaker, restrictedBirthplaceSpeaker, editorsSpeaker] =
      await db
        .insert(speakers)
        .values([
          {
            name: 'QA community story speaker',
            affiliation: 'QA community affiliation',
            birthplaceId: communityPlace.id,
            communityId,
            isActive: true,
          },
          {
            name: 'QA restricted birthplace speaker',
            birthplaceId: restrictedPlace.id,
            communityId,
            isActive: true,
          },
          {
            name: 'QA editors story speaker',
            communityId,
            isActive: true,
          },
        ])
        .returning();
    const [communityStory, editorsStory] = await db
      .insert(stories)
      .values([
        {
          title: 'QA community story',
          slug: 'qa-hono-community',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'members_only',
          language: 'qa-community-lang',
          topic: 'QA community topic',
          topicNormalized: deriveTopicNormalized('QA community topic'),
          description: 'QA community story description',
          interviewLocationId: publicPlace.id,
          interviewerId: speaker.id,
        },
        {
          title: 'QA editors story',
          slug: 'qa-hono-editors',
          communityId,
          createdBy: creatorId,
          privacyLevel: 'editors',
          description: 'QA editors story description',
          interviewLocationId: restrictedPlace.id,
          interviewerId: withdrawnSpeaker.id,
        },
      ])
      .returning();
    await db.insert(storyPlaces).values([
      { communityId, storyId: communityStory.id, placeId: communityPlace.id },
      { communityId, storyId: editorsStory.id, placeId: editorsPlace.id },
    ]);
    await db.insert(storySpeakers).values([
      {
        communityId,
        storyId: communityStory.id,
        speakerId: communitySpeaker.id,
      },
      {
        communityId,
        storyId: communityStory.id,
        speakerId: restrictedBirthplaceSpeaker.id,
      },
      { communityId, storyId: editorsStory.id, speakerId: editorsSpeaker.id },
    ]);
    const [
      privCommunityPlace,
      privEditorsPlace,
      privStorylessPlace,
      privRestrictedPlace,
    ] = await db
      .insert(places)
      .values([
        {
          name: 'QA private community-level place',
          communityId: privateCommunityId,
          latitude: -3.1,
          longitude: -60.1,
        },
        {
          name: 'QA private editors place',
          communityId: privateCommunityId,
          latitude: -3.2,
          longitude: -60.2,
        },
        {
          name: 'QA private storyless place',
          communityId: privateCommunityId,
          latitude: -3.3,
          longitude: -60.3,
        },
        {
          name: 'QA private restricted place',
          communityId: privateCommunityId,
          latitude: -3.4,
          longitude: -60.4,
          isRestricted: true,
        },
      ])
      .returning();
    const [privCommunitySpeaker, privEditorsSpeaker, privStorylessSpeaker] =
      await db
        .insert(speakers)
        .values([
          {
            name: 'QA private community-level speaker',
            birthplaceId: privRestrictedPlace.id,
            communityId: privateCommunityId,
            isActive: true,
          },
          {
            name: 'QA private editors speaker',
            birthplaceId: privCommunityPlace.id,
            communityId: privateCommunityId,
            isActive: true,
          },
          {
            name: 'QA private storyless speaker',
            communityId: privateCommunityId,
            isActive: true,
          },
        ])
        .returning();
    const [
      privCommunityStory,
      privEditorsStory,
      privRestrictedStory,
      privUnknownStory,
    ] = await db
      .insert(stories)
      .values([
        {
          title: 'QA private member story',
          slug: 'qa-hono-priv-community',
          communityId: privateCommunityId,
          createdBy: privateCreatorId,
          privacyLevel: 'members_only',
          description: 'QA private member story description',
        },
        {
          title: 'QA private editors story',
          slug: 'qa-hono-priv-editors',
          communityId: privateCommunityId,
          createdBy: privateCreatorId,
          privacyLevel: 'editors',
          description: 'QA private editors story description',
        },
        {
          title: 'QA private restricted story',
          slug: 'qa-hono-priv-restricted',
          communityId: privateCommunityId,
          createdBy: privateCreatorId,
          privacyLevel: 'public',
          isRestricted: true,
        },
        {
          title: 'QA private unknown-privacy story',
          slug: 'qa-hono-priv-unknown',
          communityId: privateCommunityId,
          createdBy: privateCreatorId,
          privacyLevel: 'unknown',
        },
      ])
      .returning();
    await db.insert(storyPlaces).values([
      {
        communityId: privateCommunityId,
        storyId: privateStory.id,
        placeId: privRestrictedPlace.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privCommunityStory.id,
        placeId: privCommunityPlace.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privEditorsStory.id,
        placeId: privEditorsPlace.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privRestrictedStory.id,
        placeId: privatePlace.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privUnknownStory.id,
        placeId: privatePlace.id,
      },
    ]);
    await db.insert(storySpeakers).values([
      {
        communityId: privateCommunityId,
        storyId: privCommunityStory.id,
        speakerId: privCommunitySpeaker.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privEditorsStory.id,
        speakerId: privEditorsSpeaker.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privRestrictedStory.id,
        speakerId: privateSpeaker.id,
      },
      {
        communityId: privateCommunityId,
        storyId: privUnknownStory.id,
        speakerId: privateSpeaker.id,
      },
    ]);
    const attachedMediaFile = async (
      ownerType: 'story' | 'place' | 'speaker',
      ownerId: number,
      role:
        | 'story_media'
        | 'place_photo'
        | 'place_name_audio'
        | 'speaker_photo',
      mimeType: string
    ): Promise<string> => {
      const id = crypto.randomUUID();
      const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'png';
      const storagePath = `communities/${communityId}/${id}.${ext}`;
      await db.insert(files).values({
        id,
        filename: `${id}.${ext}`,
        originalName: `qa-${role}.${ext}`,
        path: storagePath,
        storageKey: storagePath,
        url: `/v2/media/${id}`,
        mimeType,
        size: mediaBytes.length,
        byteSize: mediaBytes.length,
        uploadedBy: creatorId,
        communityId,
        culturalRestrictions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(attachments).values({
        communityId,
        fileId: id,
        ownerType,
        ownerId,
        role,
        ordinal: 0,
        createdAt: new Date(),
      });
      await putMedia(storagePath, mediaBytes);
      return id;
    };
    const readableStoryMediaFileId = await attachedMediaFile(
      'story',
      publicStory.id,
      'story_media',
      'audio/mpeg'
    );
    const membersStoryMediaFileId = await attachedMediaFile(
      'story',
      membersStory.id,
      'story_media',
      'audio/mpeg'
    );
    const restrictedStoryMediaFileId = await attachedMediaFile(
      'story',
      restrictedStory.id,
      'story_media',
      'audio/mpeg'
    );
    const readablePlacePhotoFileId = await attachedMediaFile(
      'place',
      publicPlace.id,
      'place_photo',
      'image/png'
    );
    const membersPlacePhotoFileId = await attachedMediaFile(
      'place',
      membersPlace.id,
      'place_photo',
      'image/png'
    );
    const storylessPlacePhotoFileId = await attachedMediaFile(
      'place',
      unassociatedPlace.id,
      'place_photo',
      'image/png'
    );
    const restrictedPlacePhotoFileId = await attachedMediaFile(
      'place',
      restrictedPlace.id,
      'place_photo',
      'image/png'
    );
    const readablePlaceAudioFileId = await attachedMediaFile(
      'place',
      publicPlace.id,
      'place_name_audio',
      'audio/mpeg'
    );
    const membersPlaceAudioFileId = await attachedMediaFile(
      'place',
      membersPlace.id,
      'place_name_audio',
      'audio/mpeg'
    );
    const storylessPlaceAudioFileId = await attachedMediaFile(
      'place',
      unassociatedPlace.id,
      'place_name_audio',
      'audio/mpeg'
    );
    const restrictedPlaceAudioFileId = await attachedMediaFile(
      'place',
      restrictedPlace.id,
      'place_name_audio',
      'audio/mpeg'
    );
    const readableSpeakerPhotoFileId = await attachedMediaFile(
      'speaker',
      speaker.id,
      'speaker_photo',
      'image/png'
    );
    const membersSpeakerPhotoFileId = await attachedMediaFile(
      'speaker',
      membersSpeaker.id,
      'speaker_photo',
      'image/png'
    );
    const storylessSpeakerPhotoFileId = await attachedMediaFile(
      'speaker',
      storylessSpeaker.id,
      'speaker_photo',
      'image/png'
    );
    const withdrawnSpeakerPhotoFileId = await attachedMediaFile(
      'speaker',
      withdrawnSpeaker.id,
      'speaker_photo',
      'image/png'
    );
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
    let handler: Handler | undefined;
    let baseUrl: string | undefined;
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
        secureCookies: false,
        // The in-process fixture presents `cf-connecting-ip` to isolate buckets.
        trustProxy: true,
        serverSecret: toHex(crypto.getRandomValues(new Uint8Array(24))),
        storage: {
          read: async (key, range) => {
            const bytes = storage.get(key);
            if (!bytes) return null;
            return {
              body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
              size: bytes.byteLength,
            };
          },
          async put(key, stream) {
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                chunks.push(value);
                total += value.byteLength;
              }
            }
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }
            storage.set(key, merged);
          },
          async delete(key) {
            storage.delete(key);
          },
        },
      });
      // Coverage comes from the app this fixture actually serves — the
      // default SQLite run and the in-process PostgreSQL run alike (see
      // routeTableOf for the filtering).
      routes = routeTableOf(app);
      if (transport === 'http') {
        // Keep native Request identity: node-server's global override makes
        // native Request.clone() fail Hono's instanceof Request dispatch.
        server = serve({
          fetch: async (request) => {
            const response = await app.fetch(request);
            observeResponseCookies(response);
            return response;
          },
          hostname: '127.0.0.1',
          port: 0,
          overrideGlobalObjects: false,
        });
        if (!server.listening) await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Failed to bind HTTP persona server address');
        baseUrl = `http://127.0.0.1:${address.port}`;
      } else {
        handler = async (request) => {
          const response = await app.fetch(request);
          observeResponseCookies(response);
          return response;
        };
      }
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
    // exactly the seeded public communities as a slug set (the two baseline
    // communities plus the #192 diacritic-named São João community) — the
    // private demo and system communities stay absent, and any unexpected
    // row fails.
    // Set comparison (not order): the index sorts newest-update-first, and
    // the seeded rows share same-tick timestamps.
    const communitiesListCheck = (body: unknown): boolean => {
      const slugs =
        (body as { data?: { slug?: string }[] }).data?.map(
          (community) => community.slug
        ) ?? [];
      // #192: the diacritic-named São João community is a third public
      // active member of the exact set — the search steps below cannot
      // narrow anything if the base list no longer carries it.
      return (
        JSON.stringify([...slugs].sort()) ===
          JSON.stringify(
            [communitySlug, foreignCommunitySlug, saoCommunity.slug].sort()
          ) &&
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
        // #192 Unicode-correct name search: a case-variant, composed
        // diacritic needle matches the São João card. This requires
        // application-side normalization — SQLite/D1 lower() folds ASCII
        // only, so a database-side fold cannot answer it (the old
        // containsInsensitive path failed this exact needle there).
        name: 'explore communities search matches case-variant diacritic',
        method: 'GET',
        path: `/explore/communities?search=${encodeURIComponent('SÃO JOÃO')}`,
        expected: 200,
        check: (body) => {
          const rows = (body as { data?: { slug?: string; name?: string }[] })
            .data;
          return (
            Array.isArray(rows) &&
            rows.length === 1 &&
            rows[0]?.slug === saoCommunity.slug &&
            rows[0]?.name === saoCommunity.name
          );
        },
      },
      {
        // Accent sensitivity on purpose: the ASCII-only transcription (a
        // base letter without its mark) must NOT match the diacritic name,
        // so the response carries exactly zero rows.
        name: 'explore communities search rejects ASCII transcription',
        method: 'GET',
        path: `/explore/communities?search=${encodeURIComponent('sao joao')}`,
        expected: 200,
        check: (body) => {
          const rows = (body as { data?: unknown }).data;
          return Array.isArray(rows) && rows.length === 0;
        },
      },
      {
        // The publication and lifecycle gates hold under search: an exact
        // name match on a public but DEACTIVATED community must surface
        // zero rows (200), never the withheld card.
        name: 'explore communities search hides the inactive public community',
        method: 'GET',
        path: `/explore/communities?search=${encodeURIComponent(
          inactiveCommunity.name
        )}`,
        expected: 200,
        check: (body) => {
          const rows = (body as { data?: unknown }).data;
          return Array.isArray(rows) && rows.length === 0;
        },
      },
      {
        // Same for the private (publicStories=false) community: its name
        // never answers a search, even the exact name.
        name: 'explore communities search hides the private community',
        method: 'GET',
        path: `/explore/communities?search=${encodeURIComponent(
          privateCommunityName
        )}`,
        expected: 200,
        check: (body) => {
          const rows = (body as { data?: unknown }).data;
          return Array.isArray(rows) && rows.length === 0;
        },
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
    let canonicalPublicListJson = '';
    let canonicalPublicDetailJson = '';
    let canonicalPublicStoriesJson = '';
    let canonicalPublicStoryDetailJson = '';
    let canonicalPublicPlacesJson = '';
    let canonicalPublicPlaceDetailJson = '';
    let canonicalPublicSpeakersJson = '';
    let canonicalPublicSpeakerDetailJson = '';
    const publicNotFoundCheck = (body: unknown): boolean =>
      keysExactly(body, ['error']) &&
      (body as { error?: string }).error === 'Not found';
    const publicMediaHeadersCheck = (headers: Headers): boolean =>
      headers.get('Content-Disposition') === 'attachment' &&
      headers.get('Accept-Ranges') === 'bytes' &&
      headers.get('Cache-Control') === 'no-store' &&
      headers.get('X-Content-Type-Options') === 'nosniff' &&
      headers.get('Content-Security-Policy') === "default-src 'none'; sandbox";
    const publicStoriesListCheck = (body: unknown): boolean => {
      const parsed = PublicStoriesListResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      const text = JSON.stringify(body) ?? '';
      return (
        parsed.data.meta.total === 2 &&
        parsed.data.meta.hasNextPage === false &&
        parsed.data.data.stories.map((s) => s.id).join(',') ===
          `${publicStory.id},${unevidencedStory.id}` &&
        parsed.data.data.stories[0]?.places.map((p) => p.id).join(',') ===
          String(publicPlace.id) &&
        parsed.data.data.stories[0]?.speakers.map((s) => s.id).join(',') ===
          String(speaker.id) &&
        parsed.data.data.stories[1]?.places.length === 0 &&
        parsed.data.data.stories[1]?.speakers.length === 0 &&
        parsed.data.data.points.map((p) => p.id).join(',') ===
          String(publicPlace.id) &&
        !text.includes('QA restricted') &&
        !text.includes('QA unknown-privacy') &&
        !text.includes('QA members-only') &&
        !text.includes('qa-members-lang') &&
        !text.includes('QA foreign')
      );
    };
    const publicFilteredStoriesCheck = (body: unknown): boolean => {
      const parsed = PublicStoriesListResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      return (
        parsed.data.meta.total === 1 &&
        parsed.data.meta.hasNextPage === false &&
        parsed.data.data.stories.map((s) => s.id).join(',') ===
          String(publicStory.id) &&
        parsed.data.data.points.map((p) => p.id).join(',') ===
          String(publicPlace.id)
      );
    };
    const v2PublicStoryDetailCheck = (body: unknown): boolean => {
      const parsed = PublicStoryDetailResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      const text = JSON.stringify(body) ?? '';
      return (
        parsed.data.data.id === publicStory.id &&
        parsed.data.data.places.map((p) => p.id).join(',') ===
          String(publicPlace.id) &&
        parsed.data.data.speakers.map((s) => s.id).join(',') ===
          String(speaker.id) &&
        parsed.data.data.points.map((p) => p.id).join(',') ===
          String(publicPlace.id) &&
        !text.includes('QA restricted') &&
        !text.includes('QA members-only')
      );
    };
    const publicPlacesListCheck = (body: unknown): boolean => {
      const parsed = PublicPlacesListResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      const text = JSON.stringify(body) ?? '';
      return (
        parsed.data.meta.total === 1 &&
        parsed.data.data.map((p) => p.id).join(',') ===
          String(publicPlace.id) &&
        !text.includes('QA restricted') &&
        !text.includes('QA unassociated') &&
        !text.includes('QA members-only')
      );
    };
    const publicPlaceDetailCheck = (body: unknown): boolean => {
      const parsed = PublicPlaceDetailResponseSchema.safeParse(body);
      return (
        parsed.success &&
        parsed.data.data.id === publicPlace.id &&
        parsed.data.data.name === publicPlace.name
      );
    };
    const publicSpeakersListCheck = (body: unknown): boolean => {
      const parsed = PublicSpeakersListResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      const text = JSON.stringify(body) ?? '';
      return (
        parsed.data.meta.total === 1 &&
        parsed.data.data.map((s) => s.id).join(',') === String(speaker.id) &&
        !text.includes('QA members-only')
      );
    };
    const publicSpeakerDetailCheck = (body: unknown): boolean => {
      const parsed = PublicSpeakerDetailResponseSchema.safeParse(body);
      return (
        parsed.success &&
        parsed.data.data.id === speaker.id &&
        parsed.data.data.name === speaker.name
      );
    };
    const checkPublicMapConfig = (
      mapConfig: Record<string, unknown> | null | undefined
    ): boolean => {
      if (!mapConfig) return false;
      const expectedStaticUrlSuffix = `/v2/public/communities/${encodeURIComponent(communitySlug)}/media/${readableFileId}`;
      return (
        mapConfig.styleUrl === 'https://tiles.example.test/style.json' &&
        mapConfig.basemapStyle === 'terrain' &&
        mapConfig.centerLatitude === -3.1 &&
        mapConfig.centerLongitude === -60.02 &&
        mapConfig.southWestLatitude === -4 &&
        mapConfig.southWestLongitude === -61 &&
        mapConfig.northEastLatitude === -2 &&
        mapConfig.northEastLongitude === -59 &&
        mapConfig.zoom === 8 &&
        mapConfig.pitch === 15 &&
        mapConfig.bearing === 0 &&
        mapConfig.threeDimensional === true &&
        mapConfig.projection === 'mercator' &&
        mapConfig.staticMapFileId === readableFileId &&
        typeof mapConfig.staticMapUrl === 'string' &&
        mapConfig.staticMapUrl.endsWith(expectedStaticUrlSuffix)
      );
    };
    const checkPublicBranding = (
      branding:
        | {
            displayImage?: { fileId?: string; url?: string } | null;
            backgroundImage?: unknown;
            sponsorLogos?: Array<{
              fileId?: string;
              url?: string;
              ordinal?: number;
            }>;
          }
        | undefined
    ): boolean => {
      if (!branding) return false;
      const mediaPrefix = `/v2/public/communities/${encodeURIComponent(communitySlug)}/media/`;
      return (
        branding.displayImage?.fileId === readableFileId &&
        typeof branding.displayImage?.url === 'string' &&
        branding.displayImage.url.endsWith(`${mediaPrefix}${readableFileId}`) &&
        branding.backgroundImage === null &&
        Array.isArray(branding.sponsorLogos) &&
        branding.sponsorLogos.length === 1 &&
        branding.sponsorLogos[0]?.fileId === sponsorLogoFileId &&
        branding.sponsorLogos[0]?.ordinal === 0 &&
        typeof branding.sponsorLogos[0]?.url === 'string' &&
        branding.sponsorLogos[0].url.endsWith(
          `${mediaPrefix}${sponsorLogoFileId}`
        )
      );
    };
    const publicCommunitiesListCheck = (body: unknown): boolean => {
      if (!keysExactly(body, ['data'])) return false;
      const parsed = PublicCommunitiesListResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      const slugs = parsed.data.data.map((community) => community.slug);
      const expectedSlugs = [
        communitySlug,
        foreignCommunitySlug,
        saoCommunity.slug,
      ].sort();
      if (JSON.stringify([...slugs].sort()) !== JSON.stringify(expectedSlugs)) {
        return false;
      }
      if (
        slugs.includes(inactiveCommunity.slug) ||
        slugs.includes(privateCommunitySlug)
      ) {
        return false;
      }
      const own = parsed.data.data.find(
        (community) => community.slug === communitySlug
      );
      if (!own) return false;
      const text = JSON.stringify(body) ?? '';
      return (
        own.id === communityId &&
        own.visibility === 'public' &&
        own.status === 'active' &&
        checkPublicBranding(own.branding) &&
        checkPublicMapConfig(
          own.mapConfig as unknown as Record<string, unknown>
        ) &&
        !text.includes(String(restrictedFileId)) &&
        !text.includes('mapboxAccessToken')
      );
    };
    const publicCommunityDetailCheck = (body: unknown): boolean => {
      if (!keysExactly(body, ['data'])) return false;
      const parsed = PublicCommunityDetailResponseSchema.safeParse(body);
      if (!parsed.success) return false;
      const data = parsed.data.data;
      const optionValues = (category: string): (number | string)[] =>
        data.filters
          .filter((option) => option.category === category)
          .map((option) => option.value);
      const text = JSON.stringify(body) ?? '';
      return (
        data.id === communityId &&
        data.slug === communitySlug &&
        data.visibility === 'public' &&
        data.status === 'active' &&
        checkPublicBranding(data.branding) &&
        checkPublicMapConfig(
          data.mapConfig as unknown as Record<string, unknown>
        ) &&
        data.storiesCount === 2 &&
        idsExactlyAsSet(data.points, [publicPlace.id]) &&
        data.points.length === 1 &&
        data.points[0]?.properties.name === 'QA public place' &&
        data.points[0]?.properties.description === null &&
        data.points[0]?.properties.region === null &&
        data.points[0]?.properties.typeOfPlace === 'QA public place type' &&
        JSON.stringify(data.categories) ===
          JSON.stringify(PUBLIC_COMMUNITY_FILTER_CATEGORIES) &&
        JSON.stringify(optionValues('place')) ===
          JSON.stringify([publicPlace.id]) &&
        JSON.stringify(optionValues('speaker')) ===
          JSON.stringify([speaker.id]) &&
        JSON.stringify(optionValues('typeOfPlace')) ===
          JSON.stringify(['QA public place type']) &&
        optionValues('region').length === 0 &&
        optionValues('topic').length === 0 &&
        JSON.stringify(optionValues('language')) === JSON.stringify(['en']) &&
        optionValues('affiliation').length === 0 &&
        !text.includes('qa-members-lang') &&
        !text.includes(String(restrictedFileId)) &&
        !text.includes('QA members-only place') &&
        !text.includes('QA members-only speaker') &&
        !text.includes('QA members-only topic') &&
        !text.includes('QA members-only affiliation') &&
        !text.includes('QA restricted place') &&
        !text.includes('QA unassociated place') &&
        !text.includes('mapboxAccessToken')
      );
    };
    const searchSaoCheck = (body: unknown): boolean => {
      const parsed = PublicCommunitiesListResponseSchema.safeParse(body);
      return (
        parsed.success &&
        parsed.data.data.length === 1 &&
        parsed.data.data[0]?.slug === saoCommunity.slug &&
        parsed.data.data[0]?.name === saoCommunity.name
      );
    };
    const emptyPublicListCheck = (body: unknown): boolean => {
      const parsed = PublicCommunitiesListResponseSchema.safeParse(body);
      return parsed.success && parsed.data.data.length === 0;
    };
    const filterAtCapParams = new URLSearchParams();
    filterAtCapParams.append('place', String(publicPlace.id));
    for (let i = 1; i < MAX_PUBLIC_FILTER_VALUES; i++) {
      filterAtCapParams.append('place', String(990000 + i));
    }
    filterAtCapParams.append('speaker', String(speaker.id));
    for (
      let i = 1;
      i < MAX_PUBLIC_TOTAL_FILTER_VALUES - MAX_PUBLIC_FILTER_VALUES;
      i++
    ) {
      filterAtCapParams.append('speaker', String(995000 + i));
    }
    const publicCommunities: Step[] = [
      {
        name: 'v2 public communities list',
        method: 'GET',
        path: '/v2/public/communities',
        expected: 200,
        check: (body) => {
          if (!publicCommunitiesListCheck(body)) return false;
          canonicalPublicListJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public communities search matches case-variant diacritic',
        method: 'GET',
        path: `/v2/public/communities?search=${encodeURIComponent('SÃO JOÃO')}`,
        expected: 200,
        check: searchSaoCheck,
      },
      {
        name: 'v2 public communities search folds final sigma',
        method: 'GET',
        path: `/v2/public/communities?search=${encodeURIComponent('ΑΣ')}`,
        expected: 200,
        check: searchSaoCheck,
      },
      {
        name: 'v2 public communities search rejects ASCII transcription',
        method: 'GET',
        path: `/v2/public/communities?search=${encodeURIComponent('sao joao')}`,
        expected: 200,
        check: emptyPublicListCheck,
      },
      {
        name: 'v2 public communities search hides inactive public community',
        method: 'GET',
        path: `/v2/public/communities?search=${encodeURIComponent(
          inactiveCommunity.name
        )}`,
        expected: 200,
        check: emptyPublicListCheck,
      },
      {
        name: 'v2 public communities search hides private community',
        method: 'GET',
        path: `/v2/public/communities?search=${encodeURIComponent(
          privateCommunityName
        )}`,
        expected: 200,
        check: emptyPublicListCheck,
      },
      {
        name: 'v2 public community detail',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}`,
        expected: 200,
        check: (body) => {
          if (!publicCommunityDetailCheck(body)) return false;
          canonicalPublicDetailJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public community detail hides private community identically',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public community detail hides inactive community identically',
        method: 'GET',
        path: `/v2/public/communities/${inactiveCommunity.slug}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public community detail returns 404 for unknown slug',
        method: 'GET',
        path: '/v2/public/communities/qa-hono-nonexistent',
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public stories list',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories?sort=title_asc`,
        expected: 200,
        check: (body) => {
          if (!publicStoriesListCheck(body)) return false;
          canonicalPublicStoriesJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public stories filter by readable place and speaker',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories?place=${publicPlace.id}&speaker=${speaker.id}`,
        expected: 200,
        check: publicFilteredStoriesCheck,
      },
      {
        name: 'v2 public stories filter hides members-only place probe',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories?place=${membersPlace.id}`,
        expected: 200,
        check: (body) => {
          const parsed = PublicStoriesListResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.stories.length === 0 &&
            parsed.data.meta.total === 0
          );
        },
      },
      {
        name: 'v2 public stories hides private community',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}/stories`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public stories hides inactive community',
        method: 'GET',
        path: `/v2/public/communities/${inactiveCommunity.slug}/stories`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public story detail',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${publicStory.id}`,
        expected: 200,
        check: (body) => {
          if (!v2PublicStoryDetailCheck(body)) return false;
          canonicalPublicStoryDetailJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public story detail hides restricted story',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${restrictedStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public story detail allows edge-less public story',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${unevidencedStory.id}`,
        expected: 200,
        check: (body) => {
          const parsed = PublicStoryDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.id === unevidencedStory.id &&
            parsed.data.data.places.length === 0 &&
            parsed.data.data.speakers.length === 0 &&
            parsed.data.data.points.length === 0
          );
        },
      },
      {
        name: 'v2 public story detail hides unknown-privacy story',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${unknownStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public story detail hides members-only story',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${membersStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public story detail hides foreign story',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${foreignStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public story detail hides private community story',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}/stories/${privateStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public places list (with readable stories)',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places`,
        expected: 200,
        check: (body) => {
          if (!publicPlacesListCheck(body)) return false;
          canonicalPublicPlacesJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public place detail',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places/${publicPlace.id}`,
        expected: 200,
        check: (body) => {
          if (!publicPlaceDetailCheck(body)) return false;
          canonicalPublicPlaceDetailJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public place detail hides restricted place',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places/${restrictedPlace.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public place detail hides story-less place',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places/${unassociatedPlace.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public place detail hides members-only-story place',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places/${membersPlace.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public speakers list (with readable stories)',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers`,
        expected: 200,
        check: (body) => {
          if (!publicSpeakersListCheck(body)) return false;
          canonicalPublicSpeakersJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public speaker detail',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers/${speaker.id}`,
        expected: 200,
        check: (body) => {
          if (!publicSpeakerDetailCheck(body)) return false;
          canonicalPublicSpeakerDetailJson = JSON.stringify(body);
          return true;
        },
      },
      {
        name: 'v2 public speaker detail hides members-only-story speaker',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers/${membersSpeaker.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public speaker detail hides foreign speaker',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers/${foreignSpeaker.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media serves authorized public media with safe headers',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readableFileId}`,
        expected: 200,
        checkHeaders: (headers) =>
          publicMediaHeadersCheck(headers) &&
          headers.get('Content-Type') === 'image/png',
      },
      {
        name: 'v2 public stories filters at maximum cap without D1 parameter overflow',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories?${filterAtCapParams.toString()}`,
        expected: 200,
        check: publicFilteredStoriesCheck,
      },
      {
        name: 'v2 public media supports Range partial content',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readableFileId}`,
        headers: { Range: 'bytes=0-0' },
        expected: 206,
        checkHeaders: (headers) =>
          publicMediaHeadersCheck(headers) &&
          (headers.get('Content-Range') ?? '').startsWith('bytes 0-0/'),
      },
      {
        name: 'v2 public media returns 416 for unsatisfiable Range',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readableFileId}`,
        headers: { Range: 'bytes=9999-' },
        expected: 416,
        checkHeaders: (headers) =>
          headers.get('Accept-Ranges') === 'bytes' &&
          (headers.get('Content-Range') ?? '').startsWith('bytes */'),
      },
      {
        name: 'v2 public media serves readable story_media -> 200',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readableStoryMediaFileId}`,
        expected: 200,
        checkHeaders: (headers) =>
          publicMediaHeadersCheck(headers) &&
          headers.get('Content-Type') === 'audio/mpeg',
      },
      {
        name: 'v2 public media serves readable place_photo -> 200',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readablePlacePhotoFileId}`,
        expected: 200,
        checkHeaders: (headers) =>
          publicMediaHeadersCheck(headers) &&
          headers.get('Content-Type') === 'image/png',
      },
      {
        name: 'v2 public media serves readable place_name_audio -> 200',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readablePlaceAudioFileId}`,
        expected: 200,
        checkHeaders: (headers) =>
          publicMediaHeadersCheck(headers) &&
          headers.get('Content-Type') === 'audio/mpeg',
      },
      {
        name: 'v2 public media serves readable speaker_photo -> 200',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readableSpeakerPhotoFileId}`,
        expected: 200,
        checkHeaders: (headers) =>
          publicMediaHeadersCheck(headers) &&
          headers.get('Content-Type') === 'image/png',
      },
      {
        name: 'v2 public media hides story_media of members-only story -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${membersStoryMediaFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides story_media of restricted story -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${restrictedStoryMediaFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides place_photo of members-only place -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${membersPlacePhotoFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides place_photo of story-less place -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${storylessPlacePhotoFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides place_photo of restricted place -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${restrictedPlacePhotoFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides place_name_audio of members-only place -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${membersPlaceAudioFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides place_name_audio of story-less place -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${storylessPlaceAudioFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides place_name_audio of restricted place -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${restrictedPlaceAudioFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides speaker_photo of members-only speaker -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${membersSpeakerPhotoFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides speaker_photo of story-less speaker -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${storylessSpeakerPhotoFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media hides speaker_photo of withdrawn speaker -> 404',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${withdrawnSpeakerPhotoFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media denies restricted community file',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${restrictedFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media denies cross-community file',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${foreignPrivateFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media denies inactive community file',
        method: 'GET',
        path: `/v2/public/communities/${inactiveCommunity.slug}/media/${inactiveFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
    ];
    const publicCommunitiesWithSession: Step[] = [
      {
        name: 'v2 public communities list matches anonymous projection',
        method: 'GET',
        path: '/v2/public/communities',
        expected: 200,
        check: (body) =>
          publicCommunitiesListCheck(body) &&
          canonicalPublicListJson !== '' &&
          JSON.stringify(body) === canonicalPublicListJson,
      },
      {
        name: 'v2 public communities Unicode search while authenticated',
        method: 'GET',
        path: `/v2/public/communities?search=${encodeURIComponent('ΑΣ')}`,
        expected: 200,
        check: searchSaoCheck,
      },
      {
        name: 'v2 public community detail matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}`,
        expected: 200,
        check: (body) =>
          publicCommunityDetailCheck(body) &&
          canonicalPublicDetailJson !== '' &&
          JSON.stringify(body) === canonicalPublicDetailJson,
      },
      {
        name: 'v2 public community detail hides private community while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public community detail hides inactive community while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${inactiveCommunity.slug}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public community detail returns 404 for unknown slug while authenticated',
        method: 'GET',
        path: '/v2/public/communities/qa-hono-nonexistent',
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public stories list matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories?sort=title_asc`,
        expected: 200,
        check: (body) =>
          publicStoriesListCheck(body) &&
          canonicalPublicStoriesJson !== '' &&
          JSON.stringify(body) === canonicalPublicStoriesJson,
      },
      {
        name: 'v2 public story detail matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${publicStory.id}`,
        expected: 200,
        check: (body) =>
          v2PublicStoryDetailCheck(body) &&
          canonicalPublicStoryDetailJson !== '' &&
          JSON.stringify(body) === canonicalPublicStoryDetailJson,
      },
      {
        name: 'v2 public story detail hides members-only story while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/${membersStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public story detail hides private community story while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}/stories/${privateStory.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public places list matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places`,
        expected: 200,
        check: (body) =>
          publicPlacesListCheck(body) &&
          canonicalPublicPlacesJson !== '' &&
          JSON.stringify(body) === canonicalPublicPlacesJson,
      },
      {
        name: 'v2 public place detail matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places/${publicPlace.id}`,
        expected: 200,
        check: (body) =>
          publicPlaceDetailCheck(body) &&
          canonicalPublicPlaceDetailJson !== '' &&
          JSON.stringify(body) === canonicalPublicPlaceDetailJson,
      },
      {
        name: 'v2 public place detail hides story-less and members-only place while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/places/${unassociatedPlace.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public speakers list matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers`,
        expected: 200,
        check: (body) =>
          publicSpeakersListCheck(body) &&
          canonicalPublicSpeakersJson !== '' &&
          JSON.stringify(body) === canonicalPublicSpeakersJson,
      },
      {
        name: 'v2 public speaker detail matches anonymous projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers/${speaker.id}`,
        expected: 200,
        check: (body) =>
          publicSpeakerDetailCheck(body) &&
          canonicalPublicSpeakerDetailJson !== '' &&
          JSON.stringify(body) === canonicalPublicSpeakerDetailJson,
      },
      {
        name: 'v2 public speaker detail hides members-only speaker while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/speakers/${membersSpeaker.id}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'v2 public media serves authorized public media while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${readableFileId}`,
        expected: 200,
        checkHeaders: publicMediaHeadersCheck,
      },
      {
        name: 'v2 public media denies restricted file while authenticated',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/media/${restrictedFileId}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
    ];
    const forbiddenCheck = (body: unknown): boolean =>
      keysExactly(body, ['error']) &&
      (body as { error?: string }).error === 'Forbidden';
    const communityBaselinePlaceIds = fixtures.places
      .filter((place) => place.communityId === communityId)
      .map((place) => place.id);
    const communityReadsStepsFor = (
      role: 'viewer' | 'member' | 'editor' | 'admin'
    ): Step[] => {
      const canReadCommunity =
        role === 'member' || role === 'editor' || role === 'admin';
      const canReadEditors = role === 'editor' || role === 'admin';
      const expectedStoryIds = canReadEditors
        ? [
            communityStory.id,
            editorsStory.id,
            publicStory.id,
            unevidencedStory.id,
          ]
        : canReadCommunity
          ? [communityStory.id, publicStory.id, unevidencedStory.id]
          : [publicStory.id, unevidencedStory.id];
      const expectedPointIds = (
        canReadEditors
          ? [publicPlace.id, communityPlace.id, editorsPlace.id]
          : canReadCommunity
            ? [publicPlace.id, communityPlace.id]
            : [publicPlace.id]
      ).sort((a, b) => a - b);
      const expectedPlaceIds = (
        canReadEditors
          ? [
              ...communityBaselinePlaceIds,
              publicPlace.id,
              unassociatedPlace.id,
              membersPlace.id,
              communityPlace.id,
              editorsPlace.id,
            ]
          : canReadCommunity
            ? [publicPlace.id, communityPlace.id]
            : [publicPlace.id]
      ).sort((a, b) => a - b);
      const expectedSpeakerIds = (
        canReadEditors
          ? [
              speaker.id,
              membersSpeaker.id,
              storylessSpeaker.id,
              withdrawnSpeaker.id,
              communitySpeaker.id,
              restrictedBirthplaceSpeaker.id,
              editorsSpeaker.id,
            ]
          : canReadCommunity
            ? [speaker.id, communitySpeaker.id, restrictedBirthplaceSpeaker.id]
            : [speaker.id]
      ).sort((a, b) => a - b);
      const mediaPrefix = '/v2/media/';
      return [
        {
          name: `v2 community detail (${role})`,
          method: 'GET',
          path: `/v2/community?communityId=${foreignCommunityId}`,
          expected: 200,
          check: (body) => {
            const parsed = CommunityReadDetailResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const d = parsed.data.data;
            const topicNames = d.filters
              .filter((f) => f.category === 'topic')
              .map((t) => String(t.value));
            const langs = d.filters
              .filter((f) => f.category === 'language')
              .map((l) => String(l.value));
            const placeFilterIds = d.filters
              .filter((f) => f.category === 'place')
              .map((p) => p.value);
            const filtersText = JSON.stringify(d.filters);
            return (
              d.id === communityId &&
              d.slug === communitySlug &&
              d.visibility === 'public' &&
              d.storiesCount === expectedStoryIds.length &&
              d.points.map((p) => p.id).join(',') ===
                expectedPlaceIds.join(',') &&
              d.branding.displayImage?.fileId === readableFileId &&
              d.branding.displayImage.url.endsWith(
                `${mediaPrefix}${readableFileId}`
              ) &&
              d.mapConfig?.staticMapFileId === readableFileId &&
              d.mapConfig.staticMapUrl?.endsWith(
                `${mediaPrefix}${readableFileId}`
              ) === true &&
              !placeFilterIds.includes(restrictedPlace.id) &&
              !topicNames.includes('QA members-only topic') &&
              !langs.includes('qa-members-lang') &&
              !filtersText.includes('QA restricted place') &&
              topicNames.includes('QA community topic') === canReadCommunity &&
              langs.includes('qa-community-lang') === canReadCommunity
            );
          },
        },
        {
          name: `v2 community map-config (${role})`,
          method: 'GET',
          path: '/v2/community/map-config',
          expected: 200,
          check: (body) => {
            const parsed = CommunityMapConfigResponseSchema.safeParse(body);
            return (
              parsed.success &&
              parsed.data.data !== null &&
              parsed.data.data.styleUrl ===
                'https://tiles.example.test/style.json' &&
              parsed.data.data.staticMapFileId === readableFileId &&
              parsed.data.data.staticMapUrl?.endsWith(
                `${mediaPrefix}${readableFileId}`
              ) === true
            );
          },
        },
        {
          name: `v2 stories list (${role})`,
          method: 'GET',
          path: '/v2/stories?sort=title_asc',
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoriesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const text = JSON.stringify(body) ?? '';
            return (
              parsed.data.meta.total === expectedStoryIds.length &&
              parsed.data.data.stories.map((s) => s.id).join(',') ===
                expectedStoryIds.join(',') &&
              parsed.data.data.points.map((p) => p.id).join(',') ===
                expectedPointIds.join(',') &&
              !text.includes('QA restricted story') &&
              !text.includes('QA restricted place') &&
              !text.includes('QA unknown-privacy') &&
              !text.includes('QA members-only') &&
              !text.includes('QA foreign story') &&
              !text.includes('QA private community story') &&
              !text.includes('QA inactive community')
            );
          },
        },
        {
          name: `v2 stories filter excludes #162 and unauthorized places (${role})`,
          method: 'GET',
          path: `/v2/stories?place=${restrictedPlace.id}`,
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoriesListResponseSchema.safeParse(body);
            return (
              parsed.success &&
              parsed.data.meta.total === 0 &&
              parsed.data.data.stories.length === 0 &&
              parsed.data.data.points.length === 0
            );
          },
        },
        {
          name: `v2 story detail public (${role})`,
          method: 'GET',
          path: `/v2/stories/${publicStory.id}`,
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoryDetailResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const expectedPublicStorySpeakers = (
              canReadEditors ? [speaker.id, withdrawnSpeaker.id] : [speaker.id]
            ).sort((a, b) => a - b);
            return (
              parsed.data.data.id === publicStory.id &&
              parsed.data.data.places.map((p) => p.id).join(',') ===
                String(publicPlace.id) &&
              parsed.data.data.speakers
                .map((s) => s.id)
                .sort((a, b) => a - b)
                .join(',') === expectedPublicStorySpeakers.join(',') &&
              parsed.data.data.attachments.some(
                (att) =>
                  att.fileId === readableStoryMediaFileId &&
                  att.url.endsWith(`${mediaPrefix}${readableStoryMediaFileId}`)
              )
            );
          },
        },
        {
          name: `v2 story detail community (${role})`,
          method: 'GET',
          path: `/v2/stories/${communityStory.id}`,
          expected: canReadCommunity ? 200 : 404,
          check: canReadCommunity
            ? (body) => {
                const parsed =
                  CommunityStoryDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.id === communityStory.id &&
                  parsed.data.data.visibility === 'community' &&
                  parsed.data.data.interviewLocation?.id === publicPlace.id &&
                  parsed.data.data.interviewer?.id === speaker.id &&
                  parsed.data.data.places.map((p) => p.id).join(',') ===
                    String(communityPlace.id)
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 story detail editors (${role})`,
          method: 'GET',
          path: `/v2/stories/${editorsStory.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed =
                  CommunityStoryDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.id === editorsStory.id &&
                  parsed.data.data.visibility === 'editors' &&
                  parsed.data.data.interviewLocation === null &&
                  parsed.data.data.interviewer?.id === withdrawnSpeaker.id &&
                  parsed.data.data.places.map((p) => p.id).join(',') ===
                    String(editorsPlace.id)
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 story detail hides #162 restricted (${role})`,
          method: 'GET',
          path: `/v2/stories/${restrictedStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 story detail hides #162 unknown privacy (${role})`,
          method: 'GET',
          path: `/v2/stories/${unknownStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 story detail hides #162 legacy members privacy (${role})`,
          method: 'GET',
          path: `/v2/stories/${membersStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 story detail hides cross-community story (${role})`,
          method: 'GET',
          path: `/v2/stories/${foreignStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 places list (${role})`,
          method: 'GET',
          path: '/v2/places',
          expected: 200,
          check: (body) => {
            const parsed = PublicPlacesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const ids = parsed.data.data.map((p) => p.id);
            const text = JSON.stringify(body) ?? '';
            return (
              parsed.data.meta.total === expectedPlaceIds.length &&
              ids.join(',') === expectedPlaceIds.join(',') &&
              !text.includes('QA restricted') &&
              !text.includes('QA foreign place')
            );
          },
        },
        {
          name: `v2 places portable near filter (${role})`,
          method: 'GET',
          path: '/v2/places?near=-3.05,-60.05,2',
          expected: 200,
          check: (body) => {
            const parsed = PublicPlacesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const expectedNear = canReadCommunity ? [communityPlace.id] : [];
            return (
              parsed.data.meta.total === expectedNear.length &&
              parsed.data.data.map((p) => p.id).join(',') ===
                expectedNear.join(',')
            );
          },
        },
        {
          name: `v2 place detail public (${role})`,
          method: 'GET',
          path: `/v2/places/${publicPlace.id}`,
          expected: 200,
          check: (body) => {
            const parsed = PublicPlaceDetailResponseSchema.safeParse(body);
            return parsed.success && parsed.data.data.id === publicPlace.id;
          },
        },
        {
          name: `v2 place detail story-less (${role})`,
          method: 'GET',
          path: `/v2/places/${unassociatedPlace.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed = PublicPlaceDetailResponseSchema.safeParse(body);
                return (
                  parsed.success && parsed.data.data.id === unassociatedPlace.id
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 place detail editors-only (${role})`,
          method: 'GET',
          path: `/v2/places/${editorsPlace.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed = PublicPlaceDetailResponseSchema.safeParse(body);
                return (
                  parsed.success && parsed.data.data.id === editorsPlace.id
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 place detail hides #162 restricted (${role})`,
          method: 'GET',
          path: `/v2/places/${restrictedPlace.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 place detail hides cross-community (${role})`,
          method: 'GET',
          path: `/v2/places/${foreignPlace.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 speakers list (${role})`,
          method: 'GET',
          path: '/v2/speakers',
          expected: 200,
          check: (body) => {
            const parsed = PublicSpeakersListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const rows = parsed.data.data;
            const restrictedSpk = rows.find(
              (s) => s.id === restrictedBirthplaceSpeaker.id
            );
            const commSpk = rows.find((s) => s.id === communitySpeaker.id);
            const text = JSON.stringify(body) ?? '';
            return (
              parsed.data.meta.total === expectedSpeakerIds.length &&
              rows.map((s) => s.id).join(',') ===
                expectedSpeakerIds.join(',') &&
              !text.includes('QA restricted place') &&
              !text.includes('QA foreign speaker') &&
              (!canReadCommunity ||
                (restrictedSpk?.birthplace === null &&
                  commSpk?.birthplace?.id === communityPlace.id))
            );
          },
        },
        {
          name: `v2 speaker detail active (${role})`,
          method: 'GET',
          path: `/v2/speakers/${speaker.id}`,
          expected: 200,
          check: (body) => {
            const parsed = PublicSpeakerDetailResponseSchema.safeParse(body);
            return parsed.success && parsed.data.data.id === speaker.id;
          },
        },
        {
          name: `v2 speaker detail restricted birthplace hidden (${role})`,
          method: 'GET',
          path: `/v2/speakers/${restrictedBirthplaceSpeaker.id}`,
          expected: canReadCommunity ? 200 : 404,
          check: canReadCommunity
            ? (body) => {
                const parsed =
                  PublicSpeakerDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.id === restrictedBirthplaceSpeaker.id &&
                  parsed.data.data.birthplace === null
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 speaker detail story-less (${role})`,
          method: 'GET',
          path: `/v2/speakers/${storylessSpeaker.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed =
                  PublicSpeakerDetailResponseSchema.safeParse(body);
                return (
                  parsed.success && parsed.data.data.id === storylessSpeaker.id
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 speaker detail withdrawn (${role})`,
          method: 'GET',
          path: `/v2/speakers/${withdrawnSpeaker.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed =
                  PublicSpeakerDetailResponseSchema.safeParse(body);
                return (
                  parsed.success && parsed.data.data.id === withdrawnSpeaker.id
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 speaker detail hides cross-community (${role})`,
          method: 'GET',
          path: `/v2/speakers/${foreignSpeaker.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
      ];
    };
    const privateCommunityReadsStepsFor = (
      role: 'viewer' | 'member' | 'editor' | 'admin'
    ): Step[] => {
      const canReadCommunity =
        role === 'member' || role === 'editor' || role === 'admin';
      const canReadEditors = role === 'editor' || role === 'admin';
      const expectedStoryIds = canReadEditors
        ? [privateStory.id, privEditorsStory.id, privCommunityStory.id]
        : canReadCommunity
          ? [privateStory.id, privCommunityStory.id]
          : [privateStory.id];
      const expectedPointIds = (
        canReadEditors
          ? [privatePlace.id, privCommunityPlace.id, privEditorsPlace.id]
          : canReadCommunity
            ? [privatePlace.id, privCommunityPlace.id]
            : [privatePlace.id]
      ).sort((a, b) => a - b);
      const expectedPlaceIds = (
        canReadEditors
          ? [
              privatePlace.id,
              privCommunityPlace.id,
              privEditorsPlace.id,
              privStorylessPlace.id,
            ]
          : canReadCommunity
            ? [privatePlace.id, privCommunityPlace.id]
            : [privatePlace.id]
      ).sort((a, b) => a - b);
      const expectedSpeakerIds = (
        canReadEditors
          ? [
              privateSpeaker.id,
              privCommunitySpeaker.id,
              privEditorsSpeaker.id,
              privStorylessSpeaker.id,
            ]
          : canReadCommunity
            ? [privateSpeaker.id, privCommunitySpeaker.id]
            : [privateSpeaker.id]
      ).sort((a, b) => a - b);
      return [
        {
          name: `v2 private community detail (${role})`,
          method: 'GET',
          path: '/v2/community',
          expected: 200,
          check: (body) => {
            const parsed = CommunityReadDetailResponseSchema.safeParse(body);
            return (
              parsed.success &&
              parsed.data.data.id === privateCommunityId &&
              parsed.data.data.visibility === 'private' &&
              parsed.data.data.storiesCount === expectedStoryIds.length &&
              parsed.data.data.points.map((p) => p.id).join(',') ===
                expectedPlaceIds.join(',')
            );
          },
        },
        {
          name: `v2 private community map-config (${role})`,
          method: 'GET',
          path: '/v2/community/map-config',
          expected: 200,
          check: (body) => {
            const parsed = CommunityMapConfigResponseSchema.safeParse(body);
            return (
              parsed.success &&
              parsed.data.data?.styleUrl ===
                'https://tiles.example.test/private-style.json'
            );
          },
        },
        {
          name: `v2 private community stories (${role})`,
          method: 'GET',
          path: '/v2/stories?sort=title_asc',
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoriesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const text = JSON.stringify(body) ?? '';
            return (
              parsed.data.meta.total === expectedStoryIds.length &&
              parsed.data.data.stories.map((s) => s.id).join(',') ===
                expectedStoryIds.join(',') &&
              parsed.data.data.points.map((p) => p.id).join(',') ===
                expectedPointIds.join(',') &&
              !text.includes('QA private restricted') &&
              !text.includes('QA private unknown-privacy') &&
              !text.includes('QA public story')
            );
          },
        },
        {
          name: `v2 private story detail public (${role})`,
          method: 'GET',
          path: `/v2/stories/${privateStory.id}`,
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoryDetailResponseSchema.safeParse(body);
            return (
              parsed.success &&
              parsed.data.data.id === privateStory.id &&
              parsed.data.data.places.map((p) => p.id).join(',') ===
                String(privatePlace.id)
            );
          },
        },
        {
          name: `v2 private story detail community (${role})`,
          method: 'GET',
          path: `/v2/stories/${privCommunityStory.id}`,
          expected: canReadCommunity ? 200 : 404,
          check: canReadCommunity
            ? (body) => {
                const parsed =
                  CommunityStoryDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.id === privCommunityStory.id
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 private story detail editors (${role})`,
          method: 'GET',
          path: `/v2/stories/${privEditorsStory.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed =
                  CommunityStoryDetailResponseSchema.safeParse(body);
                return (
                  parsed.success && parsed.data.data.id === privEditorsStory.id
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 private story detail hides #162 restricted (${role})`,
          method: 'GET',
          path: `/v2/stories/${privRestrictedStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 private story detail hides #162 unknown (${role})`,
          method: 'GET',
          path: `/v2/stories/${privUnknownStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 private story detail hides cross-community story (${role})`,
          method: 'GET',
          path: `/v2/stories/${publicStory.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 private community places (${role})`,
          method: 'GET',
          path: '/v2/places',
          expected: 200,
          check: (body) => {
            const parsed = PublicPlacesListResponseSchema.safeParse(body);
            return (
              parsed.success &&
              parsed.data.meta.total === expectedPlaceIds.length &&
              parsed.data.data.map((p) => p.id).join(',') ===
                expectedPlaceIds.join(',')
            );
          },
        },
        {
          name: `v2 private place detail story-less (${role})`,
          method: 'GET',
          path: `/v2/places/${privStorylessPlace.id}`,
          expected: canReadEditors ? 200 : 404,
        },
        {
          name: `v2 private place detail hides #162 restricted (${role})`,
          method: 'GET',
          path: `/v2/places/${privRestrictedPlace.id}`,
          expected: 404,
          check: publicNotFoundCheck,
        },
        {
          name: `v2 private community speakers (${role})`,
          method: 'GET',
          path: '/v2/speakers',
          expected: 200,
          check: (body) => {
            const parsed = PublicSpeakersListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const restrictedBirthSpk = parsed.data.data.find(
              (s) => s.id === privCommunitySpeaker.id
            );
            return (
              parsed.data.meta.total === expectedSpeakerIds.length &&
              parsed.data.data.map((s) => s.id).join(',') ===
                expectedSpeakerIds.join(',') &&
              (!canReadCommunity || restrictedBirthSpk?.birthplace === null)
            );
          },
        },
        {
          name: `v2 private speaker detail hides restricted birthplace (${role})`,
          method: 'GET',
          path: `/v2/speakers/${privCommunitySpeaker.id}`,
          expected: canReadCommunity ? 200 : 404,
          check: canReadCommunity
            ? (body) => {
                const parsed =
                  PublicSpeakerDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.id === privCommunitySpeaker.id &&
                  parsed.data.data.birthplace === null
                );
              }
            : publicNotFoundCheck,
        },
        {
          name: `v2 private speaker detail story-less (${role})`,
          method: 'GET',
          path: `/v2/speakers/${privStorylessSpeaker.id}`,
          expected: canReadEditors ? 200 : 404,
        },
        {
          name: `v2 private speaker detail editors (${role})`,
          method: 'GET',
          path: `/v2/speakers/${privEditorsSpeaker.id}`,
          expected: canReadEditors ? 200 : 404,
          check: canReadEditors
            ? (body) => {
                const parsed =
                  PublicSpeakerDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.id === privEditorsSpeaker.id &&
                  parsed.data.data.birthplace?.id === privCommunityPlace.id
                );
              }
            : publicNotFoundCheck,
        },
      ];
    };
    const forbiddenCommunityReadSteps: Step[] = [
      {
        name: 'deny v2 community detail',
        method: 'GET',
        path: '/v2/community',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 community map-config',
        method: 'GET',
        path: '/v2/community/map-config',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 stories list',
        method: 'GET',
        path: '/v2/stories',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 story detail',
        method: 'GET',
        path: `/v2/stories/${publicStory.id}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 places list',
        method: 'GET',
        path: '/v2/places',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 place detail',
        method: 'GET',
        path: `/v2/places/${publicPlace.id}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 speakers list',
        method: 'GET',
        path: '/v2/speakers',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny v2 speaker detail (forbidden role)',
        method: 'GET',
        path: `/v2/speakers/${speaker.id}`,
        expected: 403,
        check: forbiddenCheck,
      },
    ];
    const forbiddenCommunityWriteSteps: Step[] = [
      {
        name: 'deny patch v2 community',
        method: 'PATCH',
        path: '/v2/community',
        expected: 403,
        body: { name: 'Denied Community Rename' },
        check: forbiddenCheck,
      },
      {
        name: 'deny put v2 community map-config',
        method: 'PUT',
        path: '/v2/community/map-config',
        expected: 403,
        body: {},
        check: forbiddenCheck,
      },
      {
        name: 'deny post v2 places',
        method: 'POST',
        path: '/v2/places',
        expected: 403,
        body: { name: 'Denied Place' },
        check: forbiddenCheck,
      },
      {
        name: 'deny patch v2 place',
        method: 'PATCH',
        path: `/v2/places/${publicPlace.id}`,
        expected: 403,
        body: { name: 'Denied Place Patch' },
        check: forbiddenCheck,
      },
      {
        name: 'deny delete v2 place',
        method: 'DELETE',
        path: `/v2/places/${publicPlace.id}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny post v2 speakers',
        method: 'POST',
        path: '/v2/speakers',
        expected: 403,
        body: { name: 'Denied Speaker' },
        check: forbiddenCheck,
      },
      {
        name: 'deny patch v2 speaker',
        method: 'PATCH',
        path: `/v2/speakers/${speaker.id}`,
        expected: 403,
        body: { name: 'Denied Speaker Patch' },
        check: forbiddenCheck,
      },
      {
        name: 'deny delete v2 speaker',
        method: 'DELETE',
        path: `/v2/speakers/${speaker.id}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny post v2 stories',
        method: 'POST',
        path: '/v2/stories',
        expected: 403,
        body: { title: 'Denied Story' },
        check: forbiddenCheck,
      },
      {
        name: 'deny patch v2 story',
        method: 'PATCH',
        path: `/v2/stories/${publicStory.id}`,
        expected: 403,
        body: { title: 'Denied Story Patch' },
        check: forbiddenCheck,
      },
      {
        name: 'deny delete v2 story',
        method: 'DELETE',
        path: `/v2/stories/${publicStory.id}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny put v2 story places',
        method: 'PUT',
        path: `/v2/stories/${publicStory.id}/places`,
        expected: 403,
        body: { placeIds: [] },
        check: forbiddenCheck,
      },
      {
        name: 'deny put v2 story speakers',
        method: 'PUT',
        path: `/v2/stories/${publicStory.id}/speakers`,
        expected: 403,
        body: { speakerIds: [] },
        check: forbiddenCheck,
      },
      {
        name: 'deny post v2 story external links',
        method: 'POST',
        path: `/v2/stories/${publicStory.id}/external-links`,
        expected: 403,
        body: { url: 'https://denied.example.test/media' },
        check: forbiddenCheck,
      },
      {
        name: 'deny patch v2 story external links reorder',
        method: 'PATCH',
        path: `/v2/stories/${publicStory.id}/external-links/reorder`,
        expected: 403,
        body: { linkIds: [] },
        check: forbiddenCheck,
      },
      {
        name: 'deny delete v2 story external link',
        method: 'DELETE',
        path: `/v2/stories/${publicStory.id}/external-links/1`,
        expected: 403,
        check: forbiddenCheck,
      },
    ];
    const validationFieldCheck =
      (expectedPath: string, noEchoToken?: string) => (body: unknown) => {
        const parsed = V2ValidationErrorResponseSchema.safeParse(body);
        if (!parsed.success) return false;
        const hasPath =
          parsed.data.details?.fields.some((f) => f.path === expectedPath) ??
          false;
        if (!hasPath) return false;
        if (noEchoToken && JSON.stringify(body).includes(noEchoToken)) {
          return false;
        }
        return true;
      };
    let qaSlice8StoryId = 0;
    let qaSlice8LinkAId = 0;
    let qaSlice8LinkBId = 0;
    const qaSlice8ReorderBody: { linkIds: number[] } = { linkIds: [] };
    const assertEditorStoryAudits = async (
      expectedActions: readonly string[]
    ): Promise<void> => {
      const audits = await db
        .select()
        .from(auditEntries)
        .where(
          sql`${auditEntries.communityId} = ${communityId} AND ${auditEntries.resourceType} = 'story'`
        )
        .orderBy(asc(auditEntries.id));
      if (audits.length !== expectedActions.length) {
        throw new Error(
          `Expected ${expectedActions.length} story visibility audit entries for community ${communityId}, got ${audits.length}`
        );
      }
      const forbiddenTokens = [
        'QA Slice8 Story',
        'QA Slice8 Story Published',
        credentials.editor.email,
        ...HONO_PERSONA_CULTURAL_STRINGS,
      ];
      for (let i = 0; i < expectedActions.length; i++) {
        const entry = audits[i]!;
        const validated = validateContentFreeAuditEntry({
          communityId: entry.communityId,
          actorId: entry.actorId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceIds: entry.resourceIds,
          outcome: entry.outcome,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
        });
        if (
          validated.communityId !== communityId ||
          validated.action !== expectedActions[i] ||
          validated.resourceType !== 'story' ||
          JSON.stringify(validated.resourceIds) !==
            JSON.stringify([qaSlice8StoryId]) ||
          validated.outcome !== 'success' ||
          validated.ipAddress !== null ||
          validated.userAgent !== null
        ) {
          throw new Error(
            `Unexpected story audit entry at index ${i}: ${JSON.stringify(entry)}`
          );
        }
        const serialized = JSON.stringify(entry);
        for (const token of forbiddenTokens) {
          if (serialized.includes(token)) {
            throw new Error(
              `Story audit entry leaked non-content-free token "${token}"`
            );
          }
        }
      }
    };
    const editorCommunityWriteSteps: Step[] = [
      {
        name: 'editor denied patch v2 community',
        method: 'PATCH',
        path: '/v2/community',
        expected: 403,
        body: { name: 'Editor Denied' },
        check: forbiddenCheck,
      },
      {
        name: 'editor denied put v2 community map-config',
        method: 'PUT',
        path: '/v2/community/map-config',
        expected: 403,
        body: {},
        check: forbiddenCheck,
      },
      {
        name: 'editor create place rejects CSRF cross-site',
        method: 'POST',
        path: '/v2/places',
        expected: 403,
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        body: { name: 'CSRF Blocked Place' },
        check: forbiddenCheck,
      },
      {
        name: 'editor create place rejects invalid HTML href without echo',
        method: 'POST',
        path: '/v2/places',
        expected: 400,
        body: {
          name: 'Unsafe Link Place',
          description: `<p><a href="javascript:${qaSecretDescMarker}()">bad</a></p>`,
        },
        check: validationFieldCheck('description', qaSecretDescMarker),
      },
      {
        name: 'editor create place rejects oversize description without echo',
        method: 'POST',
        path: '/v2/places',
        expected: 400,
        body: {
          name: 'Oversize Desc Place',
          description: `${qaSecretDescMarker}${'a'.repeat(DESCRIPTION_MAX_LENGTH)}`,
        },
        check: validationFieldCheck('description', qaSecretDescMarker),
      },
      {
        name: 'editor create place rejects partial coordinate pair',
        method: 'POST',
        path: '/v2/places',
        expected: 400,
        body: { name: 'Half Pair', latitude: 42.1 },
        check: validationFieldCheck('longitude'),
      },
      {
        name: 'editor create place with nullable coordinates',
        method: 'POST',
        path: '/v2/places',
        expected: 201,
        captureId: 'qaSlice7Place',
        body: {
          name: 'QA Slice7 Clearing',
          description: '<p>Sanitized <strong>creek</strong></p>',
          typeOfPlace: 'clearing',
          region: 'Upper Basin',
          latitude: null,
          longitude: null,
        },
        check: (body) => {
          const parsed = PublicPlaceDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.name === 'QA Slice7 Clearing' &&
            parsed.data.data.latitude === null &&
            parsed.data.data.longitude === null &&
            parsed.data.data.description ===
              '<p>Sanitized <strong>creek</strong></p>'
          );
        },
      },
      {
        name: 'editor patch place coordinates & details',
        method: 'PATCH',
        path: '/v2/places/{qaSlice7Place}',
        expected: 200,
        body: {
          name: 'QA Slice7 Ridge',
          latitude: -15.25,
          longitude: 145.5,
        },
        check: (body) => {
          const parsed = PublicPlaceDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.name === 'QA Slice7 Ridge' &&
            parsed.data.data.latitude === -15.25 &&
            parsed.data.data.longitude === 145.5
          );
        },
      },
      {
        name: 'editor patch foreign place returns 404',
        method: 'PATCH',
        path: `/v2/places/${foreignPlace.id}`,
        expected: 404,
        body: { name: 'Cross Community Blocked' },
        check: publicNotFoundCheck,
      },
      {
        name: 'editor create speaker rejects cross-community birthplaceId',
        method: 'POST',
        path: '/v2/speakers',
        expected: 400,
        body: { name: 'Cross Birthplace', birthplaceId: foreignPlace.id },
        check: validationFieldCheck('birthplaceId'),
      },
      {
        name: 'editor create speaker rejects invalid calendar birthDate',
        method: 'POST',
        path: '/v2/speakers',
        expected: 400,
        body: { name: 'Invalid Date', birthDate: '2026-02-30' },
        check: validationFieldCheck('birthDate'),
      },
      {
        name: 'editor create speaker with same-community birthplace',
        method: 'POST',
        path: '/v2/speakers',
        expected: 201,
        captureId: 'qaSlice7Speaker',
        body: {
          name: 'QA Slice7 Speaker',
          birthDate: '1965-04-12',
          birthplaceId: publicPlace.id,
          affiliation: 'Watershed Keepers',
        },
        check: (body) => {
          const parsed = PublicSpeakerDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.name === 'QA Slice7 Speaker' &&
            parsed.data.data.birthDate === '1965-04-12' &&
            parsed.data.data.birthplace?.id === publicPlace.id
          );
        },
      },
      {
        name: 'editor patch speaker clears birthplaceId',
        method: 'PATCH',
        path: '/v2/speakers/{qaSlice7Speaker}',
        expected: 200,
        body: {
          name: 'QA Slice7 Speaker Updated',
          birthplaceId: null,
        },
        check: (body) => {
          const parsed = PublicSpeakerDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.name === 'QA Slice7 Speaker Updated' &&
            parsed.data.data.birthplace === null
          );
        },
      },
      {
        name: 'editor patch foreign speaker returns 404',
        method: 'PATCH',
        path: `/v2/speakers/${foreignSpeaker.id}`,
        expected: 404,
        body: { name: 'Cross Speaker Blocked' },
        check: publicNotFoundCheck,
      },
      {
        name: 'editor delete story-referenced place refused with 409',
        method: 'DELETE',
        path: `/v2/places/${publicPlace.id}`,
        expected: 409,
      },
      {
        name: 'editor delete story-referenced speaker refused with 409',
        method: 'DELETE',
        path: `/v2/speakers/${speaker.id}`,
        expected: 409,
      },
      {
        name: 'editor delete temporary speaker',
        method: 'DELETE',
        path: '/v2/speakers/{qaSlice7Speaker}',
        expected: 204,
      },
      {
        name: 'editor repeat delete temporary speaker returns 404',
        method: 'DELETE',
        path: '/v2/speakers/{qaSlice7Speaker}',
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'editor delete temporary place',
        method: 'DELETE',
        path: '/v2/places/{qaSlice7Place}',
        expected: 204,
      },
      {
        name: 'editor repeat delete temporary place returns 404',
        method: 'DELETE',
        path: '/v2/places/{qaSlice7Place}',
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'editor create story rejects CSRF cross-site',
        method: 'POST',
        path: '/v2/stories',
        expected: 403,
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        body: { title: 'CSRF Blocked Story' },
        check: forbiddenCheck,
      },
      {
        name: 'editor create story rejects restricted visibility',
        method: 'POST',
        path: '/v2/stories',
        expected: 400,
        body: { title: 'Bad Visibility', visibility: 'restricted' },
        check: validationFieldCheck('visibility'),
      },
      {
        name: 'editor create story rejects cross-community interview location',
        method: 'POST',
        path: '/v2/stories',
        expected: 400,
        body: {
          title: 'Cross Location Story',
          interviewLocationId: foreignPlace.id,
        },
        check: validationFieldCheck('interviewLocationId'),
      },
      {
        name: 'editor create editors-only story with multiplicity edges',
        method: 'POST',
        path: '/v2/stories',
        expected: 201,
        captureId: 'qaSlice8Story',
        body: {
          title: 'QA Slice8 Story',
          description: '<p>Initial <strong>story</strong> body</p>',
          visibility: 'editors',
          topic: '  QA Coastal Song  ',
          language: 'en',
          interviewLocationId: publicPlace.id,
          interviewerId: speaker.id,
          placeIds: [publicPlace.id, publicPlace.id],
          speakerIds: [speaker.id, speaker.id],
        },
        check: (body) => {
          const parsed = StoryWriteResponseSchema.safeParse(body);
          if (!parsed.success) return false;
          qaSlice8StoryId = parsed.data.data.id;
          return (
            parsed.data.data.title === 'QA Slice8 Story' &&
            parsed.data.data.visibility === 'editors' &&
            parsed.data.data.topic === 'QA Coastal Song' &&
            parsed.data.data.places.map((p) => p.id).join(',') ===
              `${publicPlace.id},${publicPlace.id}` &&
            parsed.data.data.speakers.map((s) => s.id).join(',') ===
              `${speaker.id},${speaker.id}`
          );
        },
      },
      {
        name: 'qa slice8 editors story starts hidden on public projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/{qaSlice8Story}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'qa slice8 editors story starts hidden on explore projection',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/{qaSlice8Story}`,
        expected: 404,
      },
      {
        name: 'editor update story visibility to public',
        method: 'PATCH',
        path: '/v2/stories/{qaSlice8Story}',
        expected: 200,
        body: {
          title: 'QA Slice8 Story Published',
          description: '<p>Updated <em>narrative</em></p>',
          visibility: 'public',
          topic: '  QA Coastal Revised  ',
        },
        check: (body) => {
          const parsed = StoryWriteResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.title === 'QA Slice8 Story Published' &&
            parsed.data.data.visibility === 'public' &&
            parsed.data.data.topic === 'QA Coastal Revised'
          );
        },
      },
      {
        name: 'qa slice8 story opens immediately on public projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/{qaSlice8Story}`,
        expected: 200,
        prepare: () => assertEditorStoryAudits(['story.visibility.public']),
        check: (body) => {
          const parsed = PublicStoryDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.id === qaSlice8StoryId &&
            parsed.data.data.places.map((p) => p.id).join(',') ===
              `${publicPlace.id},${publicPlace.id}`
          );
        },
      },
      {
        name: 'qa slice8 story opens immediately on explore projection',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/{qaSlice8Story}`,
        expected: 200,
      },
      {
        name: 'editor replace story places keeps multiplicity and rejects cross-community or restricted targets',
        method: 'PUT',
        path: '/v2/stories/{qaSlice8Story}/places',
        expected: 400,
        body: { placeIds: [publicPlace.id, foreignPlace.id] },
        check: validationFieldCheck('placeIds'),
      },
      {
        name: 'editor replace story places rejects own restricted place',
        method: 'PUT',
        path: '/v2/stories/{qaSlice8Story}/places',
        expected: 400,
        body: { placeIds: [restrictedPlace.id] },
        check: validationFieldCheck('placeIds'),
      },
      {
        name: 'editor replace story places preserves duplicate order',
        method: 'PUT',
        path: '/v2/stories/{qaSlice8Story}/places',
        expected: 200,
        body: {
          placeIds: [publicPlace.id, unassociatedPlace.id, publicPlace.id],
        },
        check: (body) => {
          const parsed = StoryWriteResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.places.map((p) => p.id).join(',') ===
              `${publicPlace.id},${unassociatedPlace.id},${publicPlace.id}`
          );
        },
      },
      {
        name: 'editor replace story speakers rejects cross-community speaker',
        method: 'PUT',
        path: '/v2/stories/{qaSlice8Story}/speakers',
        expected: 400,
        body: { speakerIds: [foreignSpeaker.id] },
        check: validationFieldCheck('speakerIds'),
      },
      {
        name: 'editor replace story speakers preserves multiplicity',
        method: 'PUT',
        path: '/v2/stories/{qaSlice8Story}/speakers',
        expected: 200,
        body: { speakerIds: [speaker.id, withdrawnSpeaker.id, speaker.id] },
        check: (body) => {
          const parsed = StoryWriteResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.speakers.map((s) => s.id).join(',') ===
              `${speaker.id},${withdrawnSpeaker.id},${speaker.id}`
          );
        },
      },
      {
        name: 'editor reject restricted story write paths with 404 (no oracle)',
        method: 'PATCH',
        path: `/v2/stories/${restrictedStory.id}`,
        expected: 404,
        body: {
          title: 'Bypass Attempt',
          interviewLocationId: foreignPlace.id,
        },
        check: publicNotFoundCheck,
      },
      {
        name: 'editor external link rejects javascript scheme without echo',
        method: 'POST',
        path: '/v2/stories/{qaSlice8Story}/external-links',
        expected: 400,
        body: { url: `javascript:alert('${qaSecretDescMarker}')` },
        check: validationFieldCheck('url', qaSecretDescMarker),
      },
      {
        name: 'editor adds first external link',
        method: 'POST',
        path: '/v2/stories/{qaSlice8Story}/external-links',
        expected: 201,
        captureId: 'qaSlice8LinkA',
        body: { url: 'https://video.example.test/qa/first' },
        check: (body) => {
          const parsed = ExternalMediaLinkWriteResponseSchema.safeParse(body);
          if (!parsed.success) return false;
          qaSlice8LinkAId = parsed.data.data.id;
          return (
            parsed.data.data.url === 'https://video.example.test/qa/first' &&
            parsed.data.data.ordinal === 0
          );
        },
      },
      {
        name: 'editor adds second external link',
        method: 'POST',
        path: '/v2/stories/{qaSlice8Story}/external-links',
        expected: 201,
        captureId: 'qaSlice8LinkB',
        body: { url: 'http://audio.example.test/qa/second' },
        check: (body) => {
          const parsed = ExternalMediaLinkWriteResponseSchema.safeParse(body);
          if (!parsed.success) return false;
          qaSlice8LinkBId = parsed.data.data.id;
          return (
            parsed.data.data.url === 'http://audio.example.test/qa/second' &&
            parsed.data.data.ordinal === 1
          );
        },
      },
      {
        name: 'editor reorders external links atomically',
        method: 'PATCH',
        path: '/v2/stories/{qaSlice8Story}/external-links/reorder',
        expected: 200,
        prepare: () => {
          qaSlice8ReorderBody.linkIds = [qaSlice8LinkBId, qaSlice8LinkAId];
        },
        body: qaSlice8ReorderBody,
        check: (body) => {
          const parsed = ExternalMediaLinksListResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.map((l) => `${l.id}:${l.ordinal}`).join(',') ===
              `${qaSlice8LinkBId}:0,${qaSlice8LinkAId}:1`
          );
        },
      },
      {
        name: 'editor deletes first external link',
        method: 'DELETE',
        path: '/v2/stories/{qaSlice8Story}/external-links/{qaSlice8LinkA}',
        expected: 204,
      },
      {
        name: 'editor repeat delete external link returns 404',
        method: 'DELETE',
        path: '/v2/stories/{qaSlice8Story}/external-links/{qaSlice8LinkA}',
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'editor flips story visibility back to editors',
        method: 'PATCH',
        path: '/v2/stories/{qaSlice8Story}',
        expected: 200,
        body: { visibility: 'editors' },
        check: (body) => {
          const parsed = StoryWriteResponseSchema.safeParse(body);
          return parsed.success && parsed.data.data.visibility === 'editors';
        },
      },
      {
        name: 'qa slice8 story closes immediately on public projection',
        method: 'GET',
        path: `/v2/public/communities/${communitySlug}/stories/{qaSlice8Story}`,
        expected: 404,
        prepare: () =>
          assertEditorStoryAudits([
            'story.visibility.public',
            'story.visibility.editors',
          ]),
        check: publicNotFoundCheck,
      },
      {
        name: 'qa slice8 story closes immediately on explore projection',
        method: 'GET',
        path: `/explore/communities/${communitySlug}/stories/{qaSlice8Story}`,
        expected: 404,
      },
      {
        name: 'editor deletes temporary slice8 story',
        method: 'DELETE',
        path: '/v2/stories/{qaSlice8Story}',
        expected: 204,
      },
      {
        name: 'editor repeat delete temporary slice8 story returns 404',
        method: 'DELETE',
        path: '/v2/stories/{qaSlice8Story}',
        expected: 404,
        check: publicNotFoundCheck,
      },
    ];
    const assertPrivateVisibilityAudits = async (
      expectedActions: readonly string[]
    ): Promise<void> => {
      // Auth events for the community's own accounts (login/logout) share
      // the community bucket; only publication decisions belong to this
      // assertion (§6.8 content-free audit contract).
      const audits = await db
        .select()
        .from(auditEntries)
        .where(
          and(
            eq(auditEntries.communityId, privateCommunityId),
            like(auditEntries.action, 'community.%'),
            eq(auditEntries.resourceType, 'community')
          )
        )
        .orderBy(asc(auditEntries.id));
      if (audits.length !== expectedActions.length) {
        throw new Error(
          `Expected ${expectedActions.length} visibility audit entries for community ${privateCommunityId}, got ${audits.length}`
        );
      }
      const forbiddenTokens = [
        privateCommunityName,
        privateCommunitySlug,
        `${privateCommunityName} Public`,
        privateCredentials.admin.email,
        ...HONO_PERSONA_CULTURAL_STRINGS,
      ];
      for (let i = 0; i < expectedActions.length; i++) {
        const entry = audits[i]!;
        const validated = validateContentFreeAuditEntry({
          communityId: entry.communityId,
          actorId: entry.actorId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceIds: entry.resourceIds,
          outcome: entry.outcome,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
        });
        if (
          validated.communityId !== privateCommunityId ||
          validated.actorId !== privateCreatorId ||
          validated.action !== expectedActions[i] ||
          validated.resourceType !== 'community' ||
          JSON.stringify(validated.resourceIds) !==
            JSON.stringify([privateCommunityId]) ||
          validated.outcome !== 'success' ||
          validated.ipAddress !== null ||
          validated.userAgent !== null
        ) {
          throw new Error(
            `Unexpected audit entry shape at index ${i}: ${JSON.stringify(entry)}`
          );
        }
        const serialized = JSON.stringify(entry);
        for (const token of forbiddenTokens) {
          if (serialized.includes(token)) {
            throw new Error(
              `Audit entry leaked non-content-free token "${token}"`
            );
          }
        }
      }
    };
    const privateAdminCommunityWriteSteps: Step[] = [
      {
        name: 'admin patch community rejects CSRF cross-site',
        method: 'PATCH',
        path: '/v2/community',
        expected: 403,
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        body: { name: 'CSRF Blocked' },
        check: forbiddenCheck,
      },
      {
        name: 'admin patch community rejects oversize description without echo',
        method: 'PATCH',
        path: '/v2/community',
        expected: 400,
        body: {
          description: `${qaSecretDescMarker}${'a'.repeat(DESCRIPTION_MAX_LENGTH)}`,
        },
        check: validationFieldCheck('description', qaSecretDescMarker),
      },
      {
        name: 'admin patch community rejects slug modification',
        method: 'PATCH',
        path: '/v2/community',
        expected: 400,
        body: { slug: 'tampered-slug' },
        check: validationFieldCheck('slug'),
      },
      {
        name: 'admin toggles private community visibility to public',
        method: 'PATCH',
        path: '/v2/community',
        expected: 200,
        body: {
          name: `${privateCommunityName} Public`,
          visibility: 'public',
        },
        check: (body) => {
          const parsed = CommunityReadDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.visibility === 'public' &&
            parsed.data.data.slug === privateCommunitySlug
          );
        },
      },
      {
        name: 'public community detail opens immediately after admin toggle',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}`,
        expected: 200,
        prepare: () =>
          assertPrivateVisibilityAudits(['community.visibility.public']),
        check: (body) => {
          const parsed = PublicCommunityDetailResponseSchema.safeParse(body);
          return parsed.success && parsed.data.data.id === privateCommunityId;
        },
      },
      {
        name: 'explore community detail opens immediately after admin toggle',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}`,
        expected: 200,
      },
      {
        name: 'admin map-config rejects invalid lat bounds swLat > neLat',
        method: 'PUT',
        path: '/v2/community/map-config',
        expected: 400,
        body: {
          southWestLatitude: 20,
          southWestLongitude: 10,
          northEastLatitude: 10,
          northEastLongitude: 20,
        },
        check: validationFieldCheck('southWestLatitude'),
      },
      {
        name: 'admin map-config rejects credential-bearing styleUrl without echo',
        method: 'PUT',
        path: '/v2/community/map-config',
        expected: 400,
        body: {
          styleUrl: `https://tiles.example.test/style.json?${qaCredentialKey}=${qaCredentialVal}`,
        },
        check: validationFieldCheck('styleUrl', qaCredentialVal),
      },
      {
        name: 'admin updates map-config with antimeridian wrap',
        method: 'PUT',
        path: '/v2/community/map-config',
        expected: 200,
        body: {
          styleUrl: 'https://tiles.example.test/styles/public/style.json',
          basemapStyle: 'satellite',
          centerLatitude: -16.5,
          centerLongitude: 179.0,
          southWestLatitude: -20.0,
          southWestLongitude: 170.0,
          northEastLatitude: -10.0,
          northEastLongitude: -170.0,
          zoom: 6,
        },
        check: (body) => {
          const parsed = PutCommunityMapConfigResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.southWestLongitude === 170.0 &&
            parsed.data.data.northEastLongitude === -170.0
          );
        },
      },
      {
        name: 'admin toggles community visibility back to private',
        method: 'PATCH',
        path: '/v2/community',
        expected: 200,
        body: {
          name: privateCommunityName,
          visibility: 'private',
        },
        check: (body) => {
          const parsed = CommunityReadDetailResponseSchema.safeParse(body);
          return parsed.success && parsed.data.data.visibility === 'private';
        },
      },
      {
        name: 'public community detail closes immediately after admin toggle',
        method: 'GET',
        path: `/v2/public/communities/${privateCommunitySlug}`,
        expected: 404,
        prepare: () =>
          assertPrivateVisibilityAudits([
            'community.visibility.public',
            'community.visibility.private',
          ]),
        check: publicNotFoundCheck,
      },
      {
        name: 'explore community detail closes immediately after admin toggle',
        method: 'GET',
        path: `/explore/communities/${privateCommunitySlug}`,
        expected: 404,
      },
      {
        name: 'admin creates temporary story in private community',
        method: 'POST',
        path: '/v2/stories',
        expected: 201,
        captureId: 'qaSlice8AdminStory',
        body: {
          title: 'QA Private Admin Story',
          visibility: 'editors',
        },
        check: (body) => {
          const parsed = StoryWriteResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.title === 'QA Private Admin Story' &&
            parsed.data.data.visibility === 'editors'
          );
        },
      },
      {
        name: 'admin deletes temporary story in private community',
        method: 'DELETE',
        path: '/v2/stories/{qaSlice8AdminStory}',
        expected: 204,
      },
    ];
    // Slice 9 media QA fixtures live in a dedicated PRIVATE community that no
    // Explore/read journey visits, so upload/attach/reorder/delete exercises
    // cannot change the exact public counts, points, or filter sets those
    // journeys pin. It has its own editor/admin/viewer/member accounts.
    const mediaCredentials: Record<
      'viewer' | 'member' | 'editor' | 'admin',
      { email: string }
    > = {
      viewer: { email: 'qa-media-viewer@example.test' },
      member: { email: 'qa-media-member@example.test' },
      editor: { email: 'qa-media-editor@example.test' },
      admin: { email: 'qa-media-admin@example.test' },
    };
    const [mediaCommunity] = await db
      .insert(communities)
      .values({
        name: 'QA media community',
        slug: 'qa-media-community',
        publicStories: false,
        isActive: true,
      })
      .returning();
    const mediaUserIds: Partial<Record<Role, number>> = {};
    for (const role of Object.keys(mediaCredentials) as Array<
      keyof typeof mediaCredentials
    >) {
      const [mediaUser] = await db
        .insert(users)
        .values({
          email: mediaCredentials[role].email,
          ...deriveUserIdentityColumns({
            email: mediaCredentials[role].email,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: `Media${role}`,
          role: sql`${role}`,
          communityId: mediaCommunity.id,
          isActive: true,
        })
        .returning();
      mediaUserIds[role] = mediaUser.id;
    }
    const [mediaStory] = await db
      .insert(stories)
      .values({
        title: 'QA media story',
        slug: 'qa-media-story',
        communityId: mediaCommunity.id,
        createdBy: mediaUserIds.editor!,
        privacyLevel: 'public',
      })
      .returning();
    const [mediaRestrictedStory] = await db
      .insert(stories)
      .values({
        title: 'QA media restricted story',
        slug: 'qa-media-restricted-story',
        communityId: mediaCommunity.id,
        createdBy: mediaUserIds.editor!,
        privacyLevel: 'public',
        isRestricted: true,
      })
      .returning();
    const [mediaPlace] = await db
      .insert(places)
      .values({
        name: 'QA media place',
        communityId: mediaCommunity.id,
        latitude: -3.4,
        longitude: -60.4,
      })
      .returning();
    const [mediaSpeaker] = await db
      .insert(speakers)
      .values({
        name: 'QA media speaker',
        communityId: mediaCommunity.id,
        isActive: true,
      })
      .returning();
    // Community map configuration so the admin static_map attachment has a
    // real owner row to authorize against.
    const mediaMapTimestamp = new Date();
    await db.insert(communityMapConfigs).values({
      communityId: mediaCommunity.id,
      styleUrl: 'https://tiles.example.test/media-style.json',
      basemapStyle: 'terrain',
      centerLatitude: -3.4,
      centerLongitude: -60.4,
      southWestLatitude: -4,
      southWestLongitude: -61,
      northEastLatitude: -2,
      northEastLongitude: -59,
      zoom: 8,
      pitch: 0,
      bearing: 0,
      threeDimensional: false,
      projection: 'mercator',
      staticMapFileId: null,
      createdAt: mediaMapTimestamp,
      updatedAt: mediaMapTimestamp,
    });
    // A media-community file already attached to its own story: a non-owner
    // member delete must be 403 (never a 404 existence oracle).
    const mediaGuardedStory = await db
      .insert(stories)
      .values({
        title: 'QA media guarded story',
        slug: 'qa-media-guarded-story',
        communityId: mediaCommunity.id,
        createdBy: mediaUserIds.editor!,
        privacyLevel: 'public',
      })
      .returning();
    const mediaGuardedBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const mediaGuardedFileId = crypto.randomUUID();
    // Slice 11a user-management community (#188): a private, active community
    // with its own accounts, so the user-management journeys can pin exact
    // list contents without disturbing the shared fixtures. Private like the
    // media community: no public-surface counts may move.
    const [userCommunity] = await db
      .insert(communities)
      .values({
        name: 'QA user community',
        slug: 'qa-user-management-community',
        publicStories: false,
        isActive: true,
      })
      .returning();
    const userCommunityCredentials = {
      admin: { email: 'qa-users-admin@example.test' },
      member: { email: 'qa-users-member@example.test' },
      viewer: { email: 'qa-users-viewer@example.test' },
    } as const;
    const userCommunityIds: Record<string, number> = {};
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const qaUsername = `qa_users_${role}`;
      const [qaUser] = await db
        .insert(users)
        .values({
          email: userCommunityCredentials[role].email,
          username: qaUsername,
          ...deriveUserIdentityColumns({
            email: userCommunityCredentials[role].email,
            username: qaUsername,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: `Users${role}`,
          role: sql`${role}`,
          communityId: userCommunity.id,
          isActive: true,
        })
        .returning();
      userCommunityIds[role] = qaUser.id;
    }
    // The verifier material for the account created through POST /v2/users,
    // so that account can log in with a device session in the journeys.
    const qaManagedDerivedKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    const qaManagedSalt = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    // A second material for the disabled-community recovery steps; built at
    // runtime like every other QA credential.
    const qaResetDerivedKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const qaResetSalt = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    // A distinct verifier for recovery redemption, so the persona proves the
    // redeem installs a NEW verifier (old password rejected, new accepted).
    const qaRecoveryRedeemDerivedKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    const mediaGuardedPath = `communities/${mediaCommunity.id}/media/${mediaGuardedFileId}`;
    await db.insert(files).values({
      id: mediaGuardedFileId,
      filename: `${mediaGuardedFileId}.png`,
      originalName: 'qa-guarded.png',
      path: mediaGuardedPath,
      storageKey: mediaGuardedPath,
      url: `/v2/media/${mediaGuardedFileId}`,
      mimeType: 'image/png',
      size: mediaGuardedBytes.byteLength,
      byteSize: mediaGuardedBytes.byteLength,
      uploadedBy: mediaUserIds.editor!,
      communityId: mediaCommunity.id,
      culturalRestrictions: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(attachments).values({
      communityId: mediaCommunity.id,
      fileId: mediaGuardedFileId,
      ownerType: 'story',
      ownerId: mediaGuardedStory[0]!.id,
      role: 'story_media',
      ordinal: 0,
      createdAt: new Date(),
    });

    // Slice 9 media journey helpers: multipart bodies are built at runtime
    // (no credential-shaped literals) and exercised identically by SQLite,
    // PostgreSQL, and the Workers/R2 build.
    const mediaPngBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    // 11 MiB exceeds the 10 MiB image cap and is small enough to stream in
    // every backend without allocating the 100 MiB request ceiling.
    const mediaOversizeBytes = (() => {
      const bytes = new Uint8Array(11 * 1024 * 1024);
      bytes.set(mediaPngBytes, 0);
      return bytes;
    })();
    const mediaWavBytes = (() => {
      const buf = new Uint8Array(44);
      buf.set(new TextEncoder().encode('RIFF'), 0);
      new DataView(buf.buffer).setUint32(4, 36, true);
      buf.set(new TextEncoder().encode('WAVEfmt '), 8);
      new DataView(buf.buffer).setUint32(16, 16, true);
      new DataView(buf.buffer).setUint16(20, 1, true);
      new DataView(buf.buffer).setUint16(22, 1, true);
      new DataView(buf.buffer).setUint32(24, 8000, true);
      new DataView(buf.buffer).setUint32(28, 8000, true);
      new DataView(buf.buffer).setUint16(32, 1, true);
      new DataView(buf.buffer).setUint16(34, 8, true);
      buf.set(new TextEncoder().encode('data'), 36);
      return buf;
    })();
    const qaMultipart = (options: {
      filename: string;
      contentType: string;
      bytes: Uint8Array;
      fields?: Record<string, string>;
    }): { rawBody: Uint8Array; headers: Record<string, string> } => {
      const boundary = `qa-bound-${Math.random().toString(16).slice(2)}`;
      const enc = new TextEncoder();
      const chunks: Uint8Array[] = [];
      for (const [key, value] of Object.entries(options.fields ?? {})) {
        chunks.push(
          enc.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
          )
        );
      }
      chunks.push(
        enc.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename}"\r\nContent-Type: ${options.contentType}\r\n\r\n`
        )
      );
      chunks.push(options.bytes);
      chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const rawBody = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        rawBody.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        rawBody,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
      };
    };
    const mediaUploadStagingCheck = (body: unknown): boolean => {
      const parsed = MediaUploadResponseSchema.safeParse(body);
      return (
        parsed.success &&
        parsed.data.data.attachment === null &&
        !('storageKey' in parsed.data.data)
      );
    };
    const mediaMetadataCheck = (body: unknown): boolean =>
      MediaMetadataResponseSchema.safeParse(body).success;
    let qaManagedUserId = 0;
    let qaIssuedLoginCode = '';
    let qaRecoveryCode = '';
    let qaOldRecoveryCode = '';
    let qaSupersededRecoveryCode = '';
    let redeemedAdminCookie = '';
    const qaIssuedRedeemBody = {
      code: '',
      communitySlug: 'qa-user-management-community',
    };
    const qaRecoveryRedeemBody = {
      code: '',
      identifier: userCommunityCredentials.admin.email,
      communitySlug: 'qa-user-management-community',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: verifierSalt,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: qaRecoveryRedeemDerivedKey,
      },
    };
    let userManagedSessionHandle = '';
    let qaStageFileId = '';
    let qaStageFile2Id = '';
    let qaAudioFileId = '';
    let qaStoryAttId = 0;
    let qaStoryAtt2Id = 0;
    let qaAdminFileId = '';
    let qaDisplayAttId = 0;
    let qaViewerFileId = '';
    let qaViewerAttId = 0;
    let qaMemberFileId = '';
    let qaSuperPhotoId = '';

    // Slice 11a (#188): the device-session revoke path is only known once
    // the list step ran, so `prepare` returns it for this run (the runner
    // honours a string return and cloned steps keep their own copy).
    const qaManagedRevokeStep: Step = {
      name: 'revoke managed account device session',
      method: 'DELETE',
      path: '/v2/users/pending',
      expected: 204,
      useSavedCookie: 'qaAdminCookie',
      prepare: () =>
        `/v2/users/${qaManagedUserId}/sessions/${userManagedSessionHandle}`,
    };
    // Cross-community negatives for a private-community admin (#188).
    const privateAdminUserManagementSteps: Step[] = [
      {
        name: 'deny cross-community user detail',
        method: 'GET',
        path: `/v2/users/${userCommunityIds.admin}`,
        expected: 404,
        check: publicNotFoundCheck,
      },
      {
        name: 'deny cross-community device session revoke',
        method: 'DELETE',
        path: `/v2/users/${userCommunityIds.admin}/sessions/abc123def456`,
        expected: 404,
        check: publicNotFoundCheck,
      },
    ];
    // Non-admin negatives on the whole user-management surface (#188).
    const userViewerForbiddenSteps: Step[] = [
      {
        name: 'deny user list',
        method: 'GET',
        path: '/v2/users',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny user detail',
        method: 'GET',
        path: `/v2/users/${userCommunityIds.admin}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny user create',
        method: 'POST',
        path: '/v2/users',
        expected: 403,
        body: {
          username: 'qa_viewer_denied',
          email: 'qa-viewer-denied@example.test',
          role: 'viewer',
        },
        check: forbiddenCheck,
      },
      {
        name: 'deny user update',
        method: 'PATCH',
        path: `/v2/users/${userCommunityIds.admin}`,
        expected: 403,
        body: { displayName: 'Denied' },
        check: forbiddenCheck,
      },
      {
        name: 'deny assisted password reset',
        method: 'POST',
        path: `/v2/users/${userCommunityIds.admin}/password-reset`,
        expected: 403,
        body: {
          algorithm: 'client-argon2id+sha256',
          salt: qaResetSalt,
          params: JSON.parse(ARGON2ID_PARAMS_JSON),
          derivedKey: qaResetDerivedKey,
        },
        check: forbiddenCheck,
      },
      {
        name: 'deny admin-issued login code',
        method: 'POST',
        path: `/v2/users/${userCommunityIds.admin}/login-codes`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny device session list',
        method: 'GET',
        path: `/v2/users/${userCommunityIds.admin}/sessions`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny device session revoke',
        method: 'DELETE',
        path: `/v2/users/${userCommunityIds.admin}/sessions/abc123def456`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny recovery code generation for viewer',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 403,
        body: {},
        check: forbiddenCheck,
      },
    ];
    const userAdminSteps: Step[] = [
      {
        name: 'login',
        method: 'POST',
        path: '/v2/auth/login',
        expected: 200,
        body: loginBody(userCommunityCredentials.admin.email),
        check: ownUser(
          userCommunityCredentials.admin.email,
          'admin',
          liveSessionCookie,
          userCommunity.id
        ),
      },
      {
        name: 'list community users without credentials',
        method: 'GET',
        path: '/v2/users',
        expected: 200,
        saveCookieAs: 'qaAdminCookie',
        check: (body) => {
          const parsed = body as {
            data?: Array<Record<string, unknown>>;
            meta?: { total?: number };
          };
          if (!Array.isArray(parsed?.data) || parsed.meta?.total !== 3)
            return false;
          const idsSeen = parsed.data
            .map((row) => Number(row.id))
            .sort((a, b) => a - b);
          const expectedIds = [
            userCommunityIds.admin,
            userCommunityIds.member,
            userCommunityIds.viewer,
          ].sort((a, b) => a - b);
          return (
            idsSeen.join(',') === expectedIds.join(',') &&
            parsed.data.every(
              (row) =>
                !('passwordVerifier' in row) &&
                !('passwordHash' in row) &&
                !('tokenHash' in row) &&
                !('passwordSalt' in row)
            )
          );
        },
      },
      {
        name: 'create community account',
        method: 'POST',
        path: '/v2/users',
        expected: 201,
        captureId: 'qaManagedUser',
        body: {
          username: 'qa_managed_user',
          email: 'qa-managed@example.test',
          displayName: 'QA Managed',
          role: 'member',
          password: {
            algorithm: 'client-argon2id+sha256',
            salt: qaManagedSalt,
            params: JSON.parse(ARGON2ID_PARAMS_JSON),
            derivedKey: qaManagedDerivedKey,
          },
        },
        check: (body) => {
          const data = (body as { data?: Record<string, unknown> })?.data;
          if (
            !data ||
            typeof data.id !== 'number' ||
            !Number.isSafeInteger(data.id)
          )
            return false;
          qaManagedUserId = data.id;
          return !('passwordVerifier' in data) && !('passwordHash' in data);
        },
      },
      {
        name: 'reject duplicate username',
        method: 'POST',
        path: '/v2/users',
        expected: 409,
        body: {
          username: 'qa_managed_user',
          email: 'qa-managed-dup@example.test',
          role: 'viewer',
        },
      },
      {
        name: 'reject community email duplicate',
        method: 'POST',
        path: '/v2/users',
        expected: 409,
        body: {
          username: 'qa_users_dup',
          email: 'qa-users-member@example.test',
          role: 'viewer',
        },
      },
      {
        name: 'reject email shared with null-community account',
        method: 'POST',
        path: '/v2/users',
        expected: 409,
        body: {
          username: 'qa_users_nullshare',
          email: 'qa-hono-super@example.test',
          role: 'viewer',
        },
      },
      {
        name: 'reject username matching another account email',
        method: 'POST',
        path: '/v2/users',
        expected: 409,
        body: {
          username: 'qa-users-admin@example.test',
          email: 'qa-users-username-email@example.test',
          role: 'viewer',
        },
      },
      {
        name: 'reject super_admin role',
        method: 'POST',
        path: '/v2/users',
        expected: 400,
        body: {
          username: 'qa_users_super',
          email: 'qa-users-super@example.test',
          role: 'super_admin',
        },
      },
      {
        name: 'list users after create',
        method: 'GET',
        path: '/v2/users',
        expected: 200,
        check: (body) => {
          const parsed = body as {
            data?: Array<{ id?: number }>;
            meta?: { total?: number };
          };
          return (
            parsed?.meta?.total === 4 &&
            Array.isArray(parsed?.data) &&
            parsed.data.length === 4 &&
            parsed.data.some((row) => row.id === qaManagedUserId)
          );
        },
      },
      {
        name: 'read managed account without credentials',
        method: 'GET',
        path: '/v2/users/{qaManagedUser}',
        expected: 200,
        check: (body) => {
          const data = (body as { data?: Record<string, unknown> })?.data;
          return (
            !!data &&
            data.id === qaManagedUserId &&
            data.role === 'member' &&
            !('passwordVerifier' in data) &&
            !('passwordHash' in data)
          );
        },
      },
      {
        name: 'promote managed account to editor',
        method: 'PATCH',
        path: '/v2/users/{qaManagedUser}',
        expected: 200,
        body: { role: 'editor' },
        check: (body) =>
          (body as { data?: { role?: unknown } })?.data?.role === 'editor',
      },
      {
        name: 'refuse login code issuance for own account',
        method: 'POST',
        path: `/v2/users/${userCommunityIds.admin}/login-codes`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'refuse assisted password reset for own account',
        method: 'POST',
        path: `/v2/users/${userCommunityIds.admin}/password-reset`,
        expected: 403,
        body: {
          algorithm: 'client-argon2id+sha256',
          salt: qaResetSalt,
          params: JSON.parse(ARGON2ID_PARAMS_JSON),
          derivedKey: qaResetDerivedKey,
        },
        check: forbiddenCheck,
      },
      {
        name: 'issue admin_issued login code',
        method: 'POST',
        path: '/v2/users/{qaManagedUser}/login-codes',
        expected: 201,
        check: (body) => {
          const data = (
            body as {
              data?: { code?: unknown; purpose?: unknown; expiresAt?: unknown };
            }
          )?.data;
          const code = data?.code;
          if (
            typeof code === 'string' &&
            /^[A-Za-z0-9_-]{20,64}$/.test(code) &&
            data?.purpose === 'admin_issued' &&
            typeof data?.expiresAt === 'string'
          ) {
            qaIssuedLoginCode = code;
            return true;
          }
          return false;
        },
      },
      {
        name: 'reset managed account password',
        method: 'POST',
        path: '/v2/users/{qaManagedUser}/password-reset',
        expected: 204,
        body: {
          algorithm: 'client-argon2id+sha256',
          salt: qaManagedSalt,
          params: JSON.parse(ARGON2ID_PARAMS_JSON),
          derivedKey: qaManagedDerivedKey,
        },
      },
      {
        name: 'managed account logs in with reset key and device session',
        method: 'POST',
        path: '/v2/auth/login',
        expected: 200,
        // An empty presented cookie: a cross-user login with the admin
        // cookie present would revoke that admin session (shared-browser
        // rule) and break the admin steps that follow.
        headers: { cookie: 'ts_session=' },
        body: {
          identifier: 'qa-managed@example.test',
          derivedKey: qaManagedDerivedKey,
          communitySlug: 'qa-user-management-community',
          deviceSession: true,
        },
        check: ownUser(
          'qa-managed@example.test',
          'editor',
          liveSessionCookie,
          userCommunity.id
        ),
      },
      {
        // The jar now carries the managed account's device session; save it
        // here so the post-revocation step can replay it.
        name: 'managed account reads own profile',
        method: 'GET',
        path: '/v2/auth/me',
        expected: 200,
        saveCookieAs: 'qaManagedCookie',
        check: ownMeUser(
          'qa-managed@example.test',
          'editor',
          liveSessionCookie,
          userCommunity.id,
          false
        ),
      },
      {
        name: 'list managed account device sessions as admin',
        method: 'GET',
        path: '/v2/users/{qaManagedUser}/sessions',
        expected: 200,
        useSavedCookie: 'qaAdminCookie',
        check: (body) => {
          const rows = (
            body as {
              data?: Array<{
                handle?: unknown;
                kind?: unknown;
                tokenHash?: unknown;
                id?: unknown;
              }>;
            }
          )?.data;
          if (!Array.isArray(rows) || rows.length !== 1) return false;
          const session = rows[0]!;
          if (session.kind !== 'device') return false;
          if (
            typeof session.handle !== 'string' ||
            session.handle.length !== 22
          )
            return false;
          // The raw session id (a token digest) never reaches the wire.
          if ('id' in session || 'tokenHash' in session) return false;
          userManagedSessionHandle = session.handle;
          return true;
        },
      },
      qaManagedRevokeStep,
      {
        name: 'list managed account device sessions as admin after revoke',
        method: 'GET',
        path: '/v2/users/{qaManagedUser}/sessions',
        expected: 200,
        useSavedCookie: 'qaAdminCookie',
        check: (body) => {
          const rows = (body as { data?: unknown[] })?.data;
          return Array.isArray(rows) && rows.length === 0;
        },
      },
      {
        name: 'revoked device session no longer authenticates',
        method: 'GET',
        path: '/v2/auth/me',
        expected: 401,
        useSavedCookie: 'qaManagedCookie',
      },
      {
        name: 'reject recovery code generation without current key on password session',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 401,
        useSavedCookie: 'qaAdminCookie',
        body: {},
        check: invalidCredentials,
      },
      {
        name: 'reject recovery code generation with wrong current password',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 401,
        useSavedCookie: 'qaAdminCookie',
        body: {
          currentDerivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
        },
        check: invalidCredentials,
      },
      {
        name: 'generate 10 recovery codes with current password step-up',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 201,
        useSavedCookie: 'qaAdminCookie',
        body: { currentDerivedKey: HONO_PERSONA_DERIVED_KEY },
        check: (body) => {
          const data = (
            body as {
              data?: {
                codes?: unknown;
                purpose?: unknown;
                createdAt?: unknown;
              };
            }
          )?.data;
          if (!data || data.purpose !== 'recovery') return false;
          if (typeof data.createdAt !== 'string') return false;
          if (!Array.isArray(data.codes) || data.codes.length !== 10)
            return false;
          const unique = new Set(data.codes);
          if (
            unique.size === 10 &&
            data.codes.every(
              (code) =>
                typeof code === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(code)
            )
          ) {
            qaRecoveryCode = data.codes[0] as string;
            qaSupersededRecoveryCode = data.codes[1] as string;
          }
          return (
            unique.size === 10 &&
            data.codes.every(
              (code) =>
                typeof code === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(code)
            ) &&
            !leaksSecret(body, liveSessionCookie)
          );
        },
      },
      {
        name: 'admin profile reflects confirmed recovery codes',
        method: 'GET',
        path: '/v2/auth/me',
        expected: 200,
        useSavedCookie: 'qaAdminCookie',
        check: ownMeUser(
          userCommunityCredentials.admin.email,
          'admin',
          liveSessionCookie,
          userCommunity.id,
          true
        ),
      },
      {
        name: 'reject unknown login code on recovery redeem',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 401,
        headers: { cookie: 'ts_session=' },
        body: { code: 'definitely-unknown-recovery-code-0000' },
        check: invalidCredentials,
      },
      {
        name: 'redeem recovery code',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 200,
        headers: { cookie: 'ts_session=' },
        prepare: () => {
          qaRecoveryRedeemBody.code = qaRecoveryCode;
        },
        body: qaRecoveryRedeemBody,
        check: ownUser(
          userCommunityCredentials.admin.email,
          'admin',
          liveSessionCookie,
          userCommunity.id
        ),
        checkHeaders: (headers) => {
          const sc = headers.get('set-cookie') ?? '';
          redeemedAdminCookie = sc.split(';')[0] ?? '';
          return true;
        },
      },
      {
        name: 'old admin session rejected after recovery redeem',
        method: 'GET',
        path: '/v2/auth/me',
        expected: 401,
        useSavedCookie: 'qaAdminCookie',
      },
      {
        name: 'old password rejected after recovery redeem',
        method: 'POST',
        path: '/v2/auth/login',
        expected: 401,
        headers: { cookie: 'ts_session=' },
        body: loginBody(userCommunityCredentials.admin.email),
        check: invalidCredentials,
      },
      {
        name: 'read own profile immediately after recovery redeem',
        method: 'GET',
        path: '/v2/auth/me',
        expected: 200,
        headers: {},
        prepare() {
          this.headers = { cookie: redeemedAdminCookie };
        },
        check: () => true,
      },
      {
        name: 'reject replay of consumed recovery code',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 401,
        headers: { cookie: 'ts_session=' },
        body: qaRecoveryRedeemBody,
        check: invalidCredentials,
      },
      {
        name: 'redeem admin_issued login code',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 200,
        headers: { cookie: 'ts_session=' },
        prepare: () => {
          qaIssuedRedeemBody.code = qaIssuedLoginCode;
        },
        body: qaIssuedRedeemBody,
        check: ownUser(
          'qa-managed@example.test',
          'editor',
          liveSessionCookie,
          userCommunity.id
        ),
      },
      {
        name: 'reject replay of consumed admin_issued login code',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 401,
        headers: { cookie: 'ts_session=' },
        body: qaIssuedRedeemBody,
        check: invalidCredentials,
      },
      {
        name: 'regenerate 10 recovery codes after redeem',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 201,
        headers: {},
        prepare() {
          this.headers = { cookie: redeemedAdminCookie };
        },
        body: { currentDerivedKey: qaRecoveryRedeemDerivedKey },
        check: (body) => {
          const data = (
            body as {
              data?: { codes?: unknown; purpose?: unknown };
            }
          )?.data;
          return (
            data?.purpose === 'recovery' &&
            Array.isArray(data?.codes) &&
            data.codes.length === 10
          );
        },
      },
      {
        name: 'reject superseded recovery code from prior sheet',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 401,
        headers: { cookie: 'ts_session=' },
        prepare: () => {
          qaRecoveryRedeemBody.code = qaSupersededRecoveryCode;
        },
        body: qaRecoveryRedeemBody,
        check: invalidCredentials,
      },
      {
        name: 'login again as user-management admin',
        method: 'POST',
        path: '/v2/auth/login',
        expected: 200,
        headers: { cookie: 'ts_session=' },
        body: {
          identifier: userCommunityCredentials.admin.email,
          derivedKey: qaRecoveryRedeemDerivedKey,
          communitySlug: 'qa-user-management-community',
        },
        check: ownUser(
          userCommunityCredentials.admin.email,
          'admin',
          liveSessionCookie,
          userCommunity.id
        ),
      },
      {
        name: 'logout',
        method: 'POST',
        path: '/v2/auth/logout',
        expected: 204,
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
          ...publicCommunities,
          {
            name: 'require authentication',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
          },
          {
            name: 'bootstrap is closed on seeded installation',
            method: 'GET',
            path: '/v2/bootstrap',
            expected: 200,
            check: (body) =>
              typeof body === 'object' &&
              body !== null &&
              Object.keys(body).length === 1 &&
              (body as { open?: unknown }).open === false,
          },
          {
            name: 'reject bootstrap replay on seeded installation',
            method: 'POST',
            path: '/v2/bootstrap',
            expected: 403,
            body: {
              community: { name: 'Replay Attempt' },
              admin: {
                username: 'replay_admin',
                email: 'replay-admin@example.test',
                password: {
                  algorithm: ARGON2ID_ALGORITHM,
                  salt: verifierSalt,
                  params: JSON.parse(ARGON2ID_PARAMS_JSON),
                  derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
                },
              },
            },
            check: (body) =>
              typeof body === 'object' &&
              body !== null &&
              (body as { error?: string }).error === 'Forbidden',
          },
          {
            name: 'reject unknown claim token uniformly',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.70',
              'cf-connecting-ip': '203.0.113.70',
            },
            body: {
              token: toBase64Url(crypto.getRandomValues(new Uint8Array(24))),
              username: 'claim_unknown_admin',
              email: 'claim-unknown@example.test',
              password: {
                algorithm: ARGON2ID_ALGORITHM,
                salt: verifierSalt,
                params: JSON.parse(ARGON2ID_PARAMS_JSON),
                derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
              },
            },
            check: invalidCredentials,
          },
          {
            name: 'require auth on v2 community reads',
            method: 'GET',
            path: '/v2/community',
            expected: 401,
          },
          {
            name: 'require auth on v2 stories reads',
            method: 'GET',
            path: '/v2/stories',
            expected: 401,
          },
          {
            name: 'require auth on v2 places reads',
            method: 'GET',
            path: '/v2/places',
            expected: 401,
          },
          {
            name: 'require auth on v2 speakers reads',
            method: 'GET',
            path: '/v2/speakers',
            expected: 401,
          },
          {
            name: 'reject wrong password',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.61',
              'cf-connecting-ip': '203.0.113.61',
            },
            body: {
              identifier: credentials.admin.email,
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            },
            check: invalidCredentials,
          },
          {
            name: 'reject unknown user identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.62',
              'cf-connecting-ip': '203.0.113.62',
            },
            body: {
              identifier: 'qa-hono-nobody@example.test',
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            },
            check: invalidCredentials,
          },
          {
            name: 'reject ambiguous email without locator identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.63',
              'cf-connecting-ip': '203.0.113.63',
            },
            body: {
              identifier: qaSharedEmail,
              derivedKey,
            },
            check: invalidCredentials,
          },
          {
            name: 'resolve ambiguous email with the communitySlug locator',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: {
              identifier: qaSharedEmail,
              derivedKey,
              communitySlug,
            },
            check: ownUser(
              qaSharedEmail,
              'viewer',
              liveSessionCookie,
              communityId
            ),
          },
          {
            name: 'login with the username identifier',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: {
              identifier: 'qa_hono_viewer',
              derivedKey,
            },
            check: ownUser(
              credentials.viewer.email,
              'viewer',
              liveSessionCookie,
              communityId
            ),
          },
          {
            // #137 Slice 10 (finding 1): a wrapped Rails-bcrypt account sends
            // the real bcrypt hash string as `derivedKey` and upgrades to
            // Argon2id atomically in the same request (SPEC-V2 §7 step 4).
            name: 'wrapped Rails-bcrypt account logs in with the hash string and upgrades',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: {
              identifier: wrappedCredentials.email,
              derivedKey: wrappedPasswordHash,
              upgrade: {
                algorithm: ARGON2ID_ALGORITHM,
                salt: verifierSalt,
                params: JSON.parse(ARGON2ID_PARAMS_JSON),
                derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
              },
            },
            check: ownUser(
              wrappedCredentials.email,
              'viewer',
              liveSessionCookie,
              communityId
            ),
          },
          {
            name: 'the upgraded account no longer accepts the bcrypt hash string',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.64',
              'cf-connecting-ip': '203.0.113.64',
            },
            body: {
              identifier: wrappedCredentials.email,
              derivedKey: wrappedPasswordHash,
            },
            check: invalidCredentials,
          },
          ...Array.from(
            { length: AUTH_THROTTLE_MAX_FAILURES },
            (_, attempt) => ({
              name: `throttled account wrong key ${attempt + 1}`,
              method: 'POST',
              path: '/v2/auth/login',
              expected: 401,
              // Both trusted-proxy forms, so the Node fixture (x-forwarded-for)
              // and the Workers build (cf-connecting-ip) isolate the same
              // dedicated address instead of the shared `unknown` bucket.
              headers: {
                'x-forwarded-for': throttledIp,
                'cf-connecting-ip': throttledIp,
              },
              body: {
                identifier: throttledCredentials.email,
                derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
              },
              check: invalidCredentials,
            })
          ),
          {
            // Finding H: once the counter reaches the threshold the correct
            // key is still refused, and no session is issued.
            name: 'a throttled account is refused even with the correct key',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': throttledIp,
              'cf-connecting-ip': throttledIp,
            },
            body: {
              identifier: throttledCredentials.email,
              derivedKey,
            },
            check: invalidCredentials,
          },
          {
            name: 'prelogin returns the stored verifier shape for a real account',
            method: 'POST',
            path: '/v2/auth/prelogin',
            expected: 200,
            body: { identifier: credentials.viewer.email },
            check: (body: unknown) => {
              const parsed = body as {
                algorithm?: unknown;
                salt?: unknown;
                params?: unknown;
              };
              return (
                Object.keys(parsed).sort().join(',') ===
                  'algorithm,params,salt' &&
                parsed.algorithm === ARGON2ID_ALGORITHM &&
                typeof parsed.salt === 'string' &&
                parsed.salt.length > 0 &&
                typeof parsed.params === 'object' &&
                parsed.params !== null
              );
            },
          },
          {
            name: 'prelogin fake answers unknown identifiers with the same shape',
            method: 'POST',
            path: '/v2/auth/prelogin',
            expected: 200,
            body: { identifier: 'qa-hono-nobody@example.test' },
            check: (body: unknown) => {
              const parsed = body as {
                algorithm?: unknown;
                salt?: unknown;
                params?: unknown;
              };
              return (
                Object.keys(parsed).sort().join(',') ===
                  'algorithm,params,salt' &&
                typeof parsed.algorithm === 'string' &&
                typeof parsed.salt === 'string' &&
                typeof parsed.params === 'object'
              );
            },
          },
          {
            // The fake is deterministic: the same identifier answers with
            // the same shape twice. Compare the two responses inside one
            // check by pinning the algorithm to a supported value and
            // asserting the salt is stable base64.
            name: 'prelogin fake is deterministic across requests',
            method: 'POST',
            path: '/v2/auth/prelogin',
            expected: 200,
            body: { identifier: 'qa-hono-nobody@example.test' },
            check: (body: unknown) => {
              const parsed = body as {
                algorithm?: unknown;
                salt?: unknown;
                params?: unknown;
              };
              return (
                (parsed.algorithm === ARGON2ID_ALGORITHM ||
                  parsed.algorithm === RAILS_BCRYPT_ALGORITHM) &&
                typeof parsed.salt === 'string' &&
                parsed.salt.length > 0 &&
                typeof parsed.params === 'object' &&
                parsed.params !== null
              );
            },
          },
          {
            name: 'prelogin fake is stable across two requests',
            method: 'POST',
            path: '/v2/auth/prelogin',
            expected: 200,
            body: { identifier: 'qa-hono-nobody@example.test' },
            check: (body: unknown) => {
              const parsed = body as { salt?: unknown };
              // The salt is derived from HMAC(secret, identifier): a second
              // identical request must produce the same salt. The previous
              // step's salt is captured by the runner's cookie-independent
              // determinism assertion below (see the fixture-level check).
              return typeof parsed.salt === 'string' && parsed.salt.length > 0;
            },
          },
          {
            // #137 Slice 10: the device-session opt-in is recorded as a
            // `device` session — the response cookie carries Max-Age = the
            // remaining absolute lifetime (the full 60 days at creation);
            // the session row remains the enforcement point.
            name: 'device session opt-in is issued with its remaining absolute lifetime',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: {
              identifier: credentials.viewer.email,
              derivedKey,
              deviceSession: true,
            },
            check: (body: unknown) =>
              ownUser(
                credentials.viewer.email,
                'viewer',
                liveSessionCookie,
                communityId
              )(body),
            checkHeaders: (headers) => {
              const setCookie = headers.get('set-cookie') ?? '';
              // A device login must survive a browser restart, so the cookie
              // carries the remaining absolute lifetime — the full 60 days at
              // creation; the session row is still the enforcement point.
              return (
                setCookie.includes('ts_session=') &&
                /Max-Age=5184000/i.test(setCookie)
              );
            },
          },
          {
            name: 'reject disabled community viewer identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.65',
              'cf-connecting-ip': '203.0.113.65',
            },
            body: loginBody(disabledViewerCredentials.email),
            check: invalidCredentials,
          },
          {
            name: 'reject disabled community member identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.66',
              'cf-connecting-ip': '203.0.113.66',
            },
            body: loginBody(disabledMemberCredentials.email),
            check: invalidCredentials,
          },
          {
            name: 'reject disabled community editor identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.67',
              'cf-connecting-ip': '203.0.113.67',
            },
            body: loginBody(disabledEditorCredentials.email),
            check: invalidCredentials,
          },
          {
            name: 'reject legacy elder role identically',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.68',
              'cf-connecting-ip': '203.0.113.68',
            },
            body: loginBody(elderCredentials.email),
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
            body: loginBody(credentials[role].email),
            check: ownUser(
              credentials[role].email,
              role,
              liveSessionCookie,
              communityId
            ),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownMeUser(
              credentials[role].email,
              role,
              liveSessionCookie,
              communityId,
              false
            ),
          },
          // #191 option A across the full claimed matrix: member — the
          // persona whose canonical role would grant the community audience —
          // joins editor and community admin in driving the authenticated
          // Explore steps, so the stories list (exact ids), community detail
          // (counts/points/filters) and the members-only 404 hold for every
          // role the README names, each while authenticated.
          ...(role === 'member' || role === 'editor' || role === 'admin'
            ? [...exploreWithSession, ...publicCommunitiesWithSession]
            : []),
          ...communityReadsStepsFor(role),
          ...(role === 'viewer' || role === 'member'
            ? forbiddenCommunityWriteSteps
            : []),
          ...(role === 'editor' ? editorCommunityWriteSteps : []),
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
            // #188: re-login with the live cookie rotates the session row
            // (same user, unexpired) on every backend — including the atomic
            // D1 batch path on Workers.
            name: 'rotate own session by re-login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(credentials[role].email),
            check: ownUser(credentials[role].email, role, liveSessionCookie),
          },
          ...(role === 'admin'
            ? [
                {
                  // #188 shared-browser login: signing in as another user
                  // over the live admin cookie binds the new user's own
                  // fresh session and revokes the presented one.
                  name: 'take over live session by cross-user login',
                  method: 'POST',
                  path: '/v2/auth/login',
                  expected: 200,
                  body: loginBody(credentials.viewer.email),
                  saveCookieAs: 'pre-takeover',
                  check: ownUser(
                    credentials.viewer.email,
                    'viewer',
                    liveSessionCookie
                  ),
                },
                {
                  name: 'reject pre-takeover admin cookie',
                  method: 'GET',
                  path: '/v2/auth/me',
                  expected: 401,
                  useSavedCookie: 'pre-takeover',
                },
              ]
            : []),
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
            body: loginBody(credentials[role].email),
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
      ...(['viewer', 'member', 'editor', 'admin'] as const).map((role) => ({
        persona: `private_${role}`,
        steps: [
          {
            name: 'login to active private community',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(privateCredentials[role].email),
            check: ownUser(
              privateCredentials[role].email,
              role,
              liveSessionCookie,
              privateCommunityId
            ),
          },
          ...privateCommunityReadsStepsFor(role),
          ...(role === 'admin'
            ? [
                ...privateAdminCommunityWriteSteps,
                ...privateAdminUserManagementSteps,
              ]
            : []),
          {
            name: 'logout private community user',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
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
            body: loginBody(credentials.super_admin.email),
            check: ownUser(
              credentials.super_admin.email,
              'super_admin',
              liveSessionCookie,
              null
            ),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownMeUser(
              credentials.super_admin.email,
              'super_admin',
              liveSessionCookie,
              null,
              false
            ),
          },
          // #137 Slice 10: self-service profile edit. Only the display name
          // is writable; privileged fields are rejected by the strict schema
          // and never take effect.
          {
            name: 'patch own display name',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 200,
            body: { displayName: 'QA Super Admin Renamed' },
            check: (body) =>
              ownUser(
                credentials.super_admin.email,
                'super_admin',
                liveSessionCookie,
                null
              )(body) &&
              (body as { user?: { displayName?: unknown } }).user
                ?.displayName === 'QA Super Admin Renamed',
          },
          {
            name: 'reject patch of privileged fields',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 400,
            body: { displayName: 'x', role: 'admin' },
          },
          {
            name: 'reject patch of communityId',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 400,
            body: { communityId },
          },
          {
            name: 'reject unauthenticated profile patch',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 401,
            // An explicitly empty cookie header suppresses the tracked
            // session cookie, so the request is genuinely unauthenticated.
            headers: { cookie: '' },
            body: { displayName: 'nope' },
          },
          // #137 Slice 10: self-service password change re-verifies the
          // current key, writes the new verifier atomically and revokes the
          // account's other sessions.
          {
            name: 'change own password',
            method: 'POST',
            path: '/v2/auth/password',
            expected: 200,
            body: {
              currentDerivedKey: derivedKey,
              algorithm: ARGON2ID_ALGORITHM,
              salt: verifierSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: superAdminNewKey,
            },
            checkHeaders: (headers) =>
              (headers.get('set-cookie') ?? '').includes('ts_session='),
          },
          {
            name: 'reject password change with the wrong current key',
            method: 'POST',
            path: '/v2/auth/password',
            expected: 401,
            body: {
              currentDerivedKey: toHex(
                crypto.getRandomValues(new Uint8Array(32))
              ),
              algorithm: ARGON2ID_ALGORITHM,
              salt: verifierSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            },
            check: invalidCredentials,
          },
          {
            name: 'reject password change below the Argon2id policy',
            method: 'POST',
            path: '/v2/auth/password',
            expected: 400,
            body: {
              currentDerivedKey: superAdminNewKey,
              algorithm: ARGON2ID_ALGORITHM,
              salt: verifierSalt,
              params: { memoryKiB: 1024, iterations: 1, parallelism: 1 },
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            },
          },
          {
            name: 'old password no longer authenticates after the change',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.69',
              'cf-connecting-ip': '203.0.113.69',
            },
            body: loginBody(credentials.super_admin.email),
            check: invalidCredentials,
          },
          {
            name: 'new password authenticates after the change',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: {
              identifier: credentials.super_admin.email,
              derivedKey: superAdminNewKey,
            },
            check: ownUser(
              credentials.super_admin.email,
              'super_admin',
              liveSessionCookie,
              null
            ),
          },
          // Explore with a session: super_admin sees the same anonymous
          // projection; privilege never widens the public surface.
          ...exploreWithSession,
          ...publicCommunitiesWithSession,
          ...forbiddenCommunityReadSteps,
          ...forbiddenCommunityWriteSteps,
          {
            // Null-community super_admin cannot read any community branding
            // asset via /v2/media/:id, even an active public community's file.
            name: 'deny readable community branding media',
            method: 'GET',
            path: `/v2/media/${readableFileId}`,
            expected: 404,
          },
          {
            // Cultural restrictions withhold this file even from the highest
            // role, inside the system community.
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
        // Own-community admin of a DISABLED community (#137 Slice 3b):
        // permitted to authenticate and hold a session (/v2/auth/me) for the
        // sovereignty surface, while all media/content routes stay denied.
        persona: 'disabled_admin',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(disabledAdminCredentials.email),
            check: ownUser(
              disabledAdminCredentials.email,
              'admin',
              liveSessionCookie,
              inactiveCommunity.id
            ),
          },
          {
            name: 'read own profile without secrets',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ownMeUser(
              disabledAdminCredentials.email,
              'admin',
              liveSessionCookie,
              inactiveCommunity.id,
              false
            ),
          },
          {
            name: 'deny own disabled community branding media',
            method: 'GET',
            path: `/v2/media/${inactiveFileId}`,
            expected: 404,
          },
          {
            name: 'deny active community branding media',
            method: 'GET',
            path: `/v2/media/${readableFileId}`,
            expected: 404,
          },
          {
            // #188: assisted recovery is the authentication surface, so it
            // stays available while the community is disabled.
            name: 'reset disabled community member password',
            method: 'POST',
            path: `/v2/users/${disabledMemberId}/password-reset`,
            expected: 204,
            body: {
              algorithm: 'client-argon2id+sha256',
              salt: qaResetSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: qaResetDerivedKey,
            },
          },
          {
            name: 'issue admin_issued code for disabled community member',
            method: 'POST',
            path: `/v2/users/${disabledMemberId}/login-codes`,
            expected: 201,
            check: (body) => {
              const data = (
                body as {
                  data?: { code?: unknown; purpose?: unknown };
                }
              )?.data;
              return (
                data?.purpose === 'admin_issued' &&
                typeof data?.code === 'string' &&
                /^[A-Za-z0-9_-]{20,64}$/.test(data.code)
              );
            },
          },
          {
            name: 'deny user list while community is disabled',
            method: 'GET',
            path: '/v2/users',
            expected: 403,
            check: forbiddenCheck,
          },
          {
            name: 'hide inactive community detail while authenticated',
            method: 'GET',
            path: `/explore/communities/${inactiveCommunity.slug}`,
            expected: 404,
          },
          ...forbiddenCommunityReadSteps,
          ...forbiddenCommunityWriteSteps,
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            saveCookieAs: 'disabled-admin-pre-logout',
          },
          {
            name: 'reject replayed cookie after logout',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'disabled-admin-pre-logout',
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
            body: loginBody(foreignViewerCredentials.email),
            check: ownUser(
              foreignViewerCredentials.email,
              'viewer',
              liveSessionCookie,
              foreignCommunityId
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
          {
            name: 'v2 community scopes strictly to own foreign community',
            method: 'GET',
            path: `/v2/community?communityId=${communityId}`,
            expected: 200,
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.id === foreignCommunityId &&
                parsed.data.data.slug === foreignCommunitySlug
              );
            },
          },
          {
            name: 'v2 stories lists only own foreign story',
            method: 'GET',
            path: '/v2/stories',
            expected: 200,
            check: (body) => {
              const parsed = CommunityStoriesListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.meta.total === 1 &&
                parsed.data.data.stories.map((s) => s.id).join(',') ===
                  String(foreignStory.id)
              );
            },
          },
          {
            name: 'v2 story detail denies primary community story',
            method: 'GET',
            path: `/v2/stories/${publicStory.id}`,
            expected: 404,
            check: publicNotFoundCheck,
          },
          {
            name: 'v2 place detail denies primary community place',
            method: 'GET',
            path: `/v2/places/${publicPlace.id}`,
            expected: 404,
            check: publicNotFoundCheck,
          },
          {
            name: 'v2 speaker detail denies primary community speaker',
            method: 'GET',
            path: `/v2/speakers/${speaker.id}`,
            expected: 404,
            check: publicNotFoundCheck,
          },
          ...publicCommunitiesWithSession,
        ],
      },
      {
        // Slice 9 media journeys: every new route reached with success and
        // adversarial paths on the same shared SQLite/PostgreSQL/Workers app.
        persona: 'media_editor',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(mediaCredentials.editor.email),
            check: ownUser(
              mediaCredentials.editor.email,
              'editor',
              liveSessionCookie,
              mediaCommunity.id
            ),
          },
          {
            name: 'upload private staging media',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaStageFile',
            ...qaMultipart({
              filename: 'qa-still.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaStageFileId = parsed.data.data.id;
              return (
                parsed.data.data.attachment === null &&
                !('storageKey' in parsed.data.data)
              );
            },
          },
          {
            name: 'read staging metadata without storage key',
            method: 'GET',
            path: '/v2/media/{qaStageFile}/metadata',
            expected: 200,
            check: mediaMetadataCheck,
          },
          {
            name: 'reject magic-byte/type mismatch on upload',
            method: 'POST',
            path: '/v2/media',
            expected: 400,
            ...qaMultipart({
              filename: 'qa-spoof.mp3',
              contentType: 'audio/mpeg',
              bytes: mediaPngBytes,
            }),
          },
          // The real-HTTP transport cannot send an 11 MiB body and keep the
          // connection reusable after the server answers 413 without draining
          // it; the 100 MiB Content-Length cap and the per-category cap are
          // covered by tests/hono/media-files.test.ts. Exercise the streamed
          // per-category cap on the in-process and Workers transports.
          ...(transport === 'http'
            ? []
            : [
                {
                  name: 'reject oversize request',
                  method: 'POST',
                  path: '/v2/media',
                  expected: 413,
                  ...qaMultipart({
                    filename: 'qa-big.png',
                    contentType: 'image/png',
                    bytes: mediaOversizeBytes,
                  }),
                },
              ]),
          {
            name: 'attach first story media',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            captureId: 'qaStoryAtt',
            body: {
              fileId: '{qaStageFile}',
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
            },
            check: (body) => {
              const parsed = AttachmentResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaStoryAttId = parsed.data.data.id;
              return (
                parsed.data.data.ownerType === 'story' &&
                parsed.data.data.ownerId === mediaStory.id &&
                parsed.data.data.role === 'story_media' &&
                parsed.data.data.ordinal === 0
              );
            },
          },
          {
            name: 'upload second staging media',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaStageFile2',
            ...qaMultipart({
              filename: 'qa-second.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaStageFile2Id = parsed.data.data.id;
              return parsed.data.data.attachment === null;
            },
          },
          {
            name: 'attach second story media with deterministic ordinal',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            captureId: 'qaStoryAtt2',
            body: {
              fileId: '{qaStageFile2}',
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
            },
            check: (body) => {
              const parsed = AttachmentResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaStoryAtt2Id = parsed.data.data.id;
              return parsed.data.data.ordinal === 1;
            },
          },
          {
            name: 'reorder story media within one owner and role',
            method: 'PATCH',
            path: '/v2/attachments/reorder',
            expected: 200,
            body: {
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
              attachmentIds: ['{qaStoryAtt2}', '{qaStoryAtt}'],
            },
            check: (body) => {
              const parsed = AttachmentListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.map((row) => row.id).join(',') ===
                  `${qaStoryAtt2Id},${qaStoryAttId}` &&
                parsed.data.data.map((row) => row.ordinal).join(',') === '0,1'
              );
            },
          },
          {
            name: 'reject another community file',
            method: 'POST',
            path: '/v2/attachments',
            expected: 404,
            body: {
              fileId: foreignFileId,
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
            },
          },
          {
            name: 'reject restricted story owner',
            method: 'POST',
            path: '/v2/attachments',
            expected: 404,
            body: {
              fileId: '{qaStageFile2}',
              ownerType: 'story',
              ownerId: mediaRestrictedStory.id,
              role: 'story_media',
            },
          },
          {
            name: 'upload place-name audio',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaAudioFile',
            ...qaMultipart({
              filename: 'qa-place.wav',
              contentType: 'audio/wav',
              bytes: mediaWavBytes,
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaAudioFileId = parsed.data.data.id;
              return parsed.data.data.mimeType === 'audio/wav';
            },
          },
          {
            name: 'attach place-name audio',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            body: {
              fileId: '{qaAudioFile}',
              ownerType: 'place',
              ownerId: mediaPlace.id,
              role: 'place_name_audio',
            },
          },
          {
            name: 'attach place photo',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            body: {
              fileId: '{qaStageFile2}',
              ownerType: 'place',
              ownerId: mediaPlace.id,
              role: 'place_photo',
            },
          },
          {
            name: 'reject image bytes for an audio-only role',
            method: 'POST',
            path: '/v2/attachments',
            expected: 400,
            body: {
              fileId: '{qaStageFile2}',
              ownerType: 'place',
              ownerId: mediaPlace.id,
              role: 'place_name_audio',
            },
          },
          {
            name: 'upload speaker photo',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaSpeakerFile',
            ...qaMultipart({
              filename: 'qa-speaker.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
          },
          {
            name: 'attach speaker photo',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            captureId: 'qaSpeakerAtt',
            body: {
              fileId: '{qaSpeakerFile}',
              ownerType: 'speaker',
              ownerId: mediaSpeaker.id,
              role: 'speaker_photo',
            },
          },
          {
            name: 'reject community branding attach for an editor',
            method: 'POST',
            path: '/v2/attachments',
            expected: 403,
            body: {
              fileId: '{qaStageFile}',
              ownerType: 'community',
              ownerId: mediaCommunity.id,
              role: 'community_display_image',
            },
          },
          {
            name: 'detach first story media',
            method: 'DELETE',
            path: '/v2/attachments/{qaStoryAtt}',
            expected: 204,
          },
          {
            name: 'detach second story media',
            method: 'DELETE',
            path: '/v2/attachments/{qaStoryAtt2}',
            expected: 204,
          },
          {
            // Detaching the last relation already removed the files row and
            // bytes; the explicit delete now finds nothing (§6.7 inline cleanup).
            name: 'delete already-removed staging bytes is 404',
            method: 'DELETE',
            path: '/v2/media/{qaStageFile}',
            expected: 404,
          },
          {
            name: 'detach speaker photo',
            method: 'DELETE',
            path: '/v2/attachments/{qaSpeakerAtt}',
            expected: 204,
          },
          {
            // Detaching the last relation already removed the files row and
            // bytes; the explicit delete now finds nothing (§6.7 inline cleanup).
            name: 'delete already-removed speaker bytes is 404',
            method: 'DELETE',
            path: '/v2/media/{qaSpeakerFile}',
            expected: 404,
          },
          {
            name: 'upload staging media for an explicit delete',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaDeleteFile',
            ...qaMultipart({
              filename: 'qa-delete.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
          },
          {
            // The explicit delete of a still-referenced file must succeed and
            // remove both the row and its bytes on every backend.
            name: 'delete staging media removes its bytes',
            method: 'DELETE',
            path: '/v2/media/{qaDeleteFile}',
            expected: 204,
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
        persona: 'media_admin',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(mediaCredentials.admin.email),
            check: ownUser(
              mediaCredentials.admin.email,
              'admin',
              liveSessionCookie,
              mediaCommunity.id
            ),
          },
          {
            name: 'upload admin staging media',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaAdminFile',
            ...qaMultipart({
              filename: 'qa-admin.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaAdminFileId = parsed.data.data.id;
              return true;
            },
          },
          {
            name: 'admin attaches another member user photo',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            body: {
              fileId: '{qaAdminFile}',
              ownerType: 'user',
              ownerId: mediaUserIds.member!,
              role: 'user_photo',
            },
          },
          {
            name: 'admin attaches community display image',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            captureId: 'qaDisplayAtt',
            body: {
              fileId: '{qaAdminFile}',
              ownerType: 'community',
              ownerId: mediaCommunity.id,
              role: 'community_display_image',
            },
            check: (body) => {
              const parsed = AttachmentResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaDisplayAttId = parsed.data.data.id;
              return true;
            },
          },
          {
            name: 'admin attaches sponsor logo',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            body: {
              fileId: '{qaAdminFile}',
              ownerType: 'community',
              ownerId: mediaCommunity.id,
              role: 'sponsor_logo',
            },
          },
          {
            name: 'admin attaches static map image',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            body: {
              fileId: '{qaAdminFile}',
              ownerType: 'map_config',
              ownerId: mediaCommunity.id,
              role: 'static_map',
            },
          },
          {
            name: 'admin detaches community display image',
            method: 'DELETE',
            path: '/v2/attachments/{qaDisplayAtt}',
            expected: 204,
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
        persona: 'media_viewer',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(mediaCredentials.viewer.email),
            check: ownUser(
              mediaCredentials.viewer.email,
              'viewer',
              liveSessionCookie,
              mediaCommunity.id
            ),
          },
          {
            name: 'reject untyped staging upload',
            method: 'POST',
            path: '/v2/media',
            expected: 403,
            ...qaMultipart({
              filename: 'qa-viewer.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
          },
          {
            name: 'upload own profile photo',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaViewerFile',
            ...qaMultipart({
              filename: 'qa-viewer-avatar.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
              fields: { role: 'user_photo' },
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaViewerFileId = parsed.data.data.id;
              qaViewerAttId = parsed.data.data.attachment?.id ?? 0;
              return (
                parsed.data.data.attachment?.ownerId === mediaUserIds.viewer &&
                parsed.data.data.attachment?.role === 'user_photo'
              );
            },
          },
          {
            name: 'reject attachment create for a viewer',
            method: 'POST',
            path: '/v2/attachments',
            expected: 403,
            body: {
              fileId: '{qaViewerFile}',
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
            },
          },
          {
            name: 'reject reorder for a viewer',
            method: 'PATCH',
            path: '/v2/attachments/reorder',
            expected: 403,
            body: {
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
              attachmentIds: [1],
            },
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
        persona: 'media_member',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(mediaCredentials.member.email),
            check: ownUser(
              mediaCredentials.member.email,
              'member',
              liveSessionCookie,
              mediaCommunity.id
            ),
          },
          {
            name: 'reject untyped staging upload',
            method: 'POST',
            path: '/v2/media',
            expected: 403,
            ...qaMultipart({
              filename: 'qa-member.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
          },
          {
            name: 'upload own profile photo',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaMemberFile',
            ...qaMultipart({
              filename: 'qa-member-avatar.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
              fields: { role: 'user_photo' },
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaMemberFileId = parsed.data.data.id;
              return (
                parsed.data.data.attachment?.ownerId === mediaUserIds.member
              );
            },
          },
          {
            name: 'reject attachment create for a member',
            method: 'POST',
            path: '/v2/attachments',
            expected: 403,
            body: {
              fileId: '{qaMemberFile}',
              ownerType: 'place',
              ownerId: mediaPlace.id,
              role: 'place_photo',
            },
          },
          {
            name: 'reject story media delete for a member',
            method: 'DELETE',
            path: `/v2/media/${mediaGuardedFileId}`,
            expected: 403,
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
        persona: 'media_super_admin',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            // The super_admin persona changed this account's key earlier in
            // the journeys; log in with the replacement key.
            body: {
              identifier: credentials.super_admin.email,
              derivedKey: superAdminNewKey,
            },
            check: ownUser(
              credentials.super_admin.email,
              'super_admin',
              liveSessionCookie,
              null
            ),
          },
          {
            name: 'reject untyped staging upload',
            method: 'POST',
            path: '/v2/media',
            expected: 403,
            ...qaMultipart({
              filename: 'qa-super.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
            }),
          },
          {
            name: 'reject non-photo typed staging upload',
            method: 'POST',
            path: '/v2/media',
            expected: 403,
            ...qaMultipart({
              filename: 'qa-super-story.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
              fields: { role: 'story_media' },
            }),
          },
          {
            name: 'upload super admin own profile photo',
            method: 'POST',
            path: '/v2/media',
            expected: 201,
            captureId: 'qaSuperPhoto',
            ...qaMultipart({
              filename: 'qa-super-avatar.png',
              contentType: 'image/png',
              bytes: mediaPngBytes,
              fields: { role: 'user_photo' },
            }),
            check: (body) => {
              const parsed = MediaUploadResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaSuperPhotoId = parsed.data.data.id;
              return parsed.data.data.attachment?.role === 'user_photo';
            },
          },
          {
            name: 'reject community story attachment from null-community owner',
            method: 'POST',
            path: '/v2/attachments',
            expected: 403,
            body: {
              fileId: '{qaSuperPhoto}',
              ownerType: 'story',
              ownerId: mediaStory.id,
              role: 'story_media',
            },
          },
          {
            name: 'reject community file for null-community attachment',
            method: 'POST',
            path: '/v2/attachments',
            expected: 404,
            body: {
              fileId: readableFileId,
              ownerType: 'user',
              ownerId: communityUserIds.super_admin!,
              role: 'user_photo',
            },
          },
          {
            name: 'read own profile photo',
            method: 'GET',
            path: '/v2/media/{qaSuperPhoto}',
            expected: 200,
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
        // Slice 11a user-management journey (#188): the admin of the private
        // user-management community drives user CRUD, identity-collision
        // rejection, assisted recovery and device-session list/revoke end to
        // end on the same shared SQLite/PostgreSQL/Workers app.
        persona: 'user_admin',
        steps: userAdminSteps,
      },
      {
        // Non-admin negatives on the user-management surface (#188).
        persona: 'user_viewer',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(userCommunityCredentials.viewer.email),
            check: ownUser(
              userCommunityCredentials.viewer.email,
              'viewer',
              liveSessionCookie,
              userCommunity.id
            ),
          },
          ...userViewerForbiddenSteps,
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
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
      contract: 'canonical-v2' as const,
      ...(handler ? { handler } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      routes,
      journeys,
      exclusions: [],
      sessionCookieName: 'ts_session',
      close: async () => {
        // Run both cleanups even if the first fails, and report every
        // failure instead of letting the second hide the first.
        const errors: unknown[] = [];
        try {
          await closeActiveServer();
        } catch (error) {
          errors.push(error);
        }
        try {
          if (backend) await backend.close();
          else await qa!.close();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, 'Persona fixture cleanup failed');
      },
    };
  } catch (error) {
    try {
      await closeActiveServer();
    } catch {
      // Cleanup errors must never mask the setup error.
    }
    try {
      if (backend) await backend.close();
      else await qa!.close();
    } catch {
      // Cleanup errors must never mask the setup error.
    }
    throw error;
  }
}
