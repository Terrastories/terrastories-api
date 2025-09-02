/**
 * Community Routes
 *
 * Handles community management operations including creation, retrieval,
 * and updating with Indigenous data sovereignty and cultural protocol support.
 *
 * Features:
 * - Community creation with cultural protocol validation
 * - Community retrieval by ID and slug
 * - Community search with filters
 * - Data sovereignty and access control
 * - Comprehensive error handling
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CommunityService } from '../services/community.service.js';
import { CommunityRepository } from '../repositories/community.repository.js';
import { getDb, type Database } from '../db/index.js';
import { storiesSqlite as storiesTable } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import {
  requireAuth,
  requireRole,
} from '../shared/middleware/auth.middleware.js';

// Request validation schemas
const createCommunitySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Community name must be at least 2 characters long')
      .max(100, 'Community name cannot exceed 100 characters'),
    description: z
      .string()
      .trim()
      .max(1000, 'Description cannot exceed 1000 characters')
      .optional(),
    slug: z
      .string()
      .trim()
      .min(3, 'Slug must be at least 3 characters long')
      .max(50, 'Slug cannot exceed 50 characters')
      .regex(
        /^[a-z0-9-]+$/,
        'Slug can only contain lowercase letters, numbers, and hyphens'
      )
      .optional(),
    publicStories: z.boolean().default(false),
    locale: z
      .string()
      .regex(
        /^[a-z]{2,3}(-[A-Z]{2})?$/,
        'Invalid locale format. Use format like "en", "es", "mic", "en-US"'
      )
      .default('en'),
    culturalSettings: z
      .object({
        languagePreferences: z.array(z.string()),
        elderContentRestrictions: z.boolean(),
        ceremonialContent: z.boolean(),
        traditionalKnowledge: z.boolean(),
        communityApprovalRequired: z.boolean(),
        dataRetentionPolicy: z.enum([
          'indefinite',
          'community-controlled',
          'time-limited-5years',
          'time-limited-10years',
          'delete-on-request',
        ]),
        accessRestrictions: z.array(z.string()),
      })
      .optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

// Note: updateCommunitySchema would be used for PUT/PATCH endpoints
// Currently only implementing POST (create) and GET endpoints

export async function communityRoutes(
  fastify: FastifyInstance,
  options?: { database?: Database }
) {
  // Initialize services
  const database = options?.database || (await getDb());
  const communityRepository = new CommunityRepository(database);
  const communityService = new CommunityService(communityRepository);

  /**
   * Create Community Endpoint
   * POST /communities
   */
  fastify.post(
    '/communities',
    {
      preHandler: [
        requireAuth,
        requireRole(['admin', 'editor', 'super_admin']),
      ],
      schema: {
        description: 'Create a new community with cultural protocol support',
        tags: ['Communities'],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100 },
            description: { type: 'string', maxLength: 1000 },
            slug: { type: 'string', minLength: 3, maxLength: 50 },
            publicStories: { type: 'boolean', default: false },
            locale: { type: 'string', default: 'en' },
            culturalSettings: {
              type: 'object',
              properties: {
                languagePreferences: {
                  type: 'array',
                  items: { type: 'string' },
                },
                elderContentRestrictions: { type: 'boolean' },
                ceremonialContent: { type: 'boolean' },
                traditionalKnowledge: { type: 'boolean' },
                communityApprovalRequired: { type: 'boolean' },
                dataRetentionPolicy: {
                  type: 'string',
                  enum: [
                    'indefinite',
                    'community-controlled',
                    'time-limited-5years',
                    'time-limited-10years',
                    'delete-on-request',
                  ],
                },
                accessRestrictions: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
            isActive: { type: 'boolean', default: true },
          },
          required: ['name'],
        },
        response: {
          201: {
            description: 'Community successfully created',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  slug: { type: 'string' },
                  publicStories: { type: 'boolean' },
                  locale: { type: 'string' },
                  culturalSettings: { type: 'string' },
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
            },
          },
          409: {
            description: 'Conflict - slug already exists',
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
        const validatedData = createCommunitySchema.parse(request.body);

        // Create community
        const community = await communityService.createCommunity(validatedData);

        // Return success response
        return reply.status(201).send({
          data: {
            id: community.id,
            name: community.name,
            description: community.description,
            slug: community.slug,
            publicStories: community.publicStories,
            locale: community.locale,
            culturalSettings: community.culturalSettings,
            isActive: community.isActive,
            createdAt: community.createdAt.toISOString(),
            updatedAt: community.updatedAt.toISOString(),
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Community creation error'
        );

        // Handle validation errors
        if (error instanceof z.ZodError) {
          const firstError = error.issues[0];
          const errorMessage = firstError
            ? firstError.message
            : 'Validation failed';
          return reply.status(400).send({
            error: errorMessage,
            statusCode: 400,
          });
        }

        // Handle service errors
        if (error instanceof Error) {
          // Community validation errors
          if (error.name === 'CommunityValidationError') {
            return reply.status(400).send({
              error: error.message,
              statusCode: 400,
            });
          }

          // Duplicate slug errors
          if (error.message.includes('slug already exists')) {
            return reply.status(409).send({
              error: 'Community slug already exists',
              statusCode: 409,
            });
          }
        }

        // Generic server error
        return reply.status(500).send({
          error: 'An unexpected error occurred',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Community by ID Endpoint
   * GET /communities/:id
   */
  fastify.get(
    '/communities/:id',
    {
      schema: {
        description: 'Get community by ID with optional statistics',
        tags: ['Communities'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9]+$' },
          },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            includeStats: { type: 'boolean', default: false },
          },
        },
        response: {
          200: {
            description: 'Community found',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  slug: { type: 'string' },
                  publicStories: { type: 'boolean' },
                  locale: { type: 'string' },
                  culturalSettings: { type: 'string' },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          404: {
            description: 'Community not found',
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
        const { id } = request.params as { id: string };
        const { includeStats = false } = request.query as {
          includeStats?: boolean;
        };

        const communityId = parseInt(id, 10);
        if (isNaN(communityId) || communityId <= 0) {
          return reply.status(400).send({
            error: 'Invalid community ID',
            statusCode: 400,
          });
        }

        const community = await communityService.getCommunityById(
          communityId,
          includeStats
        );

        if (!community) {
          return reply.status(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        return reply.status(200).send({ data: community });
      } catch (error) {
        fastify.log.error({ error, url: request.url }, 'Get community error');

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Communities List Endpoint
   * GET /communities
   */
  fastify.get(
    '/communities',
    {
      schema: {
        description: 'Get communities with optional filters and pagination',
        tags: ['Communities'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'number', minimum: 0, default: 0 },
            isActive: { type: 'boolean' },
            search: { type: 'string', maxLength: 100 },
          },
        },
        response: {
          200: {
            description: 'Communities retrieved successfully',
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    slug: { type: 'string' },
                    publicStories: { type: 'boolean' },
                    locale: { type: 'string' },
                    isActive: { type: 'boolean' },
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
                },
              },
            },
          },
          400: {
            description: 'Bad request - invalid parameters',
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
        const {
          limit = 20,
          offset = 0,
          isActive,
          search,
        } = request.query as {
          limit?: number;
          offset?: number;
          isActive?: boolean;
          search?: string;
        };

        const searchParams = {
          limit,
          offset,
          isActive,
          search,
        };

        const result = await communityService.searchCommunities(searchParams);

        // Transform response to match pagination format expected by tests
        const page = Math.floor(offset / limit) + 1;
        return reply.status(200).send({
          data: result.communities,
          meta: {
            page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Search communities error'
        );

        if (
          error instanceof Error &&
          error.name === 'CommunityValidationError'
        ) {
          return reply.status(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Community Stories Endpoint
   * GET /communities/:id/stories
   */
  fastify.get(
    '/communities/:id/stories',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get stories for a specific community',
        tags: ['Communities', 'Stories'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9]+$' },
          },
          required: ['id'],
        },
        response: {
          200: {
            description: 'Stories retrieved successfully',
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    title: { type: 'string' },
                    community_id: { type: 'number' },
                  },
                },
              },
            },
          },
          404: {
            description: 'Community not found',
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
        const { id } = request.params as { id: string };
        const communityId = parseInt(id, 10);
        // @ts-ignore
        const user = request.user;

        const conditions = [eq(storiesTable.communityId, communityId)];

        if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
          // Only show non-restricted stories to non-admin users
          conditions.push(eq(storiesTable.isRestricted, false));
        }

        const stories = await database
          .select()
          .from(storiesTable)
          .where(and(...conditions));

        return reply.status(200).send({ data: stories });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Get community stories error'
        );
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Community Story by ID Endpoint
   * GET /communities/:id/stories/:storyId
   */
  fastify.get(
    '/communities/:id/stories/:storyId',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get a specific story for a community',
        tags: ['Communities', 'Stories'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9]+$' },
            storyId: { type: 'string', pattern: '^[0-9]+$' },
          },
          required: ['id', 'storyId'],
        },
        response: {
          200: {
            description: 'Story retrieved successfully',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  title: { type: 'string' },
                  community_id: { type: 'number' },
                },
              },
            },
          },
          404: {
            description: 'Story not found',
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
        const { id, storyId } = request.params as {
          id: string;
          storyId: string;
        };
        const communityId = parseInt(id, 10);
        const sId = parseInt(storyId, 10);
        // @ts-ignore
        const user = request.user;

        const storyResult = await database
          .select()
          .from(storiesTable)
          .where(
            and(
              eq(storiesTable.communityId, communityId),
              eq(storiesTable.id, sId)
            )
          );

        if (storyResult.length === 0) {
          return reply
            .status(404)
            .send({ error: 'Story not found', statusCode: 404 });
        }

        const story = storyResult[0];

        // @ts-ignore
        if (user && user.role === 'super_admin') {
          return reply.status(403).send({
            error: 'super admin cannot access community cultural data',
            statusCode: 403,
          });
        }

        // @ts-ignore
        if (
          story.privacy_level === 'restricted' &&
          story.cultural_restrictions.includes('elder_only')
        ) {
          // @ts-ignore
          if (!user || user.role !== 'elder') {
            return reply
              .status(403)
              .send({ error: 'Elder access required', statusCode: 403 });
          }
        }

        return reply.status(200).send({ data: story });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Get community story error'
        );
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );
}
