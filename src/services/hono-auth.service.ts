/**
 * Client-stretching authentication orchestration (SPEC-V2 §6.2, §6.8, §7).
 *
 * The browser stretches the password; the server only hashes and compares.
 * Prelogin is the only step that answers before any credential is presented,
 * so it must never become an existence oracle: a real account and a fake are
 * the same `{algorithm, salt, params}` shape, and the fake is deterministic
 * per `HMAC(serverSecret, normalized identifier [+ slug])`.
 *
 * Login is the other half: resolve the account without ever taking the first
 * of several matches, verify the presented key in constant time, answer every
 * rejection with one identical failure, and feed the durable `AuthThrottle`
 * counters — per account and per IP in one database round trip.
 */
import type {
  AuthAccount,
  HonoAuthRepository,
  VerifierWrite,
} from '../repositories/hono-auth.repository.js';
import type {
  FoundationUser,
  HonoFoundationRepository,
} from '../repositories/hono-foundation.repository.js';
import {
  deterministicPreloginFake,
  parseStoredPasswordParams,
  type PreloginParams,
  type PreloginResponse,
} from '../shared/prelogin.js';
import {
  ARGON2ID_ALGORITHM,
  DERIVED_KEY_PATTERN,
  RAILS_BCRYPT_ALGORITHM,
  AuthLoginRejected,
  isCanonicalArgon2idParams,
  isCanonicalBcryptCost,
  isCanonicalBcryptSalt,
  isCanonicalVerifierSalt,
  sessionTokenDigestInput,
  type PasswordAlgorithm,
  type SessionKind,
} from '../shared/auth-policy.js';
import { constantTimeEqual, sha256Hex } from '../shared/auth-crypto.js';
import { writeAuditEntry } from '../repositories/audit-entry.repository.js';
import { normalizeSearchText } from '../shared/utils/search-normalize.js';
import { parseV2Role } from '../shared/authorization/sovereignty-policy.js';

export interface PreloginInput {
  identifier: string;
  communitySlug?: string | undefined;
}

/**
 * A login request after the route has validated its wire shape.
 *
 * `upgrade` carries the client-generated Argon2id material for a wrapped
 * Rails-bcrypt login (§7 step 4); its `derivedKey` is the Argon2id key the
 * client computed with that salt and params, and it is what becomes the new
 * verifier — never the bcrypt-string `derivedKey` of the login itself.
 */
export interface LoginInput {
  identifier: string;
  communitySlug?: string | undefined;
  derivedKey: string;
  /** Present only on a wrapped Rails-bcrypt login that upgrades (§7 step 4). */
  upgrade?:
    | { algorithm: string; salt: string; params: unknown; derivedKey: string }
    | undefined;
  deviceSession?: boolean | undefined;
  /** The presented `ts_session` cookie value, for same-user rotation (#188). */
  previousToken?: string | undefined;
}

export interface LoginSuccess {
  token: string;
  user: FoundationUser;
  kind: SessionKind;
}

export class HonoAuthService {
  /**
   * `serverSecret` is the prelogin HMAC key (`AUTH_SERVER_SECRET`). It is
   * optional only so the app can be built without it; `prelogin` then fails
   * closed instead of emitting a fake keyed with a predictable value.
   *
   * `foundation` is the foundation repository that owns the authority-gated
   * session write (`createSession`); logins rotate/create session rows
   * through it rather than reimplementing the INSERT…SELECT gate.
   */
  constructor(
    readonly repository: HonoAuthRepository,
    readonly foundation: HonoFoundationRepository,
    readonly serverSecret: string | undefined
  ) {}

  /**
   * Verifier shape for `identifier` (+ optional `communitySlug` locator), or
   * `null` when the server secret is missing and the request must fail closed.
   *
   * An unknown slug, an unknown identifier and an ambiguous email all take the
   * fake path with the same shape and status, so neither accounts nor
   * communities can be enumerated through prelogin (SPEC-V2 §6.2, §7).
   */
  async prelogin(input: PreloginInput): Promise<PreloginResponse | null> {
    const secret = this.serverSecret;
    if (secret === undefined || secret === '') return null;
    const normalized = normalizeSearchText(input.identifier);
    const communityId =
      input.communitySlug === undefined
        ? undefined
        : await this.repository.communityIdBySlug(input.communitySlug);
    // A slug that names no community cannot resolve an account; the fake path
    // answers instead, exactly as for an unknown identifier.
    const account =
      input.communitySlug !== undefined && communityId === null
        ? null
        : await this.repository.preloginAccount(
            normalized,
            communityId ?? undefined
          );
    if (account !== null) {
      const params = parseStoredPasswordParams(
        account.passwordAlgorithm,
        account.passwordParams
      );
      // A verifier row the client could not use, or one whose shape is not the
      // canonical one every V2 write produces, fails closed into the fake path.
      // Canonicalising the stored shape is what keeps a real row and a fake
      // indistinguishable — a legacy salt length or cost would otherwise be an
      // existence oracle (SPEC-V2 §7 "Verifier registry", findings 4–5).
      if (params !== null && HonoAuthService.isCanonicalShape(account, params))
        return {
          algorithm: account.passwordAlgorithm as PasswordAlgorithm,
          salt: account.passwordSalt as string,
          params,
        };
    }
    // The fake's mix is the deployment-wide one and the fake itself is keyed
    // only by the normalized identifier: no request-controlled value (least of
    // all the community slug) may shift it, or a real slug could be told from
    // a fake one and private/disabled communities enumerated (finding 5).
    return deterministicPreloginFake(
      secret,
      normalized,
      await this.repository.globalAlgorithmMix()
    );
  }

  /**
   * Whether a stored verifier row carries the canonical shape the fake mirrors
   * (SPEC-V2 §7 step 1): the one Argon2id salt length and params, or the
   * 22-character bcrypt salt with a cost a Rails row actually carries.
   */
  private static isCanonicalShape(
    account: { passwordAlgorithm: string; passwordSalt: string },
    params: PreloginParams
  ): boolean {
    if (account.passwordAlgorithm === ARGON2ID_ALGORITHM)
      return (
        isCanonicalVerifierSalt(account.passwordSalt) &&
        isCanonicalArgon2idParams(params)
      );
    if (account.passwordAlgorithm === RAILS_BCRYPT_ALGORITHM)
      return (
        isCanonicalBcryptSalt(account.passwordSalt) &&
        isCanonicalBcryptCost((params as { cost: number }).cost)
      );
    return false;
  }

  /**
   * Content-free audit entry for an auth/security event (SPEC-V2 §6.8,
   * §7 "Audit logging"). IP/UA are permitted only on auth events. A failed
   * audit write is logged content-free and never changes the auth decision —
   * the uniform 401 contract and the session-establishment path must hold
   * regardless of the audit sink.
   */
  async auditAuthEvent(input: {
    communityId: number | null;
    actorId: number | null;
    action: string;
    outcome: 'success' | 'failure';
    resourceType?: string;
    resourceIds?: Array<number | string>;
    ipAddress: string | null;
    userAgent: string | undefined;
  }): Promise<void> {
    try {
      await writeAuditEntry(this.repository.connection, {
        communityId: input.communityId,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType ?? 'auth',
        resourceIds: input.resourceIds ?? [],
        outcome: input.outcome,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
      });
    } catch {
      // Content-free operational marker: the action and outcome only, never
      // identifiers, keys or content. The audit sink failing must never
      // change the authentication decision.
      // eslint-disable-next-line no-console -- the auth service has no logging seam; this is the content-free fallback
      console.error('auth audit write failed', {
        action: input.action,
        outcome: input.outcome,
      });
    }
  }

  /**
   * Authenticate one login attempt (§7 steps 3–4, step 6).
   *
   * Every rejection raises {@link AuthLoginRejected} — the same failure for an
   * unknown slug, an unknown identifier, an ambiguous email, a wrong key and a
   * throttled attempt — and the route renders that as one `401` body. A
   * rejected attempt also feeds the per-IP counter and, when the identifier
   * resolved to exactly one account, that account's counter.
   *
   * A successful attempt resets both counters, writes the verifier when the
   * account upgrades, and establishes the session.
   */
  async login(
    input: LoginInput,
    clientIp: string,
    now: Date,
    userAgent?: string | undefined
  ): Promise<LoginSuccess> {
    const secret = this.serverSecret;
    // Login fails closed without a key exactly as prelogin does, and with the
    // same uniform failure: a deployment that cannot key its throttle must not
    // answer differently from any other rejected credential.
    if (secret === undefined || secret === '') throw new AuthLoginRejected();
    // The per-IP brake is read *before* any resolution: an unresolved guess
    // costs the server almost nothing, so the attacker's own per-IP backoff is
    // the only bound on identifier guessing (SPEC-V2 §6.8, §7 step 6). Reading
    // it here — not only on the resolved path — is what makes that bound real
    // (finding 2).
    const ipBlocked = await this.repository.throttleState(
      await this.repository.ipThrottleKey(clientIp, secret),
      now.getTime()
    );
    if (ipBlocked.blocked)
      // Unresolved on purpose: no account is known yet, so only the per-IP row
      // is written (row accounting stays ≤2 rows, 1 when unresolved).
      return this.reject(null, clientIp, userAgent, now, secret);
    const normalized = normalizeSearchText(input.identifier);
    const communityId =
      input.communitySlug === undefined
        ? undefined
        : await this.repository.communityIdBySlug(input.communitySlug);
    // An unknown slug is a uniform failure, exactly like an unknown identifier.
    if (input.communitySlug !== undefined && communityId === null)
      return this.reject(null, clientIp, userAgent, now, secret);
    const candidates = await this.repository.loginCandidates(
      input.identifier,
      normalized,
      communityId ?? undefined
    );
    // Never the first match: exactly one row may resolve, and only when it
    // passes the authority gate (§6.2, HonoFoundationRepository).
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate === undefined || !HonoAuthService.allowed(candidate))
      return this.reject(candidate ?? null, clientIp, userAgent, now, secret);
    const account = candidate as AuthAccount;
    // The per-account counter is read only once exactly one account resolved:
    // an unresolved attempt must not write (or read) an account row.
    const accountBlocked = await this.repository.throttleState(
      await this.repository.accountThrottleKey(account.id, secret),
      now.getTime()
    );
    if (accountBlocked.blocked)
      return this.reject(account, clientIp, userAgent, now, secret);
    const verification = await this.verifierFor(account, input);
    if (!verification.ok)
      return this.reject(account, clientIp, userAgent, now, secret);
    const kind: SessionKind =
      input.deviceSession === true ? 'device' : 'standard';
    const user = HonoAuthService.userOf(account);
    const established = await this.repository.establishLogin({
      repository: this.foundation,
      account,
      user,
      verifier: verification.write,
      kind,
      now,
      previousToken: sessionTokenDigestInput(input.previousToken) ?? undefined,
    });
    // The authority gate lost the race (a concurrent reset/disable changed the
    // row between the read and the write): a uniform failure and no session.
    if (!established)
      return this.reject(account, clientIp, userAgent, now, secret);
    await this.repository.resetThrottle(account.id, clientIp, secret);
    await this.auditAuthEvent({
      communityId: account.communityId,
      actorId: account.id,
      action: 'auth.login',
      outcome: 'success',
      resourceIds: [account.id],
      ipAddress: clientIp,
      userAgent,
    });
    if (verification.write !== null)
      // A wrapped Rails-bcrypt verifier was replaced by the Argon2id
      // material in the same atomic write (§7 step 4).
      await this.auditAuthEvent({
        communityId: account.communityId,
        actorId: account.id,
        action: 'auth.upgrade',
        outcome: 'success',
        resourceIds: [account.id],
        ipAddress: clientIp,
        userAgent,
      });
    return { token: established.token, user, kind };
  }

  /**
   * The verifier columns this login must store, and whether it may proceed.
   *
   * `ok: false` rejects the attempt — a wrong key, a missing or below-policy
   * upgrade, an unsupported or malformed stored verifier row (§7 steps 3–4,
   * "Verifier registry"). `write: null` is a plain Argon2id login that stores
   * nothing: the session write is authority-gated on its own, and a no-op
   * re-write would only spend a D1 row write. A wrapped bcrypt login stores
   * the upgraded material in the same atomic flow that establishes the
   * session (§7 step 4); a rejected upgrade leaves the bcrypt row unchanged
   * and fails the login with the uniform failure.
   *
   * Wrapped accounts require the `upgrade` in the same request — the client
   * always sends it (§7 step 4), so every migrated login converges onto the
   * Argon2id verifier instead of stranding the account on the wrapper.
   */
  private async verifierFor(
    account: AuthAccount,
    input: LoginInput
  ): Promise<{ ok: true; write: VerifierWrite | null } | { ok: false }> {
    const digest = await sha256Hex(input.derivedKey);
    const stored = account.passwordVerifier;
    if (stored === null) return { ok: false };
    const algorithm = account.passwordAlgorithm;
    if (algorithm === ARGON2ID_ALGORITHM) {
      if (!constantTimeEqual(digest, stored)) return { ok: false };
      return { ok: true, write: null };
    }
    if (algorithm === RAILS_BCRYPT_ALGORITHM) {
      // The stored verifier is SHA-256 of the Rails bcrypt hash string, and the
      // client sends that same string as `derivedKey` (§7 step 4).
      if (!constantTimeEqual(digest, stored)) return { ok: false };
      // A migrated account must upgrade in this same request; the upgrade must
      // be present, Argon2id, at or above the policy, and carry a usable salt.
      const upgrade = input.upgrade;
      if (upgrade === undefined) return { ok: false };
      if (upgrade.algorithm !== ARGON2ID_ALGORITHM) return { ok: false };
      // The upgraded material must be the one canonical shape every V2 write
      // produces (16-byte salt, named policy params); anything weaker — or any
      // other shape — is refused without revealing the policy (findings 4–5).
      if (!isCanonicalArgon2idParams(upgrade.params)) return { ok: false };
      if (!isCanonicalVerifierSalt(upgrade.salt)) return { ok: false };
      if (!DERIVED_KEY_PATTERN.test(upgrade.derivedKey)) return { ok: false };
      const { memoryKiB, iterations, parallelism } = upgrade.params;
      return {
        ok: true,
        write: {
          passwordHash: account.passwordHash,
          // The upgraded verifier is SHA-256 of the Argon2id-derived key the
          // client computed with the returned salt and params (§7 step 4) —
          // never the bcrypt-string `derivedKey` of the login itself.
          passwordVerifier: await sha256Hex(upgrade.derivedKey),
          passwordAlgorithm: ARGON2ID_ALGORITHM,
          passwordSalt: upgrade.salt,
          passwordParams: JSON.stringify({
            memoryKiB,
            iterations,
            parallelism,
          }),
        },
      };
    }
    // Unsupported, malformed or tampered verifier row: fail closed without
    // revealing which check failed (§7 "Verifier registry").
    return { ok: false };
  }

  /**
   * The authority gate a login candidate must still pass (§6.2, §7): an active
   * canonical-V2 account whose community is active, or an own-community
   * administrator of a disabled community, or a null-community `super_admin`.
   */
  private static allowed(account: AuthAccount): boolean {
    if (!account.isActive) return false;
    if (!parseV2Role(account.role)) return false;
    if (account.communityId === null) return account.role === 'super_admin';
    if (account.communityIsActive === true) return true;
    return account.communityIsActive === false && account.role === 'admin';
  }

  private static userOf(account: AuthAccount): FoundationUser {
    const role = parseV2Role(account.role);
    if (role === null) throw new AuthLoginRejected();
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

  /**
   * Record one rejected attempt and raise the uniform failure. */
  private async reject(
    account: AuthAccount | null,
    clientIp: string,
    userAgent: string | undefined,
    now: Date,
    secret: string
  ): Promise<never> {
    await this.repository.recordLoginFailure(
      {
        account:
          account === null
            ? null
            : { id: account.id, communityId: account.communityId },
        clientIp,
        now: now.getTime(),
      },
      secret
    );
    await this.auditAuthEvent({
      communityId: account?.communityId ?? null,
      actorId: account?.id ?? null,
      action: 'auth.login',
      outcome: 'failure',
      resourceIds: account === null ? [] : [account.id],
      ipAddress: clientIp,
      userAgent,
    });
    throw new AuthLoginRejected();
  }

  /**
   * Change the account's password (`POST /v2/auth/password`, §7 step 4 and
   * "Verifier registry"). Verifies the presented key against the stored
   * verifier, then writes the new material atomically in the same guarded
   * flow that establishes a fresh session: the verifier change fires the
   * revocation trigger, so the account's other sessions die first and the
   * fresh one survives — one row per device afterwards.
   *
   * Throws {@link AuthLoginRejected} for any rejected attempt (wrong key, a
   * malformed stored verifier row, a code-only account). Returns `null`
   * when the write loses the authority race — a concurrent reset changed the
   * row between the read and the write — so the route can answer 409.
   */
  async changePassword(
    input: {
      user: FoundationUser;
      currentDerivedKey: string;
      derivedKey: string;
      salt: string;
      params: unknown;
    },
    kind: SessionKind,
    presentedToken: string | undefined,
    clientIp: string,
    now: Date,
    userAgent?: string | undefined
  ): Promise<{ token: string } | null> {
    const user = input.user;
    const account = await this.repository.accountById(user.id);
    if (account === null) {
      await this.auditAuthEvent({
        communityId: null,
        actorId: null,
        action: 'auth.password.change',
        outcome: 'failure',
        ipAddress: clientIp,
        userAgent,
      });
      return null;
    }
    const secret = this.serverSecret;
    // Any rejected attempt is the same uniform failure, and it is audited
    // (SPEC-V2 §7 "failed verification").
    const rejectChange = async (): Promise<never> => {
      await this.auditAuthEvent({
        communityId: account.communityId,
        actorId: account.id,
        action: 'auth.password.change',
        outcome: 'failure',
        resourceIds: [account.id],
        ipAddress: clientIp,
        userAgent,
      });
      throw new AuthLoginRejected();
    };
    const digest = await sha256Hex(input.currentDerivedKey);
    const stored = account.passwordVerifier;
    if (stored === null) return rejectChange();
    if (
      account.passwordAlgorithm !== ARGON2ID_ALGORITHM &&
      account.passwordAlgorithm !== RAILS_BCRYPT_ALGORITHM
    )
      return rejectChange();
    if (!constantTimeEqual(digest, stored)) return rejectChange();
    // New material must be the one canonical Argon2id shape every V2 write
    // produces (16-byte salt, named policy params); anything weaker — or any
    // other shape — is refused without revealing the policy.
    if (!isCanonicalArgon2idParams(input.params)) return rejectChange();
    if (!isCanonicalVerifierSalt(input.salt)) return rejectChange();
    const { memoryKiB, iterations, parallelism } = input.params;
    const write: VerifierWrite = {
      passwordHash: account.passwordHash,
      passwordVerifier: await sha256Hex(input.derivedKey),
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: input.salt,
      passwordParams: JSON.stringify({ memoryKiB, iterations, parallelism }),
    };
    const established = await this.repository.establishLogin({
      repository: this.foundation,
      account,
      user,
      verifier: write,
      kind,
      now,
      previousToken: sessionTokenDigestInput(presentedToken) ?? undefined,
    });
    // The authority gate lost the race (a concurrent reset changed the row):
    // the new verifier is not stored and no session is issued. Audited as a
    // rejected attempt; it reveals nothing beyond the rejection itself.
    if (!established) {
      await this.auditAuthEvent({
        communityId: account.communityId,
        actorId: account.id,
        action: 'auth.password.change',
        outcome: 'failure',
        resourceIds: [account.id],
        ipAddress: clientIp,
        userAgent,
      });
      return null;
    }
    if (secret !== undefined && secret !== '')
      await this.repository.resetThrottle(account.id, clientIp, secret);
    await this.auditAuthEvent({
      communityId: account.communityId,
      actorId: account.id,
      action: 'auth.password.change',
      outcome: 'success',
      resourceIds: [account.id],
      ipAddress: clientIp,
      userAgent,
    });
    return { token: established.token };
  }
}
