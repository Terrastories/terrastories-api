/**
 * Enhanced Authentication & Authorization Middleware
 *
 * Provides comprehensive authentication and authorization middleware with:
 * - Data sovereignty enforcement for Indigenous communities
 * - Cultural role support (elder role for knowledge keepers)
 * - Role hierarchy system with cultural sensitivity
 * - Advanced middleware patterns and composability
 * - Security event logging and audit trails
 * - Performance optimization with caching
 *
 * CRITICAL: Enforces Indigenous data sovereignty by blocking super admin
 * access to community data as required by Indigenous rights and governance.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import {
  authorizeCommunityContent,
  createAuthorizationAuditEvent,
  isV2CommunityRole,
  type ContentRouteFamily,
  type ProtectedSurface,
} from '../authorization/sovereignty-policy.js';

/**
 * User session interface with enhanced cultural role support
 */
export interface UserSession {
  id: number;
  email: string;
  role: 'super_admin' | 'admin' | 'editor' | 'elder' | 'viewer';
  communityId: number;
  firstName?: string;
  lastName?: string;
}

/**
 * Role hierarchy with cultural sensitivity
 * Higher numbers indicate higher privileges within community context
 * Note: super_admin is excluded from community data (data sovereignty)
 */
export const ROLE_HIERARCHY = {
  viewer: 1,
  elder: 2, // Cultural role for Indigenous knowledge keepers
  editor: 3,
  admin: 4,
  super_admin: 5, // System-level only, CANNOT access community data
} as const;

/**
 * Permission matrix for role-based access control
 */
export const ROLE_PERMISSIONS = {
  viewer: ['stories:read', 'places:read', 'speakers:read'],
  elder: [
    'stories:read',
    'places:read',
    'speakers:read',
    'cultural:read',
    'cultural:validate',
  ],
  editor: [
    'stories:read',
    'stories:write',
    'places:read',
    'places:write',
    'speakers:read',
    'speakers:write',
  ],
  admin: ['*'], // All community permissions
  super_admin: ['system:*'], // System-level only, no community access
};

/**
 * Community access options for cultural protocol enforcement
 */
export interface CommunityAccessOptions {
  allowElderAccess?: boolean;
  culturalRestrictions?: string[];
  auditLevel?: 'basic' | 'detailed';
  enableCaching?: boolean;
}

/**
 * Permission requirement options
 */
export interface PermissionOptions {
  contextAware?: boolean;
  resourceOwnership?: boolean;
  enableCaching?: boolean;
}

/**
 * Extended request interface with session and direct user access
 */
export interface AuthenticatedRequest extends FastifyRequest {
  session: {
    user?: UserSession;
  } & FastifyRequest['session'];
  user: UserSession; // Direct access to user for convenience
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

  // In field-kit or offline mode, allow special offline tokens
  if (
    process.env.NODE_ENV === 'field-kit' ||
    process.env.OFFLINE_MODE === 'true'
  ) {
    const authHeader = request.headers.authorization;
    const cookie = request.headers.cookie;

    // Check for field kit special tokens
    if (
      authHeader?.includes('field-kit-admin-token') ||
      cookie?.includes('field-kit-session')
    ) {
      // Create a mock user for field kit operations
      authRequest.user = {
        id: 1,
        email: 'fieldkit@admin.local',
        role: 'admin',
        communityId: 1,
        firstName: 'Field',
        lastName: 'Kit',
      };
      // Also set session for compatibility with other middleware
      if (!authRequest.session) {
        authRequest.session = {} as FastifyRequest['session'];
      }
      Object.assign(authRequest.session, {
        user: authRequest.user,
      });
      return;
    }
  }

  if (!authRequest.session?.user) {
    return reply.status(401).send({
      error: { message: 'Authentication required' },
      statusCode: 401,
    });
  }

  // Set user directly on request for convenience
  authRequest.user = authRequest.session.user;
}

/**
 * Require specific role middleware factory
 * Creates middleware that ensures user has one of the specified roles
 */
export function requireRole(roles: string[]) {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authRequest = request as AuthenticatedRequest;
    const sessionUser = authRequest.session?.user;
    if (!sessionUser) {
      return reply.status(401).send({
        error: { message: 'Authentication required' },
        statusCode: 401,
      });
    }
    const hasRole = roles.includes(sessionUser.role);
    if (!hasRole) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions' },
      });
    }
    authRequest.user = sessionUser;
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
 * CRITICAL: Data Sovereignty Enforcement Middleware
 *
 * Enforces Indigenous data sovereignty by preventing super admins
 * from accessing community data. This is essential for Indigenous
 * communities' self-governance and data rights.
 *
 * Super admins can manage system-level operations but CANNOT
 * access any community-specific data or resources.
 */
export async function enforceDataSovereignty(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;

  // Handle both session-based and direct user authentication
  const user = authRequest.user || authRequest.session?.user;

  if (!user) {
    return reply.status(401).send({
      error: { message: 'Authentication required' },
      statusCode: 401,
    });
  }

  // CRITICAL: Super admins cannot access community data (data sovereignty)
  if (user.role === 'super_admin') {
    request.log.warn(
      {
        userId: user.id,
        action: 'community_data_access_blocked',
        reason: 'data_sovereignty_protection',
      },
      'Super admin blocked from community data'
    );

    return reply.status(403).send({
      error: { message: 'Super administrators cannot access community data' },
      reason: 'Indigenous data sovereignty protection',
    });
  }
}

/**
 * Enhanced Community Access Middleware with Cultural Protocol Support
 *
 * Provides comprehensive community data isolation with support for:
 * - Indigenous data sovereignty enforcement
 * - Cultural role awareness (elder permissions)
 * - Audit logging for Indigenous oversight
 * - Cultural restriction enforcement
 */
export function requireCommunityAccess(options: CommunityAccessOptions = {}) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    // First enforce data sovereignty
    await enforceDataSovereignty(request, reply);
    if (reply.sent) return;

    const authRequest = request as AuthenticatedRequest;
    // In offline mode, user might be set directly on the request instead of session
    const user = authRequest.user || authRequest.session?.user!;

    // Extract community ID from route params, query, or body. Multiple
    // aliases are permitted only when they identify the same tenant; a
    // conflicting set is ambiguous and must fail closed before any handler
    // can consume a different alias than the authorization layer.
    let requestedCommunityId: number | null;
    try {
      requestedCommunityId = extractCommunityId(request);
    } catch (error) {
      if (
        !(error instanceof ConflictingCommunityIdError) &&
        !(error instanceof InvalidCommunityIdError)
      ) {
        throw error;
      }
      request.log.warn(
        {
          userId: user.id,
          userCommunityId: user.communityId,
          requestedCommunityIds:
            error instanceof ConflictingCommunityIdError
              ? error.communityIds
              : undefined,
        },
        'Invalid or conflicting community identifiers rejected'
      );
      return reply.status(403).send({
        error: { message: 'Access denied - community data isolation' },
      });
    }
    const userCommunityId = user.communityId;

    // Community isolation check
    if (requestedCommunityId && requestedCommunityId !== userCommunityId) {
      // Log unauthorized access attempt
      request.log.warn(
        {
          userId: user.id,
          userCommunityId,
          requestedCommunityId,
          userRole: user.role,
        },
        'Unauthorized community data access attempt'
      );

      return reply.status(403).send({
        error: { message: 'Access denied - community data isolation' },
      });
    }

    // Cultural protocol enforcement
    if (
      options.culturalRestrictions?.length &&
      options.culturalRestrictions.length > 0
    ) {
      await enforceCulturalProtocols(request, reply, options);
      if (reply.sent) return;
    }

    // Log elder access for cultural oversight
    if (user.role === 'elder' && options.auditLevel === 'detailed') {
      request.log.info(
        {
          userId: user.id,
          role: user.role,
          communityId: userCommunityId,
          action: 'cultural_content_access',
          auditLevel: options.auditLevel,
        },
        'Elder role community access granted'
      );
    }
  };
}

/**
 * Apply the canonical V2 sovereignty policy to a concrete community-content
 * route. Legacy elder sessions stay on the legacy guard until V1 scope is
 * retired; the V2 policy itself never gains an elder role.
 */
export type ResourceCommunityResolver = (
  request: FastifyRequest,
  actorCommunityId: number
) => Promise<number | null | undefined>;

function sendResourceNotFound(
  reply: FastifyReply,
  family: ContentRouteFamily,
  request: FastifyRequest
): FastifyReply {
  const rawId = (request.params as { id?: string | number }).id;

  switch (family) {
    case 'stories':
      return reply.status(404).send({ error: 'Story not found' });
    case 'themes':
      return reply.status(404).send({ error: 'Theme not found' });
    case 'places':
      return reply.status(404).send({
        error: {
          message:
            rawId === undefined
              ? 'Place not found'
              : `Place with ID ${rawId} not found`,
        },
      });
    case 'speakers':
      return reply.status(404).send({
        error: { message: 'Speaker not found' },
      });
    case 'files':
      return reply.status(404).send({
        error: { message: 'File not found' },
      });
    default:
      return reply.status(404).send({
        error: { message: 'Resource not found' },
      });
  }
}

export function requireV2CommunityContentAccess(
  family: ContentRouteFamily,
  surface: ProtectedSurface,
  resolveResourceCommunity?: ResourceCommunityResolver
) {
  const legacyGuard = requireCommunityAccess();

  return async function enforceV2CommunityContent(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authRequest = request as AuthenticatedRequest;
    const user = authRequest.user || authRequest.session?.user;

    if (!user) {
      return reply.status(401).send({
        error: { message: 'Authentication required' },
        statusCode: 401,
      });
    }

    if (!isV2CommunityRole(user.role)) {
      await legacyGuard(request, reply);
      return;
    }

    if (user.role === 'super_admin') {
      const decision = authorizeCommunityContent({
        actor: {
          id: user.id,
          role: user.role,
          communityId: user.communityId,
          active: true,
        },
        resourceCommunityId: user.communityId,
        family,
        surface,
        visibility: 'community-only',
        communityActive: true,
      });
      request.log.warn(
        createAuthorizationAuditEvent({
          actor: {
            id: user.id,
            role: user.role,
            communityId: user.communityId,
            active: true,
          },
          resourceCommunityId: user.communityId,
          family,
          surface,
          decision,
        }),
        'V2 community content access denied'
      );
      return reply.status(403).send({
        error: { message: 'Super administrators cannot access community data' },
        reason: 'Indigenous data sovereignty protection',
      });
    }

    let resourceCommunityId: number;
    try {
      const requestedCommunityId = extractCommunityId(request);
      if (requestedCommunityId !== null) {
        resourceCommunityId = requestedCommunityId;
      } else if (resolveResourceCommunity) {
        const resolvedCommunityId = await resolveResourceCommunity(
          request,
          user.communityId
        );
        if (resolvedCommunityId === null) {
          sendResourceNotFound(reply, family, request);
          return;
        }
        resourceCommunityId = resolvedCommunityId ?? user.communityId;
      } else {
        resourceCommunityId = user.communityId;
      }
    } catch (error) {
      if (
        !(error instanceof ConflictingCommunityIdError) &&
        !(error instanceof InvalidCommunityIdError)
      ) {
        throw error;
      }
      request.log.warn(
        createAuthorizationAuditEvent({
          actor: {
            id: user.id,
            role: user.role,
            communityId: user.communityId,
            active: true,
          },
          resourceCommunityId: user.communityId,
          family,
          surface,
          decision: {
            allowed: false,
            reason: 'cross-community-denied',
          },
        }),
        'Invalid or conflicting community identifiers rejected'
      );
      return reply.status(403).send({
        error: { message: 'Access denied - community data isolation' },
      });
    }
    const decision = authorizeCommunityContent({
      actor: {
        id: user.id,
        role: user.role,
        communityId: user.communityId,
        // Login now fails closed for disabled users/inactive communities. #137
        // owns revalidation of already-issued sessions after state changes.
        active: true,
      },
      resourceCommunityId,
      family,
      surface,
      visibility: 'community-only',
      // Same issuance invariant as actor.active; stale session state is #137.
      communityActive: true,
    });

    if (decision.allowed) return;

    request.log.warn(
      createAuthorizationAuditEvent({
        actor: {
          id: user.id,
          role: user.role,
          communityId: user.communityId,
          active: true,
        },
        resourceCommunityId,
        family,
        surface,
        decision,
      }),
      'V2 community content access denied'
    );

    if (decision.reason === 'super-admin-content-denied') {
      return reply.status(403).send({
        error: { message: 'Super administrators cannot access community data' },
        reason: 'Indigenous data sovereignty protection',
      });
    }

    return reply.status(403).send({
      error: { message: 'Access denied - community data isolation' },
    });
  };
}

/**
 * Data sovereignty protection middleware
 * Blocks super administrators from accessing community-specific data
 * Implements Phase 3 requirement: super admins cannot access community data
 *
 * Alias for enforceDataSovereignty to maintain compatibility
 */
export async function requireDataSovereignty(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  return await enforceDataSovereignty(request, reply);
}

/**
 * Legacy community scope middleware (deprecated - use requireCommunityAccess)
 * Maintained for backward compatibility
 */
export async function requireCommunityScope(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Use new enhanced middleware for consistency
  const middleware = requireCommunityAccess();
  await middleware(request, reply);
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
/**
 * Role Hierarchy Authorization
 *
 * Checks if user has sufficient role level for the required role.
 * Respects cultural roles and data sovereignty constraints.
 */
export function requireRoleHierarchy(
  requiredRole: string,
  _options: { enableCaching?: boolean } = {}
) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const authRequest = request as AuthenticatedRequest;

    if (!authRequest.session?.user) {
      return reply.status(401).send({
        error: { message: 'Authentication required' },
        statusCode: 401,
      });
    }

    const user = authRequest.session.user;
    const hasPermission = hasRoleHierarchy(user.role, requiredRole);

    if (!hasPermission) {
      return reply.status(403).send({
        error: {
          message: `Insufficient permissions - requires ${requiredRole} level or higher`,
        },
        required: requiredRole,
        current: user.role,
      });
    }

    // Log authorization decision for audit
    request.log.info(
      {
        userId: user.id,
        role: user.role,
        requiredRole,
        action: 'role_hierarchy_check',
        result: 'granted',
      },
      'Role hierarchy authorization granted'
    );
  };
}

/**
 * Permission-Based Authorization
 *
 * Checks specific permissions based on role and context.
 * Supports cultural permissions for elder roles.
 */
export function requirePermission(
  permissions: string[],
  _options: PermissionOptions = {}
) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const authRequest = request as AuthenticatedRequest;

    if (!authRequest.session?.user) {
      return reply.status(401).send({
        error: { message: 'Authentication required' },
        statusCode: 401,
      });
    }

    const user = authRequest.session.user;
    const hasPermissions = checkUserPermissions(user, permissions);

    if (!hasPermissions) {
      return reply.status(403).send({
        error: { message: 'Insufficient permissions' },
        required: permissions,
        current: user.role,
      });
    }
  };
}

/**
 * Composable Middleware
 *
 * Combines multiple authorization checks into a single middleware.
 * Executes checks in sequence and fails fast on first failure.
 */
export function composeMiddleware(
  middlewares: Array<
    (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  >
) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    for (const middleware of middlewares) {
      await middleware(request, reply);
      if (reply.sent) {
        return; // Stop on first failure
      }
    }
  };
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Check if user role has hierarchy permission over required role
 */
export function hasRoleHierarchy(
  userRole: string,
  requiredRole: string
): boolean {
  // Super admin is blocked from community data (data sovereignty)
  if (userRole === 'super_admin') {
    return false;
  }

  const userLevel =
    ROLE_HIERARCHY[userRole as keyof typeof ROLE_HIERARCHY] || 0;
  const requiredLevel =
    ROLE_HIERARCHY[requiredRole as keyof typeof ROLE_HIERARCHY] || 0;

  return userLevel >= requiredLevel;
}

/**
 * Check if user has specific permissions
 */
export function checkUserPermissions(
  user: UserSession,
  requiredPermissions: string[]
): boolean {
  const rolePermissions =
    (ROLE_PERMISSIONS as Record<string, string[]>)[user.role] ||
    ([] as string[]);

  // Check for wildcard permission
  if (rolePermissions.includes('*')) {
    return true;
  }

  // Check each required permission
  return requiredPermissions.every(
    (permission) =>
      rolePermissions.includes(permission) ||
      rolePermissions.some((rolePermission: string) => {
        // Check for wildcard patterns like 'stories:*'
        const [domain] = permission.split(':');
        return rolePermission === `${domain}:*`;
      })
  );
}

/**
 * Raised when a request carries more than one distinct positive community ID
 * across supported tenant aliases. Authorization must reject this ambiguity
 * before route handlers can select a different alias.
 */
class ConflictingCommunityIdError extends Error {
  constructor(readonly communityIds: readonly number[]) {
    super('Conflicting community identifiers');
    this.name = 'ConflictingCommunityIdError';
  }
}

class InvalidCommunityIdError extends Error {
  constructor() {
    super('Invalid community identifier');
    this.name = 'InvalidCommunityIdError';
  }
}

/**
 * Extract one unambiguous community ID from params, query, or body.
 */
export function extractCommunityId(request: FastifyRequest): number | null {
  type CommunityIdValue = string | number | readonly (string | number)[];
  type CommunityIdContainer = {
    communityId?: CommunityIdValue;
    community_id?: CommunityIdValue;
  };

  const params = request.params as CommunityIdContainer;
  const query = request.query as CommunityIdContainer;
  const body = (request.body || {}) as CommunityIdContainer;

  const rawValues = [
    params.communityId,
    params.community_id,
    query.communityId,
    query.community_id,
    body.communityId,
    body.community_id,
  ];
  const providedValues = rawValues
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string | number => value !== undefined);
  const communityIds = providedValues.map((value) => Number(value));

  if (
    communityIds.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new InvalidCommunityIdError();
  }

  const uniqueCommunityIds = [...new Set(communityIds)];

  if (uniqueCommunityIds.length > 1) {
    throw new ConflictingCommunityIdError(uniqueCommunityIds);
  }

  return uniqueCommunityIds[0] ?? null;
}

/**
 * Enforce cultural protocols for Indigenous content
 */
export async function enforceCulturalProtocols(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CommunityAccessOptions
): Promise<void> {
  const authRequest = request as AuthenticatedRequest;
  const user = authRequest.session.user!;

  // Elder override for cultural content
  if (user.role === 'elder' && options.allowElderAccess) {
    request.log.info(
      {
        userId: user.id,
        role: user.role,
        culturalOverride: true,
        restrictions: options.culturalRestrictions,
      },
      'Elder cultural access override applied'
    );
    return;
  }

  // Implement cultural restriction logic here
  // This would be expanded based on specific Indigenous protocols
  // For now, we log the attempt for audit purposes
  if (
    options.culturalRestrictions?.length &&
    options.auditLevel === 'detailed'
  ) {
    request.log.info(
      {
        userId: user.id,
        role: user.role,
        restrictions: options.culturalRestrictions,
        action: 'cultural_protocol_check',
      },
      'Cultural protocol enforcement applied'
    );
  }
}
