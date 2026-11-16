import type {
  FoundationUser,
  HonoFoundationRepository,
} from '../repositories/hono-foundation.repository.js';

const invalidParts = new Set(['', '.', '..']);
export const validStorageKey = (key: string) =>
  /^communities\/[1-9][0-9]*\//.test(key) &&
  !key.includes('\\') &&
  !key.split('/').some((part) => invalidParts.has(part));

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

export interface FoundationStorage {
  read(
    key: string,
    range?: StorageReadRange
  ): Promise<StorageReadResult | null>;
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
  } | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const context = await this.repository.sessionContext(
      await tokenDigest(token),
      now
    );
    return context && parseV2Role(context.user.role) ? context : null;
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
