/**
 * Hono Users Routes
 *
 * V2 equivalent of Fastify users routes.
 * Community-scoped user management with Indigenous data sovereignty.
 * Mounted at /v2/users/*
 *
 * Endpoints:
 * - GET    /users       - List users in community (pagination/filtering)
 * - GET    /users/:id   - Get specific user details
 * - POST   /users       - Create user in community
 * - PUT    /users/:id   - Update user (full update)
 * - PATCH  /users/:id   - Update user (partial update)
 * - DELETE /users/:id   - Delete/deactivate user
 *
 * All routes require admin role within the user's community; super_admin is
 * blocked from community endpoints for data sovereignty protection.
 *
 * Pattern: auth middleware → Zod validation → service layer → JSON response
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  UserService,
  DuplicateEmailError,
  WeakPasswordError,
  InvalidCommunityError,
  UserNotFoundError,
  SuperAdminRoleError,
  SelfDeletionError,
} from '../../services/user.service.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { CommunityRepository } from '../../repositories/community.repository.js';
import { getDb, type Database } from '../../db/index.js';
import { toISOString } from '../../shared/utils/date-transforms.js';
import {
  requireAuth,
  getCurrentUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../hono-app.js';
import { handleHonoError } from '../../shared/middleware/hono-error.middleware.js';

// ========================================
// VALIDATION SCHEMAS
// ========================================

const UserIdParamSchema = z.object({
  id: z.coerce.number().int().min(1),
});

const UserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(100).optional(),
  role: z.enum(['admin', 'editor', 'viewer', 'elder']).optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const CreateUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  role: z
    .enum(['admin', 'editor', 'viewer', 'elder'])
    .optional()
    .default('viewer'),
  isActive: z.boolean().optional().default(true),
});

const UpdateUserSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().min(1).max(50).optional(),
  role: z.enum(['admin', 'editor', 'viewer', 'elder']).optional(),
  isActive: z.boolean().optional(),
});

// ========================================
// HELPERS
// ========================================

interface UserResponse {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  communityId: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function transformUser(user: {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  communityId: number;
  isActive: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    communityId: user.communityId,
    isActive: user.isActive,
    createdAt: toISOString(user.createdAt),
    updatedAt: toISOString(user.updatedAt),
  };
}

/**
 * Community-scope guard: blocks super_admin (data sovereignty) and requires
 * the admin role for community user management. Returns a Response on failure
 * or null when access is granted.
 */
function enforceCommunityAdmin(c: {
  json: (body: unknown, status: 401 | 403) => Response;
}): Response | null {
  // NOTE: getCurrentUser is checked by requireAuth upstream; this guard is a
  // belt-and-suspenders check and handles role authorization.
  const user = getCurrentUser(c as never);
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  if (user.role === 'super_admin') {
    return c.json(
      {
        error:
          'Access blocked on community endpoints for data sovereignty',
      },
      403
    );
  }
  if (user.role !== 'admin') {
    return c.json(
      { error: 'Insufficient permissions. Admin role required.' },
      403
    );
  }
  return null;
}

// ========================================
// ROUTE SETUP
// ========================================

export async function createUsersRoutes(
  database?: Database
): Promise<Hono<AppEnv>> {
  const users = new Hono<AppEnv>();

  // Initialize services
  const db: Database = database ?? (await getDb());
  const userRepository = new UserRepository(db);
  const communityRepository = new CommunityRepository(db);
  const userService = new UserService(userRepository, communityRepository);

  // Apply community-admin auth guard to all routes beneath.
  users.use('*', requireAuth, async (c, next) => {
    const blocked = enforceCommunityAdmin(c);
    if (blocked) return blocked;
    await next();
  });

  // GET /users — List users in authenticated user's community
  users.get('/', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const query = UserListQuerySchema.parse(c.req.query());

      const result = await userService.getAllUsersByCommunity({
        communityId: currentUser.communityId,
        page: query.page,
        limit: query.limit,
        search: query.search,
        role: query.role,
        active: query.active,
      });

      const transformedData = result.data.map(transformUser);

      return c.json({
        data: transformedData,
        meta: result.meta,
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /users/:id — Get specific user details (community-scoped)
  users.get('/:id', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const { id } = UserIdParamSchema.parse({ id: c.req.param('id') });

      const user = await userService.getUserByIdInCommunity(
        id,
        currentUser.communityId
      );

      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      return c.json({ data: transformUser(user) });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // POST /users — Create new user in authenticated user's community
  users.post('/', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const body = await c.req.json();
      const userData = CreateUserSchema.parse(body);

      const user = await userService.createUserInCommunity({
        ...userData,
        communityId: currentUser.communityId,
      });

      return c.json(
        {
          data: transformUser(user),
          message: 'User created successfully',
        },
        201
      );
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /users/:id — Update user (full update, community-scoped)
  users.put('/:id', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const { id } = UserIdParamSchema.parse({ id: c.req.param('id') });
      const body = await c.req.json();
      const updateData = UpdateUserSchema.parse(body);

      const user = await userService.updateUserInCommunity(
        id,
        updateData,
        currentUser.communityId
      );

      return c.json({
        data: transformUser(user),
        message: 'User updated successfully',
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PATCH /users/:id — Partially update user (community-scoped)
  users.patch('/:id', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const { id } = UserIdParamSchema.parse({ id: c.req.param('id') });
      const body = await c.req.json();
      const updateData = UpdateUserSchema.parse(body);

      const user = await userService.updateUserInCommunity(
        id,
        updateData,
        currentUser.communityId
      );

      return c.json({
        data: transformUser(user),
        message: 'User updated successfully',
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // DELETE /users/:id — Delete user (community-scoped)
  users.delete('/:id', async (c) => {
    try {
      const currentUser = getCurrentUser(c)!;
      const { id } = UserIdParamSchema.parse({ id: c.req.param('id') });

      const result = await userService.deleteUserInCommunity(
        id,
        currentUser.communityId,
        currentUser.id
      );

      return c.json({ data: result });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  return users;
}

// Re-export error classes so legacy imports/tests resolve as expected
export {
  DuplicateEmailError,
  WeakPasswordError,
  InvalidCommunityError,
  UserNotFoundError,
  SuperAdminRoleError,
  SelfDeletionError,
};
