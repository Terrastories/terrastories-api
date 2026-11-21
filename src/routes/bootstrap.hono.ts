/**
 * Hono routes for unauthenticated installation bootstrap (Slice 11b-B, #188;
 * SPEC-V2 §4, §7 "Bootstrap and account lifecycle"; route registry §1).
 *
 * MUST register before the `/v2/*` session gate.
 */
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { SessionKind } from '../shared/auth-policy.js';
import type { BootstrapService } from '../services/bootstrap.service.js';
import {
  jsonBodyLimit,
  parseJsonRequestBody,
} from './community-writes.hono.js';
import { bodyLimit } from 'hono/body-limit';

export interface PublicBootstrapRoutesOptions {
  service: BootstrapService;
  ipFor: (c: Context) => string;
  now: () => Date;
  setSessionCookie: (c: Context, token: string, kind: SessionKind) => void;
}

const claimBody4k = bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ error: 'Request too large' }, 413),
});

export function registerPublicBootstrapRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: PublicBootstrapRoutesOptions
): void {
  app.get('/v2/bootstrap', async (c) => {
    const status = await options.service.getBootstrapStatus();
    return c.json(status, 200);
  });

  app.post('/v2/bootstrap', jsonBodyLimit, async (c) => {
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await options.service.completeBootstrap(parsed.body, {
      clientIp: options.ipFor(c),
      now: options.now(),
      userAgent: c.req.header('user-agent'),
    });
    if (result.status !== 201) {
      return c.json(result.body, result.status);
    }
    options.setSessionCookie(c, result.token, result.kind);
    return c.json(result.body, 201);
  });

  app.post('/v2/bootstrap/claim', claimBody4k, async (c) => {
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await options.service.claimCommunity(
      parsed.body,
      getCookie(c, 'ts_session'),
      {
        clientIp: options.ipFor(c),
        now: options.now(),
        userAgent: c.req.header('user-agent'),
      }
    );
    if (result.status !== 201) {
      return c.json(result.body, result.status);
    }
    options.setSessionCookie(c, result.token, result.kind);
    return c.json(result.body, 201);
  });
}
