/**
 * Hono routes for V2 community user management (Slice 11a, #188; route
 * registry §6 "Users"). All routes are authenticated community routes: the
 * session gate runs first (`/v2/*` middleware), CSRF is enforced globally,
 * and the tenant always comes from the session actor — never from a path,
 * query or body field.
 */
import type { Context, Hono } from 'hono';
import type { UserManagementRepository } from '../repositories/user-management.repository.js';
import { UserManagementService } from '../services/user-management.service.js';
import {
  actorOf,
  jsonBodyLimit,
  parseJsonRequestBody,
} from './community-writes.hono.js';

export interface UserManagementRoutesOptions {
  repository: UserManagementRepository;
  publicOrigin?: string;
  /**
   * Prelogin-style HMAC key (`AUTH_SERVER_SECRET`). Without it the
   * device-session handle endpoints fail closed with 503.
   */
  serverSecret?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function respond(c: Context, result: any) {
  if (result.status === 204) {
    return c.body(null, 204);
  }
  return c.json(result.body, result.status);
}

export function registerUserManagementRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: UserManagementRoutesOptions
): void {
  const service = new UserManagementService(options.repository, {
    serverSecret: options.serverSecret,
  });

  app.get('/v2/users', async (c) => {
    const actor = actorOf(c);
    const result = await service.listUsers(actor, c.req.query());
    return respond(c, result);
  });

  app.get('/v2/users/:id', async (c) => {
    const actor = actorOf(c);
    const result = await service.getUser(actor, c.req.param('id'));
    return respond(c, result);
  });

  app.post('/v2/users', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.createUser(actor, parsed.body);
    return respond(c, result);
  });

  app.patch('/v2/users/:id', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.patchUser(
      actor,
      c.req.param('id'),
      parsed.body
    );
    return respond(c, result);
  });

  app.post('/v2/users/:id/password-reset', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.resetPassword(
      actor,
      c.req.param('id'),
      parsed.body
    );
    return respond(c, result);
  });

  app.post('/v2/users/:id/login-codes', async (c) => {
    const actor = actorOf(c);
    // No body: the code is pure server-side entropy.
    const result = await service.issueLoginCode(actor, c.req.param('id'));
    return respond(c, result);
  });

  app.get('/v2/users/:id/sessions', async (c) => {
    const actor = actorOf(c);
    const result = await service.listSessions(actor, c.req.param('id'));
    return respond(c, result);
  });

  app.delete('/v2/users/:id/sessions/:handle', async (c) => {
    const actor = actorOf(c);
    const result = await service.revokeSession(
      actor,
      c.req.param('id'),
      c.req.param('handle')
    );
    return respond(c, result);
  });
}
