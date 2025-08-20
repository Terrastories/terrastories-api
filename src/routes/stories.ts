/**
 * Story Routes
 *
 * CRUD endpoints for story management with comprehensive cultural protocols,
 * community data sovereignty, and Indigenous storytelling support.
 *
 * Features:
 * - Complete CRUD operations for stories
 * - Cultural protocol enforcement (elder-only, ceremonial content)
 * - Community data sovereignty protection
 * - Media attachment support
 * - Place and speaker associations
 * - Geographic proximity search
 * - Comprehensive error handling and audit logging
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  StoryService,
  type StoryCreateInput,
} from '../services/story.service.js';
import {
  StoryRepository,
  type StoryWithRelations,
} from '../repositories/story.repository.js';
import { FileRepository } from '../repositories/file.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { getDb } from '../db/index.js';
import {
  requireAuth,
  requireCommunityAccess,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';

// Request validation schemas
const createStorySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  communityId: z.number().int().positive(),
  mediaUrls: z.array(z.string().url()).optional(),
  language: z.string().min(2).max(10).default('en'),
  tags: z.array(z.string()).optional(),
  culturalProtocols: z
    .object({
      permissionLevel: z
        .enum(['public', 'community', 'restricted', 'elder_only'])
        .optional(),
      culturalSignificance: z.string().optional(),
      restrictions: z.array(z.string()).optional(),
      ceremonialContent: z.boolean().optional(),
      elderApprovalRequired: z.boolean().optional(),
      accessNotes: z.string().optional(),
    })
    .optional(),
  placeIds: z.array(z.number().int().positive()).optional(),
  speakerIds: z.array(z.number().int().positive()).optional(),
  placeContexts: z.array(z.string()).optional(),
  speakerRoles: z.array(z.string()).optional(),
});

const updateStorySchema = createStorySchema
  .partial()
  .omit({ communityId: true });

const storyParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const slugParamsSchema = z.object({
  slug: z.string().min(1).max(100),
  communityId: z.coerce.number().int().positive(),
});

const listStoriesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  isRestricted: z.coerce.boolean().optional(),
  tags: z
    .string()
    .optional()
    .transform((str) => {
      if (!str) return undefined;
      return str
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    }),
  createdBy: z.coerce.number().int().positive().optional(),
  language: z.string().optional(),
  sortBy: z.enum(['createdAt', 'title', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export default async function storiesRoutes(fastify: FastifyInstance) {
  const db = await getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storyRepository = new StoryRepository(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileRepository = new FileRepository(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userRepository = new UserRepository(db as any);
  const storyService = new StoryService(
    storyRepository,
    fileRepository,
    userRepository,
    fastify.log
  );

  /**
   * CREATE Story
   * POST /api/v1/stories
   */
  fastify.post<{
    Body: z.infer<typeof createStorySchema>;
    Reply: {
      201: {
        data: StoryWithRelations;
        message: string;
      };
      400: { error: string };
      401: { error: string };
      403: { error: string };
      422: { error: string };
    };
  }>(
    '/',
    {
      preHandler: [requireAuth, requireCommunityAccess()],
      schema: {
        description:
          'Create a new story with cultural protocols and community scoping for Indigenous storytelling',
        summary: 'Create story',
        tags: ['Stories'],
        body: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description: 'Story title',
            },
            description: {
              type: 'string',
              description: 'Story description',
            },
            slug: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              pattern: '^[a-z0-9-]+$',
              description: 'URL-friendly slug (auto-generated if not provided)',
            },
            communityId: {
              type: 'integer',
              minimum: 1,
              description: 'Community ID',
            },
            mediaUrls: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uri',
              },
              description: 'Associated media file URLs',
            },
            language: {
              type: 'string',
              minLength: 2,
              maxLength: 10,
              default: 'en',
              description: 'Story language code',
            },
            tags: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Story tags',
            },
            culturalProtocols: {
              type: 'object',
              properties: {
                permissionLevel: {
                  type: 'string',
                  enum: ['public', 'community', 'restricted', 'elder_only'],
                  description: 'Access permission level',
                },
                culturalSignificance: {
                  type: 'string',
                  description: 'Cultural significance notes',
                },
                restrictions: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description: 'Cultural restrictions',
                },
                ceremonialContent: {
                  type: 'boolean',
                  description: 'Contains ceremonial content',
                },
                elderApprovalRequired: {
                  type: 'boolean',
                  description: 'Requires elder approval for modifications',
                },
                accessNotes: {
                  type: 'string',
                  description: 'Cultural access notes',
                },
              },
              description: 'Cultural protocol configuration',
            },
            placeIds: {
              type: 'array',
              items: {
                type: 'integer',
                minimum: 1,
              },
              description: 'Associated place IDs',
            },
            speakerIds: {
              type: 'array',
              items: {
                type: 'integer',
                minimum: 1,
              },
              description: 'Associated speaker IDs',
            },
            placeContexts: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Cultural context for each place',
            },
            speakerRoles: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Role of each speaker in the story',
            },
          },
          required: ['title', 'communityId'],
        },
        response: {
          201: {
            description: 'Story created successfully with cultural protocols',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                description: 'Created story with relations',
              },
              message: {
                type: 'string',
                example: 'Story created successfully',
              },
            },
          },
          400: {
            description: 'Bad request - validation error',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          403: {
            description:
              'Forbidden - insufficient permissions or cultural protocol violation',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          422: {
            description: 'Unprocessable entity - business logic error',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async (
      request: AuthenticatedRequest & {
        body: z.infer<typeof createStorySchema>;
      },
      reply: FastifyReply
    ) => {
      try {
        const input = createStorySchema.parse(request.body);
        const {
          id: userId,
          role: userRole,
          communityId,
        } = request.session.user!;

        const story = await storyService.createStory(
          { ...input, createdBy: userId } as StoryCreateInput,
          userId,
          userRole,
          communityId
        );

        return reply.status(201).send({
          data: story,
          message: 'Story created successfully',
        });
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage, userId: request.session.user!.id },
          'Error creating story'
        );

        if (error instanceof Error) {
          if (error.name === 'ZodError') {
            return reply.status(400).send({ error: 'Invalid request data' });
          }

          if (
            error.name === 'InsufficientPermissionsError' ||
            error.name === 'CulturalProtocolViolationError'
          ) {
            return reply.status(403).send({ error: error.message });
          }

          if (error.name === 'DataSovereigntyViolationError') {
            return reply.status(403).send({ error: error.message });
          }

          return reply.status(422).send({ error: error.message });
        }

        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * GET Story by ID
   * GET /api/v1/stories/:id
   */
  fastify.get<{
    Params: z.infer<typeof storyParamsSchema>;
    Reply: {
      200: { data: StoryWithRelations | null };
      401: { error: string };
      403: { error: string };
      404: { error: string };
    };
  }>(
    '/:id',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'Get story by ID with cultural protocol enforcement and community scoping',
        summary: 'Get story by ID',
        tags: ['Stories'],
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              minimum: 1,
              description: 'Story ID',
            },
          },
          required: ['id'],
        },
        response: {
          200: {
            description: 'Story with all relations and cultural context',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                description:
                  'Story with places, speakers, community, and author',
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          403: {
            description: 'Forbidden - access denied or cultural restrictions',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          404: {
            description: 'Story not found or access denied',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async (
      request: AuthenticatedRequest & {
        params: z.infer<typeof storyParamsSchema>;
      },
      reply: FastifyReply
    ) => {
      try {
        const { id } = storyParamsSchema.parse(request.params);
        const {
          id: userId,
          role: userRole,
          communityId,
        } = request.session.user!;

        const story = await storyService.getStoryById(
          id,
          userId,
          userRole,
          communityId
        );

        if (!story) {
          return reply.status(404).send({ error: 'Story not found' });
        }

        return reply.send({ data: story });
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request.log.error(
          { error: errorMessage, storyId: (request.params as any).id },
          'Error fetching story'
        );
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * GET Story by Slug
   * GET /api/v1/stories/slug/:slug/community/:communityId
   */
  fastify.get<{
    Params: z.infer<typeof slugParamsSchema>;
    Reply: {
      200: { data: StoryWithRelations | null };
      401: { error: string };
      403: { error: string };
      404: { error: string };
    };
  }>(
    '/slug/:slug/community/:communityId',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'Get story by slug within community with cultural protocol enforcement',
        summary: 'Get story by slug',
        tags: ['Stories'],
        params: {
          type: 'object',
          properties: {
            slug: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              description: 'Story slug',
            },
            communityId: {
              type: 'integer',
              minimum: 1,
              description: 'Community ID',
            },
          },
          required: ['slug', 'communityId'],
        },
        response: {
          200: {
            description: 'Story with all relations and cultural context',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                description:
                  'Story with places, speakers, community, and author',
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          403: {
            description: 'Forbidden - access denied or cultural restrictions',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          404: {
            description: 'Story not found or access denied',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async (
      request: AuthenticatedRequest & {
        params: z.infer<typeof slugParamsSchema>;
      },
      reply: FastifyReply
    ) => {
      try {
        const { slug, communityId } = slugParamsSchema.parse(request.params);
        const { id: userId, role: userRole } = request.session.user!;

        const story = await storyService.getStoryBySlug(
          slug,
          communityId,
          userId,
          userRole
        );

        if (!story) {
          return reply.status(404).send({ error: 'Story not found' });
        }

        return reply.send({ data: story });
      } catch (error: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request.log.error(
          { error: (error as any).message, slug: (request.params as any).slug },
          'Error fetching story by slug'
        );
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  /**
   * UPDATE Story
   * PATCH /api/v1/stories/:id
   */
  fastify.patch<{
    Params: z.infer<typeof storyParamsSchema>;
    Body: z.infer<typeof updateStorySchema>;
    Reply: {
      200: { data: StoryWithRelations | null; message: string };
      400: { error: string };
      401: { error: string };
      403: { error: string };
      404: { error: string };
      422: { error: string };
    };
  }>(
    '/:id',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'Update story with cultural protocol validation and community scoping',
        summary: 'Update story',
        tags: ['Stories'],
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              minimum: 1,
              description: 'Story ID',
            },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description: 'Story title',
            },
            description: {
              type: 'string',
              description: 'Story description',
            },
            mediaUrls: {
              type: 'array',
              items: {
                type: 'string',
                format: 'uri',
              },
              description: 'Associated media file URLs',
            },
            language: {
              type: 'string',
              minLength: 2,
              maxLength: 10,
              description: 'Story language code',
            },
            tags: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Story tags',
            },
            culturalProtocols: {
              type: 'object',
              properties: {
                permissionLevel: {
                  type: 'string',
                  enum: ['public', 'community', 'restricted', 'elder_only'],
                },
                culturalSignificance: {
                  type: 'string',
                },
                restrictions: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                },
                ceremonialContent: {
                  type: 'boolean',
                },
                elderApprovalRequired: {
                  type: 'boolean',
                },
                accessNotes: {
                  type: 'string',
                },
              },
              description: 'Cultural protocol updates',
            },
            placeIds: {
              type: 'array',
              items: {
                type: 'integer',
                minimum: 1,
              },
              description: 'Updated place associations',
            },
            speakerIds: {
              type: 'array',
              items: {
                type: 'integer',
                minimum: 1,
              },
              description: 'Updated speaker associations',
            },
          },
        },
        response: {
          200: {
            description: 'Story updated successfully with cultural protocols',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                description: 'Updated story with relations',
              },
              message: {
                type: 'string',
                example: 'Story updated successfully',
              },
            },
          },
          400: {
            description: 'Bad request - validation error',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          403: {
            description:
              'Forbidden - insufficient permissions or cultural protocol violation',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          404: {
            description: 'Story not found',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          422: {
            description: 'Unprocessable entity - business logic error',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async (
      request: AuthenticatedRequest & {
        params: z.infer<typeof storyParamsSchema>;
        body: z.infer<typeof updateStorySchema>;
      },
      reply: FastifyReply
    ) => {
      try {
        const { id } = storyParamsSchema.parse(request.params);
        const updates = updateStorySchema.parse(request.body);
        const { id: userId, role: userRole } = request.session.user!;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const story = await storyService.updateStory(
          id,
          updates as any,
          userId,
          userRole
        );

        return reply.send({
          data: story,
          message: 'Story updated successfully',
        });
      } catch (error: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request.log.error(
          {
            error: (error as any).message,
            storyId: (request.params as any).id,
          },
          'Error updating story'
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error as any).name === 'ZodError') {
          return reply.status(400).send({ error: 'Invalid request data' });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error as any).name === 'StoryNotFoundError') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return reply.status(404).send({ error: (error as any).message });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (
          (error as any).name === 'InsufficientPermissionsError' ||
          (error as any).name === 'CulturalProtocolViolationError'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return reply.status(403).send({ error: (error as any).message });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return reply.status(422).send({ error: (error as any).message });
      }
    }
  );

  /**
   * DELETE Story
   * DELETE /api/v1/stories/:id
   */
  fastify.delete<{
    Params: z.infer<typeof storyParamsSchema>;
    Reply: {
      204: null;
      401: { error: string };
      403: { error: string };
      404: { error: string };
    };
  }>(
    '/:id',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'Delete story with cultural protocol validation and community scoping',
        summary: 'Delete story',
        tags: ['Stories'],
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              minimum: 1,
              description: 'Story ID',
            },
          },
          required: ['id'],
        },
        response: {
          204: {
            description: 'Story deleted successfully',
            type: 'null',
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          403: {
            description:
              'Forbidden - insufficient permissions or cultural protocol violation',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          404: {
            description: 'Story not found',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async (
      request: AuthenticatedRequest & {
        params: z.infer<typeof storyParamsSchema>;
      },
      reply: FastifyReply
    ) => {
      try {
        const { id } = storyParamsSchema.parse(request.params);
        const { id: userId, role: userRole } = request.session.user!;

        await storyService.deleteStory(id, userId, userRole);

        return reply.status(204).send();
      } catch (error: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request.log.error(
          {
            error: (error as any).message,
            storyId: (request.params as any).id,
          },
          'Error deleting story'
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error as any).name === 'StoryNotFoundError') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return reply.status(404).send({ error: (error as any).message });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (
          (error as any).name === 'InsufficientPermissionsError' ||
          (error as any).name === 'CulturalProtocolViolationError'
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return reply.status(403).send({ error: (error as any).message });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return reply.status(422).send({ error: (error as any).message });
      }
    }
  );

  /**
   * LIST Stories
   * GET /api/v1/stories
   */
  fastify.get<{
    Querystring: z.infer<typeof listStoriesQuerySchema>;
    Reply: {
      200: {
        data: StoryWithRelations | null[];
        meta: {
          total: number;
          page: number;
          limit: number;
          totalPages: number;
        };
      };
      401: { error: string };
      403: { error: string };
    };
  }>(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'List stories with search, filtering, pagination, and cultural protocol enforcement',
        summary: 'List community stories',
        tags: ['Stories'],
        querystring: {
          type: 'object',
          properties: {
            page: {
              type: 'integer',
              minimum: 1,
              default: 1,
              description: 'Page number',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 20,
              description: 'Items per page',
            },
            search: {
              type: 'string',
              description: 'Search in title and description',
            },
            isRestricted: {
              type: 'boolean',
              description: 'Filter by restriction status',
            },
            tags: {
              type: 'string',
              description: 'Comma-separated list of tags to filter by',
            },
            createdBy: {
              type: 'integer',
              minimum: 1,
              description: 'Filter by author ID',
            },
            language: {
              type: 'string',
              description: 'Filter by language code',
            },
            sortBy: {
              type: 'string',
              enum: ['createdAt', 'title', 'updatedAt'],
              default: 'createdAt',
              description: 'Sort field',
            },
            sortOrder: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'desc',
              description: 'Sort direction',
            },
          },
        },
        response: {
          200: {
            description:
              'Paginated list of community stories with cultural context',
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  description: 'Story with relations',
                },
              },
              meta: {
                type: 'object',
                properties: {
                  total: {
                    type: 'integer',
                    description: 'Total number of stories',
                  },
                  page: {
                    type: 'integer',
                    description: 'Current page number',
                  },
                  limit: {
                    type: 'integer',
                    description: 'Items per page',
                  },
                  totalPages: {
                    type: 'integer',
                    description: 'Total number of pages',
                  },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
          403: {
            description: 'Forbidden - access denied due to data sovereignty',
            type: 'object',
            properties: {
              error: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async (
      request: AuthenticatedRequest & {
        query: z.infer<typeof listStoriesQuerySchema>;
      },
      reply: FastifyReply
    ) => {
      try {
        const filters = listStoriesQuerySchema.parse(request.query);
        const {
          id: userId,
          role: userRole,
          communityId,
        } = request.session.user!;

        const { tags, sortBy, sortOrder, ...otherFilters } = filters;

        const pagination = {
          page: filters.page,
          limit: filters.limit,
          sortBy,
          sortOrder,
        };

        const result = await storyService.listStories(
          { ...otherFilters, tags },
          pagination,
          userId,
          userRole,
          communityId
        );

        return reply.send({
          data: result.data,
          meta: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            totalPages: result.totalPages,
          },
        });
      } catch (error: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request.log.error(
          { error: (error as any).message, userId: request.session.user!.id },
          'Error listing stories'
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error as any).name === 'DataSovereigntyViolationError') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return reply.status(403).send({ error: (error as any).message });
        }

        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
