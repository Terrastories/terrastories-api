import { sessionLifetime } from './shared/session-policy.js';
import { registerExploreAdapter } from './explore-adapter.js';
import { ExploreAdapterRepository } from './repositories/explore-adapter.repository.js';
import { CommunityReadsRepository } from './repositories/community-reads.repository.js';
import { CommunityWritesRepository } from './repositories/community-writes.repository.js';
import { MediaWritesRepository } from './repositories/media-writes.repository.js';
import { PublicCommunitiesRepository } from './repositories/public-communities.repository.js';
import { StoryWritesRepository } from './repositories/story-writes.repository.js';
import { UserManagementRepository } from './repositories/user-management.repository.js';
import { registerCommunityReadRoutes } from './routes/community-reads.hono.js';
import { registerCommunityWriteRoutes } from './routes/community-writes.hono.js';
import { registerMediaRoutes } from './routes/media-writes.hono.js';
import { registerPublicCommunityRoutes } from './routes/public-communities.hono.js';
import { registerUserManagementRoutes } from './routes/user-management.hono.js';
import { registerStoryWriteRoutes } from './routes/story-writes.hono.js';
import { registerAdminRoutes } from './routes/admin.hono.js';
import { AdminRepository } from './repositories/admin.repository.js';
import {
  registerProtectedAuthRecoveryRoutes,
  registerPublicAuthRecoveryRoutes,
} from './routes/auth-recovery.hono.js';
import { registerPublicBootstrapRoutes } from './routes/bootstrap.hono.js';
import { AuthRecoveryRepository } from './repositories/auth-recovery.repository.js';
import { AuthRecoveryService } from './services/auth-recovery.service.js';
import { BootstrapRepository } from './repositories/bootstrap.repository.js';
import { BootstrapService } from './services/bootstrap.service.js';
import { MediaCleanupCoordinator } from './services/media-cleanup.service.js';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  AUTH_LOGIN_FAILURE_BODY,
  DERIVED_KEY_PATTERN,
  ARGON2ID_ALGORITHM,
  AuthLoginRejected,
  clientIpOf,
  isCanonicalArgon2idParams,
  isCanonicalVerifierSalt,
  isDerivedKeyOrBcryptHash,
  sessionCookieMaxAge,
  type SessionKind,
} from './shared/auth-policy.js';
import type {
  FoundationUser,
  HonoFoundationRepository,
} from './repositories/hono-foundation.repository.js';
import {
  HonoFoundationService,
  tokenDigest,
  type FoundationStorage,
} from './services/hono-foundation.service.js';
import { HonoAuthRepository } from './repositories/hono-auth.repository.js';
import { HonoAuthService } from './services/hono-auth.service.js';

export type RequestHandler = (request: Request) => Promise<Response>;
export interface FoundationOptions {
  repository: HonoFoundationRepository;
  storage: FoundationStorage;
  /**
   * Prelogin HMAC key (`AUTH_SERVER_SECRET`). Without it `POST
   * /v2/auth/prelogin` fails closed with 503 instead of answering with a
   * predictable fake (SPEC-V2 §7 step 1).
   */
  serverSecret?: string;
  /**
   * Operator-provided installation bootstrap secret (`BOOTSTRAP_SECRET`,
   * SPEC-V2 §7 "Bootstrap and account lifecycle"). Without it the fresh
   * installation stays closed for bootstrap and `GET /v2/bootstrap` answers
   * `open:false` (fail closed; PR #252 bot finding 1).
   */
  bootstrapSecret?: string;
  secureCookies?: boolean;
  publicOrigin?: string;
  corsOrigins?: string[];
  now?: () => Date;
  /** Cloudflare Workers: `cf-connecting-ip` is set by the platform (finding E). */
  isWorkers?: boolean;
  /** A trusted reverse proxy is configured, so `x-forwarded-for` is usable. */
  trustProxy?: boolean;
  /**
   * Explicit name of the header the trusted proxy overwrites with the client
   * address (`TRUSTED_PROXY_HEADER=x-real-ip`). Passed through verbatim; see
   * ClientIpOptions.trustedProxyHeader.
   */
  trustedProxyHeader?: 'x-real-ip' | undefined;
  /** The transport's observed peer address, when it can be read (Node socket). */
  clientAddress?: (c: Context) => string | null;
  mediaCleanup?: MediaCleanupCoordinator;
  /** Optional local CA fingerprint surfaced once on field-kit bootstrap (§7). */
  fieldKitCaFingerprint?: string;
}
const preloginSchema = z
  .object({
    identifier: z.string().min(1).max(254),
    communitySlug: z.string().min(1).max(255).optional(),
  })
  .strict();
/**
 * A client-derived key as the wire carries it: a 64-hex Argon2id digest, or
 * the bcrypt hash string a wrapped Rails account sends (SPEC-V2 §7 step 4).
 * The wire shape is not the algorithm selector — the stored account decides —
 * so a shape that does not match the account is an ordinary uniform 401 from
 * the service, never a 400 that would reveal the account's algorithm. A value
 * that is neither shape is malformed input and fails here, before resolution,
 * independently of any account.
 */
const derivedKeyWire = z
  .string()
  .refine(isDerivedKeyOrBcryptHash, { message: 'Invalid derived key' });
const loginSchema = z
  .object({
    identifier: z.string().min(1).max(254),
    communitySlug: z.string().min(1).max(255).optional(),
    derivedKey: derivedKeyWire,
    upgrade: z
      .object({
        algorithm: z.string().min(1).max(64),
        salt: z.string().min(1).max(128),
        params: z.record(z.string(), z.unknown()),
        // The upgrade material is always the Argon2id digest; the wrapped
        // bcrypt string is the login's own `derivedKey`, never this field.
        derivedKey: z.string().regex(DERIVED_KEY_PATTERN),
      })
      .strict()
      .optional(),
    deviceSession: z.boolean().optional(),
  })
  .strict();
const mePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).nullable(),
  })
  .strict();
const passwordChangeSchema = z
  .object({
    // A still-wrapped account verifies its bcrypt hash string as the current
    // key; the new material below is always the Argon2id digest.
    currentDerivedKey: derivedKeyWire,
    algorithm: z.literal(ARGON2ID_ALGORITHM),
    salt: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
    derivedKey: z.string().regex(DERIVED_KEY_PATTERN),
  })
  .strict();
const publicUser = (user: FoundationUser) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  displayName: user.displayName,
  role: user.role,
  communityId: user.communityId,
});

export function createHonoApp(options: FoundationOptions) {
  const app = new Hono<{
    Variables: { actor: FoundationUser; sessionKind: SessionKind };
  }>();
  const service = new HonoFoundationService(
    options.repository,
    options.storage
  );
  const authRepository = new HonoAuthRepository(options.repository.connection);
  const authService = new HonoAuthService(
    authRepository,
    options.repository,
    options.serverSecret
  );
  const authRecoveryService = new AuthRecoveryService(
    new AuthRecoveryRepository(options.repository.connection),
    authRepository,
    options.serverSecret
  );
  const bootstrapRepository = new BootstrapRepository(
    options.repository.connection
  );
  const bootstrapService = new BootstrapService(
    bootstrapRepository,
    authRepository,
    {
      serverSecret: options.serverSecret,
      fieldKitCaFingerprint: options.fieldKitCaFingerprint,
      bootstrapSecret: options.bootstrapSecret,
    }
  );
  const configuredOrigin =
    options.publicOrigin === undefined
      ? undefined
      : new URL(options.publicOrigin).origin;
  if (configuredOrigin && configuredOrigin !== options.publicOrigin)
    throw new Error('publicOrigin must be an origin without path');
  const now = options.now ?? (() => new Date());
  const corsOrigins = new Set(options.corsOrigins ?? []);
  for (const origin of corsOrigins) {
    const parsed = new URL(origin);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      origin.includes('*')
    )
      throw new Error('Invalid CORS origin');
  }
  app.use(
    '*',
    cors({
      origin: (origin) => (corsOrigins.has(origin) ? origin : undefined),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    })
  );
  const cookie = {
    httpOnly: true,
    secure: options.secureCookies ?? true,
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: sessionLifetime / 1000,
  };
  // The renewal/issue cookie of a live session. `standard` carries the
  // 12-hour idle window; `device` carries its remaining absolute lifetime, so a
  // browser restart cannot silently shorten the opt-in and the cookie never
  // outlives the row that enforces it (§7 "Sessions", finding F).
  const sessionCookie = (
    kind: SessionKind,
    absoluteExpiresAt?: number | null,
    at?: number
  ) => ({
    ...cookie,
    maxAge: sessionCookieMaxAge(kind, absoluteExpiresAt ?? undefined, at),
  });
  // The client address for the per-IP throttle: only real signals are trusted
  // (finding E).
  const ipFor = (c: Context): string =>
    clientIpOf(c.req.raw.headers, {
      isWorkers: options.isWorkers,
      trustProxy: options.trustProxy,
      trustedProxyHeader: options.trustedProxyHeader,
      remoteAddress: options.clientAddress ? options.clientAddress(c) : null,
    });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('Origin');
      if (
        (origin &&
          origin !== (configuredOrigin ?? new URL(c.req.url).origin) &&
          !corsOrigins.has(origin)) ||
        (c.req.header('Sec-Fetch-Site') === 'cross-site' &&
          (!origin || !corsOrigins.has(origin)))
      )
        return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  });
  app.onError(() =>
    Response.json(
      { error: 'Service unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  );
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    await options.repository.readiness();
    return c.json({ status: 'ready' });
  });
  app.post(
    '/v2/auth/prelogin',
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: 'Request too large' }, 413),
    }),
    async (c) => {
      if (
        c.req.header('Content-Type')?.split(';')[0].trim() !==
        'application/json'
      )
        return c.json({ error: 'Expected JSON' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request' }, 400);
      }
      const parsed = preloginSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
      const result = await authService.prelogin(parsed.data);
      // Unconfigured secret is a server fault, not a credential failure: the
      // body stays content-free and names no setting (SPEC-V2 §7).
      if (!result) return c.json({ error: 'Service unavailable' }, 503);
      return c.json(result);
    }
  );
  app.post(
    '/v2/auth/login',
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: 'Request too large' }, 413),
    }),
    async (c) => {
      if (
        c.req.header('Content-Type')?.split(';')[0].trim() !==
        'application/json'
      )
        return c.json({ error: 'Expected JSON' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request' }, 400);
      }
      const parsed = loginSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
      // Unconfigured secret is a server fault, not a credential failure: the
      // body stays content-free and names no setting (SPEC-V2 §7).
      if (!options.serverSecret)
        return c.json({ error: 'Service unavailable' }, 503);
      try {
        const result = await authService.login(
          {
            ...parsed.data,
            previousToken: getCookie(c, 'ts_session'),
          },
          ipFor(c),
          now(),
          c.req.header('user-agent')
        );
        setCookie(c, 'ts_session', result.token, sessionCookie(result.kind));
        return c.json({ user: publicUser(result.user) });
      } catch (error) {
        // Every rejected attempt answers one identical 401 body (§6.2, §7).
        if (error instanceof AuthLoginRejected)
          return c.json(AUTH_LOGIN_FAILURE_BODY, 401);
        throw error;
      }
    }
  );
  // Canonical V2 unauthenticated public routes must register before the
  // `/v2/*` session gate.
  registerPublicAuthRecoveryRoutes(app, {
    service: authRecoveryService,
    ipFor,
    now,
    setSessionCookie: (c, token, kind) =>
      setCookie(c, 'ts_session', token, sessionCookie(kind)),
    publicUser,
  });
  registerPublicBootstrapRoutes(app, {
    service: bootstrapService,
    ipFor,
    now,
    setSessionCookie: (c, token, kind) =>
      setCookie(c, 'ts_session', token, sessionCookie(kind)),
  });
  registerPublicCommunityRoutes(app, {
    repository: new PublicCommunitiesRepository(options.repository.connection),
    storage: options.storage,
    publicOrigin: configuredOrigin,
  });
  app.use('/v2/*', async (c, next) => {
    const session = await service.actor(getCookie(c, 'ts_session'), now());
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('actor', session.user);
    c.set('sessionKind', session.kind);
    await next();
    if (
      c.res.status < 400 &&
      !['/v2/auth/logout', '/v2/auth/revoke', '/v2/auth/password'].includes(
        c.req.path
      )
    )
      setCookie(
        c,
        'ts_session',
        getCookie(c, 'ts_session')!,
        sessionCookie(session.kind, session.absoluteExpiresAt, now().getTime())
      );
  });
  app.get('/v2/auth/me', async (c) => {
    const actor = c.get('actor');
    const recoveryCodesConfirmed =
      await options.repository.hasActiveRecoveryCodes(actor.id);
    return c.json({
      user: { ...publicUser(actor), recoveryCodesConfirmed },
    });
  });
  app.post('/v2/auth/logout', async (c) => {
    const actor = c.get('actor');
    await options.repository.revokeSession(
      await tokenDigest(getCookie(c, 'ts_session')!)
    );
    await authService.auditAuthEvent({
      communityId: actor.communityId,
      actorId: actor.id,
      action: 'auth.logout',
      outcome: 'success',
      resourceType: 'session',
      resourceIds: [],
      ipAddress: ipFor(c),
      userAgent: c.req.header('user-agent'),
    });
    deleteCookie(c, 'ts_session', cookie);
    return c.body(null, 204);
  });
  const jsonBody4k = bodyLimit({
    maxSize: 4096,
    onError: (c) => c.json({ error: 'Request too large' }, 413),
  });
  app.patch('/v2/auth/me', jsonBody4k, async (c) => {
    if (
      c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/json'
    )
      return c.json({ error: 'Expected JSON' }, 415);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const parsed = mePatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    const actor = c.get('actor');
    // Only the display name, never role, status, communityId, username or
    // email (SPEC-V2 §6.2): parsing here, the normalisation + write live in
    // the service layer.
    const displayName = await authService.updateOwnProfile(
      actor,
      parsed.data.displayName,
      now()
    );
    return c.json({ user: publicUser({ ...actor, displayName }) });
  });
  app.post('/v2/auth/password', jsonBody4k, async (c) => {
    if (
      c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/json'
    )
      return c.json({ error: 'Expected JSON' }, 415);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const parsed = passwordChangeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    const params = parsed.data.params;
    if (
      !isCanonicalArgon2idParams(params) ||
      !isCanonicalVerifierSalt(parsed.data.salt)
    )
      return c.json({ error: 'Password does not meet requirements' }, 400);
    const { memoryKiB, iterations, parallelism } = params as Record<
      string,
      number
    >;
    const actor = c.get('actor');
    // The verifier change fires the session-revocation trigger, so the
    // account's other sessions die first and the fresh one survives
    // (SPEC-V2 §6.8, §7 step 4). Any rejected attempt answers one identical
    // 401 body.
    let changed: { token: string } | null;
    try {
      changed = await authService.changePassword(
        {
          user: actor,
          currentDerivedKey: parsed.data.currentDerivedKey,
          derivedKey: parsed.data.derivedKey,
          salt: parsed.data.salt,
          params: { memoryKiB, iterations, parallelism },
        },
        c.get('sessionKind'),
        getCookie(c, 'ts_session'),
        ipFor(c),
        now(),
        c.req.header('user-agent')
      );
    } catch (error) {
      if (error instanceof AuthLoginRejected)
        return c.json(AUTH_LOGIN_FAILURE_BODY, 401);
      throw error;
    }
    if (!changed)
      // The authority gate lost the race to a concurrent reset.
      return c.json({ error: 'Conflict' }, 409);
    setCookie(
      c,
      'ts_session',
      changed.token,
      sessionCookie(c.get('sessionKind'))
    );
    return c.json({ user: publicUser(actor) });
  });
  app.post('/v2/auth/revoke', async (c) => {
    const actor = c.get('actor');
    await options.repository.revokeUserSessions(actor.id);
    await authService.auditAuthEvent({
      communityId: actor.communityId,
      actorId: actor.id,
      action: 'auth.session.revoke',
      outcome: 'success',
      resourceType: 'session',
      resourceIds: [],
      ipAddress: ipFor(c),
      userAgent: c.req.header('user-agent'),
    });
    deleteCookie(c, 'ts_session', cookie);
    return c.body(null, 204);
  });
  registerProtectedAuthRecoveryRoutes(app, {
    service: authRecoveryService,
    ipFor,
    now,
  });
  const communityReadsRepository = new CommunityReadsRepository(
    options.repository.connection
  );
  registerCommunityReadRoutes(app, {
    repository: communityReadsRepository,
    publicOrigin: configuredOrigin,
  });
  const mediaCleanup =
    options.mediaCleanup ??
    new MediaCleanupCoordinator(options.repository.connection, options.storage);
  registerCommunityWriteRoutes(app, {
    repository: new CommunityWritesRepository(options.repository.connection),
    readsRepository: communityReadsRepository,
    publicOrigin: configuredOrigin,
    mediaCleanup,
  });
  registerStoryWriteRoutes(app, {
    repository: new StoryWritesRepository(options.repository.connection),
    readsRepository: communityReadsRepository,
    publicOrigin: configuredOrigin,
    mediaCleanup,
  });
  registerMediaRoutes(app, {
    repository: new MediaWritesRepository(options.repository.connection),
    storage: options.storage,
    cleanup: mediaCleanup,
    publicOrigin: configuredOrigin,
  });
  registerUserManagementRoutes(app, {
    repository: new UserManagementRepository(options.repository.connection),
    publicOrigin: configuredOrigin,
    serverSecret: options.serverSecret,
  });
  registerAdminRoutes(app, {
    repository: new AdminRepository(options.repository.connection),
    bootstrapRepository,
    now,
  });
  // Transitional Explore read adapter (#198): Rails-shaped public reads for
  // the existing Explore client; removed once the V2 frontend is canonical.
  registerExploreAdapter(app, {
    repository: new ExploreAdapterRepository(options.repository.connection),
    storage: options.storage,
    publicOrigin: configuredOrigin,
  });
  return app;
}
