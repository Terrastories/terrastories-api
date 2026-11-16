import type {
  FoundationUser,
  HonoFoundationRepository,
} from '../repositories/hono-foundation.repository.js';

export interface PasswordVerifier {
  verify(password: string, encodedHash: string): Promise<boolean>;
}

const invalidParts = new Set(['', '.', '..']);
const safeKey = (key: string) =>
  !key.includes('\\') && !key.split('/').some((part) => invalidParts.has(part));
export const validStorageKey = (key: string) =>
  /^(?:communities|users)\/[1-9][0-9]*\//.test(key) && safeKey(key);

/**
 * System-owned object: the orphan sweeper's resume cursor. It lives outside the
 * swept `communities/` and `users/` prefixes, so no sweep ever deletes it and no
 * tenant key can collide with it.
 */
export const ORPHAN_SWEEP_CURSOR_KEY = 'system/orphan-sweep-cursor.json';

/**
 * System-owned object: the orphan sweeper's explicit restore hold. While this
 * object exists, the sweeper deletes nothing — a filesystem/database restore
 * can recreate storage bytes before the `files` table knows them. Operators
 * create it before a restore and remove it after the restored state is
 * verified; it lives outside the swept prefixes, so the sweep never deletes
 * it (the hold cannot dissolve itself).
 */
export const ORPHAN_SWEEP_HOLD_KEY = 'system/orphan-sweep-hold';

export const validSystemStorageKey = (key: string) =>
  key === ORPHAN_SWEEP_CURSOR_KEY || key === ORPHAN_SWEEP_HOLD_KEY;

/**
 * Parse an operator env switch, fail closed: only an unset/empty value, or
 * `false`/`0` (case-insensitive), means off. Every other value — `true`,
 * `1`, `TRUE`, `on`, `yes`, … — means on, so a misconfigured flag pauses
 * rather than silently enables a destructive path (the orphan sweep).
 */
export function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized !== 'false' && normalized !== '0';
}

export interface StorageReadRange {
  /** Inclusive 0-based byte offset. */
  start: number;
  /** Inclusive 0-based byte offset. */
  end: number;
}

export interface StorageReadResult {
  body: Uint8Array | ReadableStream<Uint8Array>;
  size: number;
}

export interface StoragePutOptions {
  contentType?: string;
}

export interface StorageListEntry {
  key: string;
  /** Last-modified time; used by the orphan sweeper's grace window. */
  uploaded: Date;
}

export interface StorageListResult {
  entries: StorageListEntry[];
  /** True when more keys exist under the prefix (caller may paginate). */
  truncated: boolean;
  /**
   * Key to resume after for key-based pagination (exclusive), identical in
   * spirit and semantics to `startAfter`. Reported only when `truncated` is
   * true. Callers that walk a prefix must pass the last `nextStartAfter` back
   * in as `startAfter` to see the next page.
   */
  nextStartAfter?: string;
}

export interface StorageListOptions {
  prefix?: string;
  /** Walk keys strictly after this key (exclusive). */
  startAfter?: string;
  limit?: number;
}

export interface FoundationStorage {
  read(
    key: string,
    range?: StorageReadRange
  ): Promise<StorageReadResult | null>;
  put?(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: StoragePutOptions
  ): Promise<{ size: number }>;
  delete?(key: string): Promise<void>;
  /**
   * Enumerate stored objects under `prefix` for the restart-safe orphan
   * sweeper. Optional: adapters without listing skip orphan sweeping.
   */
  list?(options?: StorageListOptions): Promise<StorageListResult>;
  /**
   * Read/write a system-owned object by absolute key (the orphan sweeper's
   * resume cursor). Optional: adapters without them sweep without a cursor.
   */
  getSystemObject?(key: string): Promise<Uint8Array | null>;
  putSystemObject?(key: string, bytes: Uint8Array): Promise<void>;
}

import { sessionLifetime } from '../shared/session-policy.js';
import { parseV2Role } from '../shared/authorization/sovereignty-policy.js';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function tokenDigest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  return hex(new Uint8Array(bytes));
}

export class HonoFoundationService {
  constructor(
    readonly repository: HonoFoundationRepository,
    readonly storage: FoundationStorage,
    readonly verifier: PasswordVerifier
  ) {}

  async login(
    email: string,
    password: string,
    communityId: number | undefined,
    now: Date,
    previous?: string
  ) {
    const candidates = await this.repository.candidates(email, communityId);
    const user = candidates.length === 1 ? candidates[0] : undefined;
    const hash = user?.passwordHash ?? '';
    const valid = await this.verifier.verify(password, hash);
    if (!valid || !user || !parseV2Role(user.role)) return null;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const created = await this.repository.createSession(
      await tokenDigest(token),
      user,
      now,
      new Date(now.getTime() + sessionLifetime),
      previous && /^[a-f0-9]{64}$/.test(previous)
        ? await tokenDigest(previous)
        : undefined
    );
    return created ? { token, user } : null;
  }

  async actor(
    token: string | undefined,
    now: Date
  ): Promise<FoundationUser | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const user = await this.repository.session(await tokenDigest(token), now);
    return user && parseV2Role(user.role) ? user : null;
  }

  async media(id: string, user: FoundationUser) {
    if (user.role === 'super_admin' || user.communityId === null) return null;
    const file = await this.repository.brandingFile(id, user.communityId);
    if (!file) return null;
    if (
      !file.storageKey.startsWith(`communities/${user.communityId}/`) ||
      !validStorageKey(file.storageKey)
    )
      return null;
    const stored = await this.storage.read(file.storageKey);
    return stored === null
      ? null
      : { bytes: stored.body, mimeType: file.mimeType };
  }
}
