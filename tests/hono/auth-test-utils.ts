/**
 * Shared helpers for client-stretched auth (SPEC-V2 §7) in the Hono tests.
 *
 * The server never runs a password KDF: tests seed `passwordVerifier` as
 * SHA-256 of a runtime-generated stretched key, and the login helper presents
 * that key the way a browser would — only the derived key crosses the wire.
 * Secrets and hashes are built at runtime, never as literals.
 */
import { hash } from 'bcrypt';
import { sha256Hex, toHex } from '../../src/shared/auth-crypto.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS_JSON,
} from '../../src/shared/auth-policy.js';

/** A client-stretched derived key as the wire carries it (64 lowercase hex). */
export const makeDerivedKey = (): string =>
  toHex(crypto.getRandomValues(new Uint8Array(32)));

/** A runtime-built HMAC key for test apps (never a committed literal). */
export const makeServerSecret = (): string => makeDerivedKey();

/** A fresh base64 verifier salt (16 bytes) for a seeded Argon2id row. */
export const makeVerifierSalt = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');

/** The stored columns for a seeded Argon2id account (incl. legacy anchor). */
export async function argon2Seed(derivedKey: string): Promise<{
  passwordHash: string;
  passwordAlgorithm: string;
  passwordSalt: string;
  passwordParams: string;
  passwordVerifier: string;
}> {
  return {
    // The legacy `password_hash` stays as the re-read anchor for session
    // writes and the revocation triggers; client-stretched auth verifies
    // against `passwordVerifier` (SPEC-V2 §7). A runtime bcrypt hash of a
    // random value, never a literal.
    passwordHash: await hash(
      toHex(crypto.getRandomValues(new Uint8Array(16))),
      4
    ),
    passwordAlgorithm: ARGON2ID_ALGORITHM,
    passwordSalt: makeVerifierSalt(),
    passwordParams: ARGON2ID_PARAMS_JSON,
    passwordVerifier: await sha256Hex(derivedKey),
  };
}
