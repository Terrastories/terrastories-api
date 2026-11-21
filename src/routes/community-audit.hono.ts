/**
 * Hono route for Slice 13a community-scoped AuditEntry read
 * (`GET /v2/community/audit-entries`; SPEC-V2 §6.8, §7; route registry §9).
 *
 * Mounted inside the `/v2/*` session gate in `src/hono-app.ts`.
 */

import type { Hono } from 'hono';
import { CommunityAuditRepository } from '../repositories/community-audit.repository.js';
import { CommunityAuditService } from '../services/community-audit.service.js';
import { actorOf } from './community-writes.hono.js';

export interface CommunityAuditRoutesOptions {
  repository: CommunityAuditRepository;
}

export function registerCommunityAuditRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: CommunityAuditRoutesOptions
): void {
  const service = new CommunityAuditService(options.repository);

  app.get('/v2/community/audit-entries', async (c) => {
    const result = await service.listAuditEntries(
      actorOf(c),
      new URL(c.req.url).searchParams
    );
    return c.json(result.body, result.status);
  });
}
