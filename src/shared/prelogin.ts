/**
 * Prelogin fakes for the client-stretching auth protocol (SPEC-V2 §7 step 1).
 *
 * An identifier that resolves to no single account must answer with the same
 * `{algorithm, salt, params}` shape a real account returns, so the response is
 * never an existence oracle. The fake is deterministic per
 * `HMAC(serverSecret, normalizedIdentifier)` and its algorithm follows the
 * deployment-wide migrated-vs-upgraded mix.
 *
 * The fake is a function of the identifier alone: the request's
 * `communitySlug` is deliberately not an input. A slug that names no
 * community (or an account that is not there) must not be able to shift the
 * answer into a community-specific mix, which would enumerate private or
 * disabled community slugs (finding 5). The mix is the deployment-wide one for
 * the same reason.
 */
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  BCRYPT_MAX_COST,
  BCRYPT_RAILS_COSTS,
  MIN_SALT_BYTES,
  RAILS_BCRYPT_ALGORITHM,
  isStoredBcryptCost,
  type Argon2idParams,
  type PasswordAlgorithm,
} from './auth-policy.js';
import { fromHex, hmacSha256Hex, readUint32, toBase64 } from './auth-crypto.js';

export type PreloginParams = Argon2idParams | { cost: number };

export interface PreloginResponse {
  algorithm: PasswordAlgorithm;
  salt: string;
  params: PreloginParams;
}

/** The bcrypt base64 alphabet, byte-exact with Rails/bcrypt. */
const BCRYPT_ALPHABET =
  './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The only 22nd characters a real bcrypt salt can end with (`.Oeu`). */
const BCRYPT_SALT_LAST = BCRYPT_ALPHABET.split('')
  .filter((_, index) => index % 16 === 0)
  .join('');

/**
 * 22-character bcrypt salt string, byte-shaped like a Rails row: the first 21
 * characters use the full bcrypt alphabet, and the 22nd is one of `.Oeu`
 * because bcrypt's base64 only emits 4 meaningful bits there (finding C).
 */
function bcryptSalt(bytes: Uint8Array): string {
  let salt = '';
  for (let index = 0; index < 21; index += 1) {
    salt += BCRYPT_ALPHABET[(bytes[index] ?? 0) % 64];
  }
  const last = BCRYPT_SALT_LAST[(bytes[21] ?? 0) % BCRYPT_SALT_LAST.length];
  return salt + last!;
}

/**
 * Expand a SHA-256-based counter-mode key stream deterministically. Used for
 * the fake salt: the digest is HMAC output (32 bytes), not enough for salts
 * up to 64 bytes, so the stream extends it byte-for-byte.
 */
const streamEncoder = new TextEncoder();
async function keyStream(seed: string, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  for (let counter = 0; offset < length; counter += 1) {
    const block = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        streamEncoder.encode(`${seed}:${counter}`)
      )
    );
    for (let index = 0; index < block.length && offset < length; index += 1) {
      out[offset] = block[index]!;
      offset += 1;
    }
  }
  return out;
}

export type WeightedBcryptCost = { cost: number; count: number };
export type WeightedArgon2Params = Argon2idParams & { count: number };

/** The deployment-wide prelogin population (unweighted identifier mix). */
export interface PreloginMix {
  upgraded: number;
  total: number;
  /** Observed distinct migrated costs, sorted ascending (display/test view). */
  costs?: readonly number[] | undefined;
  /** Observed cost weights, so the fake draws in proportion to the real population. */
  costCounts?: ReadonlyArray<WeightedBcryptCost> | undefined;
  /** Observed Argon2id parameter combos with their weights. */
  params?: ReadonlyArray<WeightedArgon2Params> | undefined;
  /** Observed Argon2id salt byte lengths with their weights. */
  saltLengths?: ReadonlyArray<WeightedSaltLength> | undefined;
}

/** A weighted salt byte length from the stored population. */
export type WeightedSaltLength = { length: number; count: number };

/** Deterministic weighted pick by digest bytes, `weights` must be non-empty. */
function deterministicPick<T extends { count: number }>(
  digest: Uint8Array,
  offset: number,
  weights: ReadonlyArray<T>
): T {
  const total = weights.reduce((sum, weight) => sum + weight.count, 0);
  if (total <= 0) return weights[0]!;
  let point = readUint32(digest, offset) % total;
  for (const weight of weights) {
    if (point < weight.count) return weight;
    point -= weight.count;
  }
  return weights[weights.length - 1]!;
}

/**
 * Deterministic fake. `mix` is the deployment-wide upgraded/total account
 * ratio; `total === 0` means the new-password mix. Both branches draw from
 * the observed population distribution — the Argon2id params combos and the
 * migrated bcrypt costs, in proportion to their observed counts — so a fake
 * is indistinguishable from a real row in shape *and* frequency. The
 * identifier is already normalized by the caller, and nothing the request
 * controls beyond it (in particular no `communitySlug`) enters the digest.
 */
export async function deterministicPreloginFake(
  serverSecret: string,
  normalizedIdentifier: string,
  mix: PreloginMix,
  bcryptCosts: readonly number[] = BCRYPT_RAILS_COSTS
): Promise<PreloginResponse> {
  const digestHex = await hmacSha256Hex(
    serverSecret,
    `prelogin:${normalizedIdentifier}`
  );
  const digest = fromHex(digestHex);
  const bucket = readUint32(digest, 0) % 1000;
  const upgradedShare =
    mix.total === 0 ? 1000 : Math.round((mix.upgraded * 1000) / mix.total);
  if (bucket < upgradedShare) {
    const paramWeights: ReadonlyArray<WeightedArgon2Params> =
      mix.params && mix.params.length > 0
        ? mix.params
        : [{ ...ARGON2ID_PARAMS, count: 1 }];
    // Params pick at digest bytes 24..27: free of the salt (4..19), so the
    // params draw is independent of the salt bytes (item 4).
    const picked = deterministicPick(digest, 24, paramWeights);
    const saltLenWeights: ReadonlyArray<WeightedSaltLength> =
      mix.saltLengths && mix.saltLengths.length > 0
        ? mix.saltLengths
        : [{ length: MIN_SALT_BYTES, count: 1 }];
    // Bytes 28..31: free of the Argon2id salt (4..19) and the params pick
    // (24..27). The salt bytes come from their own counter-mode stream off
    // the HMAC digest, so the fake salt can match any stored length.
    const saltLength = deterministicPick(digest, 28, saltLenWeights).length;
    const saltBytes = await keyStream(digestHex, saltLength);
    return {
      algorithm: ARGON2ID_ALGORITHM,
      salt: toBase64(saltBytes),
      params: {
        memoryKiB: picked.memoryKiB,
        iterations: picked.iterations,
        parallelism: picked.parallelism,
      },
    };
  }
  // Prefer the deployment's actual cost distribution, weighted by migrated
  // frequency; fall back to the equal Rails 10/12 set when no migrated row
  // exists yet. The pick is deterministic per digest.
  const costWeights: ReadonlyArray<WeightedBcryptCost> =
    mix.costCounts && mix.costCounts.length > 0
      ? mix.costCounts
      : (bcryptCosts.length > 0 ? bcryptCosts : BCRYPT_RAILS_COSTS).map(
          (cost) => ({ cost, count: 1 })
        );
  const cost = deterministicPick(digest, 24, costWeights).cost;
  // The bcrypt salt is a salt, not a derived tag: draw it from the same
  // counter-mode key stream the Argon2id fake uses, so no digest byte is
  // shared with the cost pick at bytes 24..27 (item 3).
  const saltBytes = await keyStream(digestHex, 22);
  return {
    algorithm: RAILS_BCRYPT_ALGORITHM,
    salt: bcryptSalt(saltBytes),
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
  // Existing Rails rows keep whatever cost they were written with (4..14).
  if (
    typeof cost !== 'number' ||
    !Number.isInteger(cost) ||
    !isStoredBcryptCost(cost)
  )
    return null;
  return { cost };
}
