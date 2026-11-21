/**
 * Service layer for Slice 13a community-scoped AuditEntry read
 * (`GET /v2/community/audit-entries`; SPEC-V2 §6.2, §6.8, §7; route registry §9).
 *
 * Security & sovereignty invariants:
 * - Strictly requires an active community's own `admin`
 *   (`actor.role === 'admin' && actor.communityId !== null && active`).
 * - Disabled communities receive 403 here (the §6.2/§7 disabled-community
 *   exception covers sovereignty endpoints only; disabled communities retrieve
 *   their audit history via `POST /v2/community/export`).
 * - `super_admin` and non-admin community roles receive 403.
 * - Tenant comes exclusively from `actor.communityId`; never exposes system
 *   (`communityId IS NULL`) or other-community rows.
 */

import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import { CommunityAuditRepository } from '../repositories/community-audit.repository.js';
import {
  CommunityAuditEntriesListResponseSchema,
  ListCommunityAuditEntriesQuerySchema,
  type CommunityAuditEntriesListResponse,
} from '../shared/schemas/community-audit.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import {
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
} from './public-communities.service.js';

export type CommunityAuditReadResult =
  | { status: 200; body: CommunityAuditEntriesListResponse }
  | { status: 400 | 403 | 500; body: V2ErrorResponse };

export class CommunityAuditService {
  constructor(private readonly repository: CommunityAuditRepository) {}

  async listAuditEntries(
    actor: FoundationUser,
    searchParams: URLSearchParams
  ): Promise<CommunityAuditReadResult> {
    if (actor.role !== 'admin' || actor.communityId === null) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    const active = await this.repository.communityIsActive(actor.communityId);
    if (active !== true) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const rawQuery: Record<string, string> = {};
    const duplicatePaths: string[] = [];
    for (const key of searchParams.keys()) {
      const values = searchParams.getAll(key);
      if (values.length > 1) {
        if (!duplicatePaths.includes(key)) {
          duplicatePaths.push(key);
        }
        continue;
      }
      rawQuery[key] = values[0] ?? '';
    }
    if (duplicatePaths.length > 0) {
      return {
        status: 400,
        body: makeValidationErrorBody(
          duplicatePaths.map((path) => ({
            path,
            message: 'Duplicate query parameter is not allowed',
          }))
        ),
      };
    }

    const parsed = ListCommunityAuditEntriesQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const { limit, offset, action, resourceType, outcome, actorId, from, to } =
      parsed.data;
    const { rows, total } = await this.repository.listCommunityAuditEntries({
      communityId: actor.communityId,
      limit,
      offset,
      action,
      resourceType,
      outcome,
      actorId,
      from,
      to,
    });

    const data = rows.map((row) => ({
      id: row.id,
      communityId: row.communityId,
      actorId: row.actorId,
      action: row.action,
      resourceType: row.resourceType,
      resourceIds: [...row.resourceIds],
      outcome: row.outcome,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    }));

    const payload = {
      data,
      meta: {
        total,
        limit,
        offset,
        hasNextPage: offset + data.length < total,
      },
    };

    const validated =
      CommunityAuditEntriesListResponseSchema.safeParse(payload);
    if (!validated.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    return { status: 200, body: validated.data };
  }
}
