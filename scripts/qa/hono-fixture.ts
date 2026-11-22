import { CommunityErasureService } from '../../src/services/community-erasure.service.js';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import type { ErasureRecord } from '../../src/services/erasure-record-store.js';
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
import { and, asc, desc, eq, like, sql } from 'drizzle-orm';
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
  ImportManifestDetailResponseSchema,
  ImportManifestListResponseSchema,
} from '../../src/shared/schemas/imports.js';
import {
  AttachmentListResponseSchema,
  AttachmentResponseSchema,
  MediaMetadataResponseSchema,
  MediaUploadResponseSchema,
} from '../../src/shared/schemas/media-v2.js';
import { CreateCommunityExportResponseSchema } from '../../src/shared/schemas/community-export.js';
import {
  BootstrapResponseSchema,
  BootstrapStatusResponseSchema,
} from '../../src/shared/schemas/bootstrap.js';
import {
  AdminAuditEntryListResponseSchema,
  AdminCommunityListResponseSchema,
  AdminCommunityResponseSchema,
  ClaimTokenIssuedResponseSchema,
} from '../../src/shared/schemas/admin.js';
import {
  CommunityAuditEntrySchema,
  CommunityAuditEntriesListResponseSchema,
} from '../../src/shared/schemas/community-audit.js';
import {
  CommunitySovereigntyStatusResponseSchema,
  PutCommunityStewardResponseSchema,
  CommunityWithdrawalResponseSchema,
  CancelSovereigntyResponseSchema,
  CommunityErasureResponseSchema,
} from '../../src/shared/schemas/community-sovereignty.js';
import { EXPORT_TOKEN_TTL_MS } from '../../src/shared/export-policy.js';
import { parseDeterministicZip } from '../../src/shared/utils/deterministic-zip.js';
import { StreamingSha256 } from '../../src/shared/utils/sha256-stream.js';
import { DESCRIPTION_MAX_LENGTH } from '../../src/shared/utils/safe-description.js';
import { validateContentFreeAuditEntry } from '../../src/shared/utils/audit-entry.js';
import {
  ADMIN_ISSUED_CODE_TTL_MS,
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
  AUTH_THROTTLE_MAX_FAILURES,
  RAILS_BCRYPT_ALGORITHM,
  RECOVERY_CODE_COUNT,
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

const uniformForbidden = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  Object.keys(body as object).length === 1 &&
  (body as { error?: unknown }).error === 'Forbidden';

const bootstrapOpenCheck =
  (expectedOpen: boolean) =>
  (body: unknown): boolean => {
    const parsed = BootstrapStatusResponseSchema.safeParse(body);
    return (
      parsed.success &&
      typeof body === 'object' &&
      body !== null &&
      Object.keys(body as object).length === 1 &&
      parsed.data.open === expectedOpen
    );
  };

const validRecoverySheet = (codes: unknown): boolean =>
  Array.isArray(codes) &&
  codes.length === RECOVERY_CODE_COUNT &&
  new Set(codes).size === RECOVERY_CODE_COUNT &&
  codes.every(
    (code) => typeof code === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(code)
  );

const hasSessionCookie = (headers: Headers): boolean =>
  headers.getSetCookie().some((value) => {
    const setting = value.split(';')[0]!.trim();
    return setting.startsWith('ts_session=') && setting !== 'ts_session=';
  });

const hasNoSessionCookie = (headers: Headers): boolean =>
  headers.getSetCookie().every((value) => !value.includes('ts_session='));

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
  'QA inactive restricted story',
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
  hasMedia?: (key: string) => Promise<boolean>;
  runErasureSweep?: () => Promise<void>;
  /**
   * The served app enforces the recovery-code gate (#254), so the backend
   * seeds an active recovery code for every community administrator and
   * `GET /v2/auth/me` reports `recoveryCodesConfirmed: true` for them.
   */
  seededAdminsHaveRecoveryCodes?: boolean;
  handler: (observeResponseCookies: (response: Response) => void) => Handler;
  /**
   * Isolated fresh-installation runtime with an unseeded migrated database and
   * its own operator BOOTSTRAP_SECRET for GET/POST /v2/bootstrap QA.
   */
  freshBootstrap: {
    bootstrapSecret: string;
    handler: (observeResponseCookies: (response: Response) => void) => Handler;
  };
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
  const hasMedia: (key: string) => Promise<boolean> = backend?.hasMedia
    ? backend.hasMedia
    : async (key) => storage.has(key);
  const isD1Backend = typeof (db as { batch?: unknown }).batch === 'function';
  const {
    attachments,
    auditEntries,
    claimTokens,
    communities,
    communityMapConfigs,
    communitySovereigntyRequests,
    exportJobs,
    exportTokens,
    users,
    places,
    speakers,
    stories,
    storyPlaces,
    storySpeakers,
    files,
    importManifests,
    loginCodes,
  } = tablesFor(db);
  const communityMedia =
    dialectOf(db) === 'postgresql' ? communityMediaPg : communityMediaSqlite;
  let server: ReturnType<typeof serve> | undefined;
  let freshServer: ReturnType<typeof serve> | undefined;
  const closeActiveServer = async () => {
    const activeServer = server;
    const activeFreshServer = freshServer;
    server = undefined;
    freshServer = undefined;
    const errors: unknown[] = [];
    for (const active of [activeServer, activeFreshServer]) {
      try {
        await closeServer(active);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'HTTP persona server cleanup failed');
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
    const disabledRecoveredAdminCredentials = {
      email: 'qa-hono-disabled-recovered-admin@example.test',
    };
    const [
      disabledSeededAdmin,
      disabledSeededViewer,
      disabledSeededMember,
      disabledSeededEditor,
      disabledSeededRecoveredAdmin,
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
        {
          email: disabledRecoveredAdminCredentials.email,
          username: 'qa_hono_disabled_recovered_admin',
          displayName: 'QA Disabled Recovered Admin',
          ...deriveUserIdentityColumns({
            email: disabledRecoveredAdminCredentials.email,
            username: 'qa_hono_disabled_recovered_admin',
          }),
          ...verifier,
          firstName: 'QA',
          lastName: 'DisabledRecoveredAdmin',
          role: 'admin',
          communityId: inactiveCommunity.id,
          isActive: true,
        },
      ])
      .returning();
    void disabledSeededAdmin;
    void disabledSeededViewer;
    void disabledSeededEditor;
    void disabledSeededRecoveredAdmin;
    const disabledMemberId = disabledSeededMember!.id;
    const disabledRecoveredAdminId = disabledSeededRecoveredAdmin!.id;
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
    // Separate statement keeps D1 bound parameters below 100.
    const [inactiveRestrictedStory] = await db
      .insert(stories)
      .values({
        // #162 hidden row in disabled community: verified present in
        // disabled-community export manifest (§7).
        title: 'QA inactive restricted story',
        slug: 'qa-hono-inactive-restricted',
        communityId: inactiveCommunity.id,
        createdBy: disabledSeededAdmin!.id,
        privacyLevel: 'editors',
        isRestricted: true,
      })
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
    let freshHandler: Handler | undefined;
    let freshBaseUrl: string | undefined;
    let freshBootstrapSecret: string;
    let ensureFreshBootstrap: () => Promise<unknown>;
    // Set only where the fresh install's database can be closed and reopened
    // over the same storage (in-process SQLite); undefined elsewhere.
    let restartFreshInstall: (() => Promise<void>) | undefined;
    let routes: Endpoint[];
    let erasureSweep = backend?.runErasureSweep;
    if (backend) {
      // The backend states its coverage table; the fixture does not infer
      // one from `backend` presence. Only Workers/workerd runs the served
      // app out of process (its `app.routes` cannot be read from Node) and
      // passes the honoPersonaRouteTable() reconstruction; an in-process
      // backend passes routeTableOf of the app it actually serves.
      routes = backend.routes;
      handler = backend.handler(observeResponseCookies);
      freshBootstrapSecret = backend.freshBootstrap.bootstrapSecret;
      freshHandler = backend.freshBootstrap.handler(observeResponseCookies);
      ensureFreshBootstrap = async () => undefined;
    } else {
      const erasureRecords = new Map<number, ErasureRecord>();
      const erasureFences = new Set<number>();
      const fenceCommunity = async (id: number) => {
        erasureFences.add(id);
      };
      const assertWritable = (key: string) => {
        if (
          key.startsWith('communities/') &&
          erasureFences.has(Number(key.split('/')[1]))
        )
          throw new Error('Community storage is erasing');
      };
      erasureSweep = async () => {
        await new CommunityErasureService(
          new CommunitySovereigntyRepository(db),
          {
            fenceCommunity,
            read: async () => null,
            delete: async (key) => {
              storage.delete(key);
            },
            list: async (options) => {
              const keys = [...storage.keys()]
                .filter((k) => k.startsWith(options?.prefix ?? ''))
                .sort();
              const page = keys.slice(0, options?.limit ?? 20);
              return {
                entries: page.map((key) => ({ key, uploaded: new Date() })),
                truncated: page.length < keys.length,
              };
            },
          },
          {
            list: async () => [...erasureRecords.values()],
            write: async (r) => {
              erasureRecords.set(r.communityId, structuredClone(r));
            },
          }
        ).sweep(new Date());
      };
      const app = createHonoApp({
        erasureStore: {
          list: async () => [...erasureRecords.values()],
          write: async (r) => {
            erasureRecords.set(r.communityId, structuredClone(r));
          },
        },
        repository: new HonoFoundationRepository(db),
        secureCookies: false,
        // The in-process fixture presents `cf-connecting-ip` to isolate buckets.
        trustProxy: true,
        serverSecret: toHex(crypto.getRandomValues(new Uint8Array(24))),
        storage: {
          fenceCommunity,
          read: async (key, range) => {
            const bytes = storage.get(key);
            if (!bytes) return null;
            return {
              body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
              size: bytes.byteLength,
            };
          },
          async put(key, body) {
            assertWritable(key);
            if (body instanceof Uint8Array) {
              const copy = Uint8Array.from(body);
              storage.set(key, copy);
              return { size: copy.byteLength };
            }
            const reader = body.getReader();
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
            assertWritable(key);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }
            storage.set(key, merged);
            return { size: merged.byteLength };
          },
          async delete(key) {
            storage.delete(key);
          },
          async list(options) {
            const keys = [...storage.keys()]
              .filter((k) => k.startsWith(options?.prefix ?? ''))
              .sort();
            const page = keys.slice(0, options?.limit ?? 20);
            return {
              entries: page.map((key) => ({ key, uploaded: new Date() })),
              truncated: page.length < keys.length,
            };
          },
        },
      });
      freshBootstrapSecret = toHex(crypto.getRandomValues(new Uint8Array(24)));
      const freshServerSecret = toHex(
        crypto.getRandomValues(new Uint8Array(24))
      );
      // In-memory byte store for the fresh install, so the field-kit journey
      // can upload local media and read it back on the same SQLite database.
      const freshBytes = new Map<string, Uint8Array>();
      const freshStorage = {
        read: async (key: string, range?: { start: number; end: number }) => {
          const bytes = freshBytes.get(key);
          if (!bytes) return null;
          return {
            body: range ? bytes.subarray(range.start, range.end + 1) : bytes,
            size: bytes.byteLength,
          };
        },
        async put(key: string, body: Uint8Array | ReadableStream<Uint8Array>) {
          const merged =
            body instanceof Uint8Array
              ? Uint8Array.from(body)
              : new Uint8Array(await new Response(body).arrayBuffer());
          freshBytes.set(key, merged);
          return { size: merged.byteLength };
        },
        async delete(key: string) {
          freshBytes.delete(key);
        },
        async list(options?: { prefix?: string; limit?: number }) {
          const keys = [...freshBytes.keys()]
            .filter((k) => k.startsWith(options?.prefix ?? ''))
            .sort();
          const page = keys.slice(0, options?.limit ?? 20);
          return {
            entries: page.map((key) => ({ key, uploaded: new Date() })),
            truncated: page.length < keys.length,
          };
        },
      };
      let freshAppPromise:
        | Promise<ReturnType<typeof createHonoApp>>
        | undefined;
      const getFreshApp = () => {
        freshAppPromise ??= (async () => {
          const freshDb = await qa!.openFresh();
          return createHonoApp({
            repository: new HonoFoundationRepository(freshDb),
            secureCookies: false,
            trustProxy: true,
            serverSecret: freshServerSecret,
            bootstrapSecret: freshBootstrapSecret,
            storage: freshStorage,
            // SPEC-V2 §7 recovery-code gate (#254/#265), as the production
            // entrypoints configure it; the recovery-gate journey proves it.
            requireRecoveryCodes: true,
          });
        })();
        return freshAppPromise;
      };
      ensureFreshBootstrap = getFreshApp;
      if (qa!.reopenFresh) {
        const reopenFresh = qa!.reopenFresh;
        restartFreshInstall = async () => {
          await getFreshApp();
          // Closes the old handle, then a NEW app over the same file and the
          // same byte store; sessions and secrets must survive on their own.
          const reopenedDb = await reopenFresh();
          freshAppPromise = Promise.resolve(
            createHonoApp({
              repository: new HonoFoundationRepository(reopenedDb),
              secureCookies: false,
              trustProxy: true,
              serverSecret: freshServerSecret,
              bootstrapSecret: freshBootstrapSecret,
              storage: freshStorage,
              requireRecoveryCodes: true,
            })
          );
        };
      }
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

        freshServer = serve({
          fetch: async (request) => {
            const freshApp = await getFreshApp();
            const response = await freshApp.fetch(request);
            observeResponseCookies(response);
            return response;
          },
          hostname: '127.0.0.1',
          port: 0,
          overrideGlobalObjects: false,
        });
        if (!freshServer.listening) await once(freshServer, 'listening');
        const freshAddress = freshServer.address();
        if (!freshAddress || typeof freshAddress === 'string')
          throw new Error('Failed to bind fresh HTTP persona server address');
        freshBaseUrl = `http://127.0.0.1:${freshAddress.port}`;
      } else {
        handler = async (request) => {
          const response = await app.fetch(request);
          observeResponseCookies(response);
          return response;
        };
        freshHandler = async (request) => {
          const freshApp = await getFreshApp();
          const response = await freshApp.fetch(request);
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
        mapConfig.mapboxStyleUrl === null &&
        mapConfig.mapboxAccessToken === null &&
        mapConfig.mapbox3d === false &&
        mapConfig.protomapsBasemapStyle === null &&
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
        !text.includes('pk.test-') &&
        !text.includes('exposeMapboxCredentials')
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
        !text.includes('pk.test-') &&
        !text.includes('exposeMapboxCredentials')
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
      // Rails-shaped list interactions (UI INTERACTIONS B09): sort, pagination
      // and the story filters. Expectations are derived per role from the
      // seeded rows, so a broken sort, a limit/offset that is ignored, or a
      // filter that is ignored (or ORed instead of ANDed) changes the exact
      // ordered id list and fails.
      const readableStoryRows = [
        communityStory,
        editorsStory,
        publicStory,
        unevidencedStory,
      ].filter((s) => expectedStoryIds.includes(s.id));
      const titleAscIds = [...readableStoryRows]
        .sort((a, b) =>
          a.title === b.title ? a.id - b.id : a.title < b.title ? -1 : 1
        )
        .map((s) => s.id);
      const titleDescIds = [...titleAscIds].reverse();
      const newestIds = [...readableStoryRows]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
            b.id - a.id
        )
        .map((s) => s.id);
      if (newestIds.join(',') === titleAscIds.join(',')) {
        throw new Error('QA fixture: newest and title_asc must differ');
      }
      const storyListIs =
        (
          ids: number[],
          total: number,
          page?: { limit: number; offset: number }
        ) =>
        (body: unknown): boolean => {
          const parsed = CommunityStoriesListResponseSchema.safeParse(body);
          if (!parsed.success) return false;
          const { meta, data } = parsed.data;
          return (
            meta.total === total &&
            data.stories.map((s) => s.id).join(',') === ids.join(',') &&
            (page === undefined ||
              (meta.limit === page.limit &&
                meta.offset === page.offset &&
                meta.hasNextPage === page.offset + page.limit < total))
          );
        };
      const sortSteps: Step[] = [
        ['newest', newestIds],
        ['title_desc', titleDescIds],
      ].map(([sort, ids]) => ({
        name: `v2 stories sort=${sort as string} orders exactly (${role})`,
        method: 'GET' as const,
        path: `/v2/stories?sort=${sort as string}`,
        expected: 200,
        check: storyListIs(ids as number[], titleAscIds.length),
      }));
      const pageSteps: Step[] = [
        { limit: 1, offset: 0 },
        { limit: 1, offset: 1 },
        { limit: 2, offset: 1 },
        { limit: 2, offset: titleAscIds.length },
      ].map(({ limit, offset }) => ({
        name: `v2 stories page limit=${limit} offset=${offset} slices the title_asc order (${role})`,
        method: 'GET' as const,
        path: `/v2/stories?sort=title_asc&limit=${limit}&offset=${offset}`,
        expected: 200,
        check: storyListIs(
          titleAscIds.slice(offset, offset + limit),
          titleAscIds.length,
          { limit, offset }
        ),
      }));
      const idsByTitle = (rows: Array<{ id: number }>): number[] =>
        titleAscIds.filter((id) => rows.some((r) => r.id === id));
      const filterCases: Array<[string, string, number[]]> = [
        [
          'typeOfPlace public type',
          'typeOfPlace=QA%20public%20place%20type',
          idsByTitle(
            canReadCommunity ? [communityStory, publicStory] : [publicStory]
          ),
        ],
        [
          'typeOfPlace village',
          'typeOfPlace=village',
          idsByTitle(canReadCommunity ? [communityStory] : []),
        ],
        [
          'typeOfPlace sacred_grove',
          'typeOfPlace=sacred_grove',
          idsByTitle(canReadEditors ? [editorsStory] : []),
        ],
        [
          'region Manaus',
          'region=Manaus',
          idsByTitle(canReadCommunity ? [communityStory] : []),
        ],
        [
          'region Negro',
          'region=Negro',
          idsByTitle(canReadEditors ? [editorsStory] : []),
        ],
        [
          'region and typeOfPlace are ANDed',
          'region=Manaus&typeOfPlace=sacred_grove',
          [],
        ],
        [
          'topic',
          'topic=QA%20community%20topic',
          idsByTitle(canReadCommunity ? [communityStory] : []),
        ],
        [
          'topic is case-insensitive',
          'topic=qa%20COMMUNITY%20topic',
          idsByTitle(canReadCommunity ? [communityStory] : []),
        ],
        [
          'language qa-community-lang',
          'language=qa-community-lang',
          idsByTitle(canReadCommunity ? [communityStory] : []),
        ],
        [
          'language en',
          'language=en',
          idsByTitle(
            canReadEditors
              ? [editorsStory, publicStory, unevidencedStory]
              : [publicStory, unevidencedStory]
          ),
        ],
        ['language of a hidden members story', 'language=qa-members-lang', []],
        [
          'affiliation',
          'affiliation=QA%20community%20affiliation',
          idsByTitle(canReadCommunity ? [communityStory] : []),
        ],
        [
          'affiliation of a hidden members speaker',
          'affiliation=QA%20members-only%20affiliation',
          [],
        ],
      ];
      const filterSteps: Step[] = filterCases.map(([label, query, ids]) => ({
        name: `v2 stories filter ${label} (${role})`,
        method: 'GET' as const,
        path: `/v2/stories?${query}&sort=title_asc`,
        expected: 200,
        check: storyListIs(ids, ids.length),
      }));
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
          // Rails member search (dashboard/search#index) maps to the plain-text
          // search filter: it must never surface unreadable stories.
          name: `v2 stories plain-text search stays within readable stories (${role})`,
          method: 'GET',
          path: '/v2/stories?search=public%20story',
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoriesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const text = JSON.stringify(body) ?? '';
            const stories = parsed.data.data.stories;
            // Non-empty, narrower than the unfiltered list (so an ignored
            // `search` fails), and only readable, matching stories.
            return (
              stories.length > 0 &&
              stories.length < expectedStoryIds.length &&
              parsed.data.meta.total === stories.length &&
              stories.every(
                (s) =>
                  expectedStoryIds.includes(s.id) &&
                  s.title.toLowerCase().includes('public story')
              ) &&
              !text.includes('QA restricted story') &&
              !text.includes('QA unknown-privacy') &&
              !text.includes('QA foreign story') &&
              !text.includes('QA private community story') &&
              !text.includes('QA inactive community')
            );
          },
        },
        {
          // Every seeded title starts with 'QA', so this query matches readable
          // AND unreadable stories alike: the result must be exactly the
          // role's readable set.
          name: `v2 stories search over mixed readable/unreadable titles returns only readable (${role})`,
          method: 'GET',
          path: '/v2/stories?search=QA&sort=title_asc',
          expected: 200,
          check: (body) => {
            const parsed = CommunityStoriesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            return (
              parsed.data.meta.total === expectedStoryIds.length &&
              parsed.data.data.stories.map((s) => s.id).join(',') ===
                expectedStoryIds.join(',')
            );
          },
        },
        ...sortSteps,
        ...pageSteps,
        ...filterSteps,
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
    const unauthAdminSteps: Step[] = [
      {
        name: 'require auth on admin communities list',
        method: 'GET',
        path: '/v2/admin/communities',
        expected: 401,
      },
      {
        name: 'require auth on admin community provision',
        method: 'POST',
        path: '/v2/admin/communities',
        expected: 401,
        body: { slug: 'qa-unauth-provision' },
      },
      {
        name: 'require auth on admin claim-token issuance',
        method: 'POST',
        path: `/v2/admin/communities/${communityId}/claim-tokens`,
        expected: 401,
      },
      {
        name: 'require auth on admin community status toggle',
        method: 'PATCH',
        path: `/v2/admin/communities/${communityId}/status`,
        expected: 401,
        body: { status: 'disabled' },
      },
      {
        name: 'require auth on admin community deprovision',
        method: 'DELETE',
        path: `/v2/admin/communities/${communityId}`,
        expected: 401,
      },
      {
        name: 'require auth on admin system audit entries',
        method: 'GET',
        path: '/v2/admin/audit-entries',
        expected: 401,
      },
    ];
    const forbiddenAdminSteps: Step[] = [
      {
        name: 'deny admin communities list for community role',
        method: 'GET',
        path: '/v2/admin/communities',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny admin community provision for community role',
        method: 'POST',
        path: '/v2/admin/communities',
        expected: 403,
        body: { slug: 'qa-denied-provision' },
        check: forbiddenCheck,
      },
      {
        name: 'deny admin claim-token issuance for community role',
        method: 'POST',
        path: `/v2/admin/communities/${communityId}/claim-tokens`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny admin community status toggle for community role',
        method: 'PATCH',
        path: `/v2/admin/communities/${communityId}/status`,
        expected: 403,
        body: { status: 'disabled' },
        check: forbiddenCheck,
      },
      {
        name: 'deny admin community deprovision for community role',
        method: 'DELETE',
        path: `/v2/admin/communities/${communityId}`,
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: 'deny admin system audit entries for community role',
        method: 'GET',
        path: '/v2/admin/audit-entries',
        expected: 403,
        check: forbiddenCheck,
      },
    ];
    let qaClaimToken1 = '';
    let qaClaimToken1Id = 0;
    let qaClaimToken2 = '';
    let qaClaimToken2Id = 0;
    let qaDeprovTokenId = 0;
    let qaDisabledToken = '';
    const qaAdminClaimedKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const qaSupersededClaimBody = {
      token: '',
      username: 'qa_superseded_admin',
      email: 'qa-superseded-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: verifierSalt,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    const qaDisabledClaimBody = {
      token: '',
      username: 'qa_disabled_revive_admin',
      email: 'qa-disabled-revive@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: verifierSalt,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    const qaValidClaimBody = {
      token: '',
      username: 'qa_claimed_admin',
      email: 'qa-claimed-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: verifierSalt,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: qaAdminClaimedKey,
      },
    };
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
        name: 'editor reads story detail with first external link',
        method: 'GET',
        path: '/v2/stories/{qaSlice8Story}',
        expected: 200,
        check: (body) => {
          const parsed = CommunityStoryDetailResponseSchema.safeParse(body);
          return (
            parsed.success &&
            parsed.data.data.externalMediaLinks.length === 1 &&
            parsed.data.data.externalMediaLinks[0]?.id === qaSlice8LinkAId &&
            parsed.data.data.externalMediaLinks[0]?.url ===
              'https://video.example.test/qa/first'
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
    // Self-service and disable fixtures: a dedicated private community so the
    // password change (which revokes the account's other sessions) and the
    // disable/re-enable cycle cannot disturb the shared persona credentials or
    // the exact user lists pinned by the user-management journeys.
    const selfServiceCommunityResult = await db
      .insert(communities)
      .values({
        name: 'QA self-service community',
        slug: 'qa-self-service-community',
        publicStories: false,
        isActive: true,
      })
      .returning();
    const selfServiceCommunity = selfServiceCommunityResult[0]!;
    // Dedicated private community for per-community Mapbox & Protomaps QA journeys.
    const [mapboxCommunity] = await db
      .insert(communities)
      .values({
        name: 'QA mapbox community',
        slug: 'qa-mapbox-community',
        publicStories: false,
        isActive: true,
      })
      .returning();
    const mapboxCredentials = {
      admin: { email: 'qa-mapbox-admin@example.test', role: 'admin' },
      member: { email: 'qa-mapbox-member@example.test', role: 'member' },
    } as const;
    for (const key of ['admin', 'member'] as const) {
      await db.insert(users).values({
        email: mapboxCredentials[key].email,
        ...deriveUserIdentityColumns({
          email: mapboxCredentials[key].email,
        }),
        ...verifier,
        firstName: 'QA',
        lastName: `Mapbox${key}`,
        role: sql`${mapboxCredentials[key].role}`,
        communityId: mapboxCommunity.id,
        isActive: true,
      });
    }
    const selfServiceCredentials = {
      admin: { email: 'qa-selfsvc-admin@example.test', role: 'admin' },
      member: { email: 'qa-selfsvc-member@example.test', role: 'member' },
      editor: { email: 'qa-selfsvc-editor@example.test', role: 'editor' },
      target: { email: 'qa-selfsvc-target@example.test', role: 'viewer' },
    } as const;
    const selfServiceIds: Record<string, number> = {};
    for (const key of ['admin', 'member', 'editor', 'target'] as const) {
      const [selfServiceUser] = await db
        .insert(users)
        .values({
          email: selfServiceCredentials[key].email,
          ...deriveUserIdentityColumns({
            email: selfServiceCredentials[key].email,
          }),
          ...verifier,
          firstName: 'QA',
          lastName: `SelfService${key}`,
          role: sql`${selfServiceCredentials[key].role}`,
          communityId: selfServiceCommunity.id,
          isActive: true,
        })
        .returning();
      selfServiceIds[key] = selfServiceUser.id;
    }
    // Self-service / disable journey helpers (dedicated accounts only).
    const ssOwn = (key: 'admin' | 'member' | 'editor' | 'target') =>
      ownUser(
        selfServiceCredentials[key].email,
        selfServiceCredentials[key].role,
        liveSessionCookie,
        selfServiceCommunity.id
      );
    const ssMe =
      (key: 'member' | 'editor', displayName?: string) => (body: unknown) =>
        ownMeUser(
          selfServiceCredentials[key].email,
          selfServiceCredentials[key].role,
          liveSessionCookie,
          selfServiceCommunity.id
        )(body) &&
        (displayName === undefined ||
          (body as { user?: { displayName?: unknown } }).user?.displayName ===
            displayName);
    const ssStatus = (status: string) => (body: unknown) =>
      (body as { data?: { status?: unknown } })?.data?.status === status;
    const ssLogout: Step = {
      name: 'logout',
      method: 'POST',
      path: '/v2/auth/logout',
      expected: 204,
    };
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
      mediaParts?: Array<{
        filename: string;
        contentType: string;
        bytes: Uint8Array;
      }>;
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
      for (const media of options.mediaParts ?? []) {
        chunks.push(
          enc.encode(
            `\r\n--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${media.filename}"\r\nContent-Type: ${media.contentType}\r\n\r\n`
          )
        );
        chunks.push(media.bytes);
      }
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
    const mediaBrandingIs =
      (opts: { background: boolean; sponsors: boolean }) =>
      (body: unknown): boolean => {
        const parsed = CommunityReadDetailResponseSchema.safeParse(body);
        if (!parsed.success) return false;
        const branding = parsed.data.data.branding;
        const sponsorIds = branding.sponsorLogos.map((s) => s.fileId);
        return (
          (branding.backgroundImage?.fileId === qaAdminFileId) ===
            opts.background &&
          (branding.backgroundImage === null) === !opts.background &&
          sponsorIds.includes(qaAdminFileId) === opts.sponsors &&
          sponsorIds.length === (opts.sponsors ? 1 : 0)
        );
      };
    let qaManagedUserId = 0;
    const selfServiceMemberNewKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    let qaIssuedLoginCode = '';
    let qaDisabledRecoveredAdminLoginCode = '';
    let qaRecoveryCode = '';
    let qaOldRecoveryCode = '';
    let qaSupersededRecoveryCode = '';
    let qaAdminIssuedCodeForAdmin = '';
    let qaAdminIssuedRedeemedCookie = '';
    const qaAdminIssuedRedeemBody: { code: string } = { code: '' };
    // Seed a DB-level admin_issued LoginCode for the community admin so the
    // persona can exercise the verifier-free regeneration journey (one-shot)
    // without a second administrator issuing it.
    const qaAdminIssuedRawCode = toBase64Url(
      crypto.getRandomValues(new Uint8Array(16))
    );
    const qaAdminIssuedCodeHash = await sha256Hex(qaAdminIssuedRawCode);
    const qaAdminIssuedNowMs = Date.now();
    await db.insert(loginCodes).values({
      communityId: userCommunity.id,
      userId: userCommunityIds.admin,
      purpose: 'admin_issued',
      codeHash: qaAdminIssuedCodeHash,
      createdBy: null,
      createdAt: qaAdminIssuedNowMs,
      expiresAt: qaAdminIssuedNowMs + ADMIN_ISSUED_CODE_TTL_MS,
    });
    qaAdminIssuedCodeForAdmin = qaAdminIssuedRawCode;
    let redeemedAdminCookie = '';
    const qaIssuedRedeemBody = {
      code: '',
      communitySlug: 'qa-user-management-community',
    };
    const qaDisabledRecoveredAdminRedeemBody = {
      code: '',
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
    const qaSuperDeniedKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const qaSuperDeniedSalt = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    let qaSuperDeniedSessionHandle = '';
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

    // Slice 12 CSV import QA fixtures and helpers (#123): seeded foreign
    // previewed manifest (keeps committed_at NULL so D1's daily commit limit
    // stays unoccupied) plus state tracked across media_editor -> media_admin.
    const [foreignImportManifest] = await db
      .insert(importManifests)
      .values({
        communityId: foreignCommunityId,
        kind: 'places',
        status: 'previewed',
        createdBy: null,
        sourceFileName: 'foreign-qa.csv',
        sourceFileId: foreignFileId,
        mappings: {
          headerMappings: { name: 'name' },
          unmappedHeaders: [],
          duplicateStrategy: 'error',
        },
        normalizedRows: {
          kind: 'places',
          rows: [],
          relatedPlacesToCreate: [],
          relatedSpeakersToCreate: [],
          skippedDuplicates: 0,
          audienceCounts: null,
        },
        rowCount: 0,
        rowErrors: [],
        stagedFileIds: [],
        resultSummary: null,
        committedAt: null,
        createdAt: Date.now(),
      })
      .returning();
    let qaImportDiscardManifestId = 0;
    let qaDiscardStagedFileId = '';
    let qaDiscardStagedStorageKey = '';
    let qaDiscardSourceFileId = '';
    let qaDiscardSourceStorageKey = '';
    let qaImportUnknownAudienceId = 0;
    let qaImportPlacesManifestId = 0;
    let qaCommittedPlacesAt = '';
    let qaCommittedPlacesSummaryJson = '';
    let qaImportStoriesManifestId = 0;
    const qaD1BudgetCsv =
      'title,visibility\n' +
      Array.from(
        { length: 1005 },
        (_, i) => `QA Budget Row ${i + 1},community`
      ).join('\n') +
      '\n';
    const parseJsonArray = <T>(value: unknown): T[] => {
      if (Array.isArray(value)) return value as T[];
      if (typeof value === 'string') {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
      }
      return [];
    };
    const backdateCommittedImportsForD1 = async (): Promise<void> => {
      if (!isD1Backend) return;
      const yesterdayMs = Date.now() - 25 * 60 * 60 * 1000;
      await db
        .update(importManifests)
        .set({ committedAt: yesterdayMs })
        .where(
          and(
            eq(importManifests.communityId, mediaCommunity.id),
            eq(importManifests.status, 'committed')
          )
        );
    };
    const forbiddenImportSteps = (roleLabel: string): Step[] => [
      {
        name: `reject CSV import preview for ${roleLabel}`,
        method: 'POST',
        path: '/v2/imports/preview',
        expected: 403,
        ...qaMultipart({
          filename: 'qa-places-denied.csv',
          contentType: 'text/csv',
          bytes: new TextEncoder().encode('name\nDenied\n'),
          fields: { kind: 'places' },
        }),
        check: forbiddenCheck,
      },
      {
        name: `reject import manifest list for ${roleLabel}`,
        method: 'GET',
        path: '/v2/imports',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: `reject import manifest detail for ${roleLabel}`,
        method: 'GET',
        path: '/v2/imports/1',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: `reject import manifest commit for ${roleLabel}`,
        method: 'POST',
        path: '/v2/imports/1/commit',
        expected: 403,
        check: forbiddenCheck,
      },
      {
        name: `reject import manifest discard for ${roleLabel}`,
        method: 'DELETE',
        path: '/v2/imports/1',
        expected: 403,
        check: forbiddenCheck,
      },
    ];

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
        name: 'redeem admin-issued code for admin (verifier-free setup)',
        method: 'POST',
        path: '/v2/auth/recovery/redeem',
        expected: 200,
        headers: { cookie: 'ts_session=' },
        prepare: () => {
          qaAdminIssuedRedeemBody.code = qaAdminIssuedCodeForAdmin;
        },
        body: qaAdminIssuedRedeemBody,
        check: ownUser(
          userCommunityCredentials.admin.email,
          'admin',
          liveSessionCookie,
          userCommunity.id
        ),
        checkHeaders: (headers) => {
          const sc = headers.get('set-cookie') ?? '';
          qaAdminIssuedRedeemedCookie = sc.split(';')[0] ?? '';
          return true;
        },
      },
      {
        name: 'regenerate recovery codes verifier-free via admin_issued session',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 201,
        headers: {},
        prepare() {
          this.headers = { cookie: qaAdminIssuedRedeemedCookie };
        },
        body: undefined,
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
        name: 'reject second verifier-free regeneration (one-shot)',
        method: 'POST',
        path: '/v2/auth/recovery-codes',
        expected: 401,
        headers: {},
        prepare() {
          this.headers = { cookie: qaAdminIssuedRedeemedCookie };
        },
        body: {},
        check: invalidCredentials,
      },
      {
        name: 'logout',
        method: 'POST',
        path: '/v2/auth/logout',
        expected: 204,
      },
    ];
    // Compare every page and its total with the tenant's stored audit IDs.
    // Foreign/system events already exist, so a count or pagination leak fails
    // even when the returned page happens to contain only own-community rows.
    const communityAuditReadSteps = (tenantId: number): Step[] =>
      [0, 2, 'end' as const].map((page) => {
        let expectedIds: number[] = [];
        let offset = 0;
        return {
          name: `read content-free own-community audit page ${page}`,
          method: 'GET',
          path: '/v2/community/audit-entries',
          expected: 200,
          prepare: async () => {
            const rows = await db
              .select({ id: auditEntries.id })
              .from(auditEntries)
              .where(eq(auditEntries.communityId, tenantId))
              .orderBy(desc(auditEntries.createdAt), desc(auditEntries.id));
            expectedIds = rows.map((row) => row.id);
            if (expectedIds.length <= 2)
              throw new Error(
                'Audit pagination requires multiple nonempty pages'
              );
            offset = page === 'end' ? expectedIds.length : page;
            return `/v2/community/audit-entries?limit=2&offset=${offset}`;
          },
          check: (body) => {
            const parsed =
              CommunityAuditEntriesListResponseSchema.safeParse(body);
            if (!parsed.success) return false;
            const { data, meta } = parsed.data;
            const rawEntries = (body as { data: unknown[] }).data;
            const text = JSON.stringify(body);
            return (
              meta.total === expectedIds.length &&
              meta.limit === 2 &&
              meta.offset === offset &&
              meta.hasNextPage === offset + 2 < expectedIds.length &&
              JSON.stringify(data.map((entry) => entry.id)) ===
                JSON.stringify(expectedIds.slice(offset, offset + 2)) &&
              rawEntries.every(
                (entry) =>
                  CommunityAuditEntrySchema.strict().safeParse(entry).success
              ) &&
              data.every((entry) => {
                validateContentFreeAuditEntry({
                  communityId: entry.communityId,
                  actorId: entry.actorId,
                  action: entry.action,
                  resourceType: entry.resourceType,
                  resourceIds: entry.resourceIds,
                  outcome: entry.outcome,
                  ipAddress: entry.ipAddress,
                  userAgent: entry.userAgent,
                });
                return entry.communityId === tenantId;
              }) &&
              !HONO_PERSONA_CULTURAL_STRINGS.some((value) =>
                text.includes(value)
              ) &&
              !leaksSecret(body, liveSessionCookie)
            );
          },
        };
      });
    let activeAdminExport1ManifestToken = '';
    let qaClaimBootCommunityId = 0;
    let qaClaimBootExpiredToken = '';
    let qaClaimBootExpiredTokenId = 0;
    let qaClaimBootSupersededToken = '';
    let qaClaimBootValidToken = '';
    let qaClaimBootRecoveryCode1 = '';
    let qaClaimBootThrottleToken = '';
    let qaClaimBootPerTokenToken = '';
    const qaClaimBootAdminKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    const qaClaimBootRecoveredKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    const qaClaimBootThrottleAdminKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    const qaClaimBootSalt1 = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    const qaClaimBootSalt2 = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    const qaClaimBootSalt3 = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    const qaClaimBootExpiredBody = {
      token: '',
      username: 'qa_claim_expired_admin',
      email: 'qa-claim-expired-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt1,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    const qaClaimBootSupersededBody = {
      token: '',
      username: 'qa_claim_superseded_admin',
      email: 'qa-claim-superseded-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt1,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    const qaClaimBootValidBody = {
      token: '',
      username: 'qa_claim_journey_admin',
      email: 'qa-claim-journey-admin@example.test',
      displayName: 'QA Claim Journey Admin',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt1,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: qaClaimBootAdminKey,
      },
    };
    const qaClaimBootReplayBody = {
      token: '',
      username: 'qa_claim_replay_admin',
      email: 'qa-claim-replay-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt1,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    const qaClaimBootRedeemBody = {
      code: '',
      identifier: 'qa-claim-journey-admin@example.test',
      communitySlug: 'qa-claim-journey',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt2,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: qaClaimBootRecoveredKey,
      },
    };
    const qaClaimBootThrottleValidBody = {
      token: '',
      username: 'qa_claim_throttle_admin',
      email: 'qa-claim-throttle-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt3,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: qaClaimBootThrottleAdminKey,
      },
    };
    const qaClaimBootThrottleUnblockedBody = {
      token: '',
      username: 'qa_claim_throttle_admin',
      email: 'qa-claim-throttle-admin@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt3,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: qaClaimBootThrottleAdminKey,
      },
    };
    const qaClaimBootPerTokenConflictBody = {
      token: '',
      username: 'qa_hono_admin',
      email: credentials.admin.email,
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt3,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    const qaClaimBootPerTokenFreeBody = {
      token: '',
      username: 'qa_claim_pertoken_free',
      email: 'qa-claim-pertoken-free@example.test',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: qaClaimBootSalt3,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
      },
    };
    let freshBootstrapCommunityId = 0;
    let freshBootstrapRecoveryCode1 = '';
    let fieldKitFileId = '';
    let qaGateAdminLoginCode = '';
    const qaGateAdminRedeemBody = {
      code: '',
      communitySlug: 'qa-fresh-bootstrap',
    };
    const qaGateAdminHeaders = {
      cookie: '',
      'x-forwarded-for': '203.0.113.213',
      'cf-connecting-ip': '203.0.113.213',
    };
    const freshAdminKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const freshAdminRecoveredKey = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    );
    const freshWrongSecret =
      (freshBootstrapSecret[0] === 'a' ? 'b' : 'a') +
      freshBootstrapSecret.slice(1);
    const freshSalt1 = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    const freshSalt2 = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16))
    ).toString('base64');
    const freshBootstrapValidBody = {
      bootstrapSecret: freshBootstrapSecret,
      community: {
        name: 'QA Fresh Bootstrap Community',
        slug: 'qa-fresh-bootstrap',
        locale: 'en',
        visibility: 'private' as const,
      },
      admin: {
        username: 'qa_fresh_admin',
        email: 'qa-fresh-admin@example.test',
        displayName: 'QA Fresh Admin',
        password: {
          algorithm: ARGON2ID_ALGORITHM,
          salt: freshSalt1,
          params: JSON.parse(ARGON2ID_PARAMS_JSON),
          derivedKey: freshAdminKey,
        },
      },
    };
    const freshBootstrapWrongBody = {
      ...freshBootstrapValidBody,
      bootstrapSecret: freshWrongSecret,
    };
    const freshBootstrapMissingBody = {
      community: freshBootstrapValidBody.community,
      admin: freshBootstrapValidBody.admin,
    };
    const freshBootstrapRedeemBody = {
      code: '',
      identifier: 'qa-fresh-admin@example.test',
      communitySlug: 'qa-fresh-bootstrap',
      password: {
        algorithm: ARGON2ID_ALGORITHM,
        salt: freshSalt2,
        params: JSON.parse(ARGON2ID_PARAMS_JSON),
        derivedKey: freshAdminRecoveredKey,
      },
    };
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
          ...unauthAdminSteps,
          {
            name: 'require auth on v2 community export',
            method: 'POST',
            path: '/v2/community/export',
            expected: 401,
            body: {},
          },
          {
            name: 'require auth on v2 community export download',
            method: 'GET',
            path: `/v2/community/export/download/${'a'.repeat(64)}`,
            expected: 401,
          },
          {
            name: 'require auth on v2 community audit entries',
            method: 'GET',
            path: '/v2/community/audit-entries',
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
              role === 'admin' &&
                backend?.seededAdminsHaveRecoveryCodes === true
            ),
          },
          // Self-service login-identifier edit (member persona): step-up on
          // the current credential, admin-parity identity rules, the uniform
          // 409 and session retention. The identifiers are restored so the
          // rest of the journey keeps its seeded credentials.
          ...(role === 'member'
            ? [
                {
                  name: 'reject own identifier change without step-up',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 403,
                  body: { username: 'qa_hono_member_renamed' },
                  check: uniformForbidden,
                },
                {
                  name: 'reject own identifier change with the wrong current key',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 403,
                  body: {
                    username: 'qa_hono_member_renamed',
                    currentDerivedKey: toHex(
                      crypto.getRandomValues(new Uint8Array(32))
                    ),
                  },
                  check: uniformForbidden,
                },
                {
                  name: 'reject own username colliding with another account',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 409,
                  body: {
                    username: 'qa_hono_viewer',
                    currentDerivedKey: derivedKey,
                  },
                  check: (body: unknown) =>
                    keysExactly(body, ['error']) &&
                    (body as { error?: string }).error === 'Conflict',
                },
                {
                  name: 'reject own email colliding with a community peer',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 409,
                  body: {
                    email: credentials.viewer.email.toUpperCase(),
                    currentDerivedKey: derivedKey,
                  },
                },
                {
                  name: 'reject malformed own email',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 400,
                  body: {
                    email: 'not-an-email',
                    currentDerivedKey: derivedKey,
                  },
                },
                {
                  name: 'change own username and email with step-up',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 200,
                  body: {
                    username: 'qa_hono_member_renamed',
                    email: 'qa-hono-member-renamed@example.test',
                    currentDerivedKey: derivedKey,
                  },
                  check: (body: unknown) => {
                    const user = (body as { user?: Record<string, unknown> })
                      .user;
                    return (
                      user?.username === 'qa_hono_member_renamed' &&
                      user?.email === 'qa-hono-member-renamed@example.test' &&
                      user?.role === 'member' &&
                      !leaksSecret(body, liveSessionCookie)
                    );
                  },
                },
                {
                  name: 'session survives the identifier change',
                  method: 'GET',
                  path: '/v2/auth/me',
                  expected: 200,
                  check: (body: unknown) =>
                    (body as { user?: { username?: unknown } }).user
                      ?.username === 'qa_hono_member_renamed',
                },
                {
                  name: 'restore own username and email with step-up',
                  method: 'PATCH',
                  path: '/v2/auth/me',
                  expected: 200,
                  body: {
                    username: 'qa_hono_member',
                    email: credentials.member.email,
                    currentDerivedKey: derivedKey,
                  },
                  check: ownUser(
                    credentials.member.email,
                    'member',
                    liveSessionCookie,
                    communityId
                  ),
                },
              ]
            : []),
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
          ...forbiddenAdminSteps,
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
          ...(role !== 'admin'
            ? [
                {
                  name: 'deny community export for non-admin role',
                  method: 'POST',
                  path: '/v2/community/export',
                  expected: 403,
                  body: {},
                  check: forbiddenCheck,
                },
                {
                  name: 'deny export download for non-admin role',
                  method: 'GET',
                  path: `/v2/community/export/download/${'a'.repeat(64)}`,
                  expected: 403,
                  check: forbiddenCheck,
                },
                {
                  name: 'deny community audit entries for non-admin role',
                  method: 'GET',
                  path: '/v2/community/audit-entries',
                  expected: 403,
                  check: forbiddenCheck,
                },
              ]
            : []),
          ...(role === 'admin'
            ? (() => {
                let exportId1 = '';
                let manifestToken1 = '';
                let zipToken1 = '';
                let manifestChecksum1 = '';
                let zipChecksum1 = '';
                let manifestBytes1 = new Uint8Array(0);
                let zipBytes1 = new Uint8Array(0);
                let exportId2 = '';
                let manifestToken2 = '';
                let zipToken2 = '';
                return [
                  {
                    name: 'export active community',
                    method: 'POST',
                    path: '/v2/community/export',
                    expected: 201,
                    body: {},
                    check: (body: unknown) => {
                      const parsed =
                        CreateCommunityExportResponseSchema.safeParse(body);
                      if (!parsed.success) return false;
                      exportId1 = parsed.data.data.exportId;
                      manifestToken1 =
                        parsed.data.data.artifacts.manifest.token;
                      zipToken1 = parsed.data.data.artifacts.mediaZip.token;
                      manifestChecksum1 =
                        parsed.data.data.artifacts.manifest.checksum;
                      zipChecksum1 =
                        parsed.data.data.artifacts.mediaZip.checksum;
                      activeAdminExport1ManifestToken = manifestToken1;
                      return true;
                    },
                  },
                  {
                    name: 'valid export token still requires authentication',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 401,
                    headers: { cookie: '' },
                    prepare: () =>
                      `/v2/community/export/download/${manifestToken1}`,
                  },
                  {
                    name: 'download exported community manifest',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 200,
                    prepare: () =>
                      `/v2/community/export/download/${manifestToken1}`,
                    checkHeaders: (headers: Headers) =>
                      headers.get('cache-control') === 'no-store' &&
                      headers.get('x-content-type-options') === 'nosniff' &&
                      (headers.get('content-disposition') ?? '').includes(
                        'attachment'
                      ),
                    checkBytes: (bytes: Uint8Array) => {
                      if (
                        new StreamingSha256().update(bytes).digestHex() !==
                        manifestChecksum1
                      ) {
                        return false;
                      }
                      const text = new TextDecoder().decode(bytes);
                      if (
                        text.includes('passwordVerifier') ||
                        text.includes('passwordHash') ||
                        text.includes('passwordSalt') ||
                        text.includes('passwordParams')
                      ) {
                        return false;
                      }
                      const manifest = JSON.parse(text) as {
                        community?: { id?: number; status?: string };
                        stories?: Array<{
                          id: number;
                          isRestricted?: boolean;
                          privacyLevel?: string;
                        }>;
                        files?: Array<{ id: string }>;
                        auditEntries?: Array<{ action: string }>;
                      };
                      const hasRestricted =
                        manifest.stories?.some(
                          (s) =>
                            s.id === restrictedStory.id &&
                            s.isRestricted === true
                        ) ?? false;
                      const hasUnknown =
                        manifest.stories?.some(
                          (s) =>
                            s.id === unknownStory.id &&
                            s.privacyLevel === 'unknown'
                        ) ?? false;
                      const hasReadableFile =
                        manifest.files?.some((f) => f.id === readableFileId) ??
                        false;
                      const excludesExportLifecycle =
                        manifest.auditEntries?.every(
                          (e) => !e.action.startsWith('community.export.')
                        ) ?? false;
                      manifestBytes1 = bytes;
                      return (
                        manifest.community?.id === communityId &&
                        manifest.community?.status === 'active' &&
                        hasRestricted &&
                        hasUnknown &&
                        manifest.stories?.some(
                          (s) => s.id === unevidencedStory.id
                        ) &&
                        manifest.stories?.some(
                          (s) => s.id === membersStory.id
                        ) &&
                        !manifest.stories?.some(
                          (s) => s.id === foreignStory.id
                        ) &&
                        hasReadableFile &&
                        excludesExportLifecycle
                      );
                    },
                  },
                  {
                    name: 'download exported community media zip',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 200,
                    prepare: () => `/v2/community/export/download/${zipToken1}`,
                    checkHeaders: (headers: Headers) =>
                      headers.get('cache-control') === 'no-store' &&
                      (headers.get('content-disposition') ?? '').includes(
                        'attachment'
                      ),
                    checkBytes: (bytes: Uint8Array) => {
                      if (
                        new StreamingSha256().update(bytes).digestHex() !==
                        zipChecksum1
                      ) {
                        return false;
                      }
                      const entries = parseDeterministicZip(bytes);
                      zipBytes1 = bytes;
                      return entries.some(
                        (e) => e.path === `media/${readableFileId}`
                      );
                    },
                  },
                  {
                    name: 're-export active community deterministically',
                    method: 'POST',
                    path: '/v2/community/export',
                    expected: 201,
                    body: {},
                    check: (body: unknown) => {
                      const parsed =
                        CreateCommunityExportResponseSchema.safeParse(body);
                      if (!parsed.success) return false;
                      exportId2 = parsed.data.data.exportId;
                      manifestToken2 =
                        parsed.data.data.artifacts.manifest.token;
                      zipToken2 = parsed.data.data.artifacts.mediaZip.token;
                      return (
                        exportId2 !== exportId1 &&
                        manifestToken2 !== manifestToken1 &&
                        zipToken2 !== zipToken1 &&
                        parsed.data.data.artifacts.manifest.checksum ===
                          manifestChecksum1 &&
                        parsed.data.data.artifacts.mediaZip.checksum ===
                          zipChecksum1
                      );
                    },
                  },
                  {
                    name: 'verify byte-identical re-exported manifest',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 200,
                    prepare: () =>
                      `/v2/community/export/download/${manifestToken2}`,
                    checkBytes: (bytes: Uint8Array) =>
                      bytes.byteLength === manifestBytes1.byteLength &&
                      bytes.every((b, idx) => b === manifestBytes1[idx]),
                  },
                  {
                    name: 'verify byte-identical re-exported media zip',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 200,
                    prepare: () => `/v2/community/export/download/${zipToken2}`,
                    checkBytes: (bytes: Uint8Array) =>
                      bytes.byteLength === zipBytes1.byteLength &&
                      bytes.every((b, idx) => b === zipBytes1[idx]),
                  },
                  {
                    name: 'expire export tokens and trigger per-object cleanup on download',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 404,
                    prepare: async () => {
                      const manifestKey = `communities/${communityId}/exports/${exportId2}/manifest.json`;
                      const zipKey = `communities/${communityId}/exports/${exportId2}/media.zip`;
                      if (!(await hasMedia(manifestKey))) {
                        throw new Error(
                          'Expected manifest object to exist before expiry'
                        );
                      }
                      if (!(await hasMedia(zipKey))) {
                        throw new Error(
                          'Expected ZIP object to exist before expiry'
                        );
                      }
                      const pastNow = Date.now() - 60_000;
                      const pastCreated = pastNow - 2 * EXPORT_TOKEN_TTL_MS;
                      await db
                        .update(exportJobs)
                        .set({ createdAt: pastCreated, expiresAt: pastNow })
                        .where(eq(exportJobs.id, exportId2));
                      await db
                        .update(exportTokens)
                        .set({ createdAt: pastCreated, expiresAt: pastNow })
                        .where(eq(exportTokens.jobId, exportId2));
                      return `/v2/community/export/download/${manifestToken2}`;
                    },
                  },
                  {
                    name: 'verify expired export artifacts deleted and second token fails',
                    method: 'GET',
                    path: '/v2/community/export/download/pending',
                    expected: 404,
                    prepare: async () => {
                      const manifestKey = `communities/${communityId}/exports/${exportId2}/manifest.json`;
                      const zipKey = `communities/${communityId}/exports/${exportId2}/media.zip`;
                      if (await hasMedia(manifestKey)) {
                        throw new Error(
                          'Expected expired manifest object to be deleted'
                        );
                      }
                      if (await hasMedia(zipKey)) {
                        throw new Error(
                          'Expected expired ZIP object to be deleted'
                        );
                      }
                      const [jobRow] = await db
                        .select({
                          status: exportJobs.status,
                          cleanedUpAt: exportJobs.cleanedUpAt,
                        })
                        .from(exportJobs)
                        .where(eq(exportJobs.id, exportId2))
                        .limit(1);
                      if (
                        !jobRow ||
                        jobRow.status !== 'expired' ||
                        jobRow.cleanedUpAt === null
                      ) {
                        throw new Error(
                          'Expected expired export job to record cleanup completion'
                        );
                      }
                      return `/v2/community/export/download/${zipToken2}`;
                    },
                  },
                  ...communityAuditReadSteps(communityId),
                  {
                    name: 'filter own community audit entries by export action',
                    method: 'GET',
                    path: '/v2/community/audit-entries?action=community.export.generate',
                    expected: 200,
                    check: (body: unknown) => {
                      const parsed =
                        CommunityAuditEntriesListResponseSchema.safeParse(body);
                      if (!parsed.success) return false;
                      return (
                        parsed.data.data.length >= 1 &&
                        parsed.data.data.every(
                          (entry) =>
                            entry.communityId === communityId &&
                            entry.action === 'community.export.generate' &&
                            entry.ipAddress === null &&
                            entry.userAgent === null
                        )
                      );
                    },
                  },
                  {
                    name: 'reject caller communityId override on audit entries',
                    method: 'GET',
                    path: `/v2/community/audit-entries?communityId=${foreignCommunityId}`,
                    expected: 400,
                  },
                  {
                    name: 'read community sovereignty status',
                    method: 'GET',
                    path: '/v2/community/sovereignty',
                    expected: 200,
                    check: (body: unknown) => {
                      const parsed =
                        CommunitySovereigntyStatusResponseSchema.safeParse(
                          body
                        );
                      return (
                        parsed.success &&
                        parsed.data.data.communityId === communityId &&
                        parsed.data.data.status === 'active'
                      );
                    },
                  },
                  {
                    name: 'designate community steward with password step-up',
                    method: 'PUT',
                    path: '/v2/community/steward',
                    expected: 200,
                    body: {
                      stewardUserId: communityUserIds.member,
                      currentDerivedKey: HONO_PERSONA_DERIVED_KEY,
                    },
                    check: (body: unknown) => {
                      const parsed =
                        PutCommunityStewardResponseSchema.safeParse(body);
                      return (
                        parsed.success &&
                        parsed.data.data.steward?.userId ===
                          communityUserIds.member
                      );
                    },
                  },
                  {
                    name: 'clear community steward back to null',
                    method: 'PUT',
                    path: '/v2/community/steward',
                    expected: 200,
                    body: {
                      stewardUserId: null,
                      currentDerivedKey: HONO_PERSONA_DERIVED_KEY,
                    },
                    check: (body: unknown) => {
                      const parsed =
                        PutCommunityStewardResponseSchema.safeParse(body);
                      return (
                        parsed.success && parsed.data.data.steward === null
                      );
                    },
                  },
                ];
              })()
            : []),
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
                {
                  name: 'deny cross-community export download token',
                  method: 'GET',
                  path: '/v2/community/export/download/pending',
                  expected: 404,
                  prepare: () =>
                    `/v2/community/export/download/${activeAdminExport1ManifestToken}`,
                },
                ...communityAuditReadSteps(privateCommunityId),
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
          ...forbiddenImportSteps('super_admin'),
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
            name: 'deny community export for super_admin',
            method: 'POST',
            path: '/v2/community/export',
            expected: 403,
            body: {},
            check: forbiddenCheck,
          },
          {
            name: 'deny export download for super_admin',
            method: 'GET',
            path: `/v2/community/export/download/${'a'.repeat(64)}`,
            expected: 403,
            check: forbiddenCheck,
          },
          {
            name: 'deny community audit entries for super_admin',
            method: 'GET',
            path: '/v2/community/audit-entries',
            expected: 403,
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 users list',
            method: 'GET',
            path: '/v2/users',
            expected: 403,
            saveCookieAs: 'qaSuperAdmin',
            check: forbiddenCheck,
          },
          // Establish a real device session on a real community account so
          // super_admin denials across every /v2/users/* endpoint hit real
          // records and prove rejected mutations leave credentials, roles,
          // and sessions unchanged.
          {
            name: 'establish target community member device session for super_admin denial checks',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: { cookie: '' },
            body: {
              identifier: userCommunityCredentials.member.email,
              derivedKey,
              communitySlug: 'qa-user-management-community',
              deviceSession: true,
            },
            check: ownUser(
              userCommunityCredentials.member.email,
              'member',
              liveSessionCookie,
              userCommunity.id
            ),
          },
          {
            name: 'save target community member device session cookie',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'qaTargetMemberDevice',
            check: ownMeUser(
              userCommunityCredentials.member.email,
              'member',
              liveSessionCookie,
              userCommunity.id,
              false
            ),
          },
          {
            name: 'login target community admin to capture real device session handle',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: { cookie: '' },
            body: {
              identifier: userCommunityCredentials.admin.email,
              derivedKey,
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
            name: 'capture target community member device session handle',
            method: 'GET',
            path: `/v2/users/${userCommunityIds.member}/sessions`,
            expected: 200,
            saveCookieAs: 'qaTargetAdmin',
            check: (body) => {
              const rows = (
                body as {
                  data?: Array<{ handle?: unknown; kind?: unknown }>;
                }
              )?.data;
              if (!Array.isArray(rows) || rows.length !== 1) return false;
              const session = rows[0]!;
              if (
                session.kind !== 'device' ||
                typeof session.handle !== 'string' ||
                session.handle.length !== 22
              ) {
                return false;
              }
              qaSuperDeniedSessionHandle = session.handle;
              return true;
            },
          },
          {
            name: 'deny v2 user detail',
            method: 'GET',
            path: `/v2/users/${userCommunityIds.member}`,
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 user create',
            method: 'POST',
            path: '/v2/users',
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            body: {
              username: 'qa_super_denied_user',
              email: 'qa-super-denied-user@example.test',
              displayName: 'Denied By Policy',
              role: 'admin',
              password: {
                algorithm: ARGON2ID_ALGORITHM,
                salt: qaSuperDeniedSalt,
                params: JSON.parse(ARGON2ID_PARAMS_JSON),
                derivedKey: qaSuperDeniedKey,
              },
            },
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 user update',
            method: 'PATCH',
            path: `/v2/users/${userCommunityIds.member}`,
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            body: {
              role: 'admin',
              status: 'disabled',
              displayName: 'Tampered By Super Admin',
            },
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 user password reset',
            method: 'POST',
            path: `/v2/users/${userCommunityIds.member}/password-reset`,
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            body: {
              algorithm: ARGON2ID_ALGORITHM,
              salt: qaSuperDeniedSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: qaSuperDeniedKey,
            },
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 user login-code issuance',
            method: 'POST',
            path: `/v2/users/${userCommunityIds.member}/login-codes`,
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 user sessions list',
            method: 'GET',
            path: `/v2/users/${userCommunityIds.member}/sessions`,
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            check: forbiddenCheck,
          },
          {
            name: 'deny v2 user session revoke',
            method: 'DELETE',
            path: '/v2/users/pending',
            expected: 403,
            useSavedCookie: 'qaSuperAdmin',
            prepare: () =>
              `/v2/users/${userCommunityIds.member}/sessions/${qaSuperDeniedSessionHandle}`,
            check: forbiddenCheck,
          },
          {
            name: 'target member device session survives rejected super_admin mutations',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            useSavedCookie: 'qaTargetMemberDevice',
            check: ownMeUser(
              userCommunityCredentials.member.email,
              'member',
              liveSessionCookie,
              userCommunity.id,
              false
            ),
          },
          {
            name: 'rejected super_admin user create left no account',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.142',
              'cf-connecting-ip': '203.0.113.142',
            },
            body: {
              identifier: 'qa-super-denied-user@example.test',
              derivedKey: qaSuperDeniedKey,
              communitySlug: 'qa-user-management-community',
            },
            check: invalidCredentials,
          },
          {
            name: 'rejected super_admin password reset did not replace credentials',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.143',
              'cf-connecting-ip': '203.0.113.143',
            },
            body: {
              identifier: userCommunityCredentials.member.email,
              derivedKey: qaSuperDeniedKey,
              communitySlug: 'qa-user-management-community',
            },
            check: invalidCredentials,
          },
          {
            name: 'target member original credentials still authenticate with unchanged role',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: { cookie: '' },
            body: {
              identifier: userCommunityCredentials.member.email,
              derivedKey,
              communitySlug: 'qa-user-management-community',
            },
            check: ownUser(
              userCommunityCredentials.member.email,
              'member',
              liveSessionCookie,
              userCommunity.id
            ),
          },
          {
            name: 'logout verification member session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'target community user list unchanged after super_admin denials',
            method: 'GET',
            path: '/v2/users',
            expected: 200,
            useSavedCookie: 'qaTargetAdmin',
            check: (body) => {
              const parsed = body as {
                data?: Array<{ email?: unknown }>;
                meta?: { total?: number };
              };
              return (
                parsed?.meta?.total === 3 &&
                Array.isArray(parsed?.data) &&
                parsed.data.length === 3 &&
                !parsed.data.some(
                  (row) => row.email === 'qa-super-denied-user@example.test'
                )
              );
            },
          },
          {
            name: 'target member profile and role unchanged after super_admin denials',
            method: 'GET',
            path: `/v2/users/${userCommunityIds.member}`,
            expected: 200,
            useSavedCookie: 'qaTargetAdmin',
            check: (body) => {
              const data = (
                body as {
                  data?: {
                    id?: unknown;
                    email?: unknown;
                    role?: unknown;
                    status?: unknown;
                    displayName?: unknown;
                  };
                }
              )?.data;
              return (
                !!data &&
                data.id === userCommunityIds.member &&
                data.email === userCommunityCredentials.member.email &&
                data.role === 'member' &&
                data.status === 'active' &&
                data.displayName === null
              );
            },
          },
          {
            name: 'target member device session unchanged after super_admin denials',
            method: 'GET',
            path: `/v2/users/${userCommunityIds.member}/sessions`,
            expected: 200,
            useSavedCookie: 'qaTargetAdmin',
            check: (body) => {
              const rows = (
                body as { data?: Array<{ handle?: unknown; kind?: unknown }> }
              )?.data;
              return (
                Array.isArray(rows) &&
                rows.length === 1 &&
                rows[0]?.handle === qaSuperDeniedSessionHandle &&
                rows[0]?.kind === 'device'
              );
            },
          },
          {
            name: 'logout target community admin helper session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'qaTargetAdmin',
          },
          {
            name: 'logout target community member helper device session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'qaTargetMemberDevice',
          },
          {
            name: 'deny community media metadata',
            method: 'GET',
            path: `/v2/media/${readableFileId}/metadata`,
            expected: 404,
            useSavedCookie: 'qaSuperAdmin',
          },
          {
            name: 'deny community media delete',
            method: 'DELETE',
            path: `/v2/media/${readableFileId}`,
            expected: 404,
            useSavedCookie: 'qaSuperAdmin',
          },
          {
            name: 'logout',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'qaSuperAdmin',
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
              backend?.seededAdminsHaveRecoveryCodes === true
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
          ...forbiddenAdminSteps,
          ...forbiddenImportSteps('disabled admin'),
          ...(() => {
            let disabledManifestToken1 = '';
            let disabledZipToken1 = '';
            let disabledManifestChecksum1 = '';
            let disabledZipChecksum1 = '';
            let disabledManifestBytes1 = new Uint8Array(0);
            let disabledZipBytes1 = new Uint8Array(0);
            let disabledManifestToken2 = '';
            let disabledZipToken2 = '';
            return [
              {
                name: 'export disabled community as own admin',
                method: 'POST',
                path: '/v2/community/export',
                expected: 201,
                body: {},
                check: (body: unknown) => {
                  const parsed =
                    CreateCommunityExportResponseSchema.safeParse(body);
                  if (!parsed.success) return false;
                  disabledManifestToken1 =
                    parsed.data.data.artifacts.manifest.token;
                  disabledZipToken1 = parsed.data.data.artifacts.mediaZip.token;
                  disabledManifestChecksum1 =
                    parsed.data.data.artifacts.manifest.checksum;
                  disabledZipChecksum1 =
                    parsed.data.data.artifacts.mediaZip.checksum;
                  return true;
                },
              },
              {
                name: 'download disabled community manifest including #162 rows',
                method: 'GET',
                path: '/v2/community/export/download/pending',
                expected: 200,
                prepare: () =>
                  `/v2/community/export/download/${disabledManifestToken1}`,
                checkHeaders: (headers: Headers) =>
                  headers.get('cache-control') === 'no-store' &&
                  (headers.get('content-disposition') ?? '').includes(
                    'attachment'
                  ),
                checkBytes: (bytes: Uint8Array) => {
                  if (
                    new StreamingSha256().update(bytes).digestHex() !==
                    disabledManifestChecksum1
                  ) {
                    return false;
                  }
                  const manifest = JSON.parse(
                    new TextDecoder().decode(bytes)
                  ) as {
                    community?: { id?: number; status?: string };
                    stories?: Array<{
                      id: number;
                      isRestricted?: boolean;
                      privacyLevel?: string;
                    }>;
                    files?: Array<{ id: string }>;
                  };
                  disabledManifestBytes1 = bytes;
                  const hasPublicDisabled =
                    manifest.stories?.some((s) => s.id === inactiveStory.id) ??
                    false;
                  const hasRestrictedDisabled =
                    manifest.stories?.some(
                      (s) =>
                        s.id === inactiveRestrictedStory.id &&
                        s.isRestricted === true &&
                        s.privacyLevel === 'editors'
                    ) ?? false;
                  const hasDisabledFile =
                    manifest.files?.some((f) => f.id === inactiveFileId) ??
                    false;
                  return (
                    manifest.community?.id === inactiveCommunity.id &&
                    manifest.community?.status === 'disabled' &&
                    hasPublicDisabled &&
                    hasRestrictedDisabled &&
                    hasDisabledFile
                  );
                },
              },
              {
                name: 'download disabled community media zip',
                method: 'GET',
                path: '/v2/community/export/download/pending',
                expected: 200,
                prepare: () =>
                  `/v2/community/export/download/${disabledZipToken1}`,
                checkBytes: (bytes: Uint8Array) => {
                  if (
                    new StreamingSha256().update(bytes).digestHex() !==
                    disabledZipChecksum1
                  ) {
                    return false;
                  }
                  const entries = parseDeterministicZip(bytes);
                  disabledZipBytes1 = bytes;
                  return entries.some(
                    (e) => e.path === `media/${inactiveFileId}`
                  );
                },
              },
              {
                name: 're-export disabled community deterministically',
                method: 'POST',
                path: '/v2/community/export',
                expected: 201,
                body: {},
                check: (body: unknown) => {
                  const parsed =
                    CreateCommunityExportResponseSchema.safeParse(body);
                  if (!parsed.success) return false;
                  disabledManifestToken2 =
                    parsed.data.data.artifacts.manifest.token;
                  disabledZipToken2 = parsed.data.data.artifacts.mediaZip.token;
                  return (
                    parsed.data.data.artifacts.manifest.checksum ===
                      disabledManifestChecksum1 &&
                    parsed.data.data.artifacts.mediaZip.checksum ===
                      disabledZipChecksum1
                  );
                },
              },
              {
                name: 'verify byte-identical disabled community manifest',
                method: 'GET',
                path: '/v2/community/export/download/pending',
                expected: 200,
                prepare: () =>
                  `/v2/community/export/download/${disabledManifestToken2}`,
                checkBytes: (bytes: Uint8Array) =>
                  bytes.byteLength === disabledManifestBytes1.byteLength &&
                  bytes.every(
                    (byte, index) => byte === disabledManifestBytes1[index]
                  ),
              },
              {
                name: 'verify byte-identical disabled community media zip',
                method: 'GET',
                path: '/v2/community/export/download/pending',
                expected: 200,
                prepare: () =>
                  `/v2/community/export/download/${disabledZipToken2}`,
                checkBytes: (bytes: Uint8Array) =>
                  bytes.byteLength === disabledZipBytes1.byteLength &&
                  bytes.every(
                    (byte, index) => byte === disabledZipBytes1[index]
                  ),
              },
              {
                name: 'deny community audit entries while community is disabled',
                method: 'GET',
                path: '/v2/community/audit-entries',
                expected: 403,
                check: forbiddenCheck,
              },
            ];
          })(),
          {
            name: 'reset recovered disabled admin password (assisted)',
            method: 'POST',
            path: `/v2/users/${disabledRecoveredAdminId}/password-reset`,
            expected: 204,
            body: {
              algorithm: 'client-argon2id+sha256',
              salt: qaResetSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: qaResetDerivedKey,
            },
          },
          {
            name: 'issue admin_issued code for recovered disabled admin',
            method: 'POST',
            path: `/v2/users/${disabledRecoveredAdminId}/login-codes`,
            expected: 201,
            check: (body) => {
              const data = (
                body as {
                  data?: { code?: unknown; purpose?: unknown };
                }
              )?.data;
              if (
                data?.purpose === 'admin_issued' &&
                typeof data?.code === 'string' &&
                /^[A-Za-z0-9_-]{20,64}$/.test(data.code)
              ) {
                qaDisabledRecoveredAdminLoginCode = data.code;
                return true;
              }
              return false;
            },
          },
          {
            name: 'redeem admin_issued code for recovered disabled admin',
            method: 'POST',
            path: '/v2/auth/recovery/redeem',
            expected: 200,
            headers: { cookie: 'ts_session=' },
            prepare: () => {
              qaDisabledRecoveredAdminRedeemBody.code =
                qaDisabledRecoveredAdminLoginCode;
            },
            body: qaDisabledRecoveredAdminRedeemBody,
            checkHeaders: (headers) =>
              headers.get('set-cookie')?.includes('ts_session=') ?? false,
          },
          {
            name: 'recovered disabled admin authenticates',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: (body) =>
              (body as { user?: { email?: string } })?.user?.email ===
              disabledRecoveredAdminCredentials.email,
          },
          {
            name: 'recovered disabled admin content stays denied',
            method: 'GET',
            path: `/v2/media/${inactiveFileId}`,
            expected: 404,
          },
          {
            name: 'logout recovered disabled admin',
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
          {
            name: 'preview CSV places import with staged media for discard',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            captureId: 'qaImportDiscardManifest',
            ...qaMultipart({
              filename: 'qa-places-discard.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                'name,region,photo\nQA Import Discard Place,North,qa-discard-pic.png\n'
              ),
              fields: { kind: 'places' },
              mediaParts: [
                {
                  filename: 'qa-discard-pic.png',
                  contentType: 'image/png',
                  bytes: mediaPngBytes,
                },
              ],
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaImportDiscardManifestId = parsed.data.data.id;
              return (
                parsed.data.data.status === 'previewed' &&
                parsed.data.data.canCommit === true &&
                parsed.data.data.rowCount === 1 &&
                parsed.data.data.stagedMediaCount === 1 &&
                parsed.data.data.mediaSummary.stagedCount === 1 &&
                !JSON.stringify(body).includes('storageKey')
              );
            },
          },
          {
            name: 'withhold pre-commit import staged media from /v2/media/:id',
            method: 'GET',
            path: '/v2/media/pending',
            expected: 404,
            prepare: async () => {
              const [manifestRow] = await db
                .select({
                  stagedFileIds: importManifests.stagedFileIds,
                  sourceFileId: importManifests.sourceFileId,
                })
                .from(importManifests)
                .where(eq(importManifests.id, qaImportDiscardManifestId))
                .limit(1);
              if (!manifestRow) {
                throw new Error('Missing discard manifest row in DB');
              }
              const stagedIds = parseJsonArray<string>(
                manifestRow.stagedFileIds
              );
              if (stagedIds.length !== 1) {
                throw new Error(
                  `Expected 1 staged file ID on discard manifest, got ${stagedIds.length}`
                );
              }
              qaDiscardStagedFileId = stagedIds[0]!;
              qaDiscardSourceFileId = manifestRow.sourceFileId;
              const [sourceRow] = await db
                .select({ storageKey: files.storageKey, path: files.path })
                .from(files)
                .where(eq(files.id, qaDiscardSourceFileId))
                .limit(1);
              if (!sourceRow) {
                throw new Error('Missing source CSV file row in files table');
              }
              qaDiscardSourceStorageKey =
                sourceRow.storageKey ?? sourceRow.path;
              const [fileRow] = await db
                .select({ storageKey: files.storageKey, path: files.path })
                .from(files)
                .where(eq(files.id, qaDiscardStagedFileId))
                .limit(1);
              if (!fileRow) {
                throw new Error('Missing staged file row in files table');
              }
              qaDiscardStagedStorageKey = fileRow.storageKey ?? fileRow.path;
              if (!(await hasMedia(qaDiscardStagedStorageKey))) {
                throw new Error(
                  'Expected staged media bytes in storage before discard'
                );
              }
              return `/v2/media/${qaDiscardStagedFileId}`;
            },
          },
          {
            name: 'list own-community import manifests',
            method: 'GET',
            path: '/v2/imports',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.some(
                  (item) => item.id === qaImportDiscardManifestId
                ) &&
                !parsed.data.data.some(
                  (item) => item.id === foreignImportManifest.id
                )
              );
            },
          },
          {
            name: 'get previewed import manifest detail',
            method: 'GET',
            path: '/v2/imports/{qaImportDiscardManifest}',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'previewed' &&
                parsed.data.data.stagedMediaCount === 1
              );
            },
          },
          {
            name: 'discard previewed import manifest',
            method: 'DELETE',
            path: '/v2/imports/{qaImportDiscardManifest}',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'discarded' &&
                parsed.data.data.canCommit === false
              );
            },
          },
          {
            name: 'reject commit of discarded manifest and confirm staged bytes removed',
            method: 'POST',
            path: '/v2/imports/{qaImportDiscardManifest}/commit',
            expected: 409,
            prepare: async () => {
              const stagedRows = await db
                .select({ id: files.id })
                .from(files)
                .where(eq(files.id, qaDiscardStagedFileId))
                .limit(1);
              if (stagedRows.length !== 0) {
                throw new Error(
                  'Staged file row was not deleted on manifest discard'
                );
              }
              if (await hasMedia(qaDiscardStagedStorageKey)) {
                throw new Error(
                  'Staged media bytes remained in storage after manifest discard'
                );
              }
              if (await hasMedia(qaDiscardSourceStorageKey)) {
                throw new Error(
                  'Source CSV bytes remained in storage after manifest discard'
                );
              }
              const sourceRows = await db
                .select({ id: files.id, isActive: files.isActive })
                .from(files)
                .where(eq(files.id, qaDiscardSourceFileId))
                .limit(1);
              if (
                sourceRows.length !== 1 ||
                sourceRows[0]!.isActive !== false
              ) {
                throw new Error(
                  'Source CSV file row should remain inactive after manifest discard'
                );
              }
            },
          },
          {
            name: 'preview stories CSV with unknown audience (never coerce to public)',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            captureId: 'qaImportUnknownAudience',
            ...qaMultipart({
              filename: 'qa-unknown-audience.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                'title,visibility\nQA Bad Audience Story,secret_elders\n'
              ),
              fields: { kind: 'stories' },
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaImportUnknownAudienceId = parsed.data.data.id;
              return (
                parsed.data.data.validRowCount === 0 &&
                parsed.data.data.errorCount >= 1 &&
                parsed.data.data.canCommit === false &&
                parsed.data.data.audienceSummary?.public === 0 &&
                parsed.data.data.rowErrors.some(
                  (err) =>
                    err.field === 'visibility' &&
                    err.code === 'unknown_audience'
                )
              );
            },
          },
          {
            name: 'reject commit of manifest containing unknown audience row error',
            method: 'POST',
            path: '/v2/imports/{qaImportUnknownAudience}/commit',
            expected: 422,
            check: (body) =>
              (body as { code?: unknown })?.code === 'import_not_committable',
          },
          {
            name: 'preview places CSV referencing missing media file',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            ...qaMultipart({
              filename: 'qa-missing-media.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                'name,photo\nQA Missing Media Place,missing-asset.png\n'
              ),
              fields: { kind: 'places' },
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.canCommit === false &&
                parsed.data.data.rowErrors.some(
                  (err) => err.field === 'photo' && err.code === 'missing_media'
                )
              );
            },
          },
          {
            name: 'preview stories CSV rejecting cross-community place, speaker, and file refs',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            ...qaMultipart({
              filename: 'qa-cross-community.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                `title,visibility,place_ids,speaker_ids,media\nQA Cross Tenant Story,community,${publicPlace.id},${speaker.id},${foreignFileId}\n`
              ),
              fields: { kind: 'stories' },
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const codes = new Set(
                parsed.data.data.rowErrors.map((err) => err.code)
              );
              return (
                parsed.data.data.canCommit === false &&
                codes.has('missing_place') &&
                codes.has('missing_speaker') &&
                codes.has('missing_media')
              );
            },
          },
          {
            name: 'reject malformed CSV upload on preview',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 400,
            ...qaMultipart({
              filename: 'qa-malformed.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                'name,region\n"unclosed place,North\n'
              ),
              fields: { kind: 'places' },
            }),
          },
          ...(isD1Backend
            ? [
                {
                  name: 'reject preview exceeding D1 statement budget with actionable diagnostics',
                  method: 'POST',
                  path: '/v2/imports/preview',
                  expected: 422,
                  ...qaMultipart({
                    filename: 'qa-d1-budget.csv',
                    contentType: 'text/csv',
                    bytes: new TextEncoder().encode(qaD1BudgetCsv),
                    fields: { kind: 'stories' },
                  }),
                  check: (body: unknown) => {
                    const err = body as {
                      code?: unknown;
                      details?: {
                        commitPlan?: {
                          withinD1Budget?: unknown;
                          statementCount?: unknown;
                        };
                        violations?: Array<{ limit?: unknown }>;
                        alternatives?: unknown;
                      };
                    };
                    return (
                      err?.code === 'd1_budget_exceeded' &&
                      err.details?.commitPlan?.withinD1Budget === false &&
                      typeof err.details?.commitPlan?.statementCount ===
                        'number' &&
                      err.details.commitPlan.statementCount > 1000 &&
                      (err.details?.violations?.some(
                        (v) => v.limit === 'max_statements'
                      ) ??
                        false) &&
                      typeof err.details?.alternatives === 'string' &&
                      err.details.alternatives
                        .toLowerCase()
                        .includes('field kit')
                    );
                  },
                },
              ]
            : [
                {
                  name: 'preview over-budget CSV on Node reports withinD1Budget=false diagnostics',
                  method: 'POST',
                  path: '/v2/imports/preview',
                  expected: 201,
                  captureId: 'qaImportD1BudgetManifest',
                  ...qaMultipart({
                    filename: 'qa-d1-budget.csv',
                    contentType: 'text/csv',
                    bytes: new TextEncoder().encode(qaD1BudgetCsv),
                    fields: { kind: 'stories' },
                  }),
                  check: (body: unknown) => {
                    const parsed =
                      ImportManifestDetailResponseSchema.safeParse(body);
                    return (
                      parsed.success &&
                      parsed.data.data.canCommit === true &&
                      parsed.data.data.commitPlan.withinD1Budget === false &&
                      parsed.data.data.commitPlan.statementCount > 1000
                    );
                  },
                },
                {
                  name: 'discard oversized D1-budget preview manifest on Node',
                  method: 'DELETE',
                  path: '/v2/imports/{qaImportD1BudgetManifest}',
                  expected: 200,
                },
              ]),
          {
            name: 'preview places CSV import with staged photo and name audio',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            captureId: 'qaImportPlacesManifest',
            ...qaMultipart({
              filename: 'qa-places-commit.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                'name,region,latitude,longitude,photo,name_audio\nQA Imported Place,Highlands,-3.41,-60.41,qa-place-pic.png,qa-place-audio.wav\n'
              ),
              fields: { kind: 'places' },
              mediaParts: [
                {
                  filename: 'qa-place-pic.png',
                  contentType: 'image/png',
                  bytes: mediaPngBytes,
                },
                {
                  filename: 'qa-place-audio.wav',
                  contentType: 'audio/wav',
                  bytes: mediaWavBytes,
                },
              ],
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaImportPlacesManifestId = parsed.data.data.id;
              return (
                parsed.data.data.status === 'previewed' &&
                parsed.data.data.canCommit === true &&
                parsed.data.data.stagedMediaCount === 2 &&
                parsed.data.data.mediaSummary.stagedCount === 2 &&
                parsed.data.data.mediaSummary.totalAttachmentRefs === 2
              );
            },
          },
          {
            name: 'commit places import manifest atomically',
            method: 'POST',
            path: '/v2/imports/{qaImportPlacesManifest}/commit',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaCommittedPlacesAt = parsed.data.data.committedAt ?? '';
              qaCommittedPlacesSummaryJson = JSON.stringify(
                parsed.data.data.resultSummary
              );
              return (
                parsed.data.data.status === 'committed' &&
                parsed.data.data.canCommit === false &&
                parsed.data.data.committedAt !== null &&
                parsed.data.data.resultSummary?.createdPlaces === 1 &&
                parsed.data.data.resultSummary?.createdAttachments === 2 &&
                parsed.data.data.resultSummary?.createdSpeakers === 0 &&
                parsed.data.data.resultSummary?.createdStories === 0
              );
            },
          },
          {
            name: 're-commit committed places manifest idempotently',
            method: 'POST',
            path: '/v2/imports/{qaImportPlacesManifest}/commit',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'committed' &&
                parsed.data.data.committedAt === qaCommittedPlacesAt &&
                JSON.stringify(parsed.data.data.resultSummary) ===
                  qaCommittedPlacesSummaryJson
              );
            },
          },
          {
            name: 'read activated staged media after places import commit',
            method: 'GET',
            path: '/v2/media/pending',
            expected: 200,
            prepare: async () => {
              const [row] = await db
                .select({ stagedFileIds: importManifests.stagedFileIds })
                .from(importManifests)
                .where(eq(importManifests.id, qaImportPlacesManifestId))
                .limit(1);
              const fileId = parseJsonArray<string>(row?.stagedFileIds)[0];
              if (!fileId) {
                throw new Error('Missing activated staged file ID');
              }
              return `/v2/media/${fileId}`;
            },
          },
          {
            name: 'confirm imported place and attached media in GET /v2/places',
            method: 'GET',
            path: '/v2/places',
            expected: 200,
            check: (body) => {
              const parsed = PublicPlacesListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.some(
                  (place) =>
                    place.name === 'QA Imported Place' &&
                    place.region === 'Highlands' &&
                    place.photos.length === 1 &&
                    place.placenameAudio !== null
                )
              );
            },
          },
          ...(isD1Backend
            ? [
                {
                  name: 'enforce D1 1-import-per-UTC-day limit after committed import',
                  method: 'POST',
                  path: '/v2/imports/preview',
                  expected: 429,
                  ...qaMultipart({
                    filename: 'qa-daily-limit.csv',
                    contentType: 'text/csv',
                    bytes: new TextEncoder().encode(
                      'name\nQA Daily Limit Blocked\n'
                    ),
                    fields: { kind: 'places' },
                  }),
                  check: (body: unknown) =>
                    (body as { code?: unknown })?.code ===
                    'd1_daily_import_limit',
                },
              ]
            : []),
          {
            name: 'preview speakers CSV import with related birthplace and staged photo',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            captureId: 'qaImportSpeakersManifest',
            prepare: backdateCommittedImportsForD1,
            ...qaMultipart({
              filename: 'qa-speakers-commit.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                'name,birthplace_name,affiliation,photo\nQA Imported Speaker,QA Imported Birthplace,QA Guild,qa-speaker-pic.png\n'
              ),
              fields: { kind: 'speakers' },
              mediaParts: [
                {
                  filename: 'qa-speaker-pic.png',
                  contentType: 'image/png',
                  bytes: mediaPngBytes,
                },
              ],
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'previewed' &&
                parsed.data.data.canCommit === true &&
                parsed.data.data.relatedRecords.placesToCreateCount === 1 &&
                parsed.data.data.stagedMediaCount === 1
              );
            },
          },
          {
            name: 'commit speakers import manifest atomically',
            method: 'POST',
            path: '/v2/imports/{qaImportSpeakersManifest}/commit',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'committed' &&
                parsed.data.data.resultSummary?.createdPlaces === 1 &&
                parsed.data.data.resultSummary?.createdSpeakers === 1 &&
                parsed.data.data.resultSummary?.createdAttachments === 1
              );
            },
          },
          {
            name: 'confirm imported speaker, birthplace, and photo in GET /v2/speakers',
            method: 'GET',
            path: '/v2/speakers',
            expected: 200,
            check: (body) => {
              const parsed = PublicSpeakersListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.some(
                  (spk) =>
                    spk.name === 'QA Imported Speaker' &&
                    spk.affiliation === 'QA Guild' &&
                    spk.birthplace?.name === 'QA Imported Birthplace' &&
                    spk.photo !== null
                )
              );
            },
          },
          {
            name: 'preview stories CSV with audienceMapping, related edges, staged media, and external link',
            method: 'POST',
            path: '/v2/imports/preview',
            expected: 201,
            captureId: 'qaImportStoriesManifest',
            prepare: backdateCommittedImportsForD1,
            ...qaMultipart({
              filename: 'qa-stories-commit.csv',
              contentType: 'text/csv',
              bytes: new TextEncoder().encode(
                `title,visibility,topic,language,place_ids,place_names,speaker_ids,speaker_names,media,external_media_links\nQA Imported Story,community-circle,Oral History,en,"${mediaPlace.id},${mediaPlace.id}",QA Imported Story Place,${mediaSpeaker.id},QA Imported Story Speaker,qa-story-pic.png,https://media.example.test/qa-import/1\n`
              ),
              fields: {
                kind: 'stories',
                audienceMapping: JSON.stringify({
                  'community-circle': 'community',
                }),
              },
              mediaParts: [
                {
                  filename: 'qa-story-pic.png',
                  contentType: 'image/png',
                  bytes: mediaPngBytes,
                },
              ],
            }),
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaImportStoriesManifestId = parsed.data.data.id;
              return (
                parsed.data.data.status === 'previewed' &&
                parsed.data.data.canCommit === true &&
                parsed.data.data.audienceMapping?.['community-circle'] ===
                  'community' &&
                parsed.data.data.audienceSummary?.public === 0 &&
                parsed.data.data.audienceSummary?.community === 1 &&
                parsed.data.data.audienceSummary?.editors === 0 &&
                parsed.data.data.relatedRecords.resolvedPlacesCount === 1 &&
                parsed.data.data.relatedRecords.placesToCreateCount === 1 &&
                parsed.data.data.relatedRecords.resolvedSpeakersCount === 1 &&
                parsed.data.data.relatedRecords.speakersToCreateCount === 1 &&
                parsed.data.data.previewRows.length === 1 &&
                parsed.data.data.previewRowsTruncated === false &&
                parsed.data.data.stagedMediaCount === 1
              );
            },
          },
          {
            name: 'commit stories import manifest atomically with edge multiplicity',
            method: 'POST',
            path: '/v2/imports/{qaImportStoriesManifest}/commit',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'committed' &&
                parsed.data.data.resultSummary?.createdStories === 1 &&
                parsed.data.data.resultSummary?.createdPlaces === 1 &&
                parsed.data.data.resultSummary?.createdSpeakers === 1 &&
                parsed.data.data.resultSummary?.createdStoryPlaces === 3 &&
                parsed.data.data.resultSummary?.createdStorySpeakers === 2 &&
                parsed.data.data.resultSummary?.createdAttachments === 1 &&
                parsed.data.data.resultSummary?.createdExternalLinks === 1
              );
            },
          },
          {
            name: 'confirm imported story edges, media, and external link in GET /v2/stories',
            method: 'GET',
            path: '/v2/stories',
            expected: 200,
            check: (body) => {
              const parsed = CommunityStoriesListResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const imported = parsed.data.data.stories.find(
                (story) => story.title === 'QA Imported Story'
              );
              return (
                imported !== undefined &&
                imported.visibility === 'community' &&
                imported.attachments.length === 1 &&
                imported.externalMediaLinks.length === 1 &&
                imported.places.some((p) => p.id === mediaPlace.id) &&
                imported.places.some(
                  (p) => p.name === 'QA Imported Story Place'
                ) &&
                imported.speakers.some((s) => s.id === mediaSpeaker.id) &&
                imported.speakers.some(
                  (s) => s.name === 'QA Imported Story Speaker'
                )
              );
            },
          },
          {
            name: 'filter committed import manifests and verify content-free import audits',
            method: 'GET',
            path: '/v2/imports?status=committed',
            expected: 200,
            prepare: async () => {
              const entries = await db
                .select()
                .from(auditEntries)
                .where(
                  and(
                    eq(auditEntries.communityId, mediaCommunity.id),
                    eq(auditEntries.resourceType, 'import_manifest')
                  )
                )
                .orderBy(asc(auditEntries.id));
              const actions = new Set(entries.map((entry) => entry.action));
              for (const required of [
                'import.preview',
                'import.discard',
                'import.commit',
              ]) {
                if (!actions.has(required)) {
                  throw new Error(`Missing audit action ${required}`);
                }
              }
              const forbiddenAuditTokens = [
                'QA Imported Place',
                'QA Imported Speaker',
                'QA Imported Story',
                'QA Bad Audience Story',
                'qa-place-pic.png',
                'qa-discard-pic.png',
                'https://media.example.test/qa-import/1',
                ...HONO_PERSONA_CULTURAL_STRINGS,
              ];
              for (const entry of entries) {
                validateContentFreeAuditEntry({
                  communityId: entry.communityId,
                  actorId: entry.actorId,
                  action: entry.action,
                  resourceType: entry.resourceType,
                  resourceIds: parseJsonArray<number | string>(
                    entry.resourceIds
                  ),
                  outcome: entry.outcome,
                  ipAddress: entry.ipAddress,
                  userAgent: entry.userAgent,
                });
                const serialized = JSON.stringify(entry);
                for (const token of forbiddenAuditTokens) {
                  if (serialized.includes(token)) {
                    throw new Error(
                      `Import audit entry leaked row/content token "${token}"`
                    );
                  }
                }
              }
            },
            check: (body) => {
              const parsed = ImportManifestListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.length === 3 &&
                parsed.data.meta.total === 3 &&
                parsed.data.data.every((item) => item.status === 'committed')
              );
            },
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
            captureId: 'qaPlaceAudioAtt',
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
            captureId: 'qaPlacePhotoAtt',
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
            name: 'detach place photo',
            method: 'DELETE',
            path: '/v2/attachments/{qaPlacePhotoAtt}',
            expected: 204,
          },
          {
            name: 'detach place-name audio',
            method: 'DELETE',
            path: '/v2/attachments/{qaPlaceAudioAtt}',
            expected: 204,
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
            captureId: 'qaUserPhotoAtt',
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
            name: 'admin attaches community background image',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            captureId: 'qaBackgroundAtt',
            body: {
              fileId: '{qaAdminFile}',
              ownerType: 'community',
              ownerId: mediaCommunity.id,
              role: 'community_background_image',
            },
          },
          {
            name: 'admin attaches sponsor logo',
            method: 'POST',
            path: '/v2/attachments',
            expected: 201,
            captureId: 'qaSponsorAtt',
            body: {
              fileId: '{qaAdminFile}',
              ownerType: 'community',
              ownerId: mediaCommunity.id,
              role: 'sponsor_logo',
            },
          },
          {
            name: 'community branding shows the background image and the sponsor logo',
            method: 'GET',
            path: '/v2/community',
            expected: 200,
            check: mediaBrandingIs({ background: true, sponsors: true }),
          },
          {
            name: 'admin detaches sponsor logo',
            method: 'DELETE',
            path: '/v2/attachments/{qaSponsorAtt}',
            expected: 204,
          },
          {
            name: 'community branding drops the sponsor logo and keeps the background image',
            method: 'GET',
            path: '/v2/community',
            expected: 200,
            check: mediaBrandingIs({ background: true, sponsors: false }),
          },
          {
            name: 'admin detached sponsor logo cannot be detached twice',
            method: 'DELETE',
            path: '/v2/attachments/{qaSponsorAtt}',
            expected: 404,
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
            name: 'admin detaches member user photo',
            method: 'DELETE',
            path: '/v2/attachments/{qaUserPhotoAtt}',
            expected: 204,
          },
          {
            name: 'admin detaches community display image',
            method: 'DELETE',
            path: '/v2/attachments/{qaDisplayAtt}',
            expected: 204,
          },
          {
            name: 'admin lists own-community import manifests excluding foreign tenant',
            method: 'GET',
            path: '/v2/imports',
            expected: 200,
            check: (body) => {
              const parsed = ImportManifestListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.some(
                  (item) => item.id === qaImportStoriesManifestId
                ) &&
                !parsed.data.data.some(
                  (item) => item.id === foreignImportManifest.id
                )
              );
            },
          },
          {
            name: 'admin reads editor committed import manifest detail',
            method: 'GET',
            path: '/v2/imports/pending',
            expected: 200,
            prepare: () => `/v2/imports/${qaImportStoriesManifestId}`,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'committed' &&
                parsed.data.data.kind === 'stories'
              );
            },
          },
          {
            name: 'admin discards editor previewed import manifest',
            method: 'DELETE',
            path: '/v2/imports/pending',
            expected: 200,
            prepare: () => `/v2/imports/${qaImportUnknownAudienceId}`,
            check: (body) => {
              const parsed = ImportManifestDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'discarded' &&
                parsed.data.data.canCommit === false
              );
            },
          },
          {
            name: 'admin gets 404 reading cross-community import manifest detail',
            method: 'GET',
            path: `/v2/imports/${foreignImportManifest.id}`,
            expected: 404,
            check: publicNotFoundCheck,
          },
          {
            name: 'admin gets 404 committing cross-community import manifest',
            method: 'POST',
            path: `/v2/imports/${foreignImportManifest.id}/commit`,
            expected: 404,
            check: publicNotFoundCheck,
          },
          {
            name: 'admin gets 404 discarding cross-community import manifest',
            method: 'DELETE',
            path: `/v2/imports/${foreignImportManifest.id}`,
            expected: 404,
            check: publicNotFoundCheck,
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
          ...forbiddenImportSteps('viewer'),
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
          ...forbiddenImportSteps('member'),
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
          ...forbiddenImportSteps('super_admin'),
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
        // Self-service profile edits for non-super_admin community roles
        // (UI INTERACTIONS B02/B04). Dedicated accounts: the password change
        // revokes the account's other sessions and installs a new verifier,
        // so no shared persona credential is touched.
        persona: 'self_service_member',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              'x-forwarded-for': '203.0.113.171',
              'cf-connecting-ip': '203.0.113.171',
            },
            body: loginBody(selfServiceCredentials.member.email),
            check: ssOwn('member'),
          },
          {
            name: 'member reads own profile before the edit',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'qaSelfServiceFirstCookie',
            check: (body) =>
              ssMe('member')(body) &&
              (body as { user?: { displayName?: unknown } }).user
                ?.displayName !== 'QA Self Service Member',
          },
          {
            name: 'member patches own display name',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 200,
            body: { displayName: 'QA Self Service Member' },
            check: (body) =>
              ssOwn('member')(body) &&
              (body as { user?: { displayName?: unknown; id?: unknown } }).user
                ?.displayName === 'QA Self Service Member' &&
              (body as { user?: { id?: unknown } }).user?.id ===
                selfServiceIds.member,
          },
          {
            name: 'member display name change persists on re-read',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ssMe('member', 'QA Self Service Member'),
          },
          {
            name: 'member cannot escalate role through the profile patch',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 400,
            body: { displayName: 'QA Self Service Member', role: 'admin' },
          },
          {
            name: 'member role is unchanged after the rejected patch',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ssMe('member', 'QA Self Service Member'),
          },
          {
            // A second device: an empty presented cookie keeps the first
            // session alive so the password change can be proven to revoke it.
            name: 'member opens a second session',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: 'ts_session=',
              'x-forwarded-for': '203.0.113.171',
              'cf-connecting-ip': '203.0.113.171',
            },
            body: loginBody(selfServiceCredentials.member.email),
            check: ssOwn('member'),
          },
          {
            name: 'member changes own password',
            method: 'POST',
            path: '/v2/auth/password',
            expected: 200,
            body: {
              currentDerivedKey: derivedKey,
              algorithm: ARGON2ID_ALGORITHM,
              salt: verifierSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: selfServiceMemberNewKey,
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'member first session is revoked by the password change',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'qaSelfServiceFirstCookie',
          },
          {
            name: 'member current session survives the password change',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ssMe('member', 'QA Self Service Member'),
          },
          {
            name: 'member password change with the old key as current is refused',
            method: 'POST',
            path: '/v2/auth/password',
            expected: 401,
            body: {
              currentDerivedKey: derivedKey,
              algorithm: ARGON2ID_ALGORITHM,
              salt: verifierSalt,
              params: JSON.parse(ARGON2ID_PARAMS_JSON),
              derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
            },
            check: invalidCredentials,
          },
          ssLogout,
          {
            name: 'member old password no longer authenticates',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              'x-forwarded-for': '203.0.113.172',
              'cf-connecting-ip': '203.0.113.172',
            },
            body: loginBody(selfServiceCredentials.member.email),
            check: invalidCredentials,
          },
          {
            name: 'member new password authenticates',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              'x-forwarded-for': '203.0.113.173',
              'cf-connecting-ip': '203.0.113.173',
            },
            body: {
              identifier: selfServiceCredentials.member.email,
              derivedKey: selfServiceMemberNewKey,
            },
            check: (body) =>
              ssOwn('member')(body) &&
              (body as { user?: { displayName?: unknown } }).user
                ?.displayName === 'QA Self Service Member',
          },
          ssLogout,
        ],
      },
      {
        persona: 'self_service_editor',
        steps: [
          {
            name: 'login',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              'x-forwarded-for': '203.0.113.174',
              'cf-connecting-ip': '203.0.113.174',
            },
            body: loginBody(selfServiceCredentials.editor.email),
            check: ssOwn('editor'),
          },
          {
            name: 'editor patches own display name',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 200,
            body: { displayName: 'QA Self Service Editor' },
            check: (body) =>
              ssOwn('editor')(body) &&
              (body as { user?: { displayName?: unknown } }).user
                ?.displayName === 'QA Self Service Editor',
          },
          {
            name: 'editor rejects a blank display name',
            method: 'PATCH',
            path: '/v2/auth/me',
            expected: 400,
            body: { displayName: '   ' },
          },
          {
            name: 'editor display name keeps the last valid value',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: ssMe('editor', 'QA Self Service Editor'),
          },
          ssLogout,
        ],
      },
      {
        // Admin disables a community user (UI INTERACTIONS D05 alternative:
        // deactivate instead of delete) and the disabled account is refused.
        persona: 'user_disable',
        steps: [
          {
            name: 'target logs in before it is disabled',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              'x-forwarded-for': '203.0.113.175',
              'cf-connecting-ip': '203.0.113.175',
            },
            body: loginBody(selfServiceCredentials.target.email),
            check: ssOwn('target'),
          },
          {
            name: 'target session is live before it is disabled',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'qaDisableTargetCookie',
          },
          {
            name: 'admin logs in',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: 'ts_session=',
              'x-forwarded-for': '203.0.113.176',
              'cf-connecting-ip': '203.0.113.176',
            },
            body: loginBody(selfServiceCredentials.admin.email),
            check: ssOwn('admin'),
          },
          {
            name: 'admin disables the target account',
            method: 'PATCH',
            path: `/v2/users/${selfServiceIds.target}`,
            expected: 200,
            body: { status: 'disabled' },
            check: (body) => {
              const data = (body as { data?: Record<string, unknown> })?.data;
              return (
                !!data &&
                data.id === selfServiceIds.target &&
                data.status === 'disabled' &&
                data.role === 'viewer' &&
                !('passwordVerifier' in data) &&
                !('passwordHash' in data)
              );
            },
          },
          {
            name: 'admin reads the target as disabled',
            method: 'GET',
            path: `/v2/users/${selfServiceIds.target}`,
            expected: 200,
            check: ssStatus('disabled'),
          },
          {
            name: 'other accounts stay active',
            method: 'GET',
            path: `/v2/users/${selfServiceIds.editor}`,
            expected: 200,
            check: ssStatus('active'),
          },
          {
            name: 'disabled target existing session is purged',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'qaDisableTargetCookie',
          },
          {
            name: 'disabled target login with the correct key is refused',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              cookie: 'ts_session=',
              'x-forwarded-for': '203.0.113.177',
              'cf-connecting-ip': '203.0.113.177',
            },
            body: loginBody(selfServiceCredentials.target.email),
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'enabled account still logs in while the target is disabled',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: 'ts_session=',
              'x-forwarded-for': '203.0.113.178',
              'cf-connecting-ip': '203.0.113.178',
            },
            body: loginBody(selfServiceCredentials.editor.email),
            check: ssOwn('editor'),
          },
          {
            name: 'editor cannot re-enable a disabled account',
            method: 'PATCH',
            path: `/v2/users/${selfServiceIds.target}`,
            expected: 403,
            body: { status: 'active' },
            check: forbiddenCheck,
          },
          {
            name: 'admin logs in again',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: 'ts_session=',
              'x-forwarded-for': '203.0.113.179',
              'cf-connecting-ip': '203.0.113.179',
            },
            body: loginBody(selfServiceCredentials.admin.email),
            check: ssOwn('admin'),
          },
          {
            name: 'admin re-enables the target account',
            method: 'PATCH',
            path: `/v2/users/${selfServiceIds.target}`,
            expected: 200,
            body: { status: 'active' },
            check: ssStatus('active'),
          },
          {
            name: 're-enabled target pre-disable session stays purged',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'qaDisableTargetCookie',
          },
          {
            name: 're-enabled target logs in again',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: 'ts_session=',
              'x-forwarded-for': '203.0.113.180',
              'cf-connecting-ip': '203.0.113.180',
            },
            body: loginBody(selfServiceCredentials.target.email),
            check: ssOwn('target'),
          },
          ssLogout,
        ],
      },
      {
        // Slice 14 system administration lifecycle (#188, SPEC-V2 §6.2, §6.8, §7):
        // super_admin lists operational communities, provisions empty hosted
        // community, issues & reissues ClaimToken, verifies claim_pending and
        // post-claim refusal, toggles status (disabling purges sessions, active
        // restores), deprovisions & reprovisions unclaimed community, and reads
        // content-free system audit entries (communityId IS NULL).
        persona: 'admin_lifecycle',
        steps: [
          {
            name: 'login as super_admin',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              'x-forwarded-for': '203.0.113.140',
              'cf-connecting-ip': '203.0.113.140',
            },
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
            name: 'list operational communities without descriptive fields',
            method: 'GET',
            path: '/v2/admin/communities',
            expected: 200,
            saveCookieAs: 'qaSysAdmin',
            check: (body) => {
              const parsed = AdminCommunityListResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const text = JSON.stringify(body);
              return (
                !text.includes('"name"') &&
                !text.includes('"description"') &&
                !text.includes('"visibility"') &&
                !text.includes('"locale"') &&
                !text.includes('"country"') &&
                !HONO_PERSONA_CULTURAL_STRINGS.some((s) => text.includes(s))
              );
            },
          },
          {
            name: 'reject descriptive fields on admin community provision',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 400,
            body: { slug: 'qa-admin-bad', name: 'Forbidden Descriptive Name' },
          },
          {
            name: 'provision empty hosted community',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 201,
            captureId: 'qaClaimedComm',
            body: { slug: 'qa-admin-claimed' },
            check: (body) => {
              const parsed = AdminCommunityResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.slug === 'qa-admin-claimed' &&
                parsed.data.data.status === 'active' &&
                parsed.data.data.claimStatus === 'unclaimed'
              );
            },
          },
          {
            name: 'issue first claim token',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimedComm}/claim-tokens',
            expected: 201,
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimToken1 = parsed.data.data.token;
              qaClaimToken1Id = parsed.data.data.id;
              return true;
            },
          },
          {
            name: 'reissue claim token superseding earlier token',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimedComm}/claim-tokens',
            expected: 201,
            body: { ttlSeconds: 3600 },
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimToken2 = parsed.data.data.token;
              qaClaimToken2Id = parsed.data.data.id;
              return qaClaimToken2 !== qaClaimToken1;
            },
          },
          {
            name: 'observe claim_pending status in operational list',
            method: 'GET',
            path: '/v2/admin/communities?limit=100',
            expected: 200,
            check: (body) => {
              const parsed = AdminCommunityListResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const entry = parsed.data.data.find(
                (c) => c.slug === 'qa-admin-claimed'
              );
              return entry?.claimStatus === 'claim_pending';
            },
          },
          {
            name: 'reject superseded claim token',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.140',
              'cf-connecting-ip': '203.0.113.140',
            },
            prepare: () => {
              qaSupersededClaimBody.token = qaClaimToken1;
            },
            body: qaSupersededClaimBody,
            check: invalidCredentials,
          },
          {
            name: 'claim provisioned community with valid token',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 201,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.140',
              'cf-connecting-ip': '203.0.113.140',
            },
            prepare: () => {
              qaValidClaimBody.token = qaClaimToken2;
            },
            body: qaValidClaimBody,
            check: (body) => {
              const parsed = BootstrapResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.user.role === 'admin' &&
                parsed.data.data.user.recoveryCodesConfirmed === true &&
                validRecoverySheet(parsed.data.data.recoveryCodes.codes) &&
                !leaksSecret(body, liveSessionCookie) &&
                !JSON.stringify(body).includes(qaClaimToken2)
              );
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'claimed admin session is active',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'qaClaimedAdmin',
            check: ownMeUser(
              'qa-claimed-admin@example.test',
              'admin',
              liveSessionCookie,
              undefined,
              true
            ),
          },
          {
            name: 'refuse claim-token issuance after claim',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimedComm}/claim-tokens',
            expected: 409,
            useSavedCookie: 'qaSysAdmin',
          },
          {
            name: 'refuse deprovision of claimed community',
            method: 'DELETE',
            path: '/v2/admin/communities/{qaClaimedComm}',
            expected: 409,
            useSavedCookie: 'qaSysAdmin',
          },
          {
            name: 'disable claimed community and purge its sessions',
            method: 'PATCH',
            path: '/v2/admin/communities/{qaClaimedComm}/status',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            body: { status: 'disabled' },
            check: (body) => {
              const parsed = AdminCommunityResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'disabled' &&
                parsed.data.data.claimStatus === 'claimed'
              );
            },
          },
          {
            name: 'claimed admin session is purged after disable',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'qaClaimedAdmin',
          },
          {
            name: 'restore claimed community to active',
            method: 'PATCH',
            path: '/v2/admin/communities/{qaClaimedComm}/status',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            body: { status: 'active' },
            check: (body) => {
              const parsed = AdminCommunityResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'active' &&
                parsed.data.data.claimStatus === 'claimed'
              );
            },
          },
          {
            name: 'claimed admin logs back in after restore',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.141',
              'cf-connecting-ip': '203.0.113.141',
            },
            body: {
              identifier: 'qa-claimed-admin@example.test',
              communitySlug: 'qa-admin-claimed',
              derivedKey: qaAdminClaimedKey,
            },
            check: ownUser(
              'qa-claimed-admin@example.test',
              'admin',
              liveSessionCookie
            ),
          },
          {
            name: 'restored community serves claimed admin',
            method: 'GET',
            path: '/v2/community',
            expected: 200,
          },
          {
            name: 'logout restored claimed admin',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'provision empty community for deprovision',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 201,
            useSavedCookie: 'qaSysAdmin',
            captureId: 'qaDeprovComm',
            body: { slug: 'qa-admin-deprov' },
          },
          {
            name: 'issue claim token before deprovision',
            method: 'POST',
            path: '/v2/admin/communities/{qaDeprovComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'qaSysAdmin',
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaDeprovTokenId = parsed.data.data.id;
              return true;
            },
          },
          {
            name: 'deprovision unclaimed empty community',
            method: 'DELETE',
            path: '/v2/admin/communities/{qaDeprovComm}',
            expected: 204,
            useSavedCookie: 'qaSysAdmin',
          },
          {
            name: 'deprovisioned community returns 409 on status toggle',
            method: 'PATCH',
            path: '/v2/admin/communities/{qaDeprovComm}/status',
            expected: 409,
            useSavedCookie: 'qaSysAdmin',
            body: { status: 'disabled' },
          },
          {
            name: 'reprovision same slug after deprovision',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 201,
            useSavedCookie: 'qaSysAdmin',
            captureId: 'qaReprovComm',
            body: { slug: 'qa-admin-deprov' },
          },
          {
            name: 'issue claim token on reprovisioned community before disable',
            method: 'POST',
            path: '/v2/admin/communities/{qaReprovComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'qaSysAdmin',
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaDisabledToken = parsed.data.data.token;
              return true;
            },
          },
          {
            name: 'disable reprovisioned community supersedes token and hides claim_pending',
            method: 'PATCH',
            path: '/v2/admin/communities/{qaReprovComm}/status',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            body: { status: 'disabled' },
            check: (body) => {
              const parsed = AdminCommunityResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'disabled' &&
                parsed.data.data.claimStatus === 'unclaimed'
              );
            },
          },
          {
            name: 'list shows disabled unclaimed community without claim_pending',
            method: 'GET',
            path: '/v2/admin/communities?limit=100',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            check: (body) => {
              const parsed = AdminCommunityListResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const entry = parsed.data.data.find(
                (c) => c.slug === 'qa-admin-deprov'
              );
              return (
                entry?.status === 'disabled' &&
                entry?.claimStatus === 'unclaimed'
              );
            },
          },
          {
            name: 're-enable reprovisioned community does not restore claim_pending',
            method: 'PATCH',
            path: '/v2/admin/communities/{qaReprovComm}/status',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            body: { status: 'active' },
            check: (body) => {
              const parsed = AdminCommunityResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'active' &&
                parsed.data.data.claimStatus === 'unclaimed'
              );
            },
          },
          {
            name: 'pre-disable claim token stays rejected after re-enable',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.145',
              'cf-connecting-ip': '203.0.113.145',
            },
            prepare: () => {
              qaDisabledClaimBody.token = qaDisabledToken;
            },
            body: qaDisabledClaimBody,
            check: invalidCredentials,
          },
          {
            name: 'clean up reprovisioned community',
            method: 'DELETE',
            path: '/v2/admin/communities/{qaReprovComm}',
            expected: 204,
            useSavedCookie: 'qaSysAdmin',
          },
          {
            name: 'read system-only audit entries without community or secret leaks',
            method: 'GET',
            path: '/v2/admin/audit-entries?limit=100',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            check: (body) => {
              const parsed = AdminAuditEntryListResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const rows = parsed.data.data;
              if (!rows.every((e) => e.communityId === null)) return false;
              if (
                rows.some(
                  (e) =>
                    e.action === 'claim_token.consume' &&
                    e.outcome === 'success'
                )
              ) {
                return false;
              }
              if (
                rows.some(
                  (e) =>
                    e.action.startsWith('claim_token.') &&
                    (e.resourceIds.includes(qaClaimToken1Id) ||
                      e.resourceIds.includes(qaClaimToken2Id))
                )
              ) {
                return false;
              }
              if (
                rows.some(
                  (e) =>
                    e.action.startsWith('claim_token.') &&
                    e.resourceIds.includes(qaDeprovTokenId)
                )
              ) {
                return false;
              }
              const requiredActions = [
                'system.community.provision',
                'system.community.status.disabled',
                'system.community.status.active',
                'system.community.deprovision',
              ];
              if (
                !requiredActions.every((action) =>
                  rows.some((e) => e.action === action)
                )
              ) {
                return false;
              }
              const text = JSON.stringify(body);
              return (
                !text.includes(qaClaimToken1) &&
                !text.includes(qaClaimToken2) &&
                !HONO_PERSONA_CULTURAL_STRINGS.some((s) => text.includes(s))
              );
            },
          },
          {
            name: 'filter system audit entries by action',
            method: 'GET',
            path: '/v2/admin/audit-entries?action=system.community.deprovision',
            expected: 200,
            useSavedCookie: 'qaSysAdmin',
            check: (body) => {
              const parsed = AdminAuditEntryListResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.length >= 2 &&
                parsed.data.data.every(
                  (e) => e.action === 'system.community.deprovision'
                )
              );
            },
          },
          {
            name: 'logout super_admin',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'qaSysAdmin',
          },
        ],
      },
      {
        persona: 'claim_bootstrap',
        steps: [
          {
            name: 'login as super_admin for claim journey',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
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
            name: 'provision hosted community for claim journey',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 201,
            saveCookieAs: 'claimJourneySysAdmin',
            captureId: 'qaClaimJourneyComm',
            body: { slug: 'qa-claim-journey' },
            check: (body) => {
              const parsed = AdminCommunityResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimBootCommunityId = parsed.data.data.id;
              return (
                parsed.data.data.slug === 'qa-claim-journey' &&
                parsed.data.data.status === 'active' &&
                parsed.data.data.claimStatus === 'unclaimed'
              );
            },
          },
          {
            name: 'issue claim token to expire',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimJourneyComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            body: { ttlSeconds: 3600 },
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimBootExpiredToken = parsed.data.data.token;
              qaClaimBootExpiredTokenId = parsed.data.data.id;
              return true;
            },
          },
          {
            name: 'reject expired claim token uniformly',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.183',
              'cf-connecting-ip': '203.0.113.183',
            },
            prepare: async () => {
              const expiredAt = Date.now() - 60_000;
              await db
                .update(claimTokens)
                .set({
                  createdAt: expiredAt - 3_600_000,
                  expiresAt: expiredAt,
                })
                .where(eq(claimTokens.id, qaClaimBootExpiredTokenId));
              qaClaimBootExpiredBody.token = qaClaimBootExpiredToken;
            },
            body: qaClaimBootExpiredBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'issue claim token to be superseded',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimJourneyComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            body: { ttlSeconds: 3600 },
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimBootSupersededToken = parsed.data.data.token;
              return true;
            },
          },
          {
            name: 'reissue active claim token superseding previous token',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimJourneyComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            body: { ttlSeconds: 3600 },
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimBootValidToken = parsed.data.data.token;
              return qaClaimBootValidToken !== qaClaimBootSupersededToken;
            },
          },
          {
            name: 'reject superseded claim token uniformly',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.183',
              'cf-connecting-ip': '203.0.113.183',
            },
            prepare: () => {
              qaClaimBootSupersededBody.token = qaClaimBootSupersededToken;
            },
            body: qaClaimBootSupersededBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'reject unknown claim token with identical uniform failure',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.183',
              'cf-connecting-ip': '203.0.113.183',
            },
            body: {
              token: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
              username: 'qa_claim_unknown_journey',
              email: 'qa-claim-unknown-journey@example.test',
              password: {
                algorithm: ARGON2ID_ALGORITHM,
                salt: qaClaimBootSalt1,
                params: JSON.parse(ARGON2ID_PARAMS_JSON),
                derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
              },
            },
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'claim hosted community and receive 10 recovery codes and session',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 201,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
            prepare: () => {
              qaClaimBootValidBody.token = qaClaimBootValidToken;
            },
            body: qaClaimBootValidBody,
            check: (body) => {
              const parsed = BootstrapResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const { community, user, recoveryCodes } = parsed.data.data;
              if (!validRecoverySheet(recoveryCodes.codes)) return false;
              qaClaimBootRecoveryCode1 = recoveryCodes.codes[0]!;
              return (
                community.id === qaClaimBootCommunityId &&
                community.slug === 'qa-claim-journey' &&
                community.status === 'active' &&
                user.email === 'qa-claim-journey-admin@example.test' &&
                user.username === 'qa_claim_journey_admin' &&
                user.role === 'admin' &&
                user.communityId === qaClaimBootCommunityId &&
                user.recoveryCodesConfirmed === true &&
                !leaksSecret(body, liveSessionCookie) &&
                !JSON.stringify(body).includes(qaClaimBootValidToken)
              );
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'verify claimed admin initial session via /v2/auth/me',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'claimJourneyInitialAdmin',
            check: (body) =>
              ownMeUser(
                'qa-claim-journey-admin@example.test',
                'admin',
                liveSessionCookie,
                qaClaimBootCommunityId,
                true
              )(body),
          },
          {
            name: 'reject replay of consumed claim token uniformly',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.183',
              'cf-connecting-ip': '203.0.113.183',
            },
            prepare: () => {
              qaClaimBootReplayBody.token = qaClaimBootValidToken;
            },
            body: qaClaimBootReplayBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'logout initial claimed admin session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'claimJourneyInitialAdmin',
          },
          {
            name: 'claimed admin logs in with credentials set at claim',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
            body: {
              identifier: 'qa-claim-journey-admin@example.test',
              communitySlug: 'qa-claim-journey',
              derivedKey: qaClaimBootAdminKey,
            },
            check: (body) =>
              ownUser(
                'qa-claim-journey-admin@example.test',
                'admin',
                liveSessionCookie,
                qaClaimBootCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'claimed admin reads own community after login',
            method: 'GET',
            path: '/v2/community',
            expected: 200,
            saveCookieAs: 'claimJourneyLoginSession',
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.id === qaClaimBootCommunityId &&
                parsed.data.data.slug === 'qa-claim-journey'
              );
            },
          },
          {
            name: 'claimed admin redeems a recovery code returned at claim',
            method: 'POST',
            path: '/v2/auth/recovery/redeem',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
            prepare: () => {
              qaClaimBootRedeemBody.code = qaClaimBootRecoveryCode1;
            },
            body: qaClaimBootRedeemBody,
            check: (body) =>
              ownUser(
                'qa-claim-journey-admin@example.test',
                'admin',
                liveSessionCookie,
                qaClaimBootCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'previous claimed admin session is revoked after recovery redeem',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'claimJourneyLoginSession',
          },
          {
            name: 'claimed admin new recovery session is active',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: (body) =>
              ownMeUser(
                'qa-claim-journey-admin@example.test',
                'admin',
                liveSessionCookie,
                qaClaimBootCommunityId,
                true
              )(body),
          },
          {
            name: 'reject replay of consumed claim recovery code',
            method: 'POST',
            path: '/v2/auth/recovery/redeem',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
            body: qaClaimBootRedeemBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'reject old password of claimed admin after recovery redeem',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
            body: {
              identifier: 'qa-claim-journey-admin@example.test',
              communitySlug: 'qa-claim-journey',
              derivedKey: qaClaimBootAdminKey,
            },
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'logout recovered claimed admin session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'claimed admin logs in with new password set via recovery code',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.182',
              'cf-connecting-ip': '203.0.113.182',
            },
            body: {
              identifier: 'qa-claim-journey-admin@example.test',
              communitySlug: 'qa-claim-journey',
              derivedKey: qaClaimBootRecoveredKey,
            },
            check: (body) =>
              ownUser(
                'qa-claim-journey-admin@example.test',
                'admin',
                liveSessionCookie,
                qaClaimBootCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'logout final claimed admin session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'provision hosted community for per-IP claim throttle proof',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            captureId: 'qaClaimThrottleComm',
            body: { slug: 'qa-claim-throttle' },
          },
          {
            name: 'issue valid claim token for per-IP throttle proof',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimThrottleComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            body: { ttlSeconds: 3600 },
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimBootThrottleToken = parsed.data.data.token;
              return true;
            },
          },
          ...Array.from(
            { length: AUTH_THROTTLE_MAX_FAILURES },
            (_, attempt) => ({
              name: `claim per-IP throttle failure ${attempt + 1}`,
              method: 'POST',
              path: '/v2/bootstrap/claim',
              expected: 401,
              headers: {
                cookie: '',
                'x-forwarded-for': '203.0.113.184',
                'cf-connecting-ip': '203.0.113.184',
              },
              body: {
                token: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
                username: `qa_claim_ip_fail_${attempt + 1}`,
                email: `qa-claim-ip-fail-${attempt + 1}@example.test`,
                password: {
                  algorithm: ARGON2ID_ALGORITHM,
                  salt: qaClaimBootSalt3,
                  params: JSON.parse(ARGON2ID_PARAMS_JSON),
                  derivedKey: toHex(crypto.getRandomValues(new Uint8Array(32))),
                },
              },
              check: invalidCredentials,
              checkHeaders: hasNoSessionCookie,
            })
          ),
          {
            name: 'throttled IP is refused even with a valid unconsumed claim token',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.184',
              'cf-connecting-ip': '203.0.113.184',
            },
            prepare: () => {
              qaClaimBootThrottleValidBody.token = qaClaimBootThrottleToken;
            },
            body: qaClaimBootThrottleValidBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'same valid claim token succeeds from an unthrottled IP',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 201,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.185',
              'cf-connecting-ip': '203.0.113.185',
            },
            prepare: () => {
              qaClaimBootThrottleUnblockedBody.token = qaClaimBootThrottleToken;
            },
            body: qaClaimBootThrottleUnblockedBody,
            check: (body) => {
              const parsed = BootstrapResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.community.slug === 'qa-claim-throttle' &&
                parsed.data.data.user.role === 'admin' &&
                validRecoverySheet(parsed.data.data.recoveryCodes.codes) &&
                !leaksSecret(body, liveSessionCookie) &&
                !JSON.stringify(body).includes(qaClaimBootThrottleToken)
              );
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'logout claim throttle admin',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'provision community for per-token claim throttle proof',
            method: 'POST',
            path: '/v2/admin/communities',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            captureId: 'qaClaimPerTokenComm',
            body: { slug: 'qa-claim-token-throttle' },
          },
          {
            name: 'issue claim token for per-token throttle proof',
            method: 'POST',
            path: '/v2/admin/communities/{qaClaimPerTokenComm}/claim-tokens',
            expected: 201,
            useSavedCookie: 'claimJourneySysAdmin',
            body: { ttlSeconds: 3600 },
            check: (body) => {
              const parsed = ClaimTokenIssuedResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              qaClaimBootPerTokenToken = parsed.data.data.token;
              return true;
            },
          },
          ...Array.from(
            { length: AUTH_THROTTLE_MAX_FAILURES },
            (_, attempt) => {
              const ip = `203.0.113.${190 + attempt}`;
              return {
                name: `claim per-token throttle failure ${attempt + 1}`,
                method: 'POST',
                path: '/v2/bootstrap/claim',
                expected: 401,
                headers: {
                  cookie: '',
                  'x-forwarded-for': ip,
                  'cf-connecting-ip': ip,
                },
                prepare: () => {
                  qaClaimBootPerTokenConflictBody.token =
                    qaClaimBootPerTokenToken;
                },
                body: qaClaimBootPerTokenConflictBody,
                check: invalidCredentials,
                checkHeaders: hasNoSessionCookie,
              };
            }
          ),
          {
            name: 'per-token throttled claim token is refused even with free identity from a fresh IP',
            method: 'POST',
            path: '/v2/bootstrap/claim',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.200',
              'cf-connecting-ip': '203.0.113.200',
            },
            prepare: () => {
              qaClaimBootPerTokenFreeBody.token = qaClaimBootPerTokenToken;
            },
            body: qaClaimBootPerTokenFreeBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'clean up unclaimed per-token throttle community',
            method: 'DELETE',
            path: '/v2/admin/communities/{qaClaimPerTokenComm}',
            expected: 204,
            useSavedCookie: 'claimJourneySysAdmin',
          },
          {
            name: 'logout super_admin after claim journey',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'claimJourneySysAdmin',
          },
        ],
      },
      {
        persona: 'mapbox_admin',
        steps: [
          {
            name: 'mapbox admin logs in',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.210',
              'cf-connecting-ip': '203.0.113.210',
            },
            body: loginBody(mapboxCredentials.admin.email),
            check: ownUser(
              mapboxCredentials.admin.email,
              'admin',
              liveSessionCookie,
              mapboxCommunity.id
            ),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'mapbox admin opens community visibility to public',
            method: 'PATCH',
            path: '/v2/community',
            expected: 200,
            body: { visibility: 'public' },
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return parsed.success && parsed.data.data.visibility === 'public';
            },
          },
          {
            name: 'mapbox admin rejects sk.* secret token with 422',
            method: 'PUT',
            path: '/v2/community/map-config',
            expected: 422,
            body: {
              mapboxStyleUrl: 'mapbox://styles/qa-community/territory-v1',
              mapboxAccessToken: 'sk.test-qa-rejected',
            },
            check: (body) =>
              !JSON.stringify(body).includes('sk.test-qa-rejected'),
          },
          {
            name: 'mapbox admin rejects half-pair without token',
            method: 'PUT',
            path: '/v2/community/map-config',
            expected: 400,
            body: {
              mapboxStyleUrl: 'mapbox://styles/qa-community/territory-v1',
            },
            check: validationFieldCheck('mapboxAccessToken'),
          },
          {
            name: 'mapbox admin sets Mapbox style + pk.* token + Protomaps (unexposed)',
            method: 'PUT',
            path: '/v2/community/map-config',
            expected: 200,
            body: {
              mapboxStyleUrl: 'mapbox://styles/qa-community/territory-v1',
              mapboxAccessToken: 'pk.test-qa-mapbox-token',
              exposeMapboxCredentials: false,
              mapbox3d: true,
              protomapsApiKey: 'pm-test-qa-key',
              protomapsBasemapStyle: 'contrast',
            },
            check: (body) => {
              const parsed =
                PutCommunityMapConfigResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.mapboxStyleUrl ===
                  'mapbox://styles/qa-community/territory-v1' &&
                parsed.data.data.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token' &&
                parsed.data.data.exposeMapboxCredentials === false &&
                parsed.data.data.mapbox3d === true &&
                parsed.data.data.protomapsApiKey === 'pm-test-qa-key' &&
                parsed.data.data.protomapsBasemapStyle === 'contrast' &&
                parsed.data.render.source === 'community'
              );
            },
          },
          {
            name: 'mapbox admin saves without provider keys and stored Mapbox/Protomaps values are preserved',
            method: 'PUT',
            path: '/v2/community/map-config',
            expected: 200,
            body: { zoom: 6 },
            check: (body) => {
              const parsed =
                PutCommunityMapConfigResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.zoom === 6 &&
                parsed.data.data.mapboxStyleUrl ===
                  'mapbox://styles/qa-community/territory-v1' &&
                parsed.data.data.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token' &&
                parsed.data.data.mapbox3d === true &&
                parsed.data.data.protomapsApiKey === 'pm-test-qa-key' &&
                parsed.data.data.protomapsBasemapStyle === 'contrast'
              );
            },
          },
          {
            name: 'mapbox admin logs out before member check',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ],
      },
      {
        persona: 'mapbox_member',
        steps: [
          {
            name: 'mapbox member logs in',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: loginBody(mapboxCredentials.member.email),
            check: ownUser(
              mapboxCredentials.member.email,
              'member',
              liveSessionCookie,
              mapboxCommunity.id
            ),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'mapbox member reads community map-config with token and protomaps fields',
            method: 'GET',
            path: '/v2/community/map-config',
            expected: 200,
            check: (body) => {
              const parsed = CommunityMapConfigResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data?.mapboxStyleUrl ===
                  'mapbox://styles/qa-community/territory-v1' &&
                parsed.data.data.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token' &&
                parsed.data.data.mapbox3d === true &&
                parsed.data.data.protomapsApiKey === 'pm-test-qa-key' &&
                parsed.data.data.protomapsBasemapStyle === 'contrast' &&
                parsed.data.render.source === 'community' &&
                parsed.data.render.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token'
              );
            },
          },
          {
            name: 'mapbox member reads community detail with map-config',
            method: 'GET',
            path: '/v2/community',
            expected: 200,
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.mapConfig?.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token' &&
                parsed.data.data.mapConfig.protomapsApiKey === 'pm-test-qa-key'
              );
            },
          },
          {
            name: 'mapbox member logs out',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ],
      },
      {
        persona: 'mapbox_anonymous_before_expose',
        steps: [
          {
            name: 'anonymous sees null mapbox token and style on public detail before expose',
            method: 'GET',
            path: '/v2/public/communities/qa-mapbox-community',
            expected: 200,
            headers: { cookie: '' },
            check: (body) => {
              const parsed =
                PublicCommunityDetailResponseSchema.safeParse(body);
              const text = JSON.stringify(body) ?? '';
              return (
                parsed.success &&
                parsed.data.data.mapConfig?.mapboxStyleUrl === null &&
                parsed.data.data.mapConfig.mapboxAccessToken === null &&
                parsed.data.data.mapConfig.mapbox3d === true &&
                parsed.data.data.mapConfig.protomapsBasemapStyle ===
                  'contrast' &&
                !text.includes('pk.test-qa-mapbox-token') &&
                parsed.data.data.mapConfig.protomapsApiKey === 'pm-test-qa-key'
              );
            },
          },
          {
            name: 'anonymous sees null mapbox token and style on explore before expose',
            method: 'GET',
            path: '/explore/communities/qa-mapbox-community',
            expected: 200,
            headers: { cookie: '' },
            check: (body) => {
              const mc = (
                body as {
                  data?: {
                    mapConfig?: {
                      mapboxAccessToken?: unknown;
                      mapboxStyle?: unknown;
                      mapbox3dEnabled?: unknown;
                    };
                  };
                }
              )?.data?.mapConfig;
              const text = JSON.stringify(body) ?? '';
              return (
                mc?.mapboxAccessToken === null &&
                mc.mapboxStyle === null &&
                mc.mapbox3dEnabled === true &&
                !text.includes('pk.test-qa-mapbox-token') &&
                text.includes('pm-test-qa-key')
              );
            },
          },
        ],
      },
      {
        persona: 'mapbox_expose_and_private_reset',
        steps: [
          {
            name: 'mapbox admin logs in for expose test',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.212',
              'cf-connecting-ip': '203.0.113.212',
            },
            body: loginBody(mapboxCredentials.admin.email),
            check: ownUser(
              mapboxCredentials.admin.email,
              'admin',
              liveSessionCookie,
              mapboxCommunity.id
            ),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'mapbox admin enables exposeMapboxCredentials',
            method: 'PUT',
            path: '/v2/community/map-config',
            expected: 200,
            saveCookieAs: 'mapboxAdminCookie',
            body: {
              mapboxStyleUrl: 'mapbox://styles/qa-community/territory-v1',
              mapboxAccessToken: 'pk.test-qa-mapbox-token',
              exposeMapboxCredentials: true,
              mapbox3d: true,
              protomapsApiKey: 'pm-test-qa-key',
              protomapsBasemapStyle: 'contrast',
            },
            check: (body) => {
              const parsed =
                PutCommunityMapConfigResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.exposeMapboxCredentials === true
              );
            },
          },
          {
            name: 'anonymous receives exposed mapbox style and pk.* token on public detail',
            method: 'GET',
            path: '/v2/public/communities/qa-mapbox-community',
            expected: 200,
            headers: { cookie: '' },
            check: (body) => {
              const parsed =
                PublicCommunityDetailResponseSchema.safeParse(body);
              const text = JSON.stringify(body) ?? '';
              return (
                parsed.success &&
                parsed.data.data.mapConfig?.mapboxStyleUrl ===
                  'mapbox://styles/qa-community/territory-v1' &&
                parsed.data.data.mapConfig.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token' &&
                parsed.data.data.mapConfig.protomapsApiKey === 'pm-test-qa-key'
              );
            },
          },
          {
            name: 'anonymous receives exposed mapbox style and pk.* token on explore detail',
            method: 'GET',
            path: '/explore/communities/qa-mapbox-community',
            expected: 200,
            headers: { cookie: '' },
            check: (body) => {
              const mc = (
                body as {
                  data?: {
                    mapConfig?: {
                      mapboxAccessToken?: unknown;
                      mapboxStyle?: unknown;
                      mapbox3dEnabled?: unknown;
                    };
                  };
                }
              )?.data?.mapConfig;
              const text = JSON.stringify(body) ?? '';
              return (
                mc?.mapboxAccessToken === 'pk.test-qa-mapbox-token' &&
                mc.mapboxStyle ===
                  'mapbox://styles/qa-community/territory-v1' &&
                mc.mapbox3dEnabled === true &&
                text.includes('pm-test-qa-key')
              );
            },
          },
          {
            name: 'mapbox admin toggles community private and atomically resets expose',
            method: 'PATCH',
            path: '/v2/community',
            expected: 200,
            useSavedCookie: 'mapboxAdminCookie',
            body: { visibility: 'private' },
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.visibility === 'private' &&
                parsed.data.data.mapConfig?.exposeMapboxCredentials === false &&
                parsed.data.data.mapConfig.mapboxAccessToken ===
                  'pk.test-qa-mapbox-token'
              );
            },
          },
          {
            name: 'public detail 404s when mapbox community is private',
            method: 'GET',
            path: '/v2/public/communities/qa-mapbox-community',
            expected: 404,
            headers: { cookie: '' },
          },
          {
            name: 'mapbox admin re-opens community public and expose remains false',
            method: 'PATCH',
            path: '/v2/community',
            expected: 200,
            useSavedCookie: 'mapboxAdminCookie',
            body: { visibility: 'public' },
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.visibility === 'public' &&
                parsed.data.data.mapConfig?.exposeMapboxCredentials === false
              );
            },
          },
          {
            name: 'anonymous sees null again after private reset and re-open',
            method: 'GET',
            path: '/v2/public/communities/qa-mapbox-community',
            expected: 200,
            headers: { cookie: '' },
            check: (body) => {
              const parsed =
                PublicCommunityDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.mapConfig?.mapboxStyleUrl === null &&
                parsed.data.data.mapConfig.mapboxAccessToken === null
              );
            },
          },
          {
            name: 'mapbox admin restores community to private and logs out',
            method: 'PATCH',
            path: '/v2/community',
            expected: 200,
            useSavedCookie: 'mapboxAdminCookie',
            body: { visibility: 'private' },
          },
          {
            name: 'mapbox admin logs out',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
            useSavedCookie: 'mapboxAdminCookie',
          },
        ],
      },
      {
        persona: 'sovereignty',
        steps: [
          {
            name: 'login system account before any steward designation',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: { cookie: 'ts_session=' },
            body: {
              identifier: credentials.super_admin.email,
              derivedKey: superAdminNewKey,
            },
          },
          {
            name: 'system privilege alone cannot withdraw a community',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 403,
            saveCookieAs: 'sovSystem',
            body: { communitySlug, currentDerivedKey: superAdminNewKey },
          },
          {
            name: 'login community admin for sovereignty',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(credentials.admin.email),
            headers: { cookie: 'ts_session=' },
          },
          {
            name: 'save acting admin sovereignty session',
            method: 'GET',
            path: '/v2/community/sovereignty',
            expected: 200,
            saveCookieAs: 'sovAdmin',
          },
          {
            name: 'designate null-community system account as steward',
            method: 'PUT',
            path: '/v2/community/steward',
            expected: 200,
            body: {
              stewardUserId: communityUserIds.super_admin,
              currentDerivedKey: HONO_PERSONA_DERIVED_KEY,
            },
            check: (body) => {
              const parsed = PutCommunityStewardResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.steward?.sameCommunity === false
              );
            },
          },
          {
            name: 'system steward must supply an explicit locator',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 400,
            useSavedCookie: 'sovSystem',
            body: { currentDerivedKey: superAdminNewKey },
          },
          {
            name: 'system steward cannot target an undesignated community',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 403,
            useSavedCookie: 'sovSystem',
            body: {
              communityId: foreignCommunityId,
              currentDerivedKey: superAdminNewKey,
            },
          },
          {
            name: 'designated system steward starts a notice by explicit slug',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 202,
            useSavedCookie: 'sovSystem',
            body: { communitySlug, currentDerivedKey: superAdminNewKey },
            check: (body) => {
              const parsed = CommunityWithdrawalResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.communityId === communityId &&
                parsed.data.data.request.state === 'notice' &&
                parsed.data.data.status === 'active'
              );
            },
          },
          {
            name: 'steward designation grants no sovereignty read access',
            method: 'GET',
            path: '/v2/community/sovereignty',
            expected: 403,
            useSavedCookie: 'sovSystem',
          },
          {
            name: 'replace system steward and cancel its pending notice',
            method: 'PUT',
            path: '/v2/community/steward',
            expected: 200,
            useSavedCookie: 'sovAdmin',
            check: (body) => {
              const parsed = PutCommunityStewardResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.steward?.userId === communityUserIds.member &&
                parsed.data.data.cancelledRequestIds.length === 1
              );
            },
            body: {
              stewardUserId: communityUserIds.member,
              currentDerivedKey: HONO_PERSONA_DERIVED_KEY,
            },
          },
          {
            name: 'login designated steward',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(credentials.member.email),
            headers: { cookie: 'ts_session=' },
          },
          {
            name: 'steward withdrawal enters notice',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 202,
            saveCookieAs: 'sovSteward',
            body: { currentDerivedKey: HONO_PERSONA_DERIVED_KEY },
            check: (body) => {
              const parsed = CommunityWithdrawalResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'active' &&
                parsed.data.data.request.state === 'notice'
              );
            },
          },
          {
            name: 'admin can see pending steward notice',
            method: 'GET',
            path: '/v2/community/sovereignty',
            expected: 200,
            useSavedCookie: 'sovAdmin',
            check: (body) => {
              const parsed =
                CommunitySovereigntyStatusResponseSchema.safeParse(body);
              return (
                parsed.success && parsed.data.data.pendingRequests.length === 1
              );
            },
          },
          {
            name: 'admin cancels steward notice with step-up',
            method: 'POST',
            path: '/v2/community/sovereignty/cancel',
            expected: 200,
            useSavedCookie: 'sovAdmin',
            body: { currentDerivedKey: HONO_PERSONA_DERIVED_KEY },
            check: (body) => {
              const parsed = CancelSovereigntyResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.cancelledRequests.length === 1 &&
                parsed.data.data.cancelledRequests[0]?.state === 'cancelled'
              );
            },
          },
          {
            name: 'admin withdrawal is immediate',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 200,
            useSavedCookie: 'sovAdmin',
            body: { currentDerivedKey: HONO_PERSONA_DERIVED_KEY },
            check: (body) => {
              const parsed = CommunityWithdrawalResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.status === 'disabled' &&
                parsed.data.data.request.state === 'completed'
              );
            },
          },
          {
            name: 'withdrawal invalidates steward member session',
            method: 'GET',
            path: '/v2/stories',
            expected: 401,
            useSavedCookie: 'sovSteward',
          },
          {
            name: 'withdrawal invalidates historical public media URL',
            method: 'GET',
            path: `/v2/public/communities/${communitySlug}/media/${readableFileId}`,
            expected: 404,
          },
          {
            name: 'withdrawal immediately hides Explore detail',
            method: 'GET',
            path: `/explore/communities/${communitySlug}`,
            expected: 404,
          },
          {
            name: 'withdrawn admin reauthenticates',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            body: loginBody(credentials.admin.email),
            headers: { cookie: 'ts_session=' },
          },
          {
            name: 'withdrawn sovereignty remains reachable',
            method: 'GET',
            path: '/v2/community/sovereignty',
            expected: 200,
            saveCookieAs: 'sovAdminAfter',
            check: (body) => {
              const parsed =
                CommunitySovereigntyStatusResponseSchema.safeParse(body);
              return parsed.success && parsed.data.data.status === 'disabled';
            },
          },

          {
            name: 'designated steward reauthenticates while withdrawn',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: { cookie: 'ts_session=' },
            body: loginBody(credentials.member.email),
          },
          {
            name: 'withdrawn steward starts another notice',
            method: 'POST',
            path: '/v2/community/withdrawal',
            expected: 202,
            body: { currentDerivedKey: HONO_PERSONA_DERIVED_KEY },
          },
          {
            name: 'persisted notice takes effect on next read after downtime',
            method: 'GET',
            path: '/v2/community/sovereignty',
            expected: 200,
            useSavedCookie: 'sovAdminAfter',
            prepare: async () => {
              const ms = Date.now();
              await db
                .update(communitySovereigntyRequests)
                .set({
                  requestedAt: ms - 8 * 86400000,
                  noticeEndsAt: ms - 1000,
                })
                .where(
                  and(
                    eq(communitySovereigntyRequests.communityId, communityId),
                    eq(communitySovereigntyRequests.state, 'notice')
                  )
                );
            },
            check: (body) => {
              const parsed =
                CommunitySovereigntyStatusResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.pendingRequests.length === 0 &&
                parsed.data.data.recentRequests.some(
                  (r) =>
                    r.initiatedByRole === 'steward' && r.state === 'completed'
                )
              );
            },
          },
          {
            name: 'community administrator cannot read system erasure records',
            method: 'GET',
            path: '/v2/admin/erasures',
            expected: 403,
            useSavedCookie: 'sovAdminAfter',
          },
          {
            name: 'system privilege alone cannot erase another community',
            method: 'POST',
            path: '/v2/community/erasure',
            expected: 403,
            useSavedCookie: 'sovSystem',
            body: {
              confirmFinality: true,
              communityId: foreignCommunityId,
              currentDerivedKey: superAdminNewKey,
            },
          },
          {
            name: 'erasure requires explicit finality confirmation',
            method: 'POST',
            path: '/v2/community/erasure',
            expected: 400,
            useSavedCookie: 'sovAdminAfter',
            body: { currentDerivedKey: HONO_PERSONA_DERIVED_KEY },
          },
          {
            name: 'withdrawn own administrator requests irreversible erasure',
            method: 'POST',
            path: '/v2/community/erasure',
            expected: 202,
            useSavedCookie: 'sovAdminAfter',
            body: {
              confirmFinality: true,
              currentDerivedKey: HONO_PERSONA_DERIVED_KEY,
            },
            check: (body) => {
              const parsed = CommunityErasureResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.request.kind === 'erasure' &&
                parsed.data.data.request.state === 'requested' &&
                parsed.data.data.status === 'disabled' &&
                parsed.data.data.erasureRecord?.outcome === 'pending'
              );
            },
          },
          {
            name: 'system administrator reads content-free external erasure record',
            method: 'GET',
            path: '/v2/admin/erasures',
            expected: 200,
            useSavedCookie: 'sovSystem',
            check: (body) => {
              const data = (
                body as {
                  data?: Array<{
                    communityId: number;
                    requestingActorId: number | null;
                    requestedAt: string;
                  }>;
                }
              ).data;
              return (
                Array.isArray(data) &&
                data.some(
                  (r) =>
                    r.communityId === communityId &&
                    r.requestingActorId === communityUserIds.admin &&
                    typeof r.requestedAt === 'string'
                )
              );
            },
          },
          {
            name: 'restart-safe erasure removes rows and bytes and retains completion record',
            method: 'GET',
            path: '/v2/admin/erasures',
            expected: 200,
            useSavedCookie: 'sovSystem',
            prepare: async () => {
              if (!erasureSweep)
                throw new Error('Erasure maintenance seam missing');
              for (let pass = 0; pass < 12; pass++) await erasureSweep();
              const remaining = await db
                .select({ id: communities.id })
                .from(communities)
                .where(eq(communities.id, communityId));
              if (remaining.length)
                throw new Error('Community erasure did not complete');
            },
            check: (body) => {
              const data = (
                body as {
                  data?: Array<{
                    communityId: number;
                    outcome: string;
                    completedAt: string | null;
                  }>;
                }
              ).data;
              return (
                Array.isArray(data) &&
                data.some(
                  (r) =>
                    r.communityId === communityId &&
                    r.outcome === 'completed' &&
                    r.completedAt !== null
                )
              );
            },
          },
        ],
      },
      {
        // Slice 11b-B (#188, SPEC-V2 §4, §7): runs on an isolated unseeded
        // database/runtime with BOOTSTRAP_SECRET configured; must run after all
        // seeded journeys because PostgreSQL resets the single shared test DB.
        persona: 'fresh_bootstrap',
        ...(freshBaseUrl
          ? { baseUrl: freshBaseUrl }
          : { handler: freshHandler }),
        steps: [
          {
            name: 'fresh installation reports bootstrap open=true',
            method: 'GET',
            path: '/v2/bootstrap',
            expected: 200,
            prepare: async () => {
              await ensureFreshBootstrap();
            },
            check: bootstrapOpenCheck(true),
          },
          {
            name: 'reject bootstrap with wrong operator secret uniformly',
            method: 'POST',
            path: '/v2/bootstrap',
            expected: 403,
            headers: {
              'x-forwarded-for': '203.0.113.210',
              'cf-connecting-ip': '203.0.113.210',
            },
            body: freshBootstrapWrongBody,
            check: uniformForbidden,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'reject bootstrap with missing operator secret uniformly',
            method: 'POST',
            path: '/v2/bootstrap',
            expected: 403,
            headers: {
              'x-forwarded-for': '203.0.113.210',
              'cf-connecting-ip': '203.0.113.210',
            },
            body: freshBootstrapMissingBody,
            check: uniformForbidden,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'bootstrap stays open=true after rejected secret attempts',
            method: 'GET',
            path: '/v2/bootstrap',
            expected: 200,
            check: bootstrapOpenCheck(true),
          },
          {
            name: 'complete fresh installation bootstrap with operator secret',
            method: 'POST',
            path: '/v2/bootstrap',
            expected: 201,
            headers: {
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: freshBootstrapValidBody,
            check: (body) => {
              const parsed = BootstrapResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const { community, user, recoveryCodes } = parsed.data.data;
              if (!validRecoverySheet(recoveryCodes.codes)) return false;
              freshBootstrapCommunityId = community.id;
              freshBootstrapRecoveryCode1 = recoveryCodes.codes[0]!;
              return (
                community.slug === 'qa-fresh-bootstrap' &&
                community.status === 'active' &&
                user.email === 'qa-fresh-admin@example.test' &&
                user.username === 'qa_fresh_admin' &&
                user.role === 'admin' &&
                user.communityId === community.id &&
                user.recoveryCodesConfirmed === true &&
                !leaksSecret(body, liveSessionCookie) &&
                !JSON.stringify(body).includes(freshBootstrapSecret)
              );
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'bootstrap reports open=false immediately after completion',
            method: 'GET',
            path: '/v2/bootstrap',
            expected: 200,
            headers: { cookie: '' },
            check: bootstrapOpenCheck(false),
          },
          {
            name: 'reject bootstrap replay with valid operator secret uniformly',
            method: 'POST',
            path: '/v2/bootstrap',
            expected: 403,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: freshBootstrapValidBody,
            check: uniformForbidden,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'bootstrapped admin session is active via /v2/auth/me',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'freshBootstrapInitialAdmin',
            check: (body) =>
              ownMeUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId,
                true
              )(body),
          },
          {
            name: 'bootstrapped admin reads own community',
            method: 'GET',
            path: '/v2/community',
            expected: 200,
            check: (body) => {
              const parsed = CommunityReadDetailResponseSchema.safeParse(body);
              return (
                parsed.success &&
                parsed.data.data.id === freshBootstrapCommunityId &&
                parsed.data.data.slug === 'qa-fresh-bootstrap'
              );
            },
          },
          {
            name: 'logout initial bootstrapped admin session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'bootstrapped admin logs in with credentials set at bootstrap',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: {
              identifier: 'qa-fresh-admin@example.test',
              communitySlug: 'qa-fresh-bootstrap',
              derivedKey: freshAdminKey,
            },
            check: (body) =>
              ownUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'save bootstrapped admin login session',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'freshBootstrapLoginSession',
            check: (body) =>
              ownMeUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId,
                true
              )(body),
          },
          {
            name: 'bootstrapped admin redeems a recovery code returned at bootstrap',
            method: 'POST',
            path: '/v2/auth/recovery/redeem',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            prepare: () => {
              freshBootstrapRedeemBody.code = freshBootstrapRecoveryCode1;
            },
            body: freshBootstrapRedeemBody,
            check: (body) =>
              ownUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'previous bootstrapped admin session is revoked after recovery redeem',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 401,
            useSavedCookie: 'freshBootstrapLoginSession',
          },
          {
            name: 'bootstrapped admin new recovery session is active',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: (body) =>
              ownMeUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId,
                true
              )(body),
          },
          {
            name: 'reject replay of consumed bootstrap recovery code',
            method: 'POST',
            path: '/v2/auth/recovery/redeem',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: freshBootstrapRedeemBody,
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'reject old bootstrap password after recovery redeem',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 401,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: {
              identifier: 'qa-fresh-admin@example.test',
              communitySlug: 'qa-fresh-bootstrap',
              derivedKey: freshAdminKey,
            },
            check: invalidCredentials,
            checkHeaders: hasNoSessionCookie,
          },
          {
            name: 'logout recovered bootstrapped admin session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'bootstrapped admin logs in with new password set via recovery code',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.211',
              'cf-connecting-ip': '203.0.113.211',
            },
            body: {
              identifier: 'qa-fresh-admin@example.test',
              communitySlug: 'qa-fresh-bootstrap',
              derivedKey: freshAdminRecoveredKey,
            },
            check: (body) =>
              ownUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'logout final bootstrapped admin session',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ],
      },
      {
        // Field-kit API-level journey (#147 keeps the browser/offline proof).
        // It continues the fresh_bootstrap installation: that journey owns
        // bootstrap, the one-time 10-code sheet and the recovery-code redeem
        // that sets the new password, so this one logs in with that password
        // and exercises local media upload/read-back and CSV import on the
        // same install. The fresh runtime has an R2 MEDIA binding on Workers
        // too, so it runs there as well. The restart proof is the separate
        // 'field-kit-restart' journey (skipped journeys do not count toward
        // coverage, so it must not hide steps inside this one).
        persona: 'field-kit',
        ...{
          ...(freshBaseUrl
            ? { baseUrl: freshBaseUrl }
            : { handler: freshHandler }),
          steps: [
            {
              name: 'field-kit admin logs in with the recovery-set password',
              method: 'POST',
              path: '/v2/auth/login',
              expected: 200,
              headers: {
                cookie: '',
                'x-forwarded-for': '203.0.113.212',
                'cf-connecting-ip': '203.0.113.212',
              },
              body: {
                identifier: 'qa-fresh-admin@example.test',
                communitySlug: 'qa-fresh-bootstrap',
                derivedKey: freshAdminRecoveredKey,
              },
              check: (body) =>
                ownUser(
                  'qa-fresh-admin@example.test',
                  'admin',
                  liveSessionCookie,
                  freshBootstrapCommunityId
                )(body),
              checkHeaders: hasSessionCookie,
            },
            {
              name: 'field-kit admin reports recovery codes confirmed',
              method: 'GET',
              path: '/v2/auth/me',
              expected: 200,
              check: (body) =>
                ownMeUser(
                  'qa-fresh-admin@example.test',
                  'admin',
                  liveSessionCookie,
                  freshBootstrapCommunityId,
                  true
                )(body),
            },
            {
              name: 'upload local media on the fresh install',
              method: 'POST',
              path: '/v2/media',
              expected: 201,
              ...qaMultipart({
                filename: 'qa-field-kit.png',
                contentType: 'image/png',
                bytes: mediaPngBytes,
              }),
              check: mediaUploadStagingCheck,
            },
            {
              name: 'preview field-kit places CSV import with local photo',
              method: 'POST',
              path: '/v2/imports/preview',
              expected: 201,
              captureId: 'qaFieldKitImport',
              ...qaMultipart({
                filename: 'qa-field-kit-places.csv',
                contentType: 'text/csv',
                bytes: new TextEncoder().encode(
                  'name,region,latitude,longitude,photo\nQA Field Kit Place,Lowlands,-3.51,-60.51,qa-field-kit-pic.png\n'
                ),
                fields: { kind: 'places' },
                mediaParts: [
                  {
                    filename: 'qa-field-kit-pic.png',
                    contentType: 'image/png',
                    bytes: mediaPngBytes,
                  },
                ],
              }),
              check: (body) => {
                const parsed =
                  ImportManifestDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.status === 'previewed' &&
                  parsed.data.data.canCommit === true &&
                  parsed.data.data.stagedMediaCount === 1
                );
              },
            },
            {
              name: 'commit field-kit places import',
              method: 'POST',
              path: '/v2/imports/{qaFieldKitImport}/commit',
              expected: 200,
              check: (body) => {
                const parsed =
                  ImportManifestDetailResponseSchema.safeParse(body);
                return (
                  parsed.success &&
                  parsed.data.data.status === 'committed' &&
                  parsed.data.data.resultSummary?.createdPlaces === 1 &&
                  parsed.data.data.resultSummary?.createdAttachments === 1
                );
              },
            },
            {
              name: 'imported place lists its photo file identity',
              method: 'GET',
              path: '/v2/places',
              expected: 200,
              check: (body) => {
                const parsed = PublicPlacesListResponseSchema.safeParse(body);
                if (!parsed.success) return false;
                const place = parsed.data.data.find(
                  (p) => p.name === 'QA Field Kit Place'
                );
                if (!place || place.photos.length !== 1) return false;
                fieldKitFileId = place.photos[0]!.fileId;
                return place.region === 'Lowlands';
              },
            },
            {
              name: 'read imported media back by file identity',
              method: 'GET',
              path: '/v2/media/pending',
              expected: 200,
              prepare: () => {
                if (!fieldKitFileId) throw new Error('Missing field-kit file');
                return `/v2/media/${fieldKitFileId}`;
              },
              checkBytes: (bytes: Uint8Array) =>
                bytes.byteLength === mediaPngBytes.byteLength &&
                bytes.every((b, i) => b === mediaPngBytes[i]),
            },
            {
              name: 'logout field-kit admin',
              method: 'POST',
              path: '/v2/auth/logout',
              expected: 204,
            },
          ] as Step[],
        },
      },
      {
        // Field-kit restart proof: closes the fresh install's temp-file
        // SQLite, reopens a NEW app over the same file and byte store, and
        // proves the session, imported place, photo bytes and recovery state
        // survived. Only the in-process SQLite fixture can express this; it is
        // a separate journey so a skip never removes the field-kit coverage.
        persona: 'field-kit-restart',
        ...(restartFreshInstall
          ? {}
          : {
              skipped: backend
                ? 'Workers/workerd runs the app out of process over D1/R2 bindings the harness cannot close and reopen'
                : 'PostgreSQL fresh install resets a shared schema on open; the harness has no reopen-in-place, so restart is proved on SQLite only',
            }),
        ...(freshBaseUrl
          ? { baseUrl: freshBaseUrl }
          : { handler: freshHandler }),
        steps: [
          {
            name: 'field-kit-restart admin logs in before restart',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.213',
              'cf-connecting-ip': '203.0.113.213',
            },
            body: {
              identifier: 'qa-fresh-admin@example.test',
              communitySlug: 'qa-fresh-bootstrap',
              derivedKey: freshAdminRecoveredKey,
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'session works before restart',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            saveCookieAs: 'preRestart',
          },
          {
            name: 'restart: pre-restart session cookie still authenticates',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            useSavedCookie: 'preRestart',
            prepare: async () => {
              await restartFreshInstall!();
            },
            check: (body) =>
              ownMeUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId,
                true
              )(body),
          },
          {
            name: 'restart: imported place survives',
            method: 'GET',
            path: '/v2/places',
            expected: 200,
            useSavedCookie: 'preRestart',
            check: (body) => {
              const parsed = PublicPlacesListResponseSchema.safeParse(body);
              if (!parsed.success) return false;
              const place = parsed.data.data.find(
                (p) => p.name === 'QA Field Kit Place'
              );
              return (
                !!place &&
                place.region === 'Lowlands' &&
                place.photos.length === 1 &&
                place.photos[0]!.fileId === fieldKitFileId
              );
            },
          },
          {
            name: 'restart: photo bytes read back identical',
            method: 'GET',
            path: '/v2/media/pending',
            expected: 200,
            useSavedCookie: 'preRestart',
            prepare: () => {
              if (!fieldKitFileId) throw new Error('Missing field-kit file');
              return `/v2/media/${fieldKitFileId}`;
            },
            checkBytes: (bytes: Uint8Array) =>
              bytes.byteLength === mediaPngBytes.byteLength &&
              bytes.every((b, i) => b === mediaPngBytes[i]),
          },
          {
            name: 'restart: fresh login with the same credentials succeeds',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: {
              cookie: '',
              'x-forwarded-for': '203.0.113.214',
              'cf-connecting-ip': '203.0.113.214',
            },
            body: {
              identifier: 'qa-fresh-admin@example.test',
              communitySlug: 'qa-fresh-bootstrap',
              derivedKey: freshAdminRecoveredKey,
            },
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'logout field-kit-restart admin',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ] as Step[],
      },
      {
        // SPEC-V2 §7 recovery-code gate (#254/#265): continues the fresh
        // install, whose served app (SQLite/PostgreSQL in-process and the
        // Workers runtime) enforces the gate. A second administrator holding
        // no active recovery code is limited to /v2/auth/* until they
        // generate a sheet with their admin_issued session.
        persona: 'recovery-gate',
        ...(freshBaseUrl
          ? { baseUrl: freshBaseUrl }
          : { handler: freshHandler }),
        steps: [
          {
            name: 'gate admin (holding codes) logs in with the recovery-set password',
            method: 'POST',
            path: '/v2/auth/login',
            expected: 200,
            headers: qaGateAdminHeaders,
            body: {
              identifier: 'qa-fresh-admin@example.test',
              communitySlug: 'qa-fresh-bootstrap',
              derivedKey: freshAdminRecoveredKey,
            },
            check: (body) =>
              ownUser(
                'qa-fresh-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'admin holding recovery codes reads stories through the gate',
            method: 'GET',
            path: '/v2/stories',
            expected: 200,
          },
          {
            name: 'create second administrator without credentials or codes',
            method: 'POST',
            path: '/v2/users',
            expected: 201,
            captureId: 'qaGateAdmin',
            body: {
              username: 'qa_gate_admin',
              email: 'qa-gate-admin@example.test',
              displayName: 'QA Gate Admin',
              role: 'admin',
            },
            check: (body) => {
              const data = (body as { data?: Record<string, unknown> })?.data;
              return (
                !!data &&
                data.role === 'admin' &&
                !('passwordVerifier' in data) &&
                !('passwordHash' in data)
              );
            },
          },
          {
            name: 'issue admin_issued login code for second administrator',
            method: 'POST',
            path: '/v2/users/{qaGateAdmin}/login-codes',
            expected: 201,
            check: (body) => {
              const data = (
                body as { data?: { code?: unknown; purpose?: unknown } }
              )?.data;
              if (
                typeof data?.code === 'string' &&
                /^[A-Za-z0-9_-]{20,64}$/.test(data.code) &&
                data.purpose === 'admin_issued'
              ) {
                qaGateAdminLoginCode = data.code;
                return true;
              }
              return false;
            },
          },
          {
            name: 'logout gate admin holding codes',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
          {
            name: 'second administrator redeems admin_issued login code',
            method: 'POST',
            path: '/v2/auth/recovery/redeem',
            expected: 200,
            headers: qaGateAdminHeaders,
            prepare: () => {
              qaGateAdminRedeemBody.code = qaGateAdminLoginCode;
            },
            body: qaGateAdminRedeemBody,
            check: (body) =>
              ownUser(
                'qa-gate-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId
              )(body),
            checkHeaders: hasSessionCookie,
          },
          {
            name: 'gate denies administrator without recovery codes outside /v2/auth',
            method: 'GET',
            path: '/v2/stories',
            expected: 403,
            check: (body) =>
              (body as { code?: unknown })?.code === 'recovery_codes_required',
          },
          {
            name: 'auth surface stays open and reports recovery codes unconfirmed',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: (body) =>
              ownMeUser(
                'qa-gate-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId,
                false
              )(body),
          },
          {
            name: 'generate recovery codes verifier-free via admin_issued session',
            method: 'POST',
            path: '/v2/auth/recovery-codes',
            expected: 201,
            body: undefined,
            check: (body) => {
              const data = (
                body as { data?: { codes?: unknown; purpose?: unknown } }
              )?.data;
              return (
                data?.purpose === 'recovery' &&
                Array.isArray(data.codes) &&
                data.codes.length === 10
              );
            },
          },
          {
            name: 'gate lifts once the administrator holds recovery codes',
            method: 'GET',
            path: '/v2/stories',
            expected: 200,
          },
          {
            name: 'auth surface reports recovery codes confirmed',
            method: 'GET',
            path: '/v2/auth/me',
            expected: 200,
            check: (body) =>
              ownMeUser(
                'qa-gate-admin@example.test',
                'admin',
                liveSessionCookie,
                freshBootstrapCommunityId,
                true
              )(body),
          },
          {
            name: 'logout second administrator',
            method: 'POST',
            path: '/v2/auth/logout',
            expected: 204,
          },
        ] as Step[],
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
