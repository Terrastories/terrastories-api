import type {
  FoundationUser,
  HonoFoundationRepository,
} from '../repositories/hono-foundation.repository.js';

import type { DirectUploadAdapter } from './direct-upload.types.js';

const invalidParts = new Set(['', '.', '..']);
const safeKey = (key: string) =>
  !key.includes('\\') && !key.split('/').some((part) => invalidParts.has(part));
export const validStorageKey = (key: string) =>
  /^(?:communities|users)\/[1-9][0-9]*\//.test(key) && safeKey(key);

/** Historical file pointers may only be deleted, never written or served. */
export const validLegacyStorageKey = (key: string) =>
  key.startsWith('legacy/') && !key.includes('\0') && safeKey(key);

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
export const erasureFenceKey = (communityId: number) =>
  `system/erasure-fences/${communityId}`;

export const validSystemStorageKey = (key: string) =>
  key === ORPHAN_SWEEP_CURSOR_KEY ||
  key === ORPHAN_SWEEP_HOLD_KEY ||
  /^system\/erasure-fences\/[1-9][0-9]*$/.test(key);

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

/** Thrown by `put` when the stored bytes do not hash to `options.sha256`. */
export class StorageChecksumMismatchError extends Error {
  constructor() {
    super('Stored bytes do not match the expected SHA-256');
    this.name = 'StorageChecksumMismatchError';
  }
}

/** Thrown by `put` when a stream body needs a known `contentLength` and has none. */
export class StorageLengthRequiredError extends Error {
  constructor() {
    super('A known content length is required for this upload');
    this.name = 'StorageLengthRequiredError';
  }
}

export interface StoragePutOptions {
  contentType?: string;
  /**
   * Expected lowercase-hex SHA-256 of the whole object. The adapter verifies it
   * outside application code (R2 verifies server-side; the local adapter uses
   * native `node:crypto`) and throws `StorageChecksumMismatchError` without
   * leaving the object behind.
   */
  sha256?: string;
  /** Exact body length in bytes when the caller knows it (request Content-Length). */
  contentLength?: number;
  /** Force multipart upload even when stream length is below the default part threshold. */
  useMultipart?: boolean;
  /** Invoked as soon as a multipart upload id is created so callers can persist it for restart-safe abort. */
  onMultipartUploadCreated?: (uploadId: string) => Promise<void> | void;
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
  /**
   * True when `put` pipes a native request-body stream without per-chunk
   * JavaScript (R2 on Workers). The upload route then requires Content-Length
   * and tees the body instead of wrapping it in a JS pass-through stream.
   */
  nativeStreamPut?: boolean;
  /**
   * Direct multipart media upload backend (#286). `undefined`: the route
   * streams parts into this storage (`api` mode, Node local disk); `null`:
   * the profile cannot offer it (Workers without R2 S3 credentials), so the
   * routes answer 501; an adapter: presigned R2 multipart.
   */
  directUploads?: DirectUploadAdapter | null;
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
  /** Persistently fence new writers; existing writers must be abortable by listing/deletion. */
  fenceCommunity?(communityId: number): Promise<void>;
  deleteMany?(keys: string[]): Promise<void>;
  erasureBatchDeleteCost?(keys: string[]): number;
  /** Worst-case provider operations per erasure delete (multipart journal abort included). */
  erasureDeleteCost?: number;
  /** Abort an in-flight multipart upload by storage key and upload id (R2). */
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;
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

import { parseV2Role } from '../shared/authorization/sovereignty-policy.js';
import type { SessionKind } from '../shared/auth-policy.js';

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
    readonly storage: FoundationStorage
  ) {}

  /**
   * The session's user and kind (`standard` or `device`), re-read from the
   * database. The kind lets the response cookie reflect the session the
   * caller actually holds (§7 "Sessions").
   */
  async actor(
    token: string | undefined,
    now: Date
  ): Promise<{
    user: FoundationUser;
    kind: SessionKind;
    absoluteExpiresAt: number | null;
    tokenHash: string;
  } | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = await tokenDigest(token);
    const context = await this.repository.sessionContext(tokenHash, now);
    return context && parseV2Role(context.user.role)
      ? { ...context, tokenHash }
      : null;
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
