/**
 * Super Admin Routes
 *
 * System-level administrative endpoints for super admin users only.
 * Provides cross-community access while enforcing Indigenous data sovereignty.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { requireRole } from '../shared/middleware/auth.middleware.js';
import {
  toISOString,
  toISOStringOrNull,
} from '../shared/utils/date-transforms.js';
import {
  CommunityService,
  CommunityValidationError,
  CommunityOperationError,
} from '../services/community.service.js';
import {
  UserService,
  DuplicateEmailError,
  WeakPasswordError,
  InvalidCommunityError,
  UserNotFoundError,
} from '../services/user.service.js';
import { CommunityRepository } from '../repositories/community.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { getDb } from '../db/index.js';
import {
  listCommunitiesQuerySchema,
  createCommunitySchema,
  updateCommunitySchema,
  communityIdParamSchema,
  listUsersQuerySchema,
  createUserSchema,
  updateUserSchema,
  userIdParamSchema,
  paginatedCommunitiesResponseSchema as _paginatedCommunitiesResponseSchema,
  paginatedUsersResponseSchema,
  communityCreatedResponseSchema,
  communityUpdatedResponseSchema,
  communityDeletedResponseSchema,
  userCreatedResponseSchema,
  userUpdatedResponseSchema,
  userDeletedResponseSchema,
  errorResponseSchema as _errorResponseSchema,
  validationErrorSchema as _validationErrorSchema,
  notFoundErrorSchema as _notFoundErrorSchema,
  forbiddenErrorSchema as _forbiddenErrorSchema,
  unauthorizedErrorSchema as _unauthorizedErrorSchema,
  conflictErrorSchema as _conflictErrorSchema,
} from '../shared/schemas/super-admin.js';

// Manual JSON Schema constants (zodToJsonSchema causes serialization issues)
const ERROR_SCHEMAS = {
  400: {
    type: 'object',
    properties: {
      error: { type: 'string' },
      statusCode: { type: 'number', const: 400 },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
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
      details: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
};

const PARAM_SCHEMAS = {
  communityId: {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^\\d+$' },
    },
    required: ['id'],
  },
  userId: {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^\\d+$' },
    },
    required: ['id'],
  },
};

export async function superAdminRoutes(
  app: FastifyInstance,
  options?: { database?: any }
) {
  // Initialize services - use provided database instance or default
  const db = options?.database || (await getDb());
  const communityRepository = new CommunityRepository(db);
  const userRepository = new UserRepository(db);
  const communityService = new CommunityService(communityRepository);
  const userService = new UserService(userRepository);

  // Add super admin role protection to all routes
  // NOTE: Data sovereignty enforcement is NOT needed here because:
  // 1. These routes are FOR super admins (system administration)
  // 2. These routes don't expose cultural data (stories, places, speakers)
  // 3. Data sovereignty is enforced on /member/* routes via requireCommunityAccess()
  // 4. Tests verify super admins are blocked from /member/stories, /member/places, /member/speakers
  app.addHook('preHandler', requireRole(['super_admin']));

  /**
   * Community Management Endpoints
   */

  // GET /api/v1/super_admin/communities - List all communities
  app.get('/communities', {
    schema: {
      description:
        'List all communities with pagination and filtering (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', pattern: '^\\d+$' },
          limit: { type: 'string', pattern: '^\\d+$' },
          search: { type: 'string', maxLength: 100 },
          locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' },
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
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: ['string', 'null'] },
                  slug: { type: 'string' },
                  locale: { type: 'string' },
                  publicStories: { type: 'boolean' },
                  isActive: { type: 'boolean' },
                  userCount: { type: 'number' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
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
        Querystring: z.infer<typeof listCommunitiesQuerySchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        console.log('Route handler reached: GET /communities');

        const query = request.query as z.infer<
          typeof listCommunitiesQuerySchema
        >;
        const { page, limit, search, locale, active } = query;
        console.log('Query params:', { page, limit, search, locale, active });

        console.log(
          'About to call communityService.getAllCommunitiesForSuperAdmin'
        );
        const result = await communityService.getAllCommunitiesForSuperAdmin({
          page,
          limit,
          search,
          locale,
          active,
        });
        console.log('Service call completed successfully');

        // Temporarily skip user count aggregation to isolate the issue
        return reply.code(200).send(result);
      } catch (error) {
        console.error('Route handler error:', error);
        console.error(
          'Error stack:',
          error instanceof Error ? error.stack : 'No stack'
        );
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Failed to list communities'
        );
        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // GET /api/v1/super_admin/communities/:id - Get specific community
  app.get('/communities/:id', {
    schema: {
      description: 'Get specific community details (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.communityId,
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                name: { type: 'string' },
                description: { type: ['string', 'null'] },
                slug: { type: 'string' },
                locale: { type: 'string' },
                publicStories: { type: 'boolean' },
                isActive: { type: 'boolean' },
                userCount: { type: 'number' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
              },
            },
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
        Params: z.infer<typeof communityIdParamSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        const community = await communityService.getCommunityById(id, true);

        if (!community) {
          return reply.code(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        // Transform to super admin response format
        const response = {
          data: {
            id: community.id,
            name: community.name,
            description: community.description,
            slug: community.slug,
            locale: community.locale,
            publicStories: community.publicStories,
            isActive: community.isActive,
            userCount: community.memberCount || 0,
            createdAt: community.createdAt,
            updatedAt: community.updatedAt,
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to get community'
        );
        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // POST /api/v1/super_admin/communities - Create new community
  app.post('/communities', {
    schema: {
      description: 'Create new community (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      body: zodToJsonSchema(createCommunitySchema),
      response: {
        201: zodToJsonSchema(communityCreatedResponseSchema),
        400: ERROR_SCHEMAS[400],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        409: ERROR_SCHEMAS[409],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof createCommunitySchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const community = await communityService.createCommunityAsSuperAdmin(
          request.body
        );

        const response = {
          data: {
            id: community.id,
            name: community.name,
            description: community.description,
            slug: community.slug,
            locale: community.locale,
            publicStories: community.publicStories,
            isActive: community.isActive,
            userCount: 0,
            createdAt: toISOString(community.createdAt),
            updatedAt: toISOString(community.updatedAt),
          },
          message: 'Community created successfully',
        };

        return reply.code(201).send(response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Failed to create community'
        );

        if (error instanceof CommunityValidationError) {
          return reply.code(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        if (
          error instanceof CommunityOperationError &&
          error.message.includes('already exists')
        ) {
          return reply.code(409).send({
            error: error.message,
            statusCode: 409,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // PUT /api/v1/super_admin/communities/:id - Update community
  app.put('/communities/:id', {
    schema: {
      description: 'Update community (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.communityId,
      body: zodToJsonSchema(updateCommunitySchema),
      response: {
        200: zodToJsonSchema(communityUpdatedResponseSchema),
        400: ERROR_SCHEMAS[400],
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof communityIdParamSchema>;
        Body: z.infer<typeof updateCommunitySchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        const community = await communityService.updateCommunityAsSuperAdmin(
          id,
          request.body
        );

        const response = {
          data: {
            id: community.id,
            name: community.name,
            description: community.description,
            slug: community.slug,
            locale: community.locale,
            publicStories: community.publicStories,
            isActive: community.isActive,
            userCount: 0, // Note: User count aggregation not yet implemented
            createdAt: toISOString(community.createdAt),
            updatedAt: toISOString(community.updatedAt),
          },
          message: 'Community updated successfully',
        };

        return reply.code(200).send(response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to update community'
        );

        if (error instanceof CommunityValidationError) {
          return reply.code(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        if (
          error instanceof CommunityOperationError &&
          error.message.includes('not found')
        ) {
          return reply.code(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // DELETE /api/v1/super_admin/communities/:id - Archive community
  app.delete('/communities/:id', {
    schema: {
      description: 'Archive community (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.communityId,
      response: {
        200: zodToJsonSchema(communityDeletedResponseSchema),
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof communityIdParamSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        const result = await communityService.archiveCommunityAsSuperAdmin(id);

        return reply.code(200).send({ data: result });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to archive community'
        );

        if (
          error instanceof CommunityOperationError &&
          error.message.includes('not found')
        ) {
          return reply.code(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  /**
   * User Management Endpoints
   */

  // GET /api/v1/super_admin/users - List all users
  app.get('/users', {
    schema: {
      description:
        'List all users across communities with filtering (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'string', pattern: '^\\d+$' },
          limit: { type: 'string', pattern: '^\\d+$' },
          community: { type: 'string', pattern: '^\\d+$' },
          role: {
            type: 'string',
            enum: ['super_admin', 'admin', 'editor', 'viewer'],
          },
          search: { type: 'string', maxLength: 100 },
          active: { type: 'string', enum: ['true', 'false'] },
        },
        additionalProperties: false,
      },
      response: {
        200: zodToJsonSchema(paginatedUsersResponseSchema),
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Querystring: z.infer<typeof listUsersQuerySchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const query = request.query as z.infer<typeof listUsersQuerySchema>;
        const { page, limit, community, role, search, active } = query;

        const result = await userService.getAllUsersForSuperAdmin({
          page,
          limit,
          community,
          role,
          search,
          active,
        });

        // Add community names for each user
        const uniqueCommunityIds = [
          ...new Set(result.data.map((user) => user.communityId)),
        ];
        const communityNamesMap = new Map<number, string>();

        // Fetch community names in batch
        await Promise.all(
          uniqueCommunityIds.map(async (communityId) => {
            const community = await communityRepository.findById(communityId);
            communityNamesMap.set(
              communityId,
              community?.name || `Community ${communityId}`
            );
          })
        );

        // Update users with community names
        const dataWithCommunityNames = result.data.map((user) => ({
          ...user,
          communityName:
            communityNamesMap.get(user.communityId) ||
            `Community ${user.communityId}`,
        }));

        return reply.code(200).send({
          ...result,
          data: dataWithCommunityNames,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ error: errorMessage }, 'Failed to list users');
        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // GET /api/v1/super_admin/users/:id - Get specific user
  app.get('/users/:id', {
    schema: {
      description: 'Get specific user details (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.userId,
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                email: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                role: { type: 'string' },
                communityId: { type: 'number' },
                communityName: { type: 'string' },
                isActive: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
                lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
          },
        },
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{ Params: z.infer<typeof userIdParamSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        const user = await userService.getUserByIdAsSuperAdmin(id);

        if (!user) {
          return reply.code(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        // Get community name
        const community = await communityRepository.findById(user.communityId);
        const communityName =
          community?.name || `Community ${user.communityId}`;

        // Transform to response format
        const response = {
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
        };

        return reply.code(200).send(response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to get user'
        );
        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // POST /api/v1/super_admin/users - Create new user
  app.post('/users', {
    schema: {
      description: 'Create user in any community (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      body: zodToJsonSchema(createUserSchema),
      response: {
        201: zodToJsonSchema(userCreatedResponseSchema),
        400: ERROR_SCHEMAS[400],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        409: ERROR_SCHEMAS[409],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof createUserSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const user = await userService.createUserAsSuperAdmin(request.body);

        // Get community name
        const community = await communityRepository.findById(user.communityId);
        const communityName =
          community?.name || `Community ${user.communityId}`;

        const response = {
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
        };

        return reply.code(201).send(response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error({ error: errorMessage }, 'Failed to create user');

        if (error instanceof DuplicateEmailError) {
          return reply.code(409).send({
            error: error.message,
            statusCode: 409,
          });
        }

        if (error instanceof WeakPasswordError) {
          return reply.code(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        if (error instanceof InvalidCommunityError) {
          return reply.code(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // PUT /api/v1/super_admin/users/:id - Update user
  app.put('/users/:id', {
    schema: {
      description: 'Update user details including role changes (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.userId,
      body: zodToJsonSchema(updateUserSchema),
      response: {
        200: zodToJsonSchema(userUpdatedResponseSchema),
        400: ERROR_SCHEMAS[400],
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{
        Params: z.infer<typeof userIdParamSchema>;
        Body: z.infer<typeof updateUserSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        const user = await userService.updateUserAsSuperAdmin(id, request.body);

        // Get community name
        const community = await communityRepository.findById(user.communityId);
        const communityName =
          community?.name || `Community ${user.communityId}`;

        const response = {
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
        };

        return reply.code(200).send(response);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to update user'
        );

        if (error instanceof UserNotFoundError) {
          return reply.code(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        if (error instanceof DuplicateEmailError) {
          return reply.code(409).send({
            error: error.message,
            statusCode: 409,
          });
        }

        if (error instanceof InvalidCommunityError) {
          return reply.code(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });

  // DELETE /api/v1/super_admin/users/:id - Deactivate user
  app.delete('/users/:id', {
    schema: {
      description: 'Deactivate user account (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.userId,
      response: {
        200: zodToJsonSchema(userDeletedResponseSchema),
        404: ERROR_SCHEMAS[404],
        401: ERROR_SCHEMAS[401],
        403: ERROR_SCHEMAS[403],
        500: ERROR_SCHEMAS[500],
      },
    },
    handler: async (
      request: FastifyRequest<{ Params: z.infer<typeof userIdParamSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;

        const result = await userService.deactivateUserAsSuperAdmin(id);

        return reply.code(200).send({ data: result });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, id: request.params.id },
          'Failed to deactivate user'
        );

        if (error instanceof UserNotFoundError) {
          return reply.code(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });
}
