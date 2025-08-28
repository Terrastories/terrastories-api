/**
 * Super Admin Routes
 *
 * System-level administrative endpoints for super admin users only.
 * Provides cross-community access while enforcing Indigenous data sovereignty.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
// import { zodToJsonSchema } from 'zod-to-json-schema'; // Replaced with manual schemas
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
  getAuditLogger,
  SuperAdminAuditLogger,
} from '../shared/utils/audit-logger.js';
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
  paginatedUsersResponseSchema as _paginatedUsersResponseSchema,
  communityCreatedResponseSchema as _communityCreatedResponseSchema,
  communityUpdatedResponseSchema as _communityUpdatedResponseSchema,
  communityDeletedResponseSchema as _communityDeletedResponseSchema,
  userCreatedResponseSchema as _userCreatedResponseSchema,
  userUpdatedResponseSchema as _userUpdatedResponseSchema,
  userDeletedResponseSchema as _userDeletedResponseSchema,
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

const BODY_SCHEMAS = {
  createCommunity: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      slug: {
        type: 'string',
        minLength: 3,
        maxLength: 50,
        pattern: '^[a-z0-9-]+$',
      },
      locale: {
        type: 'string',
        pattern: '^[a-z]{2,3}(-[A-Z]{2})?$',
        default: 'en',
      },
      publicStories: { type: 'boolean', default: false },
      isActive: { type: 'boolean', default: true },
    },
    required: ['name'],
    additionalProperties: false,
  },
  updateCommunity: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      locale: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' },
      publicStories: { type: 'boolean' },
      isActive: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  createUser: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      firstName: { type: 'string', minLength: 1, maxLength: 50 },
      lastName: { type: 'string', minLength: 1, maxLength: 50 },
      role: {
        type: 'string',
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
      },
      communityId: { type: 'number', minimum: 1 },
      isActive: { type: 'boolean', default: true },
    },
    required: [
      'email',
      'password',
      'firstName',
      'lastName',
      'role',
      'communityId',
    ],
    additionalProperties: false,
  },
  updateUser: {
    type: 'object',
    properties: {
      firstName: { type: 'string', minLength: 1, maxLength: 50 },
      lastName: { type: 'string', minLength: 1, maxLength: 50 },
      role: {
        type: 'string',
        enum: ['super_admin', 'admin', 'editor', 'viewer'],
      },
      communityId: { type: 'number', minimum: 1 },
      isActive: { type: 'boolean' },
    },
    additionalProperties: false,
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

  // Initialize audit logger for Indigenous oversight
  const auditLogger = getAuditLogger();
  auditLogger.addLogger((entry) => {
    app.log.warn(entry, 'Super Admin Action Audit');
  });

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
    config: {
      rateLimit: {
        max: 10, // More restrictive for super admin endpoints
        timeWindow: 60 * 1000, // 1 minute
      },
    },
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
        const query = request.query as z.infer<
          typeof listCommunitiesQuerySchema
        >;
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

        return reply.code(200).send({
          ...result,
          data: dataWithUserCounts,
        });
      } catch (error) {
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
        const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

        const community = await communityService.getCommunityById(
          numericId,
          true
        );

        if (!community) {
          return reply.code(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        // Calculate actual user count for this community
        const userCount = await userRepository.countUsersByCommunity(
          community.id
        );

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
            userCount,
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
    config: {
      rateLimit: {
        max: 3, // Very restrictive for creation endpoints
        timeWindow: 60 * 1000, // 1 minute
      },
    },
    schema: {
      description: 'Create new community (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      body: BODY_SCHEMAS.createCommunity,
      response: {
        201: {
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
      request: FastifyRequest<{ Body: z.infer<typeof createCommunitySchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const authRequest = request as any; // Cast to access user
        const community = await communityService.createCommunityAsSuperAdmin(
          request.body
        );

        // Audit log the community creation
        if (authRequest.user) {
          const auditEntry = SuperAdminAuditLogger.createCommunityEntry(
            'community_create',
            authRequest.user.id,
            authRequest.user.email,
            true,
            community.id,
            {
              name: community.name,
              slug: community.slug,
              locale: community.locale,
            }
          );
          auditLogger.log(auditEntry);
        }

        // Calculate actual user count for this community (should be 0 for new communities)
        const userCount = await userRepository.countUsersByCommunity(
          community.id
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
            userCount,
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
    config: {
      rateLimit: {
        max: 10, // Moderate limit for update endpoints
        timeWindow: 60 * 1000, // 1 minute
      },
    },
    schema: {
      description: 'Update community (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.communityId,
      body: BODY_SCHEMAS.updateCommunity,
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
        Params: z.infer<typeof communityIdParamSchema>;
        Body: z.infer<typeof updateCommunitySchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

        const community = await communityService.updateCommunityAsSuperAdmin(
          numericId,
          request.body
        );

        // Audit log the community update
        const authRequest = request as any; // Cast to access user
        if (authRequest.user) {
          const auditEntry = SuperAdminAuditLogger.createCommunityEntry(
            'community_update',
            authRequest.user.id,
            authRequest.user.email,
            true,
            community.id,
            {
              name: community.name,
              changes: request.body,
            }
          );
          auditLogger.log(auditEntry);
        }

        // Calculate actual user count for this community
        const userCount = await userRepository.countUsersByCommunity(
          community.id
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
            userCount,
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
        const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

        const result =
          await communityService.archiveCommunityAsSuperAdmin(numericId);

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
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  email: { type: 'string', format: 'email' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['super_admin', 'admin', 'editor', 'viewer'],
                  },
                  communityId: { type: 'number' },
                  communityName: { type: 'string' },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                  lastLoginAt: {
                    type: ['string', 'null'],
                    format: 'date-time',
                  },
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

        // Community names are now included via JOIN query in repository
        return reply.code(200).send(result);
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
        const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

        const user = await userService.getUserByIdWithCommunityName(numericId);

        if (!user) {
          return reply.code(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        const communityName =
          user.communityName || `Community ${user.communityId}`;

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
    config: {
      rateLimit: {
        max: 5, // Restrictive for user creation endpoints
        timeWindow: 60 * 1000, // 1 minute
      },
    },
    schema: {
      description: 'Create user in any community (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      body: BODY_SCHEMAS.createUser,
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                email: { type: 'string', format: 'email' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                role: {
                  type: 'string',
                  enum: ['super_admin', 'admin', 'editor', 'viewer'],
                },
                communityId: { type: 'number' },
                communityName: { type: 'string' },
                isActive: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
                lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
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
      request: FastifyRequest<{ Body: z.infer<typeof createUserSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const user = await userService.createUserAsSuperAdmin(request.body);

        // Audit log the user creation
        const authRequest = request as any; // Cast to access user
        if (authRequest.user) {
          const auditEntry = SuperAdminAuditLogger.createUserEntry(
            'user_create',
            authRequest.user.id,
            authRequest.user.email,
            true,
            user.id,
            {
              email: user.email,
              role: user.role,
              communityId: user.communityId,
            }
          );
          auditLogger.log(auditEntry);
        }

        // Get community name efficiently in single query
        const userWithCommunity =
          await userRepository.findByIdWithCommunityName(user.id);
        const communityName =
          userWithCommunity?.communityName || `Community ${user.communityId}`;

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
    config: {
      rateLimit: {
        max: 10, // Moderate limit for user update endpoints
        timeWindow: 60 * 1000, // 1 minute
      },
    },
    schema: {
      description: 'Update user details including role changes (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      params: PARAM_SCHEMAS.userId,
      body: BODY_SCHEMAS.updateUser,
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                email: { type: 'string', format: 'email' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                role: {
                  type: 'string',
                  enum: ['super_admin', 'admin', 'editor', 'viewer'],
                },
                communityId: { type: 'number' },
                communityName: { type: 'string' },
                isActive: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
                lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
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
        Params: z.infer<typeof userIdParamSchema>;
        Body: z.infer<typeof updateUserSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

        const user = await userService.updateUserAsSuperAdmin(
          numericId,
          request.body
        );

        // Get community name efficiently in single query
        const userWithCommunity =
          await userRepository.findByIdWithCommunityName(user.id);
        const communityName =
          userWithCommunity?.communityName || `Community ${user.communityId}`;

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
        const numericId = typeof id === 'string' ? parseInt(id, 10) : id;

        const result = await userService.deactivateUserAsSuperAdmin(numericId);

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
