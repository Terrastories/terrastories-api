/**
 * Client-stretching authentication orchestration (SPEC-V2 §7 "Passwords").
 *
 * The browser stretches the password; the server never runs a KDF. Prelogin is
 * the only step that answers before any credential is presented, so it must
 * never become an existence oracle: a real account and a fake are the same
 * `{algorithm, salt, params}` shape, and the fake is deterministic per
 * `HMAC(serverSecret, identifier)`.
 */
import type { HonoAuthRepository } from '../repositories/hono-auth.repository.js';
import {
  deterministicPreloginFake,
  parseStoredPasswordParams,
  type PreloginResponse,
} from '../shared/prelogin.js';
import type { PasswordAlgorithm } from '../shared/auth-policy.js';
import { normalizeSearchText } from '../shared/utils/search-normalize.js';

export interface PreloginInput {
  identifier: string;
  communitySlug?: string | undefined;
}

export class HonoAuthService {
  /**
   * `serverSecret` is the prelogin HMAC key (`AUTH_SERVER_SECRET`). It is
   * optional only so the app can be built without it; `prelogin` then fails
   * closed instead of emitting a fake keyed with a predictable value.
   */
  constructor(
    readonly repository: HonoAuthRepository,
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
}
