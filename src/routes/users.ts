/**
 * Community-Scoped User Management Routes
 *
 * Regular user management endpoints for community admins to manage users
 * within their community boundaries, enforcing Indigenous data sovereignty.
 *
 * These endpoints provide community-scoped user CRUD operations separate
 * from super admin endpoints, ensuring data isolation and proper access control.
 *
 * Key Features:
 * - Community data sovereignty (users can only manage users in their community)
 * - Role-based access control (admin role required)
 * - Comprehensive input validation with Zod schemas
 * - Proper error handling with appropriate HTTP status codes
 * - OpenAPI/Swagger documentation for all endpoints
 * - Prevents super admin role creation/assignment through community endpoints
 *
 * Endpoints:
 * - GET    /api/v1/users       - List users with pagination and filtering
 * - GET    /api/v1/users/:id   - Get specific user details
 * - POST   /api/v1/users       - Create new user in community
 * - PUT    /api/v1/users/:id   - Update user (full update)
 * - PATCH  /api/v1/users/:id   - Update user (partial update)
 * - DELETE /api/v1/users/:id   - Delete/deactivate user
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  requireAuth,
  requireRole,
} from '../shared/middleware/auth.middleware.js';
import {
  UserService,
  DuplicateEmailError,
  WeakPasswordError,
  InvalidCommunityError,
  UserNotFoundError,
} from '../services/user.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { getDb, type Database } from '../db/index.js';
import { toISOString } from '../shared/utils/date-transforms.js';

// Validation schemas for community-scoped user operations
const UserIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'User ID must be a positive integer'),
});

const UserListQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  search: z.string().max(100).optional(),
  role: z.enum(['admin', 'editor', 'viewer', 'elder']).optional(),
  active: z.enum(['true', 'false']).optional(),
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

// Manual JSON Schema constants for Swagger documentation
const ERROR_SCHEMAS = {
  400: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number', const: 400 },
    },
  },
  401: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number', const: 401 },
    },
  },
  403: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number', const: 403 },
    },
  },
  404: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number', const: 404 },
    },
  },
  409: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number', const: 409 },
    },
  },
  500: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number' },
    },
  },
};

const USER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    email: { type: 'string', format: 'email' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'editor', 'viewer', 'elder'] },
    communityId: { type: 'number' },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

export async function userRoutes(
  app: FastifyInstance,
  options?: { database?: Database }
) {
  // Initialize services
  const db = options?.database || (await getDb());
  const userRepository = new UserRepository(db);
  const userService = new UserService(userRepository);

  // Apply authentication and role requirement to all routes
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole(['admin']));

  // GET /api/v1/users - List users in authenticated user's community
  app.get('/', {
    schema: {
      description:
        'List users in authenticated user community with pagination and filtering',
      tags: ['User Management'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', pattern: '^\\d+$' },
          limit: { type: 'string', pattern: '^\\d+$' },
          search: { type: 'string', maxLength: 100 },
          role: {
            type: 'string',
            enum: ['admin', 'editor', 'viewer', 'elder'],
          },
          active: { type: 'string', enum: ['true', 'false'] },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: USER_RESPONSE_SCHEMA,
            },
            meta: {
              type: 'object',
              properties: {
                page: { type: 'number' },
                limit: { type: 'number' },
                total: { type: 'number' },
                totalPages: { type: 'number' },
              },
            },
          },
        },
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Querystring: z.infer<typeof UserListQuerySchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any;
        const currentUser = authRequest.user;

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        // Parse and validate query parameters
        const query = UserListQuerySchema.parse(request.query);
        const { page, limit, search, role, active } = query;

        // Convert string parameters to appropriate types
        const pageNum = page ? parseInt(page, 10) : 1;
        const limitNum = limit ? parseInt(limit, 10) : 20;
        const activeFilter = active ? active === 'true' : undefined;

        // Get users in the current user's community
        const result = await userService.getAllUsersByCommunity({
          communityId: currentUser.communityId,
          page: pageNum,
          limit: limitNum,
          search,
          role,
          active: activeFilter,
        });

        // Transform response to include formatted dates
        const transformedData = result.data.map((user) => ({
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          communityId: user.communityId,
          isActive: user.isActive,
          createdAt: toISOString(user.createdAt),
          updatedAt: toISOString(user.updatedAt),
        }));

        return reply.status(200).send({
          data: transformedData,
          meta: result.meta,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ error: errorMessage }, 'Failed to list users');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // GET /api/v1/users/:id - Get specific user details (community-scoped)
  app.get('/:id', {
    schema: {
      description: 'Get user details for user in same community',
      tags: ['User Management'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^\\d+$' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: USER_RESPONSE_SCHEMA,
          },
        },
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof UserIdParamSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any;
        const currentUser = authRequest.user;

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const { id } = UserIdParamSchema.parse(request.params);
        const userId = parseInt(id, 10);

        // Get user in the same community
        const user = await userService.getUserByIdInCommunity(
          userId,
          currentUser.communityId
        );

        if (!user) {
          return reply.status(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        const responseData = {
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

        return reply.status(200).send({ data: responseData });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to get user'
        );
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // POST /api/v1/users - Create new user in authenticated user's community
  app.post('/', {
    schema: {
      description: 'Create new user in authenticated user community',
      tags: ['User Management'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email', maxLength: 255 },
          password: { type: 'string', minLength: 8, maxLength: 128 },
          firstName: { type: 'string', minLength: 1, maxLength: 50 },
          lastName: { type: 'string', minLength: 1, maxLength: 50 },
          role: {
            type: 'string',
            enum: ['admin', 'editor', 'viewer', 'elder'],
            default: 'viewer',
          },
          isActive: { type: 'boolean', default: true },
        },
        required: ['email', 'password', 'firstName', 'lastName'],
        additionalProperties: false,
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: USER_RESPONSE_SCHEMA,
            message: { type: 'string' },
          },
        },
        400: ERROR_SCHEMAS[400],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        409: ERROR_SCHEMAS[409],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof CreateUserSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any;
        const currentUser = authRequest.user;

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const userData = CreateUserSchema.parse(request.body);

        // Create user in the current user's community
        const user = await userService.createUserInCommunity({
          ...userData,
          communityId: currentUser.communityId,
        });

        const responseData = {
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

        return reply.status(201).send({
          data: responseData,
          message: 'User created successfully',
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ error: errorMessage }, 'Failed to create user');

        if (error instanceof DuplicateEmailError) {
          return reply.status(409).send({
            error: error.message,
            statusCode: 409,
          });
        }

        if (error instanceof WeakPasswordError) {
          return reply.status(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        if (error instanceof InvalidCommunityError) {
          return reply.status(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        if (errorMessage.includes('Cannot create super admin')) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // PUT /api/v1/users/:id - Update user (community-scoped)
  app.put('/:id', {
    schema: {
      description: 'Update user in same community (full update)',
      tags: ['User Management'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^\\d+$' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          firstName: { type: 'string', minLength: 1, maxLength: 50 },
          lastName: { type: 'string', minLength: 1, maxLength: 50 },
          role: {
            type: 'string',
            enum: ['admin', 'editor', 'viewer', 'elder'],
          },
          isActive: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: USER_RESPONSE_SCHEMA,
            message: { type: 'string' },
          },
        },
        400: ERROR_SCHEMAS[400],
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof UserIdParamSchema>;
        Body: z.infer<typeof UpdateUserSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any;
        const currentUser = authRequest.user;

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const { id } = UserIdParamSchema.parse(request.params);
        const userId = parseInt(id, 10);
        const updateData = UpdateUserSchema.parse(request.body);

        // Update user in the same community
        const user = await userService.updateUserInCommunity(
          userId,
          updateData,
          currentUser.communityId
        );

        const responseData = {
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

        return reply.status(200).send({
          data: responseData,
          message: 'User updated successfully',
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to update user'
        );

        if (error instanceof UserNotFoundError) {
          return reply.status(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        if (error instanceof DuplicateEmailError) {
          return reply.status(409).send({
            error: error.message,
            statusCode: 409,
          });
        }

        if (errorMessage.includes('Cannot assign super admin')) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // PATCH /api/v1/users/:id - Partially update user (community-scoped)
  app.patch('/:id', {
    schema: {
      description: 'Partially update user in same community',
      tags: ['User Management'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^\\d+$' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          firstName: { type: 'string', minLength: 1, maxLength: 50 },
          lastName: { type: 'string', minLength: 1, maxLength: 50 },
          role: {
            type: 'string',
            enum: ['admin', 'editor', 'viewer', 'elder'],
          },
          isActive: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: USER_RESPONSE_SCHEMA,
            message: { type: 'string' },
          },
        },
        400: ERROR_SCHEMAS[400],
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof UserIdParamSchema>;
        Body: z.infer<typeof UpdateUserSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any;
        const currentUser = authRequest.user;

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const { id } = UserIdParamSchema.parse(request.params);
        const userId = parseInt(id, 10);
        const updateData = UpdateUserSchema.parse(request.body);

        // Update user in the same community (same logic as PUT)
        const user = await userService.updateUserInCommunity(
          userId,
          updateData,
          currentUser.communityId
        );

        const responseData = {
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

        return reply.status(200).send({
          data: responseData,
          message: 'User updated successfully',
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to update user'
        );

        if (error instanceof UserNotFoundError) {
          return reply.status(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        if (error instanceof DuplicateEmailError) {
          return reply.status(409).send({
            error: error.message,
            statusCode: 409,
          });
        }

        if (errorMessage.includes('Cannot assign super admin')) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // DELETE /api/v1/users/:id - Delete user (community-scoped)
  app.delete('/:id', {
    schema: {
      description: 'Delete user in same community',
      tags: ['User Management'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^\\d+$' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                id: { type: 'number' },
              },
            },
          },
        },
        400: ERROR_SCHEMAS[400],
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof UserIdParamSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any;
        const currentUser = authRequest.user;

        if (!currentUser) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const { id } = UserIdParamSchema.parse(request.params);
        const userId = parseInt(id, 10);

        // Delete user in the same community
        const result = await userService.deleteUserInCommunity(
          userId,
          currentUser.communityId,
          currentUser.id
        );

        return reply.status(200).send({ data: result });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to delete user'
        );

        if (error instanceof UserNotFoundError) {
          return reply.status(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        if (errorMessage.includes('cannot delete themselves')) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });
}
