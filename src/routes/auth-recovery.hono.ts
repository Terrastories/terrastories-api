/**
 * Hono routes for V2 recovery-code generation and login-code redemption
 * (Slice 11b-A, #188; route registry §1).
 *
 * - `POST /v2/auth/recovery/redeem` is unauthenticated and MUST register before
 *   the `/v2/*` session gate.
 * - `POST /v2/auth/recovery-codes` is authenticated and registers after `/v2/*`.
 */
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type { SessionKind } from '../shared/auth-policy.js';
import type { AuthRecoveryService } from '../services/auth-recovery.service.js';
import { tokenDigest } from '../services/hono-foundation.service.js';
import { actorOf } from './community-writes.hono.js';

export interface PublicAuthRecoveryRoutesOptions {
  service: AuthRecoveryService;
  ipFor: (c: Context) => string;
  now: () => Date;
  setSessionCookie: (c: Context, token: string, kind: SessionKind) => void;
  publicUser: (user: FoundationUser) => Record<string, unknown>;
}

export interface ProtectedAuthRecoveryRoutesOptions {
  service: AuthRecoveryService;
  ipFor: (c: Context) => string;
  now: () => Date;
}

const jsonBody4k = bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ error: 'Request too large' }, 413),
});

export function registerPublicAuthRecoveryRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: PublicAuthRecoveryRoutesOptions
): void {
  app.post('/v2/auth/recovery/redeem', jsonBody4k, async (c) => {
    if (
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    ) {
      return c.json({ error: 'Expected JSON' }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const result = await options.service.redeemLoginCode(
      body,
      getCookie(c, 'ts_session'),
      {
        clientIp: options.ipFor(c),
        now: options.now(),
        userAgent: c.req.header('user-agent'),
      }
    );
    if (result.status !== 200) {
      return c.json(result.body, result.status);
    }
    options.setSessionCookie(c, result.token, result.kind);
    return c.json({ user: options.publicUser(result.user) }, 200);
  });
}

export function registerProtectedAuthRecoveryRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: ProtectedAuthRecoveryRoutesOptions
): void {
  app.post('/v2/auth/recovery-codes', jsonBody4k, async (c) => {
    const contentTypeHeader = c.req.header('Content-Type');
    let body: unknown;
    if (contentTypeHeader !== undefined) {
      if (
        contentTypeHeader.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      ) {
        return c.json({ error: 'Expected JSON' }, 415);
      }
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request' }, 400);
      }
    } else {
      const rawText = await c.req.text();
      if (rawText.length === 0) {
        body = {};
      } else {
        return c.json({ error: 'Expected JSON' }, 415);
      }
    }

    const rawSession = getCookie(c, 'ts_session');
    const sessionTokenHash = rawSession
      ? await tokenDigest(rawSession)
      : undefined;
    const actor = actorOf(c);
    const result = await options.service.generateRecoveryCodes(
      actor,
      body,
      sessionTokenHash,
      {
        clientIp: options.ipFor(c),
        now: options.now(),
        userAgent: c.req.header('user-agent'),
      }
    );
    return c.json(result.body, result.status);
  });
}
