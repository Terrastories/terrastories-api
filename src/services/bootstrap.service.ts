/**
 * Installation bootstrap orchestration (Slice 11b-B, #188; SPEC-V2 §4, §6.8,
 * §7 "Bootstrap and account lifecycle"; route registry §1).
 */
import type { BootstrapRepository } from '../repositories/bootstrap.repository.js';
import type {
  HonoAuthRepository,
  VerifierWrite,
} from '../repositories/hono-auth.repository.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import {
  ARGON2ID_ALGORITHM,
  RECOVERY_CODE_COUNT,
  isCanonicalArgon2idParams,
  isCanonicalVerifierSalt,
  sessionLifetimesFor,
  type SessionKind,
} from '../shared/auth-policy.js';
import { sha256Hex, toHex } from '../shared/auth-crypto.js';
import {
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
      status: 400 | 403;
      body: V2ErrorResponse | V2ValidationErrorResponse;
    };

const PASSWORD_REQUIREMENTS_BODY: V2ErrorResponse = Object.freeze({
  error: 'Password does not meet requirements',
});

/** Derive a deterministic URL-safe slug when `community.slug` is omitted. */
export function deriveBootstrapSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base.length > 0 ? base : 'community';
}

export class BootstrapService {
  private readonly fieldKitCaFingerprint?: string;

  constructor(
    private readonly bootstrapRepo: BootstrapRepository,
    private readonly authRepo: HonoAuthRepository,
    options: {
      serverSecret?: string;
      fieldKitCaFingerprint?: string;
    } = {}
  ) {
    const trimmed = options.fieldKitCaFingerprint?.trim();
    this.fieldKitCaFingerprint =
      trimmed && trimmed.length > 0 ? trimmed : undefined;
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
    const open = await this.bootstrapRepo.isBootstrapOpen();
    if (!open) {
      await this.auditFailure({
        communityId: null,
        action: 'bootstrap.complete',
        resourceType: 'bootstrap',
        resourceIds: [],
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });
      return { status: 403, body: FORBIDDEN_BODY };
    }

    const parsed = BootstrapRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
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
      await this.auditFailure({
        communityId: null,
        action: 'bootstrap.complete',
        resourceType: 'bootstrap',
        resourceIds: [],
        clientIp: context.clientIp,
        userAgent: context.userAgent,
      });
      return { status: 403, body: FORBIDDEN_BODY };
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
}
