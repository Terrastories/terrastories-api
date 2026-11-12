import type {
  FoundationUser,
  HonoFoundationRepository,
} from '../repositories/hono-foundation.repository.js';

export interface PasswordVerifier {
  verify(password: string, encodedHash: string): Promise<boolean>;
}

export interface FoundationStorage {
  read(key: string): Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
}

export const sessionLifetime = 8 * 60 * 60 * 1000;
const permittedRoles = new Set([
  'viewer',
  'member',
  'editor',
  'admin',
  'super_admin',
]);

export async function tokenDigest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** Request-path operations use Web APIs and an injected password verifier. */
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
    const valid = await this.verifier.verify(
      password,
      user?.passwordHash ?? ''
    );
    if (!valid || !user || !permittedRoles.has(user.role)) return null;
    const token = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const created = await this.repository.createSession(
      await tokenDigest(token),
      user,
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
    return user && permittedRoles.has(user.role) ? user : null;
  }

  async media(id: string, user: FoundationUser) {
    if (user.role === 'super_admin') return null;
    const file = await this.repository.brandingFile(id, user.communityId);
    if (!file) return null;
    // A database path cannot escape the tenant's storage namespace.
    if (
      !file.storageKey.startsWith(`communities/${user.communityId}/`) ||
      file.storageKey
        .split('/')
        .some(
          (part) =>
            !part || part === '.' || part === '..' || part.includes('\\')
        )
    )
      return null;
    const bytes = await this.storage.read(file.storageKey);
    return bytes === null ? null : { bytes, mimeType: file.mimeType };
  }
}
