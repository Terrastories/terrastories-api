/**
 * Member Dashboard Routes
 *
 * Authenticated CRUD endpoints for member story, place, and speaker management
 * with comprehensive cultural protocols, community data sovereignty, and role-based access control.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../shared/middleware/auth.middleware.js';
import { z } from 'zod';
import { StoryService } from '../../services/story.service.js';
import { PlaceService } from '../../services/place.service.js';
import { SpeakerService } from '../../services/speaker.service.js';
import { StoryRepository } from '../../repositories/story.repository.js';
import { PlaceRepository } from '../../repositories/place.repository.js';
import { SpeakerRepository } from '../../repositories/speaker.repository.js';
import { FileRepository } from '../../repositories/file.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { getDb } from '../../db/index.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toMemberStory,
  toMemberPlace,
  toMemberSpeaker,
  createPaginationMeta,
  type MemberListResponse,
  type MemberStoryDTO,
  type MemberPlaceDTO,
  type MemberSpeakerDTO,
  MemberPaginationQuerySchema,
  PlaceSearchQuerySchema,
  SpeakerSearchQuerySchema,
  MemberIdParamSchema,
} from '../../shared/types/member.js';

export interface MemberRoutesOptions {
  database?: unknown;
}

/**
 * Register all member dashboard routes
 * Routes are mounted under /api/v1/member prefix
 */
export async function memberRoutes(
  app: FastifyInstance,
  _options?: MemberRoutesOptions
) {
  const db = await getDb();

  // Type-safe repository instantiation
  const storyRepository = new StoryRepository(
    db as unknown as BetterSQLite3Database<Record<string, never>>
  );
  const placeRepository = new PlaceRepository(db);
  const speakerRepository = new SpeakerRepository(db);
  const fileRepository = new FileRepository(db);
  const userRepository = new UserRepository(db);

  // Service instantiation
  const storyService = new StoryService(
    storyRepository,
    fileRepository,
    userRepository,
    app.log
  );
  const placeService = new PlaceService(placeRepository);
  const speakerService = new SpeakerService(speakerRepository);

  // Helper function to get authenticated user
  const getAuthenticatedUser = (request: FastifyRequest) => {
    const user = (request as AuthenticatedRequest).user;
    if (!user || !user.communityId) {
      throw new Error('UNAUTHORIZED');
    }
    return {
      user,
      userCommunityId: user.communityId,
      userRole: user.role as
        | 'super_admin'
        | 'admin'
        | 'editor'
        | 'viewer'
        | 'elder',
    };
  };

  // Helper function for error handling
  const handleError = (
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
    context: string
  ) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request parameters',
          details: error.issues,
        },
      });
    }

    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    request.log.error({ error: errorMessage }, context);
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: `Failed to ${context}` },
    });
  };

  // === STORY ROUTES ===

  // GET /api/v1/member/stories - List user's community stories
  app.get('/stories', {
    config: {
      rateLimit: {
        max: 100, // 100 requests per minute for member dashboard
        timeWindow: 60 * 1000, // 1 minute in milliseconds
        keyGenerator: (req: FastifyRequest) => {
          const user = (req as AuthenticatedRequest).user;
          // Prefer user-scoped limiting; fallback to IP if unauthenticated
          return user ? `member:${user.communityId}:${user.id}` : req.ip;
        },
      },
    },
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
            data: { type: 'array', items: { type: 'object' } },
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
        const { user, userCommunityId, userRole } =
          getAuthenticatedUser(request);

        const querySchema = MemberPaginationQuerySchema.extend({
          search: z.string().optional(),
          language: z.string().optional(),
          tags: z
            .string()
            .optional()
            .transform((str) =>
              str ? str.split(',').map((s) => s.trim()) : undefined
            ),
        });

        const query = querySchema.parse(request.query);
        const page = parseInt(String(query.page), 10);
        const limit = parseInt(String(query.limit), 10);

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

        const storyDTOs = result.data.map((story) =>
          toMemberStory(story, userRole)
        );

        const response: MemberListResponse<MemberStoryDTO> = {
          data: storyDTOs,
          meta: createPaginationMeta(page, limit, result.total),
        };

        return reply.code(200).send(response);
      } catch (error: unknown) {
        return handleError(error, request, reply, 'list stories');
      }
    },
  });

  // GET /api/v1/member/stories/:id - Get specific story
  app.get('/stories/:id', {
    config: {
      rateLimit: {
        max: 100, // 100 requests per minute for member dashboard
        timeWindow: 60 * 1000, // 1 minute in milliseconds
        keyGenerator: (req: FastifyRequest) => {
          const user = (req as AuthenticatedRequest).user;
          // Prefer user-scoped limiting; fallback to IP if unauthenticated
          return user ? `member:${user.communityId}:${user.id}` : req.ip;
        },
      },
    },
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
          properties: { data: { type: 'object' } },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { user, userCommunityId, userRole } =
          getAuthenticatedUser(request);

        const params = MemberIdParamSchema.parse(request.params);
        const storyId = parseInt(params.id, 10);

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
        return handleError(error, request, reply, 'get story');
      }
    },
  });

  // === PLACE ROUTES ===

  // GET /api/v1/member/places - List user's community places
  app.get('/places', {
    config: {
      rateLimit: {
        max: 100, // 100 requests per minute for member dashboard
        timeWindow: 60 * 1000, // 1 minute in milliseconds
        keyGenerator: (req: FastifyRequest) => {
          const user = (req as AuthenticatedRequest).user;
          // Prefer user-scoped limiting; fallback to IP if unauthenticated
          return user ? `member:${user.communityId}:${user.id}` : req.ip;
        },
      },
    },
    schema: {
      description: "List places in member's community",
      tags: ['Member Places'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          radius: { type: 'number', minimum: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
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
        const { userCommunityId, userRole } = getAuthenticatedUser(request);

        const query = PlaceSearchQuerySchema.parse(request.query);
        const page = parseInt(String(query.page), 10);
        const limit = parseInt(String(query.limit), 10);

        const searchOptions = {
          search: query.search,
          lat: query.lat ? Number(query.lat) : undefined,
          lng: query.lng ? Number(query.lng) : undefined,
          radius: query.radius ? Number(query.radius) : undefined,
        };

        const result = await placeService.getPlacesByCommunity(
          userCommunityId,
          { ...searchOptions, page, limit },
          userRole
        );

        const placeDTOs = result.data.map((place) =>
          toMemberPlace(place, userRole)
        );

        const response: MemberListResponse<MemberPlaceDTO> = {
          data: placeDTOs,
          meta: createPaginationMeta(page, limit, result.total),
        };

        return reply.code(200).send(response);
      } catch (error: unknown) {
        return handleError(error, request, reply, 'list places');
      }
    },
  });

  // === SPEAKER ROUTES ===

  // GET /api/v1/member/speakers - List user's community speakers
  app.get('/speakers', {
    config: {
      rateLimit: {
        max: 100, // 100 requests per minute for member dashboard
        timeWindow: 60 * 1000, // 1 minute in milliseconds
        keyGenerator: (req: FastifyRequest) => {
          const user = (req as AuthenticatedRequest).user;
          // Prefer user-scoped limiting; fallback to IP if unauthenticated
          return user ? `member:${user.communityId}:${user.id}` : req.ip;
        },
      },
    },
    schema: {
      description: "List speakers in member's community",
      tags: ['Member Speakers'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          culturalRole: {
            type: 'string',
            enum: [
              'storyteller',
              'elder',
              'historian',
              'cultural_keeper',
              'ceremonial_leader',
            ],
          },
          isElder: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
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
        const { user, userCommunityId, userRole } =
          getAuthenticatedUser(request);

        const query = SpeakerSearchQuerySchema.parse(request.query);
        const page = parseInt(String(query.page), 10);
        const limit = parseInt(String(query.limit), 10);

        const searchOptions = {
          search: query.search,
          culturalRole: query.culturalRole,
          isElder: query.isElder,
        };

        const result = await speakerService.getSpeakersByCommunity(
          userCommunityId,
          { ...searchOptions, page, limit },
          user.id,
          userRole
        );

        const speakerDTOs = result.data.map((speaker) =>
          toMemberSpeaker(speaker, userRole)
        );

        const response: MemberListResponse<MemberSpeakerDTO> = {
          data: speakerDTOs,
          meta: createPaginationMeta(page, limit, result.total),
        };

        return reply.code(200).send(response);
      } catch (error: unknown) {
        return handleError(error, request, reply, 'list speakers');
      }
    },
  });
}
