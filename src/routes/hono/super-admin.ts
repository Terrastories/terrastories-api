/**
 * Hono Super Admin Routes
 *
 * V2 equivalent of Fastify super_admin routes.
 * System-level administrative endpoints for super admin users only.
 * Provides cross-community access while enforcing Indigenous data sovereignty.
 *
 * Mounted at /v2/super-admin/*
 *
 * NOTE: Data sovereignty enforcement is NOT applied here because these routes
 * are FOR super admins (system administration) and do not expose cultural data
 * (stories, places, speakers). Data sovereignty is enforced on /v2/member/* routes.
 *
 * Pattern: requireSuperAdmin → Zod validation → service layer → JSON response
 */

import { Hono } from 'hono';
import {
  toISOString,
  toISOStringOrNull,
} from '../../shared/utils/date-transforms.js';
import {
  CommunityService,
  CommunityValidationError,
  CommunityOperationError,
} from '../../services/community.service.js';
import {
  UserService,
  DuplicateEmailError,
  WeakPasswordError,
  InvalidCommunityError,
  UserNotFoundError,
} from '../../services/user.service.js';
import { CommunityRepository } from '../../repositories/community.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import type { Database } from '../../db/index.js';
import {
  getAuditLogger,
  SuperAdminAuditLogger,
} from '../../shared/utils/audit-logger.js';
import {
  listCommunitiesQuerySchema,
  createCommunitySchema,
  updateCommunitySchema,
  communityIdParamSchema,
  listUsersQuerySchema,
  createUserSchema,
  updateUserSchema,
  userIdParamSchema,
} from '../../shared/schemas/super-admin.js';
import {
  requireAuth,
  requireSuperAdmin,
  getCurrentUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../hono-app.js';
import { handleHonoError } from '../../shared/middleware/hono-error.middleware.js';

export function createSuperAdminRoutes(database?: Database): Hono<AppEnv> {
  const superAdmin = new Hono<AppEnv>();

  const db = database;
  if (!db) return superAdmin;

  // Initialize services
  const communityRepository = new CommunityRepository(db);
  const userRepository = new UserRepository(db);
  const communityService = new CommunityService(communityRepository);
  const userService = new UserService(userRepository, communityRepository);

  // Initialize audit logger for Indigenous oversight
  const auditLogger = getAuditLogger();

  // Apply auth + super admin protection to all routes below.
  // (Equivalent to Fastify's app.addHook('preHandler', requireRole(['super_admin'])).)
  superAdmin.use('*', requireAuth, requireSuperAdmin);

  // ============================================================
  // COMMUNITY MANAGEMENT
  // ============================================================

  // GET /communities — List all communities
  superAdmin.get('/communities', async (c) => {
    try {
      const query = listCommunitiesQuerySchema.parse(c.req.query());
      const { page, limit, search, locale, active } = query;

      const result = await communityService.getAllCommunitiesForSuperAdmin({
        page,
        limit,
        search,
        locale,
        active,
      });

      // Add user counts for each community
      const dataWithUserCounts = await Promise.all(
        result.data.map(async (community) => {
          const userCount = await userRepository.countUsersByCommunity(
            community.id
          );
          return {
            ...community,
            userCount,
          };
        })
      );

      return c.json({
        ...result,
        data: dataWithUserCounts,
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /communities/:id — Get specific community
  // getCommunityById returns CommunityResponseSchema with string dates.
  superAdmin.get('/communities/:id', async (c) => {
    try {
      const { id } = communityIdParamSchema.parse({
        id: c.req.param('id'),
      });
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

      const community = await communityService.getCommunityById(
        numericId,
        true
      );

      if (!community) {
        return c.json({ error: 'Community not found' }, 404);
      }

      // Calculate actual user count for this community
      const userCount = await userRepository.countUsersByCommunity(
        community.id
      );

      return c.json({
        data: {
          id: community.id,
          name: community.name,
          description: community.description,
          slug: community.slug,
          locale: community.locale,
          publicStories: community.publicStories,
          isActive: community.isActive,
          userCount,
          createdAt: community.createdAt,
          updatedAt: community.updatedAt,
        },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // POST /communities — Create new community
  // createCommunityAsSuperAdmin returns raw Community with Date objects.
  superAdmin.post('/communities', async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const body = await c.req.json();
      const validated = createCommunitySchema.parse(body);

      const community =
        await communityService.createCommunityAsSuperAdmin(validated);

      // Audit log the community creation
      const auditEntry = SuperAdminAuditLogger.createCommunityEntry(
        'community_create',
        user.id,
        user.email,
        true,
        community.id,
        {
          name: community.name,
          slug: community.slug,
          locale: community.locale,
        }
      );
      auditLogger.log(auditEntry);

      const userCount = await userRepository.countUsersByCommunity(
        community.id
      );

      return c.json(
        {
          data: {
            id: community.id,
            name: community.name,
            description: community.description,
            slug: community.slug,
            locale: community.locale,
            publicStories: community.publicStories,
            isActive: community.isActive,
            userCount,
            createdAt: toISOString(community.createdAt),
            updatedAt: toISOString(community.updatedAt),
          },
          message: 'Community created successfully',
        },
        201
      );
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (
        error instanceof CommunityOperationError &&
        error.message.includes('already exists')
      ) {
        return c.json({ error: error.message }, 409);
      }
      return handleHonoError(c, error);
    }
  });

  // PUT /communities/:id — Update community
  // updateCommunityAsSuperAdmin returns raw Community with Date objects.
  superAdmin.put('/communities/:id', async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = communityIdParamSchema.parse({
        id: c.req.param('id'),
      });
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

      const body = await c.req.json();
      const validated = updateCommunitySchema.parse(body);

      const community = await communityService.updateCommunityAsSuperAdmin(
        numericId,
        validated
      );

      // Audit log the community update
      const auditEntry = SuperAdminAuditLogger.createCommunityEntry(
        'community_update',
        user.id,
        user.email,
        true,
        community.id,
        {
          name: community.name,
          changes: validated,
        }
      );
      auditLogger.log(auditEntry);

      const userCount = await userRepository.countUsersByCommunity(
        community.id
      );

      return c.json({
        data: {
          id: community.id,
          name: community.name,
          description: community.description,
          slug: community.slug,
          locale: community.locale,
          publicStories: community.publicStories,
          isActive: community.isActive,
          userCount,
          createdAt: toISOString(community.createdAt),
          updatedAt: toISOString(community.updatedAt),
        },
        message: 'Community updated successfully',
      });
    } catch (error) {
      if (error instanceof CommunityValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (
        error instanceof CommunityOperationError &&
        error.message.includes('not found')
      ) {
        return c.json({ error: 'Community not found' }, 404);
      }
      return handleHonoError(c, error);
    }
  });

  // DELETE /communities/:id — Archive community
  superAdmin.delete('/communities/:id', async (c) => {
    try {
      const { id } = communityIdParamSchema.parse({
        id: c.req.param('id'),
      });
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

      const result =
        await communityService.archiveCommunityAsSuperAdmin(numericId);

      return c.json({ data: result });
    } catch (error) {
      if (
        error instanceof CommunityOperationError &&
        error.message.includes('not found')
      ) {
        return c.json({ error: 'Community not found' }, 404);
      }
      return handleHonoError(c, error);
    }
  });

  // ============================================================
  // USER MANAGEMENT
  // ============================================================

  // GET /users — List all users
  superAdmin.get('/users', async (c) => {
    try {
      const query = listUsersQuerySchema.parse(c.req.query());
      const { page, limit, community, role, search, active } = query;

      const result = await userService.getAllUsersForSuperAdmin({
        page,
        limit,
        community,
        role,
        search,
        active,
      });

      // Community names are included via JOIN query in repository
      return c.json(result);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /users/:id — Get specific user
  superAdmin.get('/users/:id', async (c) => {
    try {
      const { id } = userIdParamSchema.parse({ id: c.req.param('id') });
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

      const user = await userService.getUserByIdWithCommunityName(numericId);

      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      const communityName =
        user.communityName || `Community ${user.communityId}`;

      return c.json({
        data: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          communityId: user.communityId,
          communityName,
          isActive: user.isActive,
          createdAt: toISOString(user.createdAt),
          updatedAt: toISOString(user.updatedAt),
          lastLoginAt: toISOStringOrNull(user.lastLoginAt),
        },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // POST /users — Create new user
  superAdmin.post('/users', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const body = await c.req.json();
      const validated = createUserSchema.parse(body);

      const user = await userService.createUserAsSuperAdmin(validated);

      // Audit log the user creation
      const auditEntry = SuperAdminAuditLogger.createUserEntry(
        'user_create',
        currentUser.id,
        currentUser.email,
        true,
        user.id,
        {
          email: user.email,
          role: user.role,
          communityId: user.communityId,
        }
      );
      auditLogger.log(auditEntry);

      // Get community name efficiently in single query
      const userWithCommunity =
        await userRepository.findByIdWithCommunityName(user.id);
      const communityName =
        userWithCommunity?.communityName || `Community ${user.communityId}`;

      return c.json(
        {
          data: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            communityId: user.communityId,
            communityName,
            isActive: user.isActive,
            createdAt: toISOString(user.createdAt),
            updatedAt: toISOString(user.updatedAt),
            lastLoginAt: null,
          },
          message: 'User created successfully',
        },
        201
      );
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof WeakPasswordError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof InvalidCommunityError) {
        return c.json({ error: error.message }, 400);
      }
      return handleHonoError(c, error);
    }
  });

  // PUT /users/:id — Update user
  superAdmin.put('/users/:id', async (c) => {
    try {
      const { id } = userIdParamSchema.parse({ id: c.req.param('id') });
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

      const body = await c.req.json();
      const validated = updateUserSchema.parse(body);

      const user = await userService.updateUserAsSuperAdmin(
        numericId,
        validated
      );

      // Get community name efficiently in single query
      const userWithCommunity =
        await userRepository.findByIdWithCommunityName(user.id);
      const communityName =
        userWithCommunity?.communityName || `Community ${user.communityId}`;

      return c.json({
        data: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          communityId: user.communityId,
          communityName,
          isActive: user.isActive,
          createdAt: toISOString(user.createdAt),
          updatedAt: toISOString(user.updatedAt),
          lastLoginAt: toISOStringOrNull(user.lastLoginAt),
        },
        message: 'User updated successfully',
      });
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return c.json({ error: 'User not found' }, 404);
      }
      if (error instanceof DuplicateEmailError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof InvalidCommunityError) {
        return c.json({ error: error.message }, 400);
      }
      return handleHonoError(c, error);
    }
  });

  // DELETE /users/:id — Deactivate user
  superAdmin.delete('/users/:id', async (c) => {
    try {
      const { id } = userIdParamSchema.parse({ id: c.req.param('id') });
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

      const result = await userService.deactivateUserAsSuperAdmin(numericId);

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        return c.json({ error: 'User not found' }, 404);
      }
      return handleHonoError(c, error);
    }
  });

  return superAdmin;
}
