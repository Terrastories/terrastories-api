/**
 * Service layer for Slice 13b community sovereignty endpoints
 * (SPEC-V2 §6.2, §6.8, §7 #187; route registry §9).
 *
 * Step-up verification contract:
 * - Current password (`currentDerivedKey`) is verified in constant time
 *   against the re-read account verifier, gated by per-IP and per-account
 *   `AuthThrottle` counters (identical uniform 401 failure on mismatch or
 *   lockout).
 * - Only `own-admin` callers may also use a fresh, unconsumed `admin_issued`
 *   step-up session without re-presenting a password (one-shot consumption
 *   inside the atomic DB unit). Stewards always re-verify current password.
 */

import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type {
  AuthAccount,
  HonoAuthRepository,
} from '../repositories/hono-auth.repository.js';
import {
  CommunitySovereigntyRepository,
  type ArchiveCustodyRecord,
  type SovereigntyAuditMeta,
  type SovereigntyRequestRecord,
  type SovereigntyStepUp,
  type StewardRecord,
} from '../repositories/community-sovereignty.repository.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import {
  ARGON2ID_ALGORITHM,
  AUTH_LOGIN_FAILURE_BODY,
  RAILS_BCRYPT_ALGORITHM,
} from '../shared/auth-policy.js';
import { constantTimeEqual, sha256Hex } from '../shared/auth-crypto.js';
import { parseV2Role } from '../shared/authorization/sovereignty-policy.js';
import {
  SOVEREIGNTY_AUDIT_ACTIONS,
  STEWARD_NOTICE_PERIOD_SECONDS,
  STEWARD_NOTICE_PERIOD_MS,
} from '../shared/sovereignty-policy.js';
import {
  PutCommunityStewardRequestSchema,
  CommunityWithdrawalRequestSchema,
  CancelSovereigntyRequestSchema,
  type CommunityWithdrawalResponse,
  type CancelSovereigntyResponse,
  type ArchiveCustodyView,
  type CommunitySovereigntyStatusResponse,
  type CommunityStewardView,
  type PutCommunityStewardResponse,
  type SovereigntyRequestView,
} from '../shared/schemas/community-sovereignty.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
  type V2ValidationErrorResponse,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import {
  FORBIDDEN_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import { sanitizeUserAgent } from './auth-recovery.service.js';

export type SovereigntyServiceResult<T> =
  | { status: 200 | 202; body: T; sessionPurged?: boolean }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 503;
      body: V2ErrorResponse | V2ValidationErrorResponse;
    };

export interface SovereigntyRequestContext {
  clientIp: string;
  now: Date;
  userAgent?: string | undefined;
}

const SERVICE_UNAVAILABLE_BODY: V2ErrorResponse = Object.freeze({
  error: 'Service unavailable',
});
const ERASURE_IN_PROGRESS_BODY: V2ErrorResponse = Object.freeze({
  error: 'Conflict',
  code: 'erasure_in_progress',
});
const CONFLICT_BODY: V2ErrorResponse = Object.freeze({ error: 'Conflict' });

function authorizeCommunityAdmin(
  actor: FoundationUser
): { actorId: number; communityId: number } | null {
  if (actor.role !== 'admin' || actor.communityId === null) {
    return null;
  }
  return { actorId: actor.id, communityId: actor.communityId };
}

function accountAllowedForStepUp(account: AuthAccount): boolean {
  if (!account.isActive) return false;
  if (!parseV2Role(account.role)) return false;
  if (account.communityId === null) return account.role === 'super_admin';
  if (account.communityIsActive === true) return true;
  return (
    account.communityIsActive === false &&
    (account.role === 'admin' || account.isDesignatedSteward)
  );
}

export function toStewardView(
  steward: StewardRecord | null
): CommunityStewardView | null {
  if (!steward) return null;
  return {
    userId: steward.userId,
    role: steward.role,
    status: steward.status,
    sameCommunity: steward.sameCommunity,
    designatedBy: steward.designatedBy,
    designatedAt: steward.designatedAt.toISOString(),
  };
}

export function toSovereigntyRequestView(
  row: SovereigntyRequestRecord
): SovereigntyRequestView {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    initiatedBy: row.initiatedBy,
    initiatedByRole: row.initiatedByRole,
    requestedAt: row.requestedAt.toISOString(),
    noticeEndsAt: row.noticeEndsAt ? row.noticeEndsAt.toISOString() : null,
    effectiveAt: row.effectiveAt ? row.effectiveAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelledBy: row.cancelledBy,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export function toArchiveCustodyView(
  row: ArchiveCustodyRecord | null
): ArchiveCustodyView | null {
  if (!row) return null;
  return {
    status: row.status,
    custodianType: row.custodianType,
    custodianUserId: row.custodianUserId,
    retentionUntil: row.retentionUntil.toISOString(),
    destroyedAt: row.destroyedAt ? row.destroyedAt.toISOString() : null,
    destructionAttestationRef: row.destructionAttestationRef,
  };
}

export class CommunitySovereigntyService {
  constructor(
    private readonly repository: CommunitySovereigntyRepository,
    private readonly authRepository: HonoAuthRepository,
    private readonly serverSecret: string | undefined
  ) {}

  private async auditSecurityEvent(input: {
    communityId: number | null;
    actorId: number | null;
    action: string;
    resourceType: string;
    resourceIds: Array<number | string>;
    outcome: 'success' | 'failure';
    context: SovereigntyRequestContext;
  }): Promise<void> {
    try {
      await writeAuditEntry(
        this.repository.connection,
        {
          communityId: input.communityId,
          actorId: input.actorId,
          action: input.action,
          resourceType: input.resourceType,
          resourceIds: input.resourceIds,
          outcome: input.outcome,
          ipAddress: input.context.clientIp,
          userAgent: sanitizeUserAgent(input.context.userAgent),
        },
        input.context.now
      );
    } catch {
      // eslint-disable-next-line no-console -- content-free fallback when audit sink fails
      console.error('sovereignty audit write failed', {
        action: input.action,
        outcome: input.outcome,
      });
    }
  }

  /**
   * Verify step-up credentials (`currentDerivedKey` with `AuthThrottle`, or
   * fresh `admin_issued` session when allowed).
   */
  async verifyStepUp(input: {
    actor: FoundationUser;
    currentDerivedKey: string | undefined;
    sessionTokenHash: string | undefined;
    allowAdminIssuedSession: boolean;
    auditAction: string;
    auditCommunityId: number | null;
    context: SovereigntyRequestContext;
  }): Promise<
    | { ok: true; stepUp: SovereigntyStepUp; resetThrottleAccountId?: number }
    | { ok: false; status: 401 | 503; body: V2ErrorResponse }
  > {
    const secret = this.serverSecret;
    if (secret === undefined || secret === '') {
      return { ok: false, status: 503, body: SERVICE_UNAVAILABLE_BODY };
    }

    const nowMs = input.context.now.getTime();
    const auditFailure = (actorId: number | null, communityId: number | null) =>
      this.auditSecurityEvent({
        communityId,
        actorId,
        action: input.auditAction,
        resourceType: 'community_sovereignty',
        resourceIds: communityId === null ? [] : [communityId],
        outcome: 'failure',
        context: input.context,
      });

    if (input.currentDerivedKey !== undefined) {
      const ipBlocked = await this.authRepository.throttleState(
        await this.authRepository.ipThrottleKey(input.context.clientIp, secret),
        nowMs
      );
      if (ipBlocked.blocked) {
        return { ok: false, status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }

      const account = await this.authRepository.accountById(input.actor.id);
      if (account === null || !accountAllowedForStepUp(account)) {
        await auditFailure(
          input.actor.id,
          input.auditCommunityId ?? input.actor.communityId
        );
        return { ok: false, status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }

      const accountBlocked = await this.authRepository.throttleState(
        await this.authRepository.accountThrottleKey(account.id, secret),
        nowMs
      );
      if (accountBlocked.blocked) {
        return { ok: false, status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }

      const rejectPassword = async (): Promise<{
        ok: false;
        status: 401;
        body: V2ErrorResponse;
      }> => {
        await this.authRepository.recordLoginFailure(
          {
            account: { id: account.id, communityId: account.communityId },
            clientIp: input.context.clientIp,
            now: nowMs,
          },
          secret
        );
        await auditFailure(
          account.id,
          input.auditCommunityId ?? account.communityId
        );
        return { ok: false, status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      };

      const stored = account.passwordVerifier;
      if (
        stored === null ||
        (account.passwordAlgorithm !== ARGON2ID_ALGORITHM &&
          account.passwordAlgorithm !== RAILS_BCRYPT_ALGORITHM)
      ) {
        return rejectPassword();
      }

      const digest = await sha256Hex(input.currentDerivedKey);
      if (!constantTimeEqual(digest, stored)) {
        return rejectPassword();
      }

      return {
        ok: true,
        stepUp: {
          mode: 'password',
          passwordHash: account.passwordHash,
          expectedVerifier: stored,
          sessionTokenHash: input.sessionTokenHash,
        },
        resetThrottleAccountId: account.id,
      };
    }

    if (
      !input.allowAdminIssuedSession ||
      !input.sessionTokenHash ||
      !(await this.repository.hasAdminIssuedStepUp(
        input.actor.id,
        input.sessionTokenHash,
        nowMs
      ))
    ) {
      await auditFailure(
        input.actor.id,
        input.auditCommunityId ?? input.actor.communityId
      );
      return { ok: false, status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }

    return {
      ok: true,
      stepUp: {
        mode: 'admin_issued_session',
        sessionTokenHash: input.sessionTokenHash,
      },
    };
  }

  private async resetThrottleBestEffort(
    accountId: number | undefined,
    context: SovereigntyRequestContext
  ): Promise<void> {
    if (accountId === undefined || !this.serverSecret) return;
    try {
      await this.authRepository.resetAccountThrottle(
        accountId,
        context.clientIp,
        this.serverSecret
      );
    } catch {
      // eslint-disable-next-line no-console -- content-free fallback
      console.error('sovereignty throttle reset failed', {
        action: 'community.sovereignty.throttle_reset',
        outcome: 'failure',
      });
    }
  }

  /** GET /v2/community/sovereignty */
  async getSovereignty(
    actor: FoundationUser
  ): Promise<SovereigntyServiceResult<CommunitySovereigntyStatusResponse>> {
    const caller = authorizeCommunityAdmin(actor);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const state = await this.repository.getSovereigntyState(caller.communityId);
    if (!state) {
      return { status: 404, body: NOT_FOUND_BODY };
    }

    return {
      status: 200,
      body: {
        data: {
          communityId: state.communityId,
          status: state.status,
          steward: toStewardView(state.steward),
          noticePeriodSeconds: STEWARD_NOTICE_PERIOD_SECONDS,
          pendingRequests: state.pendingRequests.map(toSovereigntyRequestView),
          recentRequests: state.recentRequests.map(toSovereigntyRequestView),
          archiveCustody: toArchiveCustodyView(state.archiveCustody),
        },
      },
    };
  }

  /** PUT /v2/community/steward */
  async updateSteward(
    actor: FoundationUser,
    rawBody: unknown,
    sessionTokenHash: string | undefined,
    context: SovereigntyRequestContext
  ): Promise<SovereigntyServiceResult<PutCommunityStewardResponse>> {
    const caller = authorizeCommunityAdmin(actor);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = PutCommunityStewardRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    const auditAction =
      parsed.data.stewardUserId === null
        ? SOVEREIGNTY_AUDIT_ACTIONS.STEWARD_REMOVED
        : SOVEREIGNTY_AUDIT_ACTIONS.STEWARD_DESIGNATED;

    const stepUpCheck = await this.verifyStepUp({
      actor,
      currentDerivedKey: parsed.data.currentDerivedKey,
      sessionTokenHash,
      allowAdminIssuedSession: true,
      auditAction,
      auditCommunityId: caller.communityId,
      context,
    });
    if (!stepUpCheck.ok) {
      return { status: stepUpCheck.status, body: stepUpCheck.body };
    }

    const auditMeta: SovereigntyAuditMeta = {
      ipAddress: context.clientIp,
      userAgent: sanitizeUserAgent(context.userAgent),
    };

    const result = await this.repository.setStewardAtomically({
      communityId: caller.communityId,
      actorId: caller.actorId,
      stewardUserId: parsed.data.stewardUserId,
      now: context.now,
      stepUp: stepUpCheck.stepUp,
      auditMeta,
    });

    if (result.outcome === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (result.outcome === 'erasure_in_progress') {
      return { status: 409, body: ERASURE_IN_PROGRESS_BODY };
    }
    if (result.outcome === 'target_not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (result.outcome === 'step_up_failed') {
      await this.auditSecurityEvent({
        communityId: caller.communityId,
        actorId: caller.actorId,
        action: auditAction,
        resourceType: 'community_sovereignty',
        resourceIds: [caller.communityId],
        outcome: 'failure',
        context,
      });
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }
    if (result.outcome === 'authority_lost') {
      return { status: 409, body: CONFLICT_BODY };
    }

    await this.resetThrottleBestEffort(
      stepUpCheck.resetThrottleAccountId,
      context
    );

    return {
      status: 200,
      body: {
        data: {
          communityId: caller.communityId,
          steward: toStewardView(result.steward),
          cancelledRequestIds: result.cancelledRequestIds,
        },
      },
    };
  }
  /** POST /v2/community/withdrawal; only designated stewards can use a locator. */
  async withdraw(
    actor: FoundationUser,
    rawBody: unknown,
    sessionTokenHash: string | undefined,
    context: SovereigntyRequestContext
  ): Promise<SovereigntyServiceResult<CommunityWithdrawalResponse>> {
    const parsed = CommunityWithdrawalRequestSchema.safeParse(rawBody);
    if (!parsed.success)
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    const data = parsed.data;
    let communityId = actor.communityId;
    let role: 'admin' | 'steward' =
      actor.role === 'admin' && communityId !== null ? 'admin' : 'steward';
    if (communityId !== null) {
      if (data.communityId !== undefined || data.communitySlug !== undefined)
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'communityId',
              message: 'Community comes from the session',
            },
          ]),
        };
      if (
        role === 'steward' &&
        !(await this.repository.findStewardDesignation(actor.id, {
          communityId,
        }))
      )
        return { status: 403, body: FORBIDDEN_BODY };
    } else {
      if (actor.role !== 'super_admin')
        return { status: 403, body: FORBIDDEN_BODY };
      if (data.communityId === undefined && data.communitySlug === undefined)
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'communityId',
              message: 'An explicit community locator is required',
            },
          ]),
        };
      const target = await this.repository.findStewardDesignation(
        actor.id,
        data
      );
      if (!target) return { status: 403, body: FORBIDDEN_BODY };
      communityId = target.communityId;
      role = 'steward';
    }
    const check = await this.verifyStepUp({
      actor,
      currentDerivedKey: data.currentDerivedKey,
      sessionTokenHash,
      allowAdminIssuedSession: role === 'admin',
      auditAction: SOVEREIGNTY_AUDIT_ACTIONS.WITHDRAWAL_COMPLETED,
      auditCommunityId: communityId,
      context,
    });
    if (!check.ok) return { status: check.status, body: check.body };
    const request = await this.repository.requestWithdrawal({
      communityId,
      actorId: actor.id,
      role,
      requestId: crypto.randomUUID(),
      stepUp: check.stepUp,
      now: context.now,
      noticeEndsAt:
        role === 'steward'
          ? context.now.getTime() + STEWARD_NOTICE_PERIOD_MS
          : null,
      auditMeta: {
        ipAddress: context.clientIp,
        userAgent: sanitizeUserAgent(context.userAgent),
      },
    });
    if (!request) return { status: 409, body: CONFLICT_BODY };
    this.authRepository.invalidatePreloginMixCache();
    await this.resetThrottleBestEffort(check.resetThrottleAccountId, context);
    const state = await this.repository.getSovereigntyState(communityId);
    return {
      status: role === 'admin' ? 200 : 202,
      body: {
        data: {
          communityId,
          status: state!.status,
          request: toSovereigntyRequestView(request),
        },
      },
    };
  }

  async cancel(
    actor: FoundationUser,
    rawBody: unknown,
    sessionTokenHash: string | undefined,
    context: SovereigntyRequestContext
  ): Promise<SovereigntyServiceResult<CancelSovereigntyResponse>> {
    const caller = authorizeCommunityAdmin(actor);
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    const parsed = CancelSovereigntyRequestSchema.safeParse(rawBody);
    if (!parsed.success)
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    const check = await this.verifyStepUp({
      actor,
      currentDerivedKey: parsed.data.currentDerivedKey,
      sessionTokenHash,
      allowAdminIssuedSession: true,
      auditAction: SOVEREIGNTY_AUDIT_ACTIONS.REQUEST_CANCELLED,
      auditCommunityId: caller.communityId,
      context,
    });
    if (!check.ok) return { status: check.status, body: check.body };
    const cancelled = await this.repository.cancelNotice({
      communityId: caller.communityId,
      actorId: actor.id,
      requestId: parsed.data.requestId,
      stepUp: check.stepUp,
      now: context.now,
      auditMeta: {
        ipAddress: context.clientIp,
        userAgent: sanitizeUserAgent(context.userAgent),
      },
    });
    if (cancelled.length === 0) return { status: 409, body: CONFLICT_BODY };
    await this.resetThrottleBestEffort(check.resetThrottleAccountId, context);
    return {
      status: 200,
      body: {
        data: {
          communityId: caller.communityId,
          cancelledRequests: cancelled.map(toSovereigntyRequestView),
        },
      },
    };
  }
}
