/**
 * Hono routes for V2 system administration (`/v2/admin/*`, Slice 14; SPEC-V2
 * §6.2, §6.8, §7; route registry §10).
 *
 * Registered after the `/v2/*` session gate. All routes require canonical
 * null-community `super_admin`; community roles receive `403` before any body,
 * content-type, or path-id parsing runs.
 */
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AdminRepository } from '../repositories/admin.repository.js';
import type { BootstrapRepository } from '../repositories/bootstrap.repository.js';
import {
  AdminService,
  isSuperAdminActor,
  type AdminServiceResult,
} from '../services/admin.service.js';
import { FORBIDDEN_BODY } from '../services/public-communities.service.js';
import { actorOf, parseJsonRequestBody } from './community-writes.hono.js';

export interface AdminRoutesOptions {
  repository: AdminRepository;
  bootstrapRepository: BootstrapRepository;
  now: () => Date;
}

const adminBody4k = bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ error: 'Request too large' }, 413),
});

function respondAdmin<T>(c: Context, result: AdminServiceResult<T>) {
  if (result.status === 204) {
    return c.body(null, 204);
  }
  return c.json(result.body, result.status);
}

async function parseOptionalJsonBody(
  c: Context
): Promise<
  { ok: true; body: unknown } | { ok: false; status: 400 | 415; error: string }
> {
  const contentTypeHeader = c.req.header('Content-Type');
  if (contentTypeHeader !== undefined) {
    return parseJsonRequestBody(c);
  }
  const rawText = await c.req.text();
  if (rawText.length === 0) {
    return { ok: true, body: {} };
  }
  return { ok: false, status: 415, error: 'Expected JSON' };
}

export function registerAdminRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: AdminRoutesOptions
): void {
  const service = new AdminService(
    options.repository,
    options.bootstrapRepository
  );

  // Enforce super_admin before body limits or route-level validation so
  // community roles always receive 403 without probing request bounds.
  app.use('/v2/admin/*', async (c, next) => {
    const actor = actorOf(c);
    if (!isSuperAdminActor(actor)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    await next();
  });

  app.get('/v2/admin/communities', async (c) => {
    const actor = actorOf(c);
    const result = await service.listCommunities(
      actor,
      c.req.query(),
      options.now()
    );
    return respondAdmin(c, result);
  });

  app.post('/v2/admin/communities', adminBody4k, async (c) => {
    const actor = actorOf(c);
    if (!isSuperAdminActor(actor)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.provisionCommunity(
      actor,
      parsed.body,
      options.now()
    );
    return respondAdmin(c, result);
  });

  app.post('/v2/admin/communities/:id/claim-tokens', adminBody4k, async (c) => {
    const actor = actorOf(c);
    if (!isSuperAdminActor(actor)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    const parsed = await parseOptionalJsonBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.issueClaimToken(
      actor,
      c.req.param('id'),
      parsed.body,
      options.now()
    );
    return respondAdmin(c, result);
  });

  app.patch('/v2/admin/communities/:id/status', adminBody4k, async (c) => {
    const actor = actorOf(c);
    if (!isSuperAdminActor(actor)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.updateCommunityStatus(
      actor,
      c.req.param('id'),
      parsed.body,
      options.now()
    );
    return respondAdmin(c, result);
  });

  app.delete('/v2/admin/communities/:id', async (c) => {
    const actor = actorOf(c);
    if (!isSuperAdminActor(actor)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    const result = await service.deprovisionCommunity(
      actor,
      c.req.param('id'),
      options.now()
    );
    return respondAdmin(c, result);
  });

  app.get('/v2/admin/audit-entries', async (c) => {
    const actor = actorOf(c);
    if (!isSuperAdminActor(actor)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    const result = await service.listSystemAuditEntries(actor, c.req.query());
    return respondAdmin(c, result);
  });
}
