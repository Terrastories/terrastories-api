/**
 * Recovery-code generation and single-use LoginCode redemption orchestration
 * (Slice 11b-A, #188; SPEC-V2 §6.8, §6.10, §7 "Bootstrap and account lifecycle";
 * route registry §1).
 */
import type {
  AuthAccount,
  HonoAuthRepository,
  VerifierWrite,
} from '../repositories/hono-auth.repository.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type { AuthRecoveryRepository } from '../repositories/auth-recovery.repository.js';
import {
  ADMIN_CODE_STEP_UP_TTL_MS,
  ARGON2ID_ALGORITHM,
  AUTH_LOGIN_FAILURE_BODY,
  LOGIN_CODE_ENTROPY_BYTES,
  RAILS_BCRYPT_ALGORITHM,
  RECOVERY_CODE_COUNT,
  isCanonicalArgon2idParams,
  isCanonicalVerifierSalt,
  sessionLifetimesFor,
  sessionTokenDigestInput,
  type SessionKind,
} from '../shared/auth-policy.js';
import {
  constantTimeEqual,
  sha256Hex,
  toBase64Url,
  toHex,
} from '../shared/auth-crypto.js';
import {
  RecoveryCodesRequestSchema,
  RecoveryRedeemRequestSchema,
} from '../shared/schemas/auth-recovery.js';
import { parseV2Role } from '../shared/authorization/sovereignty-policy.js';
import { normalizeSearchText } from '../shared/utils/search-normalize.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';

export type RecoveryCodesResult =
  | {
      status: 201;
      body: {
        data: {
          codes: string[];
          purpose: 'recovery';
          createdAt: string;
        };
      };
    }
  | {
      status: 400 | 401 | 403 | 409 | 503;
      body: { error: string };
    };

export type RedeemLoginCodeResult =
  | {
      status: 200;
      token: string;
      kind: SessionKind;
      user: FoundationUser;
    }
  | {
      status: 400 | 401 | 503;
      body: { error: string };
    };

export interface AuthRequestContext {
  clientIp: string;
  now: Date;
  userAgent?: string | undefined;
}

const SERVICE_UNAVAILABLE_BODY = Object.freeze({
  error: 'Service unavailable',
});
const INVALID_REQUEST_BODY = Object.freeze({ error: 'Invalid request' });
const FORBIDDEN_BODY = Object.freeze({ error: 'Forbidden' });
const CONFLICT_BODY = Object.freeze({ error: 'Conflict' });
const PASSWORD_REQUIREMENTS_BODY = Object.freeze({
  error: 'Password does not meet requirements',
});

/** Strip control characters and truncate User-Agent for safe audit storage. */
export function sanitizeUserAgent(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = raw
    .replace(/[\r\n\0]/g, '')
    .trim()
    .slice(0, 512);
  return cleaned.length > 0 ? cleaned : null;
}

/** Generate one >=100-bit CSPRNG code (128 bits, base64url). */
export function generateEntropyCode(): string {
  return toBase64Url(
    crypto.getRandomValues(new Uint8Array(LOGIN_CODE_ENTROPY_BYTES))
  );
}

/**
 * Accounts eligible to hold recovery codes (§6.8, §7): community admins,
 * null-community `super_admin`s, and (once Slice 13 lands) designated stewards.
 */
function canHoldRecoveryCodes(
  actor: FoundationUser
): actor is FoundationUser & { role: 'admin' | 'super_admin' } {
  if (actor.role === 'admin' && actor.communityId !== null) return true;
  if (actor.role === 'super_admin' && actor.communityId === null) return true;
  return false;
}

function accountAllowed(account: AuthAccount): boolean {
  if (!account.isActive) return false;
  if (!parseV2Role(account.role)) return false;
  if (account.communityId === null) return account.role === 'super_admin';
  if (account.communityIsActive === true) return true;
  return account.communityIsActive === false && account.role === 'admin';
}

function toFoundationUser(account: AuthAccount): FoundationUser {
  const role = parseV2Role(account.role);
  if (role === null) throw new Error('Invalid V2 role');
  return {
    id: account.id,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    passwordHash: account.passwordHash,
    role,
    communityId: account.communityId,
  };
}

export class AuthRecoveryService {
  constructor(
    private readonly recoveryRepo: AuthRecoveryRepository,
    private readonly authRepo: HonoAuthRepository,
    private readonly serverSecret: string | undefined
  ) {}

  private async auditSecurityEvent(input: {
    communityId: number | null;
    actorId: number | null;
    action: string;
    resourceType: string;
    resourceIds: Array<number | string>;
    outcome: 'success' | 'failure';
    clientIp: string;
    userAgent?: string | undefined;
  }): Promise<void> {
    try {
      await writeAuditEntry(this.authRepo.connection, {
        communityId: input.communityId,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceIds: input.resourceIds,
        outcome: input.outcome,
        ipAddress: input.clientIp,
        userAgent: sanitizeUserAgent(input.userAgent),
      });
    } catch {
      // Content-free fallback: action and outcome only.
      // eslint-disable-next-line no-console -- no logging seam in auth recovery service
      console.error('auth recovery audit write failed', {
        action: input.action,
        outcome: input.outcome,
      });
    }
  }

  /**
   * Generate or regenerate 10 single-use recovery codes for the authenticated
   * administrator / super_admin (POST /v2/auth/recovery-codes).
   */
  async generateRecoveryCodes(
    actor: FoundationUser,
    rawBody: unknown,
    sessionTokenHash: string | undefined,
    context: AuthRequestContext
  ): Promise<RecoveryCodesResult> {
    if (!canHoldRecoveryCodes(actor)) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    const parsed = RecoveryCodesRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { status: 400, body: INVALID_REQUEST_BODY };
    }
    const secret = this.serverSecret;
    if (secret === undefined || secret === '') {
      return { status: 503, body: SERVICE_UNAVAILABLE_BODY };
    }

    const nowMs = context.now.getTime();
    const auditInput = {
      communityId: actor.communityId,
      actorId: actor.id,
      action: 'auth.recovery_codes.generate',
      resourceType: 'recovery_codes',
      resourceIds: [actor.id],
      outcome: 'success' as const,
      ipAddress: context.clientIp,
      userAgent: sanitizeUserAgent(context.userAgent),
    };

    const failAudit = (outcomeActor: {
      id: number | null;
      communityId: number | null;
    }) =>
      this.auditSecurityEvent({
        communityId: outcomeActor.communityId,
        actorId: outcomeActor.id,
        action: 'auth.recovery_codes.generate',
        resourceType: 'recovery_codes',
        resourceIds: outcomeActor.id === null ? [] : [outcomeActor.id],
        outcome: 'failure',
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });

    if (parsed.data.currentDerivedKey !== undefined) {
      // The per-IP brake is read before the step-up verifier, exactly as login
      // does (SPEC-V2 §6.8, §7 step 6): a failed step-up increments both the
      // account and the client-address counter, so a client address blocked by
      // any other auth endpoint must be refused here too — otherwise the
      // address-level brake is only a write amplifier.
      const ipBlocked = await this.authRepo.throttleState(
        await this.authRepo.ipThrottleKey(context.clientIp, secret),
        nowMs
      );
      if (ipBlocked.blocked) {
        return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }
      const account = await this.authRepo.accountById(actor.id);
      if (account === null || !accountAllowed(account)) {
        await failAudit({ id: actor.id, communityId: actor.communityId });
        return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }

      const blocked = await this.authRepo.throttleState(
        await this.authRepo.accountThrottleKey(account.id, secret),
        nowMs
      );
      if (blocked.blocked) {
        return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }

      const rejectPasswordStepUp = async (): Promise<RecoveryCodesResult> => {
        await this.authRepo.recordLoginFailure(
          {
            account: { id: account.id, communityId: account.communityId },
            clientIp: context.clientIp,
            now: nowMs,
          },
          secret
        );
        await failAudit({ id: account.id, communityId: account.communityId });
        return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      };

      const stored = account.passwordVerifier;
      if (
        stored === null ||
        (account.passwordAlgorithm !== ARGON2ID_ALGORITHM &&
          account.passwordAlgorithm !== RAILS_BCRYPT_ALGORITHM)
      ) {
        return rejectPasswordStepUp();
      }
      const digest = await sha256Hex(parsed.data.currentDerivedKey);
      if (!constantTimeEqual(digest, stored)) {
        return rejectPasswordStepUp();
      }

      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
        generateEntropyCode()
      );
      const codeHashes = await Promise.all(
        codes.map((code) => sha256Hex(code))
      );
      const outcome = await this.recoveryRepo.generateRecoveryCodesAtomically(
        {
          actor: {
            id: actor.id,
            communityId: actor.communityId,
            role: actor.role,
          },
          codeHashes,
          nowMs,
          stepUp: {
            mode: 'password',
            passwordHash: account.passwordHash,
            expectedVerifier: stored,
            sessionTokenHash,
          },
        },
        auditInput
      );

      if (outcome !== 'generated') {
        await failAudit({ id: account.id, communityId: account.communityId });
        return { status: 409, body: CONFLICT_BODY };
      }

      try {
        await this.authRepo.resetAccountThrottle(
          account.id,
          context.clientIp,
          secret
        );
      } catch {
        // The recovery sheet has already been generated and the old sheet
        // superseded inside the committed write. A failed counter reset is
        // housekeeping: log it content-free and still deliver the one-time
        // sheet (§6.8, §7) rather than failing a request that cannot be
        // retried.
        // eslint-disable-next-line no-console -- no logging seam in auth recovery service; content-free fallback
        console.error('recovery codes throttle reset failed', {
          action: 'auth.recovery_codes.throttle_reset',
          outcome: 'failure',
        });
      }
      return {
        status: 201,
        body: {
          data: {
            codes,
            purpose: 'recovery',
            createdAt: context.now.toISOString(),
          },
        },
      };
    }

    // Verifier-free path: ONLY allowed on a fresh, unconsumed `admin_issued`
    // session within ADMIN_CODE_STEP_UP_TTL_MS.
    if (!sessionTokenHash) {
      await failAudit({ id: actor.id, communityId: actor.communityId });
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateEntropyCode()
    );
    const codeHashes = await Promise.all(codes.map((code) => sha256Hex(code)));
    const outcome = await this.recoveryRepo.generateRecoveryCodesAtomically(
      {
        actor: {
          id: actor.id,
          communityId: actor.communityId,
          role: actor.role,
        },
        codeHashes,
        nowMs,
        stepUp: {
          mode: 'admin_issued_session',
          sessionTokenHash,
        },
      },
      auditInput
    );

    if (outcome !== 'generated') {
      await failAudit({ id: actor.id, communityId: actor.communityId });
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }

    return {
      status: 201,
      body: {
        data: {
          codes,
          purpose: 'recovery',
          createdAt: context.now.toISOString(),
        },
      },
    };
  }

  /**
   * Unauthenticated redemption of one single-use LoginCode (`recovery` or
   * `admin_issued`), atomically setting any supplied password verifier,
   * revoking prior sessions, and issuing a new `ts_session`
   * (POST /v2/auth/recovery/redeem).
   */
  async redeemLoginCode(
    rawBody: unknown,
    previousToken: string | undefined,
    context: AuthRequestContext
  ): Promise<RedeemLoginCodeResult> {
    const parsed = RecoveryRedeemRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { status: 400, body: INVALID_REQUEST_BODY };
    }

    const { code, identifier, communitySlug, password, deviceSession } =
      parsed.data;

    let verifier: VerifierWrite | null = null;
    if (password !== undefined) {
      if (
        !isCanonicalArgon2idParams(password.params) ||
        !isCanonicalVerifierSalt(password.salt)
      ) {
        return { status: 400, body: PASSWORD_REQUIREMENTS_BODY };
      }
      const { memoryKiB, iterations, parallelism } = password.params;
      verifier = {
        // Store the existing account's passwordHash placeholder only if needed;
        // redeemLoginCodeAtomically leaves `password_hash` untouched.
        passwordHash: '',
        passwordVerifier: await sha256Hex(password.derivedKey),
        passwordAlgorithm: ARGON2ID_ALGORITHM,
        passwordSalt: password.salt,
        passwordParams: JSON.stringify({ memoryKiB, iterations, parallelism }),
      };
    }

    const secret = this.serverSecret;
    if (secret === undefined || secret === '') {
      return { status: 503, body: SERVICE_UNAVAILABLE_BODY };
    }

    const nowMs = context.now.getTime();
    const ipBlocked = await this.authRepo.throttleState(
      await this.authRepo.ipThrottleKey(context.clientIp, secret),
      nowMs
    );
    if (ipBlocked.blocked) {
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }

    const rejectRedeem = async (
      resolvedAccount: AuthAccount | null
    ): Promise<RedeemLoginCodeResult> => {
      await this.authRepo.recordLoginFailure(
        {
          account:
            resolvedAccount === null
              ? null
              : {
                  id: resolvedAccount.id,
                  communityId: resolvedAccount.communityId,
                },
          clientIp: context.clientIp,
          now: nowMs,
        },
        secret
      );
      await this.auditSecurityEvent({
        communityId: resolvedAccount?.communityId ?? null,
        actorId: resolvedAccount?.id ?? null,
        action: 'auth.recovery.redeem',
        resourceType: 'login_code',
        resourceIds: resolvedAccount === null ? [] : [resolvedAccount.id],
        outcome: 'failure',
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    };

    const slugCommunityId =
      communitySlug === undefined
        ? undefined
        : await this.authRepo.communityIdBySlug(communitySlug);

    const codeHash = await sha256Hex(code);
    const codeRow = await this.recoveryRepo.findLoginCodeByHash(codeHash);

    let account: AuthAccount | null = null;
    if (identifier !== undefined) {
      if (communitySlug !== undefined && slugCommunityId === null) {
        return rejectRedeem(null);
      }
      const normalized = normalizeSearchText(identifier);
      const candidates = await this.authRepo.loginCandidates(
        identifier,
        normalized,
        slugCommunityId ?? undefined
      );
      const candidate = candidates.length === 1 ? candidates[0]! : null;
      if (candidate === null) {
        return rejectRedeem(null);
      }
      const accountBlocked = await this.authRepo.throttleState(
        await this.authRepo.accountThrottleKey(candidate.id, secret),
        nowMs
      );
      if (accountBlocked.blocked) {
        return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }
      if (
        codeRow === null ||
        !constantTimeEqual(codeRow.codeHash, codeHash) ||
        codeRow.userId !== candidate.id
      ) {
        return rejectRedeem(candidate);
      }
      account = candidate;
    } else {
      if (codeRow === null || !constantTimeEqual(codeRow.codeHash, codeHash)) {
        return rejectRedeem(null);
      }
      const resolved = await this.authRepo.accountById(codeRow.userId);
      if (!resolved) {
        return rejectRedeem(null);
      }
      const accountBlocked = await this.authRepo.throttleState(
        await this.authRepo.accountThrottleKey(resolved.id, secret),
        nowMs
      );
      if (accountBlocked.blocked) {
        return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
      }
      account = resolved;
    }

    // Verify optional communitySlug locator against the resolved account
    // (null-community super_admin rejects any communitySlug).
    if (communitySlug !== undefined) {
      if (
        slugCommunityId === null ||
        account.communityId === null ||
        account.communityId !== slugCommunityId
      ) {
        return rejectRedeem(account);
      }
    }

    if (!accountAllowed(account)) {
      return rejectRedeem(account);
    }

    if (
      codeRow.usedAt !== null ||
      codeRow.supersededAt !== null ||
      (codeRow.expiresAt !== null && codeRow.expiresAt <= nowMs)
    ) {
      return rejectRedeem(account);
    }

    // §6.8 / §7: redeeming a `recovery` code mandates setting a new password
    // verifier; `admin_issued` may set one or omit it.
    if (codeRow.purpose === 'recovery' && verifier === null) {
      return rejectRedeem(account);
    }

    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token);
    const kind: SessionKind = deviceSession === true ? 'device' : 'standard';
    const lifetimes = sessionLifetimesFor(kind, nowMs);
    const previousValid = sessionTokenDigestInput(previousToken);
    const previousHash =
      previousValid === null ? undefined : await sha256Hex(previousValid);

    const adminCodeStepUpExpiresAtMs =
      codeRow.purpose === 'admin_issued'
        ? nowMs + ADMIN_CODE_STEP_UP_TTL_MS
        : null;

    const user = toFoundationUser(account);
    const redeemed = await this.recoveryRepo.redeemLoginCodeAtomically(
      {
        code: {
          id: codeRow.id,
          codeHash: codeRow.codeHash,
          userId: codeRow.userId,
          purpose: codeRow.purpose,
          expiresAt: codeRow.expiresAt,
        },
        account: {
          id: account.id,
          communityId: account.communityId,
          role: user.role,
          passwordHash: account.passwordHash,
        },
        verifier,
        session: {
          tokenHash,
          kind,
          createdAtMs: nowMs,
          idleExpiresAtMs: lifetimes.idleExpiresAt,
          absoluteExpiresAtMs: lifetimes.absoluteExpiresAt,
          adminCodeStepUpExpiresAtMs,
          previousHash,
        },
        nowMs,
      },
      {
        communityId: account.communityId,
        actorId: account.id,
        action: 'auth.recovery.redeem',
        resourceType: 'login_code',
        resourceIds: [account.id],
        outcome: 'success',
        ipAddress: context.clientIp,
        userAgent: sanitizeUserAgent(context.userAgent),
      }
    );

    if (!redeemed) {
      return rejectRedeem(account);
    }

    try {
      await this.authRepo.resetAccountThrottle(
        account.id,
        context.clientIp,
        secret
      );
    } catch {
      // The redemption has already committed (code consumed, sessions revoked,
      // new session issued). A failed counter reset is housekeeping: log it
      // content-free and still deliver the new session token (§6.8, §7)
      // rather than failing a request that cannot be retried.
      // eslint-disable-next-line no-console -- no logging seam in auth recovery service; content-free fallback
      console.error('recovery redeem throttle reset failed', {
        action: 'auth.recovery.redeem.throttle_reset',
        outcome: 'failure',
      });
    }
    return {
      status: 200,
      token,
      kind,
      user,
    };
  }
}
