/**
 * Hono Authentication & Authorization Middleware
 *
 * Ports the Fastify auth middleware to Hono patterns.
 * Uses Hono Variables for typed context state instead of request mutation.
 *
 * Key differences from Fastify version:
 * - c.set('user', user) instead of request.user = user
 * - return c.json({...}, 401) instead of reply.status(401).send({...})
 * - Session via custom SessionStore instead of @fastify/session
 */

import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import {
  getSessionStore,
  parseSessionCookie,
  createSessionCookie,
  generateSessionId,
  type SessionData,
} from '../session/session-store.js';
import { getConfig } from '../config/index.js';

// ========================================
// TYPES
// ========================================

export interface SessionUser {
  id: number;
  email: string;
  role: 'super_admin' | 'admin' | 'editor' | 'elder' | 'viewer';
  communityId: number;
  firstName?: string;
  lastName?: string;
}

/**
 * Hono app variables for auth state.
 * Access via c.get('user'), c.get('sessionId').
 */
export interface AppAuthVariables {
  user: SessionUser;
  sessionId: string;
}

/**
 * Role hierarchy (same as Fastify version).
 * Higher = more privileges within community context.
 * super_admin is system-level only — cannot access community data (data sovereignty).
 */
export const ROLE_HIERARCHY = {
  viewer: 1,
  elder: 2,
  editor: 3,
  admin: 4,
  super_admin: 5,
} as const;

// ========================================
// SESSION HELPERS
// ========================================

/**
 * Create a new session and set the signed cookie on the response.
 * Returns the session ID.
 */
export async function createSession(
  c: Context,
  user: SessionUser,
  maxAgeMs?: number
): Promise<string> {
  const config = getConfig();
  const sessionId = generateSessionId();
  const store = getSessionStore();
  const ttl = maxAgeMs ?? config.auth.session.maxAge;

  const sessionData: SessionData = {
    user,
    createdAt: Date.now(),
  };

  await store.set(sessionId, sessionData, ttl);

  // Set signed cookie
  const signedValue = createSessionCookie(
    sessionId,
    config.auth.session.secret
  );
  setCookie(c, 'sessionId', signedValue, {
    httpOnly: config.auth.session.httpOnly,
    secure: config.auth.session.secure,
    sameSite: config.auth.session.sameSite as
      | 'lax'
      | 'strict'
      | 'none'
      | undefined,
    maxAge: Math.floor(ttl / 1000), // seconds
    path: '/',
  });

  return sessionId;
}

/**
 * Destroy current session and clear cookie.
 */
export async function destroySession(c: Context): Promise<void> {
  const sessionId = c.get('sessionId' as never) as string | undefined;
  if (sessionId) {
    const store = getSessionStore();
    await store.delete(sessionId);
  }
  deleteCookie(c, 'sessionId', { path: '/' });
}

// ========================================
// AUTH MIDDLEWARE
// ========================================

/**
 * Require authentication — user must have a valid session.
 * Sets c.var.user and c.var.sessionId on success.
 */
export const requireAuth = createMiddleware<{
  Variables: AppAuthVariables;
}>(async (c, next) => {
  // Field-kit / offline mode support (same as Fastify version)
  if (
    process.env.NODE_ENV === 'field-kit' ||
    process.env.OFFLINE_MODE === 'true'
  ) {
    const authHeader = c.req.header('authorization');
    const cookieHeader = c.req.header('cookie');
    if (
      authHeader?.includes('field-kit-admin-token') ||
      cookieHeader?.includes('field-kit-session')
    ) {
      const user: SessionUser = {
        id: 1,
        email: 'fieldkit@admin.local',
        role: 'admin',
        communityId: 1,
        firstName: 'Field',
        lastName: 'Kit',
      };
      c.set('user', user);
      c.set('sessionId', 'field-kit');
      await next();
      return;
    }
  }

  const config = getConfig();
  const cookieValue = getCookie(c, 'sessionId');

  if (!cookieValue) {
    return c.json({ error: { message: 'Authentication required' } }, 401);
  }

  const sessionId = parseSessionCookie(cookieValue, config.auth.session.secret);
  if (!sessionId) {
    return c.json({ error: { message: 'Authentication required' } }, 401);
  }

  const store = getSessionStore();
  const session = await store.get(sessionId);

  if (!session) {
    return c.json({ error: { message: 'Authentication required' } }, 401);
  }

  c.set('user', session.user as SessionUser);
  c.set('sessionId', sessionId);
  await next();
});

/**
 * Require specific role(s). Must be used after requireAuth.
 */
export function requireRole(roles: string[]) {
  return createMiddleware<{ Variables: AppAuthVariables }>(async (c, next) => {
    const user = c.get('user' as never) as SessionUser | undefined;
    if (!user) {
      return c.json({ error: { message: 'Authentication required' } }, 401);
    }
    if (!roles.includes(user.role)) {
      return c.json({ error: { message: 'Insufficient permissions' } }, 403);
    }
    await next();
  });
}

/**
 * Require admin or super_admin role.
 */
export const requireAdmin = createMiddleware<{
  Variables: AppAuthVariables;
}>(async (c, next) => {
  const user = c.get('user' as never) as SessionUser | undefined;
  if (!user) {
    return c.json({ error: { message: 'Authentication required' } }, 401);
  }
  if (!['admin', 'super_admin'].includes(user.role)) {
    return c.json({ error: { message: 'Insufficient permissions' } }, 403);
  }
  await next();
});

/**
 * Require super_admin role.
 */
export const requireSuperAdmin = createMiddleware<{
  Variables: AppAuthVariables;
}>(async (c, next) => {
  const user = c.get('user' as never) as SessionUser | undefined;
  if (!user) {
    return c.json({ error: { message: 'Authentication required' } }, 401);
  }
  if (user.role !== 'super_admin') {
    return c.json({ error: { message: 'Insufficient permissions' } }, 403);
  }
  await next();
});

/**
 * Data Sovereignty Enforcement.
 * Blocks super_admin from accessing community data.
 */
export const enforceDataSovereignty = createMiddleware<{
  Variables: AppAuthVariables;
}>(async (c, next) => {
  const user = c.get('user' as never) as SessionUser | undefined;
  if (!user) {
    return c.json({ error: { message: 'Authentication required' } }, 401);
  }
  if (user.role === 'super_admin') {
    console.warn(
      JSON.stringify({
        userId: user.id,
        action: 'community_data_access_blocked',
        reason: 'data_sovereignty_protection',
      })
    );
    return c.json(
      {
        error: {
          message: 'Super administrators cannot access community data',
        },
        reason: 'Indigenous data sovereignty protection',
      },
      403
    );
  }
  await next();
});

/**
 * Community access middleware.
 * Enforces data sovereignty + community isolation.
 */
export function requireCommunityAccess() {
  return createMiddleware<{ Variables: AppAuthVariables }>(async (c, next) => {
    const user = c.get('user' as never) as SessionUser | undefined;
    if (!user) {
      return c.json({ error: { message: 'Authentication required' } }, 401);
    }

    // Data sovereignty: super_admin cannot access community data
    if (user.role === 'super_admin') {
      return c.json(
        {
          error: {
            message: 'Super administrators cannot access community data',
          },
          reason: 'Indigenous data sovereignty protection',
        },
        403
      );
    }

    // Community isolation check
    const requestedCommunityId = extractCommunityId(c);
    if (requestedCommunityId && requestedCommunityId !== user.communityId) {
      console.warn(
        JSON.stringify({
          userId: user.id,
          userCommunityId: user.communityId,
          requestedCommunityId,
          userRole: user.role,
        })
      );
      return c.json(
        {
          error: {
            message: 'Access denied - community data isolation',
          },
        },
        403
      );
    }

    await next();
  });
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Extract community ID from route params or query string.
 */
export function extractCommunityId(c: Context): number | null {
  const communityIdParam =
    c.req.param('communityId') || c.req.query('communityId');
  const communityId = parseInt(communityIdParam || '0');
  return communityId > 0 ? communityId : null;
}

/**
 * Get current user from context.
 */
export function getCurrentUser(c: Context): SessionUser | null {
  return (c.get('user' as never) as SessionUser | undefined) ?? null;
}

/**
 * Check if user role has hierarchy permission.
 */
export function hasRoleHierarchy(
  userRole: string,
  requiredRole: string
): boolean {
  if (userRole === 'super_admin') return false;
  const userLevel =
    ROLE_HIERARCHY[userRole as keyof typeof ROLE_HIERARCHY] || 0;
  const requiredLevel =
    ROLE_HIERARCHY[requiredRole as keyof typeof ROLE_HIERARCHY] || 0;
  return userLevel >= requiredLevel;
}
