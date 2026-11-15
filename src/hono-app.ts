import { sessionLifetime } from './shared/session-policy.js';
import { registerExploreAdapter } from './explore-adapter.js';
import { ExploreAdapterRepository } from './repositories/explore-adapter.repository.js';
import { CommunityReadsRepository } from './repositories/community-reads.repository.js';
import { CommunityWritesRepository } from './repositories/community-writes.repository.js';
import { PublicCommunitiesRepository } from './repositories/public-communities.repository.js';
import { StoryWritesRepository } from './repositories/story-writes.repository.js';
import { registerCommunityReadRoutes } from './routes/community-reads.hono.js';
import { registerCommunityWriteRoutes } from './routes/community-writes.hono.js';
import { registerPublicCommunityRoutes } from './routes/public-communities.hono.js';
import { registerStoryWriteRoutes } from './routes/story-writes.hono.js';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  AUTH_LOGIN_FAILURE_BODY,
  DERIVED_KEY_PATTERN,
  AuthLoginRejected,
  clientIpOf,
  sessionCookieMaxAge,
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
  secureCookies?: boolean;
  publicOrigin?: string;
  corsOrigins?: string[];
  now?: () => Date;
}
const preloginSchema = z
  .object({
    identifier: z.string().min(1).max(254),
    communitySlug: z.string().min(1).max(255).optional(),
  })
  .strict();
const loginSchema = z
  .object({
    identifier: z.string().min(1).max(254),
    communitySlug: z.string().min(1).max(255).optional(),
    derivedKey: z.string().regex(DERIVED_KEY_PATTERN),
    upgrade: z
      .object({
        algorithm: z.string().min(1).max(64),
        salt: z.string().min(1).max(128),
        params: z.record(z.string(), z.unknown()),
        derivedKey: z.string().regex(DERIVED_KEY_PATTERN),
      })
      .strict()
      .optional(),
    deviceSession: z.boolean().optional(),
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
  const app = new Hono<{ Variables: { actor: FoundationUser } }>();
  const service = new HonoFoundationService(
    options.repository,
    options.storage
  );
  const authService = new HonoAuthService(
    new HonoAuthRepository(options.repository.connection),
    options.repository,
    options.serverSecret
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
          clientIpOf(c.req.raw.headers),
          now()
        );
        const maxAge = sessionCookieMaxAge(result.kind);
        setCookie(
          c,
          'ts_session',
          result.token,
          maxAge === null
            ? {
                httpOnly: true,
                secure: options.secureCookies ?? true,
                sameSite: 'Strict',
                path: '/',
              }
            : { ...cookie, maxAge }
        );
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
  registerPublicCommunityRoutes(app, {
    repository: new PublicCommunitiesRepository(options.repository.connection),
    storage: options.storage,
    publicOrigin: configuredOrigin,
  });
  app.use('/v2/*', async (c, next) => {
    const user = await service.actor(getCookie(c, 'ts_session'), now());
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('actor', user);
    await next();
    if (
      c.res.status < 400 &&
      !['/v2/auth/logout', '/v2/auth/revoke'].includes(c.req.path)
    )
      setCookie(c, 'ts_session', getCookie(c, 'ts_session')!, cookie);
  });
  app.get('/v2/auth/me', (c) => c.json({ user: publicUser(c.get('actor')) }));
  app.post('/v2/auth/logout', async (c) => {
    await options.repository.revokeSession(
      await tokenDigest(getCookie(c, 'ts_session')!)
    );
    deleteCookie(c, 'ts_session', cookie);
    return c.body(null, 204);
  });
  app.post('/v2/auth/revoke', async (c) => {
    await options.repository.revokeUserSessions(c.get('actor').id);
    deleteCookie(c, 'ts_session', cookie);
    return c.body(null, 204);
  });
  const communityReadsRepository = new CommunityReadsRepository(
    options.repository.connection
  );
  registerCommunityReadRoutes(app, {
    repository: communityReadsRepository,
    publicOrigin: configuredOrigin,
  });
  registerCommunityWriteRoutes(app, {
    repository: new CommunityWritesRepository(options.repository.connection),
    readsRepository: communityReadsRepository,
    publicOrigin: configuredOrigin,
  });
  registerStoryWriteRoutes(app, {
    repository: new StoryWritesRepository(options.repository.connection),
    readsRepository: communityReadsRepository,
    publicOrigin: configuredOrigin,
  });
  app.get('/v2/media/:id', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Not found' }, 404);
    const file = await service.media(id.data, c.get('actor'));
    if (!file) return c.json({ error: 'Not found' }, 404);
    // Download disposition + sandbox prevents active branding formats executing.
    return new Response(
      file.bytes instanceof Uint8Array
        ? new Uint8Array(file.bytes)
        : file.bytes,
      {
        headers: {
          'Content-Type': file.mimeType,
          'Content-Disposition': 'attachment',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      }
    );
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
