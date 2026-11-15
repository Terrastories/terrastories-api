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
  type PreloginResponse,
} from '../shared/prelogin.js';
import {
  ARGON2ID_ALGORITHM,
  DERIVED_KEY_PATTERN,
  RAILS_BCRYPT_ALGORITHM,
  AuthLoginRejected,
  MIN_SALT_BYTES,
  SALT_BASE64_PATTERN,
  argon2idParamsSatisfyPolicy,
  sessionTokenDigestInput,
  type PasswordAlgorithm,
  type SessionKind,
} from '../shared/auth-policy.js';
import { constantTimeEqual, sha256Hex } from '../shared/auth-crypto.js';
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
    // A slug that names no community cannot resolve an account, and consulting
    // a mix for it is impossible; the deployment-wide mix hides it instead.
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
      // A verifier row the client could not use (unsupported algorithm or
      // malformed params) fails closed into the fake path, never into a shape
      // that reveals which check failed (SPEC-V2 §7 "Verifier registry").
      if (params !== null)
        return {
          algorithm: account.passwordAlgorithm as PasswordAlgorithm,
          salt: account.passwordSalt,
          params,
        };
    }
    const mix =
      communityId === null || communityId === undefined
        ? await this.repository.globalAlgorithmMix()
        : await this.repository.communityAlgorithmMix(communityId);
    return deterministicPreloginFake(
      secret,
      normalized,
      input.communitySlug,
      mix
    );
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
    now: Date
  ): Promise<LoginSuccess> {
    const secret = this.serverSecret;
    // Login fails closed without a key exactly as prelogin does, and with the
    // same uniform failure: a deployment that cannot key its throttle must not
    // answer differently from any other rejected credential.
    if (secret === undefined || secret === '') throw new AuthLoginRejected();
    const normalized = normalizeSearchText(input.identifier);
    const communityId =
      input.communitySlug === undefined
        ? undefined
        : await this.repository.communityIdBySlug(input.communitySlug);
    // An unknown slug is a uniform failure, exactly like an unknown identifier.
    if (input.communitySlug !== undefined && communityId === null)
      return this.reject(null, clientIp, now, secret);
    const candidates = await this.repository.loginCandidates(
      input.identifier,
      normalized,
      communityId ?? undefined
    );
    // Never the first match: exactly one row may resolve, and only when it
    // passes the authority gate (§6.2, HonoFoundationRepository).
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate === undefined || !HonoAuthService.allowed(candidate))
      return this.reject(candidate ?? null, clientIp, now, secret);
    const account = candidate as AuthAccount;
    // A throttled account or IP is the same uniform failure (§6.8).
    const [accountBlocked, ipBlocked] = await Promise.all([
      this.repository.throttleState(
        await this.repository.accountThrottleKey(account.id, secret),
        now.getTime()
      ),
      this.repository.throttleState(
        await this.repository.ipThrottleKey(clientIp, secret),
        now.getTime()
      ),
    ]);
    if (accountBlocked.blocked || ipBlocked.blocked)
      return this.reject(account, clientIp, now, secret);
    const verification = await this.verifierFor(account, input);
    if (!verification.ok) return this.reject(account, clientIp, now, secret);
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
    if (!established) return this.reject(account, clientIp, now, secret);
    await this.repository.resetThrottle(account.id, clientIp, secret);
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
      if (!argon2idParamsSatisfyPolicy(upgrade.params)) return { ok: false };
      if (!HonoAuthService.usableSalt(upgrade.salt)) return { ok: false };
      if (!DERIVED_KEY_PATTERN.test(upgrade.derivedKey)) return { ok: false };
      const { memoryKiB, iterations, parallelism } = upgrade.params as Record<
        string,
        number
      >;
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

  /** A stored salt must be decodable base64 of at least 128 bits (§7 step 2). */
  private static usableSalt(salt: string): boolean {
    if (!SALT_BASE64_PATTERN.test(salt)) return false;
    const padding = salt.endsWith('==') ? 2 : salt.endsWith('=') ? 1 : 0;
    // floor(length * 3 / 4) - padding, without accepting atob's leniency.
    const bytes = Math.floor((salt.length * 3) / 4) - padding;
    return bytes >= MIN_SALT_BYTES;
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

  /** Record one rejected attempt and raise the uniform failure. */
  private async reject(
    account: AuthAccount | null,
    clientIp: string,
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
    throw new AuthLoginRejected();
  }
}
