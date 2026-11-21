/**
 * System administration orchestration (`/v2/admin/*`, Slice 14; SPEC-V2 §6.2,
 * §6.8, §7; route registry §10).
 *
 * Only canonical null-community `super_admin` callers are admitted; every
 * community role receives `403`. Community descriptive fields and content are
 * never read or written.
 */
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type {
  AdminRepository,
  OperationalCommunityRow,
} from '../repositories/admin.repository.js';
import type { BootstrapRepository } from '../repositories/bootstrap.repository.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import { generateClaimTokenMaterial } from './bootstrap.service.js';
import {
  AdminAuditEntriesQuerySchema,
  AdminCommunityListQuerySchema,
  IssueClaimTokenRequestSchema,
  ProvisionCommunityRequestSchema,
  UpdateCommunityStatusRequestSchema,
  type AdminAuditEntryListResponse,
  type AdminCommunityListResponse,
  type AdminCommunityOperational,
  type AdminCommunityResponse,
  type ClaimTokenIssuedResponse,
} from '../shared/schemas/admin.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
  type V2ValidationErrorResponse,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import { CLAIM_TOKEN_MAX_TTL_MS } from '../shared/auth-policy.js';
import {
  BAD_REQUEST_BODY,
  FORBIDDEN_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import { CONFLICT_BODY } from './community-writes.service.js';

export type AdminServiceResult<T> =
  | { status: 200 | 201; body: T }
  | { status: 204 }
  | {
      status: 400 | 403 | 404 | 409;
      body: V2ErrorResponse | V2ValidationErrorResponse;
    };

export function isSuperAdminActor(
  actor: FoundationUser | null | undefined
): actor is FoundationUser & { role: 'super_admin'; communityId: null } {
  return (
    Boolean(actor) &&
    actor!.role === 'super_admin' &&
    actor!.communityId === null
  );
}

export class AdminService {
  constructor(
    private readonly adminRepo: AdminRepository,
    private readonly bootstrapRepo: BootstrapRepository
  ) {}

  private toOperationalProjection(
    row: OperationalCommunityRow
  ): AdminCommunityOperational {
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      claimStatus: row.claimStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async auditFailureBestEffort(input: {
    communityId: number | null;
    actorId: number;
    action: string;
    resourceType: string;
    resourceIds: Array<number | string>;
    now: Date;
  }): Promise<void> {
    try {
      await writeAuditEntry(
        this.adminRepo.connection,
        {
          communityId: input.communityId,
          actorId: input.actorId,
          action: input.action,
          resourceType: input.resourceType,
          resourceIds: input.resourceIds,
          outcome: 'failure',
          ipAddress: null,
          userAgent: null,
        },
        input.now
      );
    } catch {
      // eslint-disable-next-line no-console -- content-free operational fallback when audit sink fails
      console.error('admin audit write failed', {
        action: input.action,
        outcome: 'failure',
      });
    }
  }

  /** GET /v2/admin/communities */
  async listCommunities(
    actor: FoundationUser,
    query: Record<string, string | undefined>,
    now: Date
  ): Promise<AdminServiceResult<AdminCommunityListResponse>> {
    if (!isSuperAdminActor(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = AdminCommunityListQuerySchema.safeParse(query);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const { limit, offset, status } = parsed.data;
    const { rows, total } = await this.adminRepo.listOperationalCommunities({
      limit,
      offset,
      status,
      nowMs: now.getTime(),
    });
    const data = rows.map((row) => this.toOperationalProjection(row));

    return {
      status: 200,
      body: {
        data,
        meta: {
          total,
          limit,
          offset,
          hasNextPage: offset + data.length < total,
        },
      },
    };
  }

  /** POST /v2/admin/communities */
  async provisionCommunity(
    actor: FoundationUser,
    rawBody: unknown,
    now: Date
  ): Promise<AdminServiceResult<AdminCommunityResponse>> {
    if (!isSuperAdminActor(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = ProvisionCommunityRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const result = await this.adminRepo.provisionCommunityAtomically({
      actorId: actor.id,
      slug: parsed.data.slug,
      now,
    });

    if (result.outcome === 'authority_lost') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (result.outcome === 'slug_conflict') {
      return { status: 409, body: CONFLICT_BODY };
    }

    return {
      status: 201,
      body: {
        data: this.toOperationalProjection(result.community),
      },
    };
  }

  /** POST /v2/admin/communities/:id/claim-tokens */
  async issueClaimToken(
    actor: FoundationUser,
    idParam: string,
    rawBody: unknown,
    now: Date
  ): Promise<AdminServiceResult<ClaimTokenIssuedResponse>> {
    if (!isSuperAdminActor(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (!isDatabaseIdString(idParam)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const parsed = IssueClaimTokenRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const communityId = Number(idParam);
    const ttlMs =
      parsed.data.ttlSeconds !== undefined
        ? parsed.data.ttlSeconds * 1000
        : CLAIM_TOKEN_MAX_TTL_MS;
    const material = await generateClaimTokenMaterial(now, ttlMs);

    const outcome = await this.bootstrapRepo.issueClaimTokenAtomically({
      actorId: actor.id,
      communityId,
      tokenHash: material.tokenHash,
      createdAtMs: material.createdAtMs,
      expiresAtMs: material.expiresAtMs,
    });

    if (outcome.outcome === 'authority_lost') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (outcome.outcome === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (outcome.outcome === 'conflict') {
      // No claim_tokens row was created on conflict, so resourceIds stays empty
      // while communityId identifies the community.
      await this.auditFailureBestEffort({
        communityId,
        actorId: actor.id,
        action: 'claim_token.issue',
        resourceType: 'claim_token',
        resourceIds: [],
        now,
      });
      return { status: 409, body: CONFLICT_BODY };
    }

    return {
      status: 201,
      body: {
        data: {
          id: outcome.id,
          communityId,
          token: material.token,
          expiresAt: new Date(material.expiresAtMs).toISOString(),
          createdAt: new Date(material.createdAtMs).toISOString(),
        },
      },
    };
  }

  /** PATCH /v2/admin/communities/:id/status */
  async updateCommunityStatus(
    actor: FoundationUser,
    idParam: string,
    rawBody: unknown,
    now: Date
  ): Promise<AdminServiceResult<AdminCommunityResponse>> {
    if (!isSuperAdminActor(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (!isDatabaseIdString(idParam)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }
    const parsed = UpdateCommunityStatusRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const communityId = Number(idParam);
    const result = await this.adminRepo.setCommunityStatusAtomically({
      actorId: actor.id,
      communityId,
      status: parsed.data.status,
      now,
    });

    if (result.outcome === 'authority_lost') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (result.outcome === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }

    if (result.outcome === 'conflict')
      return { status: 409, body: CONFLICT_BODY };

    return {
      status: 200,
      body: {
        data: this.toOperationalProjection(result.community),
      },
    };
  }

  /** DELETE /v2/admin/communities/:id */
  async deprovisionCommunity(
    actor: FoundationUser,
    idParam: string,
    now: Date
  ): Promise<AdminServiceResult<never>> {
    if (!isSuperAdminActor(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (!isDatabaseIdString(idParam)) {
      return { status: 400, body: BAD_REQUEST_BODY };
    }

    const communityId = Number(idParam);
    const result = await this.adminRepo.deprovisionCommunityAtomically({
      actorId: actor.id,
      communityId,
      now,
    });

    if (result.outcome === 'authority_lost') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (result.outcome === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (result.outcome === 'conflict') {
      await this.auditFailureBestEffort({
        communityId: null,
        actorId: actor.id,
        action: 'system.community.deprovision',
        resourceType: 'system',
        resourceIds: [communityId],
        now,
      });
      return { status: 409, body: CONFLICT_BODY };
    }

    return { status: 204 };
  }

  /** GET /v2/admin/audit-entries */
  async listSystemAuditEntries(
    actor: FoundationUser,
    query: Record<string, string | undefined>
  ): Promise<AdminServiceResult<AdminAuditEntryListResponse>> {
    if (!isSuperAdminActor(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = AdminAuditEntriesQuerySchema.safeParse(query);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const { limit, offset, action, outcome } = parsed.data;
    const { rows, total } = await this.adminRepo.listSystemAuditEntries({
      limit,
      offset,
      action,
      outcome,
    });

    const data = rows.map((row) => ({
      id: row.id,
      communityId: row.communityId,
      actorId: row.actorId,
      action: row.action,
      resourceType: row.resourceType,
      resourceIds: row.resourceIds,
      outcome: row.outcome,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      status: 200,
      body: {
        data,
        meta: {
          total,
          limit,
          offset,
          hasNextPage: offset + data.length < total,
        },
      },
    };
  }
}
