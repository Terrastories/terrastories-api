// Shared by make-auth-seed.mjs and load-auth.mjs. derivedKey(i) stands in for the
// client's Argon2id/bcrypt output; the server stores SHA-256(derivedKey).
import { createHash } from 'node:crypto';

export const USERS = 50;
export const COMMUNITY_ID = 1;
export const identifier = (i) => `user${i}`;
export const derivedKey = (i) =>
  createHash('sha256').update(`spike-derived-key-${i}`).digest();
export const keyHash = (i) =>
  createHash('sha256').update(derivedKey(i)).digest();
export const b64url = (buf) => buf.toString('base64url');
