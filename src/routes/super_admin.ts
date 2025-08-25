/**
 * Super Admin Routes
 *
 * System-level administrative endpoints for super admin users only.
 * Provides cross-community access while enforcing Indigenous data sovereignty.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../shared/middleware/auth.middleware.js';
import { requireRole } from '../shared/middleware/auth.middleware.js';
import { CommunityService } from '../services/community.service.js';
import { UserService } from '../services/user.service.js';
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
  paginatedCommunitiesResponseSchema,
  paginatedUsersResponseSchema,
  communityCreatedResponseSchema,
  communityUpdatedResponseSchema,
  communityDeletedResponseSchema,
  userCreatedResponseSchema,
  userUpdatedResponseSchema,
  userDeletedResponseSchema,
  errorResponseSchema,
  validationErrorSchema,
  notFoundErrorSchema,
  forbiddenErrorSchema,
  unauthorizedErrorSchema,
  conflictErrorSchema,
} from '../shared/schemas/super-admin.js';

export async function superAdminRoutes(app: FastifyInstance) {
  const db = await getDb();
  const communityRepository = new CommunityRepository(db);
  const userRepository = new UserRepository(db);
  const communityService = new CommunityService(communityRepository);
  const userService = new UserService(userRepository);

  // Add super admin role protection to all routes
  app.addHook('preHandler', requireRole(['super_admin']));

  /**
   * Community Management Endpoints
   */

  // GET /api/v1/super_admin/communities - List all communities
  app.get('/communities', {
    schema: {
      description: 'List all communities with pagination and filtering (Super Admin)',
      tags: ['Super Admin - Communities'],
      security: [{ bearerAuth: [] }],
      querystring: listCommunitiesQuerySchema,
      response: {
        200: paginatedCommunitiesResponseSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Querystring: z.infer<typeof listCommunitiesQuerySchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const { page, limit, search, locale, active } = request.query;
        
        const result = await communityService.getAllCommunitiesForSuperAdmin({
          page,
          limit,
          search,
          locale,
          active,
        });

        return reply.code(200).send(result);
      } catch (error) {
        request.log.error('Failed to list communities', { error });
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
      params: communityIdParamSchema,
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
        404: notFoundErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Params: z.infer<typeof communityIdParamSchema> }>,
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
        request.log.error('Failed to get community', { error, id: request.params.id });
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
      body: createCommunitySchema,
      response: {
        201: communityCreatedResponseSchema,
        400: validationErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        409: conflictErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof createCommunitySchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const community = await communityService.createCommunityAsSuperAdmin(request.body);

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
            createdAt: community.createdAt instanceof Date 
              ? community.createdAt.toISOString() 
              : new Date(community.createdAt).toISOString(),
            updatedAt: community.updatedAt instanceof Date 
              ? community.updatedAt.toISOString() 
              : new Date(community.updatedAt).toISOString(),
          },
          message: 'Community created successfully',
        };

        return reply.code(201).send(response);
      } catch (error) {
        request.log.error('Failed to create community', { error });
        
        if (error instanceof Error) {
          if (error.message.includes('validation')) {
            return reply.code(400).send({
              error: error.message,
              statusCode: 400,
            });
          }
          if (error.message.includes('already exists')) {
            return reply.code(409).send({
              error: error.message,
              statusCode: 409,
            });
          }
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
      params: communityIdParamSchema,
      body: updateCommunitySchema,
      response: {
        200: communityUpdatedResponseSchema,
        400: validationErrorSchema,
        404: notFoundErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
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
        
        const community = await communityService.updateCommunityAsSuperAdmin(id, request.body);

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
            createdAt: community.createdAt instanceof Date 
              ? community.createdAt.toISOString() 
              : new Date(community.createdAt).toISOString(),
            updatedAt: community.updatedAt instanceof Date 
              ? community.updatedAt.toISOString() 
              : new Date(community.updatedAt).toISOString(),
          },
          message: 'Community updated successfully',
        };

        return reply.code(200).send(response);
      } catch (error) {
        request.log.error('Failed to update community', { error, id: request.params.id });
        
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.code(404).send({
              error: 'Community not found',
              statusCode: 404,
            });
          }
          if (error.message.includes('validation')) {
            return reply.code(400).send({
              error: error.message,
              statusCode: 400,
            });
          }
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
      params: communityIdParamSchema,
      response: {
        200: communityDeletedResponseSchema,
        404: notFoundErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Params: z.infer<typeof communityIdParamSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        
        const result = await communityService.archiveCommunityAsSuperAdmin(id);

        return reply.code(200).send({ data: result });
      } catch (error) {
        request.log.error('Failed to archive community', { error, id: request.params.id });
        
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.code(404).send({
              error: 'Community not found',
              statusCode: 404,
            });
          }
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
      description: 'List all users across communities with filtering (Super Admin)',
      tags: ['Super Admin - Users'],
      security: [{ bearerAuth: [] }],
      querystring: listUsersQuerySchema,
      response: {
        200: paginatedUsersResponseSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Querystring: z.infer<typeof listUsersQuerySchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const { page, limit, community, role, search, active } = request.query;
        
        const result = await userService.getAllUsersForSuperAdmin({
          page,
          limit,
          community,
          role,
          search,
          active,
        });

        return reply.code(200).send(result);
      } catch (error) {
        request.log.error('Failed to list users', { error });
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
      params: userIdParamSchema,
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
        404: notFoundErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Params: z.infer<typeof userIdParamSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        
        const user = await userService.getUserById(id);
        
        if (!user) {
          return reply.code(404).send({
            error: 'User not found',
            statusCode: 404,
          });
        }

        // Transform to response format (placeholder)
        const response = {
          data: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            communityId: user.communityId,
            communityName: `Community ${user.communityId}`, // Note: Community name lookup not yet implemented
            isActive: user.isActive,
            createdAt: user.createdAt instanceof Date 
              ? user.createdAt.toISOString() 
              : new Date(user.createdAt).toISOString(),
            updatedAt: user.updatedAt instanceof Date 
              ? user.updatedAt.toISOString() 
              : new Date(user.updatedAt).toISOString(),
            lastLoginAt: user.lastLoginAt ? (
              user.lastLoginAt instanceof Date 
                ? user.lastLoginAt.toISOString() 
                : new Date(user.lastLoginAt).toISOString()
            ) : null,
          },
        };

        return reply.code(200).send(response);
      } catch (error) {
        request.log.error('Failed to get user', { error, id: request.params.id });
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
      body: createUserSchema,
      response: {
        201: userCreatedResponseSchema,
        400: validationErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        409: conflictErrorSchema,
        500: errorResponseSchema,
      },
    },
    handler: async (
      request: FastifyRequest<{ Body: z.infer<typeof createUserSchema> }>,
      reply: FastifyReply
    ) => {
      try {
        const user = await userService.createUserAsSuperAdmin(request.body);

        const response = {
          data: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            communityId: user.communityId,
            communityName: `Community ${user.communityId}`, // Note: Community name lookup not yet implemented
            isActive: user.isActive,
            createdAt: user.createdAt instanceof Date 
              ? user.createdAt.toISOString() 
              : new Date(user.createdAt).toISOString(),
            updatedAt: user.updatedAt instanceof Date 
              ? user.updatedAt.toISOString() 
              : new Date(user.updatedAt).toISOString(),
            lastLoginAt: null,
          },
          message: 'User created successfully',
        };

        return reply.code(201).send(response);
      } catch (error) {
        request.log.error('Failed to create user', { error });
        
        if (error instanceof Error) {
          if (error.message.includes('email already exists')) {
            return reply.code(409).send({
              error: error.message,
              statusCode: 409,
            });
          }
          if (error.message.includes('validation')) {
            return reply.code(400).send({
              error: error.message,
              statusCode: 400,
            });
          }
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
      params: userIdParamSchema,
      body: updateUserSchema,
      response: {
        200: userUpdatedResponseSchema,
        400: validationErrorSchema,
        404: notFoundErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
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

        const response = {
          data: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            communityId: user.communityId,
            communityName: `Community ${user.communityId}`, // Note: Community name lookup not yet implemented
            isActive: user.isActive,
            createdAt: user.createdAt instanceof Date 
              ? user.createdAt.toISOString() 
              : new Date(user.createdAt).toISOString(),
            updatedAt: user.updatedAt instanceof Date 
              ? user.updatedAt.toISOString() 
              : new Date(user.updatedAt).toISOString(),
            lastLoginAt: user.lastLoginAt ? (
              user.lastLoginAt instanceof Date 
                ? user.lastLoginAt.toISOString() 
                : new Date(user.lastLoginAt).toISOString()
            ) : null,
          },
          message: 'User updated successfully',
        };

        return reply.code(200).send(response);
      } catch (error) {
        request.log.error('Failed to update user', { error, id: request.params.id });
        
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.code(404).send({
              error: 'User not found',
              statusCode: 404,
            });
          }
          if (error.message.includes('validation')) {
            return reply.code(400).send({
              error: error.message,
              statusCode: 400,
            });
          }
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
      params: userIdParamSchema,
      response: {
        200: userDeletedResponseSchema,
        404: notFoundErrorSchema,
        401: unauthorizedErrorSchema,
        403: forbiddenErrorSchema,
        500: errorResponseSchema,
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
        request.log.error('Failed to deactivate user', { error, id: request.params.id });
        
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.code(404).send({
              error: 'User not found',
              statusCode: 404,
            });
          }
        }

        return reply.code(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    },
  });
}