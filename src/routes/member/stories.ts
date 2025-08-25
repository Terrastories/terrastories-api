/**
 * Member Stories Routes
 *
 * Authenticated CRUD endpoints for member story management with comprehensive
 * cultural protocols, community data sovereignty, and role-based access control.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../shared/middleware/auth.middleware.js';
import { z } from 'zod';
import { StoryService } from '../../services/story.service.js';
import { StoryRepository } from '../../repositories/story.repository.js';
import { FileRepository } from '../../repositories/file.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { getDb } from '../../db/index.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toMemberStory,
  createPaginationMeta,
  type MemberListResponse,
  type MemberStoryDTO,
  MemberPaginationQuerySchema,
  MemberIdParamSchema,
  CreateStorySchema,
  UpdateStorySchema,
} from '../../shared/types/member.js';

// Request schemas
const listStoriesQuerySchema = MemberPaginationQuerySchema.extend({
  search: z.string().optional(),
  language: z.string().optional(),
  tags: z
    .string()
    .optional()
    .transform((str) =>
      str ? str.split(',').map((s) => s.trim()) : undefined
    ),
});

export async function memberStoriesRoutes(app: FastifyInstance) {
  const db = await getDb();
  // Type-safe repository instantiation with proper casting
  // StoryRepository requires BetterSQLite3Database, using unknown intermediate for type safety
  const storyRepository = new StoryRepository(
    db as unknown as BetterSQLite3Database<Record<string, never>>
  );
  const fileRepository = new FileRepository(db);
  const userRepository = new UserRepository(db);
  const storyService = new StoryService(
    storyRepository,
    fileRepository,
    userRepository,
    app.log
  );

  // GET /api/v1/member/stories - List user's community stories
  app.get('/', {
    schema: {
      description: "List stories in member's community",
      tags: ['Member Stories'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          language: { type: 'string' },
          tags: { type: 'string', description: 'Comma-separated list of tags' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { type: 'object' },
            },
            meta: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
                totalPages: { type: 'integer' },
                hasNextPage: { type: 'boolean' },
                hasPrevPage: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Type assertions for authenticated requests
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const query = listStoriesQuerySchema.parse(request.query);
        const page = parseInt(String(query.page), 10);
        const limit = parseInt(String(query.limit), 10);

        // Get stories using service
        const result = await storyService.listStories(
          {
            search: query.search,
            language: query.language,
            tags: query.tags,
          },
          { page, limit },
          user.id,
          userRole,
          userCommunityId
        );

        // Convert to DTOs
        const storyDTOs = result.data.map((story) =>
          toMemberStory(story, userRole)
        );

        const response: MemberListResponse<MemberStoryDTO> = {
          data: storyDTOs,
          meta: createPaginationMeta(page, limit, result.total),
        };

        return reply.code(200).send(response);
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid query parameters',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Error listing member stories'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to retrieve stories',
          },
        });
      }
    },
  });

  // GET /api/v1/member/stories/:id - Get specific story
  app.get('/:id', {
    schema: {
      description: 'Get specific story by ID',
      tags: ['Member Stories'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const params = MemberIdParamSchema.parse(request.params);
        const storyId = params.id;

        const story = await storyService.getStoryById(
          storyId,
          user.id,
          userRole,
          userCommunityId
        );

        if (!story) {
          return reply.code(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Story not found in your community',
            },
          });
        }

        const storyDTO = toMemberStory(story, userRole);
        return reply.code(200).send({ data: storyDTO });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid parameters',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          {
            error: errorMessage,
            storyId: (request.params as { id: string }).id,
          },
          'Error getting member story'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to retrieve story',
          },
        });
      }
    },
  });

  // POST /api/v1/member/stories - Create new story
  app.post('/', {
    schema: {
      description: 'Create new story',
      tags: ['Member Stories'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['title', 'slug'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string' },
          slug: { type: 'string', minLength: 1, maxLength: 100 },
          mediaUrls: {
            type: 'array',
            items: { type: 'string', format: 'uri' },
          },
          language: {
            type: 'string',
            minLength: 2,
            maxLength: 10,
            default: 'en',
          },
          tags: { type: 'array', items: { type: 'string' } },
          placeIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          speakerIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          isRestricted: { type: 'boolean', default: false },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const data = CreateStorySchema.parse(request.body);

        const storyData = {
          ...data,
          communityId: userCommunityId,
          createdBy: user.id,
        };

        const story = await storyService.createStory(
          storyData,
          user.id,
          userRole,
          userCommunityId
        );

        const storyDTO = toMemberStory(story, userRole);
        return reply.code(201).send({ data: storyDTO });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request body',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Error creating member story'
        );
        return reply.code(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create story' },
        });
      }
    },
  });

  // PUT /api/v1/member/stories/:id - Update story
  app.put('/:id', {
    schema: {
      description: 'Update story',
      tags: ['Member Stories'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string' },
          slug: { type: 'string', minLength: 1, maxLength: 100 },
          mediaUrls: {
            type: 'array',
            items: { type: 'string', format: 'uri' },
          },
          language: { type: 'string', minLength: 2, maxLength: 10 },
          tags: { type: 'array', items: { type: 'string' } },
          placeIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          speakerIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          isRestricted: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const params = MemberIdParamSchema.parse(request.params);
        const storyId = params.id;
        const updates = UpdateStorySchema.parse(request.body);

        const updatedStory = await storyService.updateStory(
          storyId,
          updates,
          user.id,
          userRole
        );

        const storyDTO = toMemberStory(updatedStory, userRole);
        return reply.code(200).send({ data: storyDTO });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          {
            error: errorMessage,
            storyId: (request.params as { id: string }).id,
          },
          'Error updating member story'
        );
        return reply.code(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to update story' },
        });
      }
    },
  });

  // DELETE /api/v1/member/stories/:id - Delete story
  app.delete('/:id', {
    schema: {
      description: 'Delete story',
      tags: ['Member Stories'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      response: {
        204: {
          type: 'null',
          description: 'Story deleted successfully',
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const params = MemberIdParamSchema.parse(request.params);
        const storyId = params.id;

        await storyService.deleteStory(storyId, user.id, userRole);

        return reply.code(204).send();
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid parameters',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          {
            error: errorMessage,
            storyId: (request.params as { id: string }).id,
          },
          'Error deleting member story'
        );
        return reply.code(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete story' },
        });
      }
    },
  });
}
