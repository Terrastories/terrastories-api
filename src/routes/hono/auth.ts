/**
 * Hono Auth Routes
 *
 * V2 equivalent of Fastify auth routes.
 * Handles register, login, logout, me, admin-only, community-data.
 * Mounted at /v2/auth/*
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { UserService } from '../../services/user.service.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { CommunityRepository } from '../../repositories/community.repository.js';
import { getDb, type Database } from '../../db/index.js';
import {
  requireAuth,
  requireAdmin,
  enforceDataSovereignty,
  createSession,
  destroySession,
  getCurrentUser,
  type SessionUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../hono-app.js';

// ========================================
// VALIDATION SCHEMAS
// ========================================

const registerSchema = z
  .object({
    email: z.string().trim().email('Invalid email format'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(128, 'Password too long'),
    firstName: z
      .string()
      .trim()
      .min(1, 'First name is required')
      .max(100, 'First name too long'),
    lastName: z
      .string()
      .trim()
      .min(1, 'Last name is required')
      .max(100, 'Last name too long'),
    role: z
      .enum(['super_admin', 'admin', 'editor', 'elder', 'viewer'])
      .default('viewer'),
    communityId: z
      .number()
      .int()
      .positive('Community ID must be a positive integer'),
  })
  .strict();

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
  communityId: z
    .number()
    .int()
    .positive('Community ID must be a positive integer')
    .optional(),
});

// ========================================
// ROUTE SETUP
// ========================================

export async function createAuthRoutes(database?: Database): Promise<Hono<AppEnv>> {
  const authRoutes = new Hono<AppEnv>();

  // Initialize services
  const db: Database = database ?? (await getDb());
  const userRepository = new UserRepository(db);
  const communityRepository = new CommunityRepository(db);
  const userService = new UserService(userRepository, communityRepository);

  /**
   * POST /auth/register
   */
  authRoutes.post('/auth/register', async (c) => {
    try {
      const body = await c.req.json();
      const validatedData = registerSchema.parse(body);

      const user = await userService.registerUser(validatedData);

      return c.json(
        {
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            communityId: user.communityId,
            isActive: user.isActive,
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
          },
        },
        201
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.issues[0];
        return c.json(
          { error: firstError ? firstError.message : 'Validation failed' },
          400
        );
      }

      if (error instanceof Error) {
        switch (error.constructor.name) {
          case 'DuplicateEmailError':
            return c.json({ error: error.message }, 409);
          case 'WeakPasswordError':
            return c.json({ error: error.message }, 400);
          case 'InvalidCommunityError':
            return c.json({ error: error.message }, 400);
          default:
            if (
              error.message.includes('Invalid email format') ||
              error.message.includes('required') ||
              error.message.includes('Invalid role')
            ) {
              return c.json({ error: error.message }, 400);
            }
        }
      }

      return c.json({ error: 'An unexpected error occurred' }, 500);
    }
  });

  /**
   * POST /auth/login
   */
  authRoutes.post('/auth/login', async (c) => {
    try {
      const body = await c.req.json();
      const validatedData = loginSchema.parse(body);

      const user = validatedData.communityId
        ? await userService.authenticateUser(
            validatedData.email,
            validatedData.password,
            validatedData.communityId
          )
        : await userService.authenticateUserGlobal(
            validatedData.email,
            validatedData.password
          );

      const userSession: SessionUser = {
        id: user.id,
        email: user.email,
        role: user.role as SessionUser['role'],
        communityId: user.communityId,
        firstName: user.firstName,
        lastName: user.lastName,
      };

      const sessionId = await createSession(c, userSession);

      return c.json(
        {
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            communityId: user.communityId,
            isActive: user.isActive,
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
          },
          sessionId,
        },
        200
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          {
            error: 'Validation failed',
            statusCode: 400,
            details: error.issues.map(
              (err) => `${err.path.join('.')}: ${err.message}`
            ),
          },
          400
        );
      }

      if (error instanceof Error) {
        if (
          error.constructor.name === 'AuthenticationError' ||
          error.message.includes('Invalid email or password')
        ) {
          return c.json(
            {
              error: 'Invalid email or password',
              statusCode: 401,
            },
            401
          );
        }
      }

      return c.json(
        { error: 'Internal server error', statusCode: 500 },
        500
      );
    }
  });

  /**
   * POST /auth/logout
   */
  authRoutes.post('/auth/logout', requireAuth, async (c) => {
    try {
      await destroySession(c);
      return c.json({ message: 'Successfully logged out' });
    } catch (error) {
      return c.json(
        { error: 'Internal server error', statusCode: 500 },
        500
      );
    }
  });

  /**
   * GET /auth/me
   */
  authRoutes.get('/auth/me', requireAuth, async (c) => {
    const currentUser = getCurrentUser(c);
    if (!currentUser) {
      return c.json(
        { error: 'Authentication required', statusCode: 401 },
        401
      );
    }

    return c.json({
      user: {
        id: currentUser.id,
        email: currentUser.email,
        firstName: currentUser.firstName,
        lastName: currentUser.lastName,
        role: currentUser.role,
        communityId: currentUser.communityId,
        isActive: true,
      },
    });
  });

  /**
   * GET /auth/admin-only
   */
  authRoutes.get('/auth/admin-only', requireAuth, requireAdmin, async (c) => {
    const currentUser = getCurrentUser(c);
    return c.json({
      message: 'Admin access granted',
      user: {
        id: currentUser!.id,
        role: currentUser!.role,
      },
    });
  });

  /**
   * GET /auth/community-data
   * Tests data sovereignty enforcement.
   */
  authRoutes.get(
    '/auth/community-data',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      const currentUser = getCurrentUser(c);
      return c.json({
        message: 'Community data access granted',
        user: {
          id: currentUser!.id,
          communityId: currentUser!.communityId,
        },
      });
    }
  );

  return authRoutes;
}
