/**
 * Authentication Routes
 *
 * Handles complete authentication system with session-based authentication.
 * Provides comprehensive input validation, error handling, and security measures.
 *
 * Features:
 * - User registration with password validation
 * - Session-based login with secure cookies
 * - Secure logout with session destruction and cookie clearing
 * - Community-scoped authentication
 * - Rate limiting and security headers
 * - Comprehensive error handling
 * - Authentication middleware integration
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { UserService } from '../services/user.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { getDb } from '../db/index.js';
import {
  setUserSession,
  clearUserSession,
  getCurrentUser,
  requireAuth,
  requireAdmin,
  type UserSession,
} from '../shared/middleware/auth.middleware.js';
import { getConfig } from '../shared/config/index.js';

// Request validation schemas with strict validation
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

// Response schemas for Swagger documentation (for future use)
// const userResponseSchema = z.object({
//   id: z.number(),
//   email: z.string().email(),
//   firstName: z.string(),
//   lastName: z.string(),
//   role: z.enum(['super_admin', 'admin', 'editor', 'viewer']),
//   communityId: z.number(),
//   isActive: z.boolean(),
//   createdAt: z.string(),
//   updatedAt: z.string(),
// });

// const errorResponseSchema = z.object({
//   error: z.string(),
//   statusCode: z.number(),
//   details: z.array(z.string()).optional(),
// });

export async function authRoutes(
  fastify: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { database?: any }
) {
  // Initialize services - use provided database instance or default
  const database = options?.database || (await getDb());
  const userRepository = new UserRepository(database);
  const userService = new UserService(userRepository);
  const config = getConfig();

  // Import middleware for data sovereignty protection
  const { requireDataSovereignty } = await import(
    '../shared/middleware/auth.middleware.js'
  );

  /**
   * User Registration Endpoint
   * POST /auth/register
   */
  fastify.post(
    '/auth/register',
    {
      config: {
        rateLimit: {
          max: config.auth.rateLimit.max,
          timeWindow: config.auth.rateLimit.timeWindow,
        },
      },
      schema: {
        description:
          'Register a new user with password hashing and community association',
        tags: ['Authentication'],
        response: {
          201: {
            description: 'User successfully registered',
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  email: { type: 'string', format: 'email' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['super_admin', 'admin', 'editor', 'elder', 'viewer'],
                  },
                  communityId: { type: 'number' },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          400: {
            description: 'Bad request - validation errors',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
              details: { type: 'array', items: { type: 'string' } },
            },
          },
          409: {
            description: 'Conflict - email already exists in community',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate request body
        const validatedData = registerSchema.parse(request.body);

        // Register user
        const user = await userService.registerUser(validatedData);

        // Create clean response object (avoiding destructuring issues)
        const userResponse = {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          communityId: user.communityId,
          isActive: user.isActive,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        };

        // Return success response - schema expects user property wrapper
        return reply.status(201).send({ user: userResponse });
      } catch (error) {
        fastify.log.error({ error, url: request.url }, 'Registration error');

        // Handle specific business logic errors
        if (error instanceof z.ZodError) {
          // Extract the first specific error message for consistency with tests
          const firstError = error.issues[0];
          const errorMessage = firstError
            ? firstError.message
            : 'Validation failed';
          return reply.status(400).send({
            error: errorMessage,
          });
        }

        // Handle user service errors
        if (error instanceof Error) {
          switch (error.constructor.name) {
            case 'DuplicateEmailError':
              return reply.status(409).send({
                error: error.message,
              });
            case 'WeakPasswordError':
              return reply.status(400).send({
                error: error.message,
              });
            case 'InvalidCommunityError':
              return reply.status(400).send({
                error: error.message,
              });
            default:
              // Generic user service errors
              if (
                error.message.includes('Invalid email format') ||
                error.message.includes('required') ||
                error.message.includes('Invalid role')
              ) {
                return reply.status(400).send({
                  error: error.message,
                });
              }
          }
        }

        // Generic server error
        return reply.status(500).send({
          error: 'An unexpected error occurred',
        });
      }
    }
  );

  /**
   * User Login Endpoint
   * POST /auth/login
   */
  fastify.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: config.auth.rateLimit.max,
          timeWindow: config.auth.rateLimit.timeWindow,
        },
      },
      schema: {
        description: 'Authenticate user and create session',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'User successfully authenticated',
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  email: { type: 'string', format: 'email' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['super_admin', 'admin', 'editor', 'elder', 'viewer'],
                  },
                  communityId: { type: 'number' },
                  isActive: { type: 'boolean' },
                },
              },
              sessionId: { type: 'string', description: 'Session identifier' },
            },
          },
          400: {
            description: 'Bad request - validation errors',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
              details: { type: 'array', items: { type: 'string' } },
            },
          },
          401: {
            description: 'Unauthorized - invalid credentials',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Validate request body
        const validatedData = loginSchema.parse(request.body);

        // Authenticate user
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

        // Create secure session with user data
        const userSession: UserSession = {
          id: user.id,
          email: user.email,
          role: user.role,
          communityId: user.communityId,
          firstName: user.firstName,
          lastName: user.lastName,
        };

        // Set user session using middleware helper
        setUserSession(request, userSession);

        // Remove sensitive data from response
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { passwordHash, ...userResponse } = user;

        // Return success response with user data (sessionId is handled by cookie)
        return reply.status(200).send({
          user: {
            ...userResponse,
            createdAt: userResponse.createdAt.toISOString(),
            updatedAt: userResponse.updatedAt.toISOString(),
          },
          sessionId: request.session.sessionId || 'session-created',
        });
      } catch (error) {
        fastify.log.error({ error, url: request.url }, 'Login error');

        // Handle validation errors
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: 'Validation failed',
            statusCode: 400,
            details: error.issues.map(
              (err) => `${err.path.join('.')}: ${err.message}`
            ),
          });
        }

        // Handle authentication errors
        if (error instanceof Error) {
          if (
            error.constructor.name === 'AuthenticationError' ||
            error.message.includes('Invalid email or password')
          ) {
            return reply.status(401).send({
              error: 'Invalid email or password',
              statusCode: 401,
            });
          }
        }

        // Generic server error
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Logout Endpoint
   * POST /auth/logout
   */
  fastify.post(
    '/auth/logout',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Destroy user session and logout',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'Successfully logged out',
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          500: {
            description: 'Internal server error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Get current user for logging
        const currentUser = getCurrentUser(request);

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        // Log the logout event for security monitoring
        fastify.log.info(
          {
            userId: currentUser.id,
            communityId: currentUser.communityId,
          },
          'User logout'
        );

        // Clear user session using middleware helper
        clearUserSession(request);

        // Destroy the session entirely
        await request.session.destroy();

        // Clear session cookie
        reply.clearCookie('sessionId', {
          path: '/',
          httpOnly: true,
          secure: config.auth.session.secure,
          sameSite: 'lax',
        });

        return reply.status(200).send({
          message: 'Successfully logged out',
        });
      } catch (error) {
        fastify.log.error({ error, url: request.url }, 'Logout error');

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Current User Endpoint
   * GET /auth/me
   * Protected route that returns current user information
   */
  fastify.get(
    '/auth/me',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get current authenticated user information',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'Current user information',
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  email: { type: 'string', format: 'email' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['super_admin', 'admin', 'editor', 'elder', 'viewer'],
                  },
                  communityId: { type: 'number' },
                  isActive: { type: 'boolean' },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = getCurrentUser(request);

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        return reply.status(200).send({
          user: {
            id: currentUser.id,
            email: currentUser.email,
            firstName: currentUser.firstName,
            lastName: currentUser.lastName,
            role: currentUser.role,
            communityId: currentUser.communityId,
            isActive: true, // Session users are always active
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Get current user error'
        );

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Admin Only Endpoint
   * GET /auth/admin-only
   * Protected route that requires admin privileges
   */
  fastify.get(
    '/auth/admin-only',
    {
      preHandler: [requireAdmin],
      schema: {
        description: 'Admin-only endpoint for testing role-based access',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'Admin access granted',
            type: 'object',
            properties: {
              message: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  role: { type: 'string' },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          403: {
            description: 'Forbidden - insufficient permissions',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = getCurrentUser(request);

        return reply.status(200).send({
          message: 'Admin access granted',
          user: {
            id: currentUser!.id,
            role: currentUser!.role,
          },
        });
      } catch (error) {
        fastify.log.error({ error, url: request.url }, 'Admin endpoint error');

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Test Endpoint for Data Sovereignty
   * GET /auth/community-data
   * Protected route that tests data sovereignty enforcement
   */
  fastify.get(
    '/auth/community-data',
    {
      preHandler: [requireAuth, requireDataSovereignty],
      schema: {
        description:
          'Test endpoint for data sovereignty - super admin should be blocked',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'Community data access granted',
            type: 'object',
            properties: {
              message: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  role: { type: 'string' },
                  communityId: { type: 'number' },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          403: {
            description: 'Forbidden - super admin blocked from community data',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const currentUser = getCurrentUser(request);

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        return reply.status(200).send({
          message: 'Community data access granted',
          user: {
            id: currentUser.id,
            role: currentUser.role,
            communityId: currentUser.communityId,
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Community data access error'
        );

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );
}
