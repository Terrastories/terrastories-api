/**
 * Client-side password stretching for the walkthrough, exactly as the browser
 * would do it (SPEC-V2 section 7). The server never sees a password: it
 * receives a derived key. Passwords and keys live in memory only.
 */
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import bcrypt from 'bcrypt';

export const ARGON2ID_ALGORITHM = 'client-argon2id+sha256';
export const RAILS_BCRYPT_ALGORITHM = 'client-bcrypt-rails+sha256';
export const POLICY_PARAMS = Object.freeze({
  memoryKiB: 19 * 1024,
  iterations: 2,
  parallelism: 1,
});

export interface PreloginAnswer {
  algorithm: string;
  salt: string;
  params: Record<string, unknown>;
}

export interface Verifier {
  algorithm: typeof ARGON2ID_ALGORITHM;
  salt: string;
  params: { memoryKiB: number; iterations: number; parallelism: number };
  derivedKey: string;
}

/** Argon2id(password, salt, params) as a 64-hex derived key. */
export async function argonDerivedKey(
  password: string,
  saltBase64: string,
  params: Record<string, unknown>
): Promise<string> {
  const raw = await argon2.hash(password, {
    raw: true,
    type: argon2.argon2id,
    salt: Buffer.from(saltBase64, 'base64'),
    memoryCost: Number(params.memoryKiB),
    timeCost: Number(params.iterations),
    parallelism: Number(params.parallelism),
    hashLength: 32,
  });
  return raw.toString('hex');
}

/** Rails has_secure_password hash, recomputed with the stored salt and cost. */
export async function railsBcryptKey(
  password: string,
  salt22: string,
  cost: number
): Promise<string> {
  // Byte-exact with Rails: bcrypt only reads the first 72 bytes.
  const bytes = Buffer.from(password, 'utf8').subarray(0, 72);
  const prefix = `$2a$${String(cost).padStart(2, '0')}$${salt22}`;
  return bcrypt.hash(bytes, prefix);
}

/** A fresh Argon2id verifier for a new password (enrolment, change, claim). */
export async function newVerifier(password: string): Promise<Verifier> {
  const salt = randomBytes(16).toString('base64');
  const params = { ...POLICY_PARAMS };
  return {
    algorithm: ARGON2ID_ALGORITHM,
    salt,
    params,
    derivedKey: await argonDerivedKey(password, salt, params),
  };
}

/** What the login form submits for this prelogin answer. */
export async function loginMaterial(
  password: string,
  answer: PreloginAnswer
): Promise<{ derivedKey: string; upgrade?: Verifier }> {
  if (answer.algorithm === RAILS_BCRYPT_ALGORITHM) {
    const cost = Number((answer.params as { cost?: number }).cost);
    return {
      derivedKey: await railsBcryptKey(password, answer.salt, cost),
      upgrade: await newVerifier(password),
    };
  }
  return {
    derivedKey: await argonDerivedKey(password, answer.salt, answer.params),
  };
}

/** A random password for a walkthrough account; never written anywhere. */
export function randomPassword(): string {
  return `wt-${randomBytes(18).toString('base64url')}`;
}
