/**
 * Installation bootstrap and hosted community claim orchestration (Slice 11b-B
 * and 11b-C, #188; SPEC-V2 §4, §6.8, §7 "Bootstrap and account lifecycle";
 * route registry §1).
 */
import type { BootstrapRepository } from '../repositories/bootstrap.repository.js';
import type {
  HonoAuthRepository,
  VerifierWrite,
} from '../repositories/hono-auth.repository.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import {
  ARGON2ID_ALGORITHM,
  AUTH_LOGIN_FAILURE_BODY,
  CLAIM_TOKEN_MAX_TTL_MS,
  RECOVERY_CODE_COUNT,
  isCanonicalArgon2idParams,
  isCanonicalVerifierSalt,
  sessionLifetimesFor,
  sessionTokenDigestInput,
  type SessionKind,
} from '../shared/auth-policy.js';
import { sha256Hex, constantTimeEqual, toHex } from '../shared/auth-crypto.js';
import {
  BootstrapClaimRequestSchema,
  BootstrapRequestSchema,
  type BootstrapResponse,
} from '../shared/schemas/bootstrap.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
  type V2ValidationErrorResponse,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import {
  deriveDescriptionForWrite,
  deriveUserIdentityColumns,
} from '../shared/utils/derived-columns.js';
import { FORBIDDEN_BODY } from './public-communities.service.js';
import {
  generateEntropyCode,
  sanitizeUserAgent,
  type AuthRequestContext,
} from './auth-recovery.service.js';

export type BootstrapResult =
  | {
      status: 201;
      token: string;
      kind: SessionKind;
      body: BootstrapResponse;
    }
  | {
      status: 400 | 401 | 403 | 409 | 503;
      body: V2ErrorResponse | V2ValidationErrorResponse;
    };

const PASSWORD_REQUIREMENTS_BODY: V2ErrorResponse = Object.freeze({
  error: 'Password does not meet requirements',
});
const INVALID_REQUEST_BODY: V2ErrorResponse = Object.freeze({
  error: 'Invalid request',
});
const SERVICE_UNAVAILABLE_BODY: V2ErrorResponse = Object.freeze({
  error: 'Service unavailable',
});

/** Derive a deterministic URL-safe slug when `community.slug` is omitted. */
export function deriveBootstrapSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'community';
}

export class BootstrapService {
  private readonly serverSecret?: string;
  private readonly fieldKitCaFingerprint?: string;
  private readonly bootstrapSecret?: string;

  constructor(
    private readonly bootstrapRepo: BootstrapRepository,
    private readonly authRepo: HonoAuthRepository,
    options: {
      serverSecret?: string;
      fieldKitCaFingerprint?: string;
      bootstrapSecret?: string;
    } = {}
  ) {
    this.serverSecret = options.serverSecret;
    const trimmed = options.fieldKitCaFingerprint?.trim();
    this.fieldKitCaFingerprint =
      trimmed && trimmed.length > 0 ? trimmed : undefined;
    const bootstrapSecret = options.bootstrapSecret?.trim();
    this.bootstrapSecret =
      bootstrapSecret && bootstrapSecret.length > 0
        ? bootstrapSecret
        : undefined;
  }

  /**
   * Uniform bootstrap denial (closed installation, wrong/missing operator
   * secret, replay after close): per-IP `AuthThrottle` brake first, then a
   * content-free audit of only the first failure per IP window, and never an
   * audit row for an already-blocked address (PR #252 bot findings 1 + 4: no
   * unbounded `bootstrap.complete` audit growth on fresh networks).
   */
  private async denyBootstrapAttempt(
    context: AuthRequestContext
  ): Promise<BootstrapResult> {
    const secret = this.bootstrapSecret;
    if (secret === undefined) {
      // Fail closed without minting throttle/audit state when the operator
      // never configured the bootstrap secret.
      return { status: 403, body: FORBIDDEN_BODY };
    }
    const nowMs = context.now.getTime();
    const ipBlocked = await this.authRepo.throttleState(
      await this.authRepo.ipThrottleKey(context.clientIp, secret),
      nowMs
    );
    if (ipBlocked.blocked) {
      // A throttled address is refused before any audit row is written.
      return { status: 403, body: FORBIDDEN_BODY };
    }
    await this.authRepo.recordLoginFailure(
      {
        account: null,
        clientIp: context.clientIp,
        now: nowMs,
      },
      secret
    );
    if (ipBlocked.failures === 0) {
      // First failure of the window only: later failures in the same window
      // are throttle state, not new audit facts.
      await this.auditFailure({
        communityId: null,
        action: 'bootstrap.complete',
        resourceType: 'bootstrap',
        resourceIds: [],
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });
    }
    return { status: 403, body: FORBIDDEN_BODY };
  }

  private async auditFailure(input: {
    communityId: number | null;
    action: string;
    resourceType: string;
    resourceIds: Array<number | string>;
    clientIp: string;
    userAgent?: string | undefined;
  }): Promise<void> {
    try {
      await writeAuditEntry(this.authRepo.connection, {
        communityId: input.communityId,
        actorId: null,
        action: input.action,
        resourceType: input.resourceType,
        resourceIds: input.resourceIds,
        outcome: 'failure',
        ipAddress: input.clientIp,
        userAgent: sanitizeUserAgent(input.userAgent),
      });
    } catch {
      // eslint-disable-next-line no-console -- no logging seam in bootstrap service; content-free fallback
      console.error('bootstrap audit write failed', {
        action: input.action,
        outcome: 'failure',
      });
    }
  }

  /** GET /v2/bootstrap — fail-closed boolean status, no community data. */
  async getBootstrapStatus(): Promise<{ open: boolean }> {
    // Fail closed: an installation whose operator has not configured the
    // bootstrap secret (`BOOTSTRAP_SECRET`) never opens for initial setup
    // (PR #252 bot finding 1; SPEC-V2 §7 "Bootstrap and account lifecycle").
    if (this.bootstrapSecret === undefined) {
      return { open: false };
    }
    const open = await this.bootstrapRepo.isBootstrapOpen();
    return { open };
  }

  /**
   * POST /v2/bootstrap — initial community + first admin setup on a fresh
   * installation; permanently closes after use and refuses replays with 403.
   */
  async completeBootstrap(
    rawBody: unknown,
    context: AuthRequestContext
  ): Promise<BootstrapResult> {
    // Fail closed: bootstrap authority is operator-provided via
    // `BOOTSTRAP_SECRET` — an installation without one is permanently closed
    // for initial setup (PR #252 bot finding 1; SPEC-V2 §7).
    const open =
      this.bootstrapSecret !== undefined &&
      (await this.bootstrapRepo.isBootstrapOpen());
    if (!open) {
      if (this.bootstrapSecret === undefined) {
        // No operator secret configured: closed, and no throttle/audit state
        // is minted for anonymous probes of a deployment that never opened.
        return { status: 403, body: FORBIDDEN_BODY };
      }
      return this.denyBootstrapAttempt(context);
    }

    const parsed = BootstrapRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }

    // The operator secret is compared as SHA-256 digests with the constant-time
    // comparator, so the raw value never crosses a comparison boundary and a
    // wrong/missing secret answers exactly like a closed installation (no
    // distinguishing oracle; PR #252 bot finding 1).
    const presentedBootstrapSecret = parsed.data.bootstrapSecret;
    const bootstrapSecretDigest =
      this.bootstrapSecret === undefined
        ? null
        : await sha256Hex(this.bootstrapSecret);
    const presentedSecretDigest =
      presentedBootstrapSecret === undefined
        ? null
        : await sha256Hex(presentedBootstrapSecret);
    const secretMatches =
      bootstrapSecretDigest !== null &&
      presentedSecretDigest !== null &&
      constantTimeEqual(bootstrapSecretDigest, presentedSecretDigest);
    if (!secretMatches) {
      return this.denyBootstrapAttempt(context);
    }

    const { community, admin, deviceSession } = parsed.data;
    if (
      !isCanonicalArgon2idParams(admin.password.params) ||
      !isCanonicalVerifierSalt(admin.password.salt)
    ) {
      return { status: 400, body: PASSWORD_REQUIREMENTS_BODY };
    }

    const { memoryKiB, iterations, parallelism } = admin.password.params as {
      memoryKiB: number;
      iterations: number;
      parallelism: number;
    };
    const passwordHash = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const verifier: VerifierWrite = {
      passwordHash,
      passwordVerifier: await sha256Hex(admin.password.derivedKey),
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: admin.password.salt,
      passwordParams: JSON.stringify({ memoryKiB, iterations, parallelism }),
    };

    const derivedDescription = deriveDescriptionForWrite(
      community.description ?? null
    );
    const slug = community.slug ?? deriveBootstrapSlug(community.name);
    const identity = deriveUserIdentityColumns({
      email: admin.email,
      username: admin.username,
    });
    const emailNormalized = identity.emailNormalized as string;
    const usernameNormalized = identity.usernameNormalized as string;

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateEntropyCode()
    );
    const recoveryCodeHashes = await Promise.all(
      codes.map((code) => sha256Hex(code))
    );

    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token);
    const kind: SessionKind = deviceSession === true ? 'device' : 'standard';
    const nowMs = context.now.getTime();
    const lifetimes = sessionLifetimesFor(kind, nowMs);

    const execution =
      await this.bootstrapRepo.completeInstallationBootstrapAtomically(
        {
          community: {
            name: community.name,
            slug,
            description: derivedDescription.description,
            descriptionPlain: derivedDescription.descriptionPlain,
            locale: community.locale,
            country: community.country ?? null,
            visibility: community.visibility,
          },
          admin: {
            username: admin.username,
            usernameNormalized,
            email: admin.email,
            emailNormalized,
            displayName: admin.displayName ?? null,
            passwordHash,
            verifier,
          },
          recoveryCodeHashes,
          session: {
            tokenHash,
            kind,
            idleExpiresAtMs: lifetimes.idleExpiresAt,
            absoluteExpiresAtMs: lifetimes.absoluteExpiresAt,
          },
          now: context.now,
        },
        {
          ipAddress: context.clientIp,
          userAgent: sanitizeUserAgent(context.userAgent),
        }
      );

    if (execution.outcome === 'already_closed') {
      // Replay against a permanently closed installation: same per-IP brake
      // and content-free first-failure audit as any other denial.
      return this.denyBootstrapAttempt(context);
    }

    return {
      status: 201,
      token,
      kind,
      body: {
        data: {
          community: {
            id: execution.community.id,
            name: execution.community.name,
            slug: execution.community.slug,
            description: execution.community.description,
            locale: execution.community.locale,
            country: execution.community.country,
            visibility: execution.community.visibility,
            status: 'active',
            createdAt: execution.community.createdAt.toISOString(),
            updatedAt: execution.community.updatedAt.toISOString(),
          },
          user: {
            id: execution.userId,
            email: admin.email,
            username: admin.username,
            displayName: admin.displayName ?? null,
            role: 'admin',
            communityId: execution.community.id,
            recoveryCodesConfirmed: true,
          },
          recoveryCodes: {
            codes,
            purpose: 'recovery',
            createdAt: context.now.toISOString(),
          },
          ...(this.fieldKitCaFingerprint !== undefined
            ? { caFingerprint: this.fieldKitCaFingerprint }
            : {}),
        },
      },
    };
  }

  /**
   * POST /v2/bootstrap/claim — unauthenticated single-use `ClaimToken`
   * redemption for an empty, never-administered hosted community. Throttled
   * per IP and per resolved ClaimToken row via `AuthThrottle`.
   */
  async claimCommunity(
    rawBody: unknown,
    previousToken: string | undefined,
    context: AuthRequestContext
  ): Promise<BootstrapResult> {
    const parsed = BootstrapClaimRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return { status: 400, body: INVALID_REQUEST_BODY };
    }

    const { token, username, email, displayName, password, deviceSession } =
      parsed.data;
    if (
      !isCanonicalArgon2idParams(password.params) ||
      !isCanonicalVerifierSalt(password.salt)
    ) {
      return { status: 400, body: PASSWORD_REQUIREMENTS_BODY };
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

    const tokenHash = await sha256Hex(token);
    const claimRow = await this.bootstrapRepo.findClaimTokenByHash(tokenHash);

    // The digest lookup is by index, but the presented material is still
    // re-verified in constant time before any decision is made (§6.8): a row
    // that somehow resolved without matching this request's digest is treated
    // exactly like no row at all.
    if (
      claimRow === null ||
      !constantTimeEqual(claimRow.tokenHash, tokenHash)
    ) {
      await this.authRepo.recordClaimFailure(
        {
          claimToken: null,
          clientIp: context.clientIp,
          now: nowMs,
        },
        secret
      );
      await this.auditFailure({
        communityId: null,
        action: 'bootstrap.claim',
        resourceType: 'bootstrap',
        resourceIds: [],
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }

    const tokenBlocked = await this.authRepo.throttleState(
      await this.authRepo.claimThrottleKey(claimRow.id, secret),
      nowMs
    );
    if (tokenBlocked.blocked) {
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    }

    const rejectClaim = async (): Promise<BootstrapResult> => {
      await this.authRepo.recordClaimFailure(
        {
          claimToken: { id: claimRow.id, communityId: claimRow.communityId },
          clientIp: context.clientIp,
          now: nowMs,
        },
        secret
      );
      await this.auditFailure({
        communityId: claimRow.communityId,
        action: 'claim_token.consume',
        resourceType: 'claim_token',
        resourceIds: [claimRow.id],
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });
      return { status: 401, body: AUTH_LOGIN_FAILURE_BODY };
    };

    if (
      claimRow.consumedAt !== null ||
      claimRow.supersededAt !== null ||
      claimRow.expiresAt <= nowMs ||
      claimRow.expiresAt - claimRow.createdAt > CLAIM_TOKEN_MAX_TTL_MS ||
      !claimRow.communityIsActive
    ) {
      return rejectClaim();
    }

    const { memoryKiB, iterations, parallelism } = password.params as {
      memoryKiB: number;
      iterations: number;
      parallelism: number;
    };
    const passwordHash = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const verifier: VerifierWrite = {
      passwordHash,
      passwordVerifier: await sha256Hex(password.derivedKey),
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: password.salt,
      passwordParams: JSON.stringify({ memoryKiB, iterations, parallelism }),
    };

    const identity = deriveUserIdentityColumns({ email, username });
    const emailNormalized = identity.emailNormalized as string;
    const usernameNormalized = identity.usernameNormalized as string;

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateEntropyCode()
    );
    const recoveryCodeHashes = await Promise.all(
      codes.map((code) => sha256Hex(code))
    );

    const sessionToken = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const sessionTokenHash = await sha256Hex(sessionToken);
    const kind: SessionKind = deviceSession === true ? 'device' : 'standard';
    const lifetimes = sessionLifetimesFor(kind, nowMs);
    const previousValid = sessionTokenDigestInput(previousToken);
    const previousHash =
      previousValid === null ? undefined : await sha256Hex(previousValid);

    const execution = await this.bootstrapRepo.claimCommunityAtomically(
      {
        claimTokenId: claimRow.id,
        tokenHash,
        communityId: claimRow.communityId,
        community: {
          id: claimRow.communityId,
          name: claimRow.communityName,
          slug: claimRow.communitySlug,
          description: claimRow.communityDescription,
          locale: claimRow.communityLocale,
          country: claimRow.communityCountry,
          publicStories: claimRow.communityPublicStories,
          isActive: claimRow.communityIsActive,
          createdAt: claimRow.communityCreatedAt,
          updatedAt: claimRow.communityUpdatedAt,
        },
        admin: {
          username,
          usernameNormalized,
          email,
          emailNormalized,
          displayName: displayName ?? null,
          passwordHash,
          verifier,
        },
        recoveryCodeHashes,
        session: {
          tokenHash: sessionTokenHash,
          kind,
          idleExpiresAtMs: lifetimes.idleExpiresAt,
          absoluteExpiresAtMs: lifetimes.absoluteExpiresAt,
          previousHash,
        },
        now: context.now,
      },
      {
        ipAddress: context.clientIp,
        userAgent: sanitizeUserAgent(context.userAgent),
      }
    );

    // §6.2 identity collisions are NOT disclosed: a token holder could
    // otherwise probe which usernames/emails already exist by watching
    // 409-vs-401. Both failures answer exactly like an invalid token (same
    // throttling and content-free audit) and leave the token unconsumed for a
    // retry with a free identity.
    if (
      execution.outcome === 'invalid_token' ||
      execution.outcome === 'identity_conflict'
    ) {
      return rejectClaim();
    }

    try {
      await this.authRepo.resetClaimThrottle(
        claimRow.id,
        context.clientIp,
        secret
      );
    } catch {
      // The claim is already committed and the raw recovery codes exist only
      // in this response. A failed counter reset is housekeeping: log it
      // content-free and still deliver the one-time sheet and session
      // (§6.8, §7) rather than failing a request that cannot be retried.
      // eslint-disable-next-line no-console -- no logging seam in bootstrap service; content-free fallback
      console.error('claim throttle reset failed', {
        action: 'claim_token.throttle_reset',
        outcome: 'failure',
      });
    }

    return {
      status: 201,
      token: sessionToken,
      kind,
      body: {
        data: {
          community: {
            id: execution.community.id,
            name: execution.community.name,
            slug: execution.community.slug,
            description: execution.community.description,
            locale: execution.community.locale,
            country: execution.community.country,
            visibility: execution.community.visibility,
            status: 'active',
            createdAt: execution.community.createdAt.toISOString(),
            updatedAt: execution.community.updatedAt.toISOString(),
          },
          user: {
            id: execution.userId,
            email,
            username,
            displayName: displayName ?? null,
            role: 'admin',
            communityId: execution.community.id,
            recoveryCodesConfirmed: true,
          },
          recoveryCodes: {
            codes,
            purpose: 'recovery',
            createdAt: context.now.toISOString(),
          },
        },
      },
    };
  }
}
