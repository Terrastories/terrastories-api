/**
 * Community user-management orchestration (Slice 11a, #188; SPEC-V2 §6.2,
 * §6.8, §7 "Bootstrap and account lifecycle"; route registry §6 "Users").
 *
 * Authority model: every route requires an own-community `admin` (user-
 * management authority). Only `POST /v2/users/:id/password-reset` and
 * `POST /v2/users/:id/login-codes` are also available while the community is
 * disabled — credential recovery is the authentication surface, never content
 * access (§7, "Which administrators these are is fixed at the moment the
 * community is disabled…"; assisted recovery "remains available while the
 * community is disabled because credential recovery is part of the
 * authentication surface, not community-content access"). Everything else
 * fails closed while the community is disabled.
 *
 * `super_admin` (null community) never reaches these routes; a null-community
 * target is likewise out of reach — the queries are community-scoped, so the
 * answer is an identical 404.
 */
import {
  UserManagementRepository,
  isUniqueConstraintError,
  type ManagedUserRow,
} from '../repositories/user-management.repository.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import { userStatusFromPhysical } from '../policy/canonical-state.js';
import { deriveUserIdentityColumns } from '../shared/utils/derived-columns.js';
import {
  sha256Hex,
  toHex,
  constantTimeEqual,
  hmacSha256Bytes,
  toBase64Url,
} from '../shared/auth-crypto.js';
import {
  ARGON2ID_ALGORITHM,
  ADMIN_ISSUED_CODE_TTL_MS,
  LOGIN_CODE_ENTROPY_BYTES,
  isCanonicalArgon2idParams,
  isCanonicalVerifierSalt,
} from '../shared/auth-policy.js';
import { isDatabaseIdString } from '../shared/types/public.js';
import {
  AdminPasswordResetRequestSchema,
  CreateManagedUserRequestSchema,
  ListUsersQuerySchema,
  PatchManagedUserRequestSchema,
  SESSION_HANDLE_PATTERN,
  DEVICE_SESSION_HANDLE_LENGTH,
  type ManagedUser,
  type ManagedUserListResponse,
} from '../shared/schemas/users-admin.js';
import {
  FORBIDDEN_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import { CONFLICT_BODY } from './community-writes.service.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';

export const PASSWORD_REQUIREMENTS_BODY: V2ErrorResponse = Object.freeze({
  error: 'Password does not meet requirements',
});

/** 409 when a role/status change would leave the community without an admin. */
export const LAST_ADMIN_BODY = Object.freeze({
  error: 'Conflict',
  code: 'last_admin',
});

export type UserManagementResult<T> =
  | { status: 200 | 201; body: T }
  | { status: 204 }
  | { status: 400 | 403 | 404 | 409 | 500 | 503; body: V2ErrorResponse };

export interface AdminUserManagementCaller {
  actorId: number;
  communityId: number;
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/**
 * Prelogin-style fail-closed body for an unconfigured deployment secret
 * (§7): the session-handle surface cannot compute handles without it.
 */
export const HANDLE_SERVICE_UNAVAILABLE_BODY: V2ErrorResponse = Object.freeze({
  error: 'Service unavailable',
});

/**
 * Input of the HMAC that binds a device-session handle to this deployment.
 * Never a token digest and never a session id.
 */
const SESSION_HANDLE_INPUT_PREFIX = 'session-handle:';

export class UserManagementService {
  private readonly serverSecret?: string;

  constructor(
    private readonly repository: UserManagementRepository,
    options: { serverSecret?: string } = {}
  ) {
    this.serverSecret = options.serverSecret;
  }

  /**
   * Opaque, per-deployment handle for a session id (base64url HMAC-SHA256
   * truncated to 22 chars). Verifies nothing about possession; it only names
   * the session without exposing the raw id (which is a token digest).
   */
  private async sessionHandle(sessionId: string): Promise<string> {
    const digest = await hmacSha256Bytes(
      this.serverSecret as string,
      `${SESSION_HANDLE_INPUT_PREFIX}${sessionId}`
    );
    return toBase64Url(digest).slice(0, DEVICE_SESSION_HANDLE_LENGTH);
  }

  /** Constant-time handle resolution against a target's live device sessions. */
  private async resolveSessionHandle(
    targetUserId: number,
    handle: string
  ): Promise<string | null> {
    const rows = await this.repository.listDeviceSessions(
      targetUserId,
      new Date()
    );
    for (const row of rows) {
      const candidate = await this.sessionHandle(row.id);
      if (constantTimeEqual(candidate, handle)) return row.id;
    }
    return null;
  }

  /**
   * The shared authority gate: canonical `admin` of a non-null community.
   * When `allowDisabledCommunity` is false (every route except assisted
   * recovery), the community must also be active — otherwise 403.
   */
  private async authorizeCaller(
    actor: FoundationUser,
    options: { allowDisabledCommunity: boolean }
  ): Promise<AdminUserManagementCaller | null> {
    if (actor.role !== 'admin' || actor.communityId === null) return null;
    if (!options.allowDisabledCommunity) {
      const active = await this.repository.communityIsActive(actor.communityId);
      if (active !== true) return null;
    }
    return { actorId: actor.id, communityId: actor.communityId };
  }

  private toManagedUser(row: ManagedUserRow): ManagedUser {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      status: userStatusFromPhysical(row.isActive),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Content-free audit trail for user-management actions (§7): actor,
   * community, action, resource ids and outcome only — never codes,
   * passwords, tokens, session identifiers or content.
   */
  private async audit(
    actor: { id: number; communityId: number | null },
    input: {
      action: string;
      resourceType: string;
      resourceIds: Array<number | string>;
      outcome: 'success' | 'failure';
    }
  ): Promise<void> {
    try {
      await writeAuditEntry(this.repository.connection, {
        communityId: actor.communityId,
        actorId: actor.id,
        action: input.action,
        resourceType: input.resourceType,
        resourceIds: input.resourceIds,
        outcome: input.outcome,
        ipAddress: null,
        userAgent: null,
      });
    } catch {
      // Content-free operational marker only; the audit sink failing must
      // never change the user-management decision.
      // eslint-disable-next-line no-console -- no logging seam in the service; this is the content-free fallback
      console.error('user-management audit write failed', {
        action: input.action,
        outcome: input.outcome,
      });
    }
  }

  async listUsers(
    actor: FoundationUser,
    query: Record<string, string | undefined>
  ): Promise<UserManagementResult<ManagedUserListResponse>> {
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: false,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    const parsed = ListUsersQuerySchema.safeParse(query);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }
    const { limit, offset } = parsed.data;
    const { rows, total } = await this.repository.listCommunityUsers(
      caller.communityId,
      limit,
      offset
    );
    const data = rows.map((row) => this.toManagedUser(row));
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

  async getUser(
    actor: FoundationUser,
    idParam: string
  ): Promise<UserManagementResult<{ data: ManagedUser }>> {
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: false,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    if (!isDatabaseIdString(idParam)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const target = await this.repository.findCommunityUser(
      caller.communityId,
      Number(idParam)
    );
    if (!target) return { status: 404, body: NOT_FOUND_BODY };
    return { status: 200, body: { data: this.toManagedUser(target) } };
  }

  async createUser(
    actor: FoundationUser,
    rawBody: unknown
  ): Promise<UserManagementResult<{ data: ManagedUser }>> {
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: false,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    const parsed = CreateManagedUserRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }
    const input = parsed.data;
    const identity = deriveUserIdentityColumns({
      email: input.email,
      username: input.username,
    });
    const emailNormalized = identity.emailNormalized as string;
    const usernameNormalized = identity.usernameNormalized ?? null;
    const collided = await this.repository.hasIdentityCollision({
      communityId: caller.communityId,
      emailNormalized,
      usernameNormalized,
    });
    if (collided) {
      await this.audit(actor, {
        action: 'user.create',
        resourceType: 'user',
        resourceIds: [],
        outcome: 'failure',
      });
      // One uniform 409 — never which rule was hit (§6.2).
      return { status: 409, body: CONFLICT_BODY };
    }
    let verifier: {
      passwordVerifier: string;
      passwordAlgorithm: string;
      passwordSalt: string;
      passwordParams: string;
    } | null = null;
    if (input.password !== undefined) {
      const material = input.password;
      if (
        !isCanonicalArgon2idParams(material.params) ||
        !isCanonicalVerifierSalt(material.salt)
      ) {
        return { status: 400, body: PASSWORD_REQUIREMENTS_BODY };
      }
      const { memoryKiB, iterations, parallelism } = material.params as {
        memoryKiB: number;
        iterations: number;
        parallelism: number;
      };
      verifier = {
        passwordVerifier: await sha256Hex(material.derivedKey),
        passwordAlgorithm: ARGON2ID_ALGORITHM,
        passwordSalt: material.salt,
        passwordParams: JSON.stringify({ memoryKiB, iterations, parallelism }),
      };
    }
    // The V1 legacy `password_hash` is NOT NULL; V2 never verifies it, so a
    // runtime random placeholder keeps the column satisfied without inventing
    // a credential.
    const passwordHash = toHex(crypto.getRandomValues(new Uint8Array(32)));
    try {
      const { id } = await this.repository.createCommunityUser({
        communityId: caller.communityId,
        username: input.username,
        usernameNormalized,
        email: input.email,
        emailNormalized,
        displayName: input.displayName ?? null,
        role: input.role,
        passwordHash,
        verifier,
        createdAt: new Date(),
      });
      const created = await this.repository.findCommunityUser(
        caller.communityId,
        id
      );
      await this.audit(actor, {
        action: 'user.create',
        resourceType: 'user',
        resourceIds: [id],
        outcome: 'success',
      });
      return {
        status: 201,
        body: { data: this.toManagedUser(created as ManagedUserRow) },
      };
    } catch (error) {
      // Unique-index backstop for the check-then-insert race (§6.2).
      if (isUniqueConstraintError(error)) {
        await this.audit(actor, {
          action: 'user.create',
          resourceType: 'user',
          resourceIds: [],
          outcome: 'failure',
        });
        return { status: 409, body: CONFLICT_BODY };
      }
      throw error;
    }
  }

  async patchUser(
    actor: FoundationUser,
    idParam: string,
    rawBody: unknown
  ): Promise<UserManagementResult<{ data: ManagedUser }>> {
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: false,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    if (!isDatabaseIdString(idParam)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const targetId = Number(idParam);
    const parsed = PatchManagedUserRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }
    const target = await this.repository.findCommunityUser(
      caller.communityId,
      targetId
    );
    if (!target) return { status: 404, body: NOT_FOUND_BODY };
    const body = parsed.data;
    const next = {
      displayName:
        body.displayName !== undefined ? body.displayName : target.displayName,
      username: body.username !== undefined ? body.username : target.username,
      email: body.email !== undefined ? body.email : target.email,
      role: (body.role ?? target.role) as
        | 'viewer'
        | 'member'
        | 'editor'
        | 'admin',
      status: body.status ?? userStatusFromPhysical(target.isActive),
    };
    const identity = deriveUserIdentityColumns({
      email: next.email,
      username: next.username ?? null,
    });
    const collided = await this.repository.hasIdentityCollision({
      communityId: caller.communityId,
      emailNormalized: identity.emailNormalized as string,
      usernameNormalized: identity.usernameNormalized ?? null,
      excludeUserId: target.id,
    });
    if (collided) {
      await this.audit(actor, {
        action: 'user.update',
        resourceType: 'user',
        resourceIds: [target.id],
        outcome: 'failure',
      });
      return { status: 409, body: CONFLICT_BODY };
    }
    // SPEC-V2 §6.2: the disabled gate fixes exactly which administrators keep
    // authority at disable time; the task rule — an admin cannot demote or
    // deactivate themselves when that would leave the community without an
    // administrator — prevents silent lockout. The guard is part of the
    // write itself (a single guarded statement on SQLite/D1, or a
    // community-locked transaction on PostgreSQL): the actor is re-read as an
    // active admin inside the write, so a concurrent role change cannot slip
    // a lockout in behind a pre-check.
    let outcome: 'updated' | 'not_found' | 'authority_lost' | 'last_admin';
    try {
      outcome = await this.repository.updateCommunityUser({
        id: target.id,
        communityId: caller.communityId,
        actorId: caller.actorId,
        ...(body.displayName !== undefined
          ? { displayName: body.displayName }
          : {}),
        ...(body.username !== undefined
          ? {
              username: body.username,
              usernameNormalized: identity.usernameNormalized ?? null,
            }
          : {}),
        ...(body.email !== undefined
          ? { email: body.email, emailNormalized: identity.emailNormalized }
          : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined
          ? { isActive: body.status === 'active' }
          : {}),
        updatedAt: new Date(),
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        await this.audit(actor, {
          action: 'user.update',
          resourceType: 'user',
          resourceIds: [target.id],
          outcome: 'failure',
        });
        return { status: 409, body: CONFLICT_BODY };
      }
      throw error;
    }
    if (outcome === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (outcome === 'authority_lost') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (outcome === 'last_admin') {
      await this.audit(actor, {
        action: 'user.update',
        resourceType: 'user',
        resourceIds: [target.id],
        outcome: 'failure',
      });
      return { status: 409, body: LAST_ADMIN_BODY };
    }
    // The users_revoke_sessions trigger fires on role/community/is_active
    // changes and deletes the target's sessions (SPEC-V2 §6.8); nothing else
    // to do here.
    const updated = await this.repository.findCommunityUser(
      caller.communityId,
      target.id
    );
    await this.audit(actor, {
      action: 'user.update',
      resourceType: 'user',
      resourceIds: [target.id],
      outcome: 'success',
    });
    return {
      status: 200,
      body: { data: this.toManagedUser(updated as ManagedUserRow) },
    };
  }

  /**
   * Admin-assisted password reset for **another** account of the actor's
   * community (route registry §6): the actor's client stretches the temporary
   * password and sends only the verifier material; the server never sees or
   * generates a password. Applies the verifier atomically with revoking the
   * target's sessions and establishes no session for anyone (§7).
   */
  async resetPassword(
    actor: FoundationUser,
    idParam: string,
    rawBody: unknown
  ): Promise<UserManagementResult<never>> {
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: true,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    if (!isDatabaseIdString(idParam)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const target = await this.repository.findCommunityUserForReset(
      caller.communityId,
      Number(idParam)
    );
    if (!target) return { status: 404, body: NOT_FOUND_BODY };
    if (target.id === actor.id) {
      // "never for their own" (§7). Own-account recovery has its own paths.
      return { status: 403, body: FORBIDDEN_BODY };
    }
    const parsed = AdminPasswordResetRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }
    const material = parsed.data;
    if (
      !isCanonicalArgon2idParams(material.params) ||
      !isCanonicalVerifierSalt(material.salt)
    ) {
      return { status: 400, body: PASSWORD_REQUIREMENTS_BODY };
    }
    const { memoryKiB, iterations, parallelism } = material.params as {
      memoryKiB: number;
      iterations: number;
      parallelism: number;
    };
    const verifier = {
      passwordVerifier: await sha256Hex(material.derivedKey),
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: material.salt,
      passwordParams: JSON.stringify({ memoryKiB, iterations, parallelism }),
    };
    const reset = await this.repository.resetVerifierAndRevokeSessions({
      target,
      verifier,
    });
    if (!reset) {
      await this.audit(actor, {
        action: 'user.password_reset',
        resourceType: 'user',
        resourceIds: [target.id],
        outcome: 'failure',
      });
      return { status: 409, body: CONFLICT_BODY };
    }
    await this.audit(actor, {
      action: 'user.password_reset',
      resourceType: 'user',
      resourceIds: [target.id],
      outcome: 'success',
    });
    return { status: 204 };
  }

  /**
   * Issue a one-time `admin_issued` LoginCode for **another** account of the
   * actor's community (route registry §6; SPEC-V2 §6.8). ≥100 bits from the
   * platform CSPRNG, single-use, at most 72h, stored only as SHA-256, returned
   * exactly once. Independent of outstanding codes; nothing else is superseded.
   */
  async issueLoginCode(
    actor: FoundationUser,
    idParam: string
  ): Promise<
    UserManagementResult<{
      data: { code: string; purpose: 'admin_issued'; expiresAt: string };
    }>
  > {
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: true,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    if (!isDatabaseIdString(idParam)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const target = await this.repository.findCommunityUser(
      caller.communityId,
      Number(idParam)
    );
    if (!target) return { status: 404, body: NOT_FOUND_BODY };
    if (target.id === actor.id) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    const codeBytes = crypto.getRandomValues(
      new Uint8Array(LOGIN_CODE_ENTROPY_BYTES)
    );
    const code = base64Url(codeBytes);
    const codeHash = await sha256Hex(code);
    const now = Date.now();
    const expiresAt = now + ADMIN_ISSUED_CODE_TTL_MS;
    await this.repository.insertLoginCode({
      // Target is same-community by construction; §6.8 stores the
      // account's community on the code row (null only for null-community
      // accounts, which cannot reach here).
      communityId: caller.communityId,
      userId: target.id,
      purpose: 'admin_issued',
      codeHash,
      createdBy: actor.id,
      createdAt: now,
      expiresAt,
    });
    await this.audit(actor, {
      action: 'user.login_code_issue',
      resourceType: 'user',
      resourceIds: [target.id],
      outcome: 'success',
    });
    return {
      status: 201,
      body: {
        data: {
          code,
          purpose: 'admin_issued',
          expiresAt: new Date(expiresAt).toISOString(),
        },
      },
    };
  }

  async listSessions(
    actor: FoundationUser,
    idParam: string
  ): Promise<
    UserManagementResult<{
      data: Array<{
        handle: string;
        kind: 'device';
        createdAt: string;
        lastSeenAt: string | null;
        idleExpiresAt: string | null;
        absoluteExpiresAt: string | null;
      }>;
    }>
  > {
    // The registry §6 lists Device sessions of an own-community account for
    // the user-management admin; the registry does not grant an account-owner
    // exception for non-admins, so self-service stays on /v2/auth/revoke.
    if (!this.serverSecret) {
      return { status: 503, body: HANDLE_SERVICE_UNAVAILABLE_BODY };
    }
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: false,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    if (!isDatabaseIdString(idParam)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const target = await this.repository.findCommunityUser(
      caller.communityId,
      Number(idParam)
    );
    if (!target) return { status: 404, body: NOT_FOUND_BODY };
    const rows = await this.repository.listDeviceSessions(
      target.id,
      new Date()
    );
    const iso = (value: number | null) =>
      value === null ? null : new Date(value).toISOString();
    const data = await Promise.all(
      rows.map(async (row) => ({
        handle: await this.sessionHandle(row.id),
        kind: 'device' as const,
        createdAt:
          row.createdAt === null ? '' : new Date(row.createdAt).toISOString(),
        lastSeenAt: iso(row.lastSeenAt),
        idleExpiresAt: iso(row.idleExpiresAt),
        absoluteExpiresAt: iso(row.absoluteExpiresAt),
      }))
    );
    return {
      status: 200,
      body: { data },
    };
  }

  async revokeSession(
    actor: FoundationUser,
    idParam: string,
    handle: string
  ): Promise<UserManagementResult<never>> {
    // Handles are resolved by computing one for every live device session of
    // the target (a bounded, already user-scoped set) and comparing in
    // constant time — the raw id is never supplied or accepted.
    if (!this.serverSecret) {
      return { status: 503, body: HANDLE_SERVICE_UNAVAILABLE_BODY };
    }
    const caller = await this.authorizeCaller(actor, {
      allowDisabledCommunity: false,
    });
    if (!caller) return { status: 403, body: FORBIDDEN_BODY };
    if (!isDatabaseIdString(idParam)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (!SESSION_HANDLE_PATTERN.test(handle)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const target = await this.repository.findCommunityUser(
      caller.communityId,
      Number(idParam)
    );
    if (!target) return { status: 404, body: NOT_FOUND_BODY };
    const sessionId = await this.resolveSessionHandle(target.id, handle);
    if (sessionId === null) return { status: 404, body: NOT_FOUND_BODY };
    const revoked = await this.repository.revokeDeviceSession({
      userId: target.id,
      sessionId,
      revokedBy: actor.id,
      now: new Date(),
    });
    if (!revoked) return { status: 404, body: NOT_FOUND_BODY };
    await this.audit(actor, {
      action: 'user.session.revoke',
      resourceType: 'session',
      // Session identifiers are never written to an audit entry (§6.8).
      resourceIds: [],
      outcome: 'success',
    });
    return { status: 204 };
  }
}
