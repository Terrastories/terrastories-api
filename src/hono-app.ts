import { sessionLifetime } from './shared/session-policy.js';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type {
  FoundationUser,
  HonoFoundationRepository,
} from './repositories/hono-foundation.repository.js';
import {
  HonoFoundationService,
  tokenDigest,
  type FoundationStorage,
  type PasswordVerifier,
} from './services/hono-foundation.service.js';

export type RequestHandler = (request: Request) => Promise<Response>;
export interface FoundationOptions {
  repository: HonoFoundationRepository;
  storage: FoundationStorage;
  verifier: PasswordVerifier;
  secureCookies?: boolean;
  publicOrigin?: string;
  corsOrigins?: string[];
  now?: () => Date;
}
const loginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(128),
    communityId: z.number().int().positive().safe().optional(),
  })
  .strict();
const publicUser = (user: FoundationUser) => ({
  id: user.id,
  email: user.email,
  role: user.role,
  communityId: user.communityId,
});

export function createHonoApp(options: FoundationOptions) {
  const app = new Hono<{ Variables: { actor: FoundationUser } }>();
  const service = new HonoFoundationService(
    options.repository,
    options.storage,
    options.verifier
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
      allowMethods: ['GET', 'POST', 'OPTIONS'],
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
      const { email, password, communityId } = parsed.data;
      const result = await service.login(
        email,
        password,
        communityId,
        now(),
        getCookie(c, 'ts_session')
      );
      if (!result) return c.json({ error: 'Invalid credentials' }, 401);
      setCookie(c, 'ts_session', result.token, cookie);
      return c.json({ user: publicUser(result.user) });
    }
  );
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
  return app;
}
