/**
 * Session Store for Hono
 *
 * Provides server-side session storage with an opaque signed session ID cookie.
 * Phase 1 uses MemoryStore. The interface is ready for KV (Phase 3).
 *
 * This replaces @fastify/session for the Hono app.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface SessionData {
  user: {
    id: number;
    email: string;
    role: string;
    communityId: number;
    firstName?: string;
    lastName?: string;
  };
  createdAt: number;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData, maxAgeMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * In-memory session store for dev/test.
 * Maps to KV in Phase 3.
 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, { data: SessionData; expires: number }>();

  async get(sessionId: string): Promise<SessionData | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.sessions.delete(sessionId);
      return null;
    }
    return entry.data;
  }

  async set(
    sessionId: string,
    data: SessionData,
    maxAgeMs: number
  ): Promise<void> {
    this.sessions.set(sessionId, {
      data,
      expires: Date.now() + maxAgeMs,
    });
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** Clear all sessions — useful for test teardown */
  clear(): void {
    this.sessions.clear();
  }
}

// Singleton store (in dev/test). KV-backed in production (Phase 3).
let storeInstance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!storeInstance) {
    storeInstance = new MemorySessionStore();
  }
  return storeInstance;
}

export function setSessionStore(store: SessionStore): void {
  storeInstance = store;
}

/**
 * Sign a value using HMAC-SHA256 with the session secret.
 * Format: value.signature
 */
export function sign(value: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${sig}`;
}

/**
 * Verify and unsign a value.
 * Returns the original value if valid, null otherwise.
 */
export function unsign(signedValue: string, secret: string): string | null {
  const dotIdx = signedValue.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const value = signedValue.substring(0, dotIdx);
  const sig = signedValue.substring(dotIdx + 1);

  const expectedSig = createHmac('sha256', secret)
    .update(value)
    .digest('base64url');

  try {
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (timingSafeEqual(sigBuf, expectedBuf)) return value;
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a new random session ID.
 */
export function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Create a signed session cookie value.
 * The cookie contains: signedSessionId
 */
export function createSessionCookie(
  sessionId: string,
  secret: string
): string {
  return sign(sessionId, secret);
}

/**
 * Parse and verify a session cookie value.
 * Returns the session ID if valid, null otherwise.
 */
export function parseSessionCookie(
  cookieValue: string,
  secret: string
): string | null {
  return unsign(cookieValue, secret);
}
