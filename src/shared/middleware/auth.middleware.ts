/**
 * Authentication Middleware
 *
 * Provides reusable authentication and authorization middleware for protected routes.
 * Integrates with Fastify session management for secure user authentication.
 */

import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * User session interface
 */
export interface UserSession {
  id: number;
  email: string;
  role: string;
  communityId: number;
  firstName?: string;
  lastName?: string;
}

/**
 * Extended request interface with session
 */
export interface AuthenticatedRequest extends FastifyRequest {
  session: {
    user?: UserSession;
  } & FastifyRequest['session'];
}

/**
 * Require authentication middleware
 * Ensures user is logged in before accessing protected routes
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;

  if (!authRequest.session?.user) {
    return reply.status(401).send({
      error: 'Authentication required',
      statusCode: 401,
    });
  }
}

/**
 * Require specific role middleware factory
 * Creates middleware that ensures user has one of the specified roles
 */
export function requireRole(roles: string[]) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const authRequest = request as AuthenticatedRequest;

    if (!authRequest.session?.user) {
      return reply.status(401).send({
        error: 'Authentication required',
        statusCode: 401,
      });
    }

    if (!roles.includes(authRequest.session.user.role)) {
      return reply.status(403).send({
        error: 'Insufficient permissions',
        statusCode: 403,
      });
    }
  };
}

/**
 * Require admin role middleware
 * Ensures user has admin or super_admin role
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  return requireRole(['admin', 'super_admin'])(request, reply);
}

/**
 * Require super admin role middleware
 * Ensures user has super_admin role
 */
export async function requireSuperAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  return requireRole(['super_admin'])(request, reply);
}

/**
 * Community scoped middleware
 * Ensures user can only access data from their own community
 * Super admins are exempt from this restriction
 */
export async function requireCommunityScope(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;

  if (!authRequest.session?.user) {
    return reply.status(401).send({
      error: 'Authentication required',
      statusCode: 401,
    });
  }

  // Super admins can access all communities
  if (authRequest.session.user.role === 'super_admin') {
    return;
  }

  // Extract community ID from route params or query
  const requestedCommunityId =
    parseInt(
      (request.params as { communityId?: string })?.communityId || '0'
    ) ||
    parseInt((request.query as { communityId?: string })?.communityId || '0');

  if (
    requestedCommunityId &&
    requestedCommunityId !== authRequest.session.user.communityId
  ) {
    return reply.status(403).send({
      error: 'Access denied to this community',
      statusCode: 403,
    });
  }
}

/**
 * Get current user helper
 * Safely extracts user from session
 */
export function getCurrentUser(request: FastifyRequest): UserSession | null {
  const authRequest = request as AuthenticatedRequest;
  return authRequest.session?.user || null;
}

/**
 * Set user session helper
 * Safely sets user in session
 */
export function setUserSession(
  request: FastifyRequest,
  user: UserSession
): void {
  const authRequest = request as AuthenticatedRequest;
  authRequest.session.user = user;
}

/**
 * Clear user session helper
 * Safely removes user from session
 */
export function clearUserSession(request: FastifyRequest): void {
  const authRequest = request as AuthenticatedRequest;
  if (authRequest.session) {
    authRequest.session.user = undefined;
  }
}
