import type {
  FoundationUser,
  HonoFoundationRepository,
} from '../repositories/hono-foundation.repository.js';

export interface PasswordVerifier {
  verify(password: string, encodedHash: string): Promise<boolean>;
}

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

export interface FoundationStorage {
  read(
    key: string,
    range?: StorageReadRange
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
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
    const bytes = await this.storage.read(file.storageKey);
    return bytes === null ? null : { bytes, mimeType: file.mimeType };
  }
}
