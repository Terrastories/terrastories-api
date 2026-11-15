/**
 * Prelogin fakes for the client-stretching auth protocol (SPEC-V2 §7 step 1).
 *
 * An identifier that resolves to no single account must answer with the same
 * `{algorithm, salt, params}` shape a real account returns, so the response is
 * never an existence oracle. The fake is deterministic per
 * `HMAC(serverSecret, normalizedIdentifier [+ communitySlug])`, and its
 * algorithm follows the community's migrated-vs-upgraded mix so a population
 * of fakes mirrors the population of real accounts.
 */
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  BCRYPT_MAX_COST,
  BCRYPT_MIN_COST,
  MIN_SALT_BYTES,
  RAILS_BCRYPT_ALGORITHM,
  type Argon2idParams,
  type PasswordAlgorithm,
} from './auth-policy.js';
import { fromHex, hmacSha256Hex, readUint32, toBase64 } from './auth-crypto.js';

/** The bcrypt base64 alphabet, byte-exact with Rails/bcrypt. */
const BCRYPT_ALPHABET =
  './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export type PreloginParams = Argon2idParams | { cost: number };

export interface PreloginResponse {
  algorithm: PasswordAlgorithm;
  salt: string;
  params: PreloginParams;
}

/** 22-character bcrypt salt string (the shape a Rails row carries). */
function bcryptSalt(digest: Uint8Array): string {
  let salt = '';
  for (let index = 0; index < 22; index += 1) {
    salt += BCRYPT_ALPHABET[(digest[index % digest.length] ?? 0) % 64];
  }
  return salt;
}

/**
 * Deterministic fake. `mix` is the community's (or, with no community, the
 * deployment's) upgraded/total account ratio; `total === 0` means the new
 * password mix. The identifier is already normalized by the caller.
 */
export async function deterministicPreloginFake(
  serverSecret: string,
  normalizedIdentifier: string,
  communitySlug: string | undefined,
  mix: { upgraded: number; total: number }
): Promise<PreloginResponse> {
  const digestHex = await hmacSha256Hex(
    serverSecret,
    `prelogin:${communitySlug ?? ''}:${normalizedIdentifier}`
  );
  const digest = fromHex(digestHex);
  const bucket = readUint32(digest, 0) % 1000;
  const upgradedShare =
    mix.total === 0 ? 1000 : Math.round((mix.upgraded * 1000) / mix.total);
  if (bucket < upgradedShare) {
    return {
      algorithm: ARGON2ID_ALGORITHM,
      salt: toBase64(digest.slice(4, 4 + MIN_SALT_BYTES)),
      params: {
        memoryKiB: ARGON2ID_PARAMS.memoryKiB,
        iterations: ARGON2ID_PARAMS.iterations,
        parallelism: ARGON2ID_PARAMS.parallelism,
      },
    };
  }
  // Cost 10 or 12 both occur in Rails rows; the fake stays inside that range.
  const cost = BCRYPT_MIN_COST + ((digest[4] ?? 0) % 3);
  return {
    algorithm: RAILS_BCRYPT_ALGORITHM,
    salt: bcryptSalt(digest.slice(5)),
    params: { cost: Math.min(cost, BCRYPT_MAX_COST) },
  };
}

/**
 * Parse a stored `passwordParams` JSON string into the wire shape. Returns
 * `null` for an unsupported algorithm or malformed values, so the caller can
 * fall back to the fake instead of presenting a shape the client cannot use.
 */
export function parseStoredPasswordParams(
  algorithm: string | null,
  raw: string | null
): PreloginParams | null {
  if (algorithm !== ARGON2ID_ALGORITHM && algorithm !== RAILS_BCRYPT_ALGORITHM)
    return null;
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (algorithm === ARGON2ID_ALGORITHM) {
    const { memoryKiB, iterations, parallelism } = parsed as Record<
      string,
      unknown
    >;
    if (
      typeof memoryKiB !== 'number' ||
      typeof iterations !== 'number' ||
      typeof parallelism !== 'number'
    )
      return null;
    return { memoryKiB, iterations, parallelism };
  }
  const { cost } = parsed as Record<string, unknown>;
  if (
    typeof cost !== 'number' ||
    !Number.isInteger(cost) ||
    cost < BCRYPT_MIN_COST ||
    cost > BCRYPT_MAX_COST
  )
    return null;
  return { cost };
}
