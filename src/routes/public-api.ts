/**
 * Public API Routes
 *
 * Community-scoped public read-only API endpoints for Terrastories.
 * These endpoints provide public access to community content without authentication,
 * supporting the public storytelling mission while respecting cultural protocols.
 *
 * Features:
 * - Community-scoped story and place access
 * - No authentication required (public access)
 * - Community data sovereignty enforcement
 * - Cultural protocol compliance (elder content filtering)
 * - Pagination and error handling
 * - Rails API response format compatibility
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { StoryService } from '../services/story.service.js';
import { PlaceService } from '../services/place.service.js';
import { CommunityService } from '../services/community.service.js';
import { StoryRepository } from '../repositories/story.repository.js';
import { PlaceRepository } from '../repositories/place.repository.js';
import { CommunityRepository } from '../repositories/community.repository.js';
import { FileRepository } from '../repositories/file.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { getDb } from '../db/index.js';
import {
  toPublicStory,
  toPublicPlace,
  CommunityIdParamSchema,
  PaginationQuerySchema,
} from '../shared/types/public.js';

// Note: Request validation schemas removed as they're not currently used
// in favor of simple parameter validation within route handlers

export async function publicApiRoutes(
  fastify: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { database?: any }
) {
  // Initialize database connection - use provided database instance or default
  const database = options?.database || (await getDb());

  /**
   * Community validation middleware
   * Validates that community_id exists and is accessible
   */
  async function validateCommunity(
    request: FastifyRequest<{ Params: { community_id: string } }>,
    reply: FastifyReply
  ) {
    const { community_id } = request.params;

    try {
      const communityRepository = new CommunityRepository(database);
      const communityService = new CommunityService(communityRepository);

      const community = await communityService.getCommunityById(
        parseInt(community_id, 10)
      );

      if (!community) {
        return reply.status(404).send({
          error: 'Community not found',
        });
      }

      // Attach community to request context for service use
      (request as FastifyRequest & { community: unknown }).community =
        community;
    } catch (error) {
      console.error('Community validation error:', error);
      return reply.status(500).send({
        error: 'Internal server error',
      });
    }
  }
  // GET /communities/:community_id/stories
  fastify.get<{
    Params: { community_id: string };
    Querystring: { page?: string; limit?: string };
  }>(
    '/communities/:community_id/stories',
    {
      preHandler: validateCommunity,
    },
    async (request, reply) => {
      try {
        // Validate parameters with Zod
        const params = CommunityIdParamSchema.parse(request.params);
        const query = PaginationQuerySchema.parse(request.query);

        const { community_id } = params;
        const page = parseInt(query.page, 10);
        const limit = parseInt(query.limit, 10);
        const storyRepository = new StoryRepository(database);
        const fileRepository = new FileRepository(database);
        const userRepository = new UserRepository(database);
        const storyService = new StoryService(
          storyRepository,
          fileRepository,
          userRepository,
          fastify.log
        );

        // Get public stories for the community
        const result = await storyService.getPublicStoriesByCommunity(
          community_id,
          {
            page,
            limit,
          }
        );

        return {
          data: result.stories.map(toPublicStory),
          meta: {
            pagination: {
              page,
              limit,
              total: result.total,
              totalPages: Math.ceil(result.total / limit),
              hasNextPage: page < Math.ceil(result.total / limit),
              hasPrevPage: page > 1,
            },
          },
        };
      } catch (error) {
        console.error('Public stories listing error:', error);
        // Handle validation errors
        if (error instanceof Error && error.message.includes('Invalid')) {
          return reply.status(400).send({
            error: error.message,
          });
        }
        return reply.status(500).send({
          error: 'Internal server error',
        });
      }
    }
  );

  // GET /communities/:community_id/stories/:id
  fastify.get<{
    Params: { community_id: string; id: string };
  }>(
    '/communities/:community_id/stories/:id',
    {
      preHandler: validateCommunity,
    },
    async (request, reply) => {
      const { community_id, id } = request.params;

      try {
        const storyRepository = new StoryRepository(database);
        const fileRepository = new FileRepository(database);
        const userRepository = new UserRepository(database);
        const storyService = new StoryService(
          storyRepository,
          fileRepository,
          userRepository,
          fastify.log
        );

        // Get public story by ID with community validation
        const story = await storyService.getPublicStoryById(id, community_id);

        if (!story) {
          return reply.status(404).send({
            error: 'Story not found or not public',
          });
        }

        return {
          data: toPublicStory(story),
        };
      } catch (error) {
        console.error('Public story retrieval error:', error);
        return reply.status(500).send({
          error: 'Internal server error',
        });
      }
    }
  );

  // GET /communities/:community_id/places
  fastify.get<{
    Params: { community_id: string };
    Querystring: { page?: string; limit?: string };
  }>(
    '/communities/:community_id/places',
    {
      preHandler: validateCommunity,
    },
    async (request, reply) => {
      const { community_id } = request.params;
      const page = parseInt(request.query.page || '1', 10);
      const limit = parseInt(request.query.limit || '20', 10);

      // Validate pagination parameters
      if (page < 1 || limit < 1 || limit > 100) {
        return reply.status(400).send({
          error: 'Invalid pagination parameters',
        });
      }

      try {
        const placeRepository = new PlaceRepository(database);
        const placeService = new PlaceService(placeRepository);

        // Get places for the community using existing method
        const result = await placeService.getPlacesByCommunity(
          parseInt(community_id, 10),
          {
            page,
            limit,
          },
          'viewer'
        );

        return {
          data: result.data.map(toPublicPlace),
          meta: {
            pagination: {
              page: result.page,
              limit: result.limit,
              total: result.total,
              totalPages: result.pages,
              hasNextPage: result.page < result.pages,
              hasPrevPage: result.page > 1,
            },
          },
        };
      } catch (error) {
        console.error('Public places listing error:', error);
        return reply.status(500).send({
          error: 'Internal server error',
        });
      }
    }
  );

  // GET /communities/:community_id/places/:id
  fastify.get<{
    Params: { community_id: string; id: string };
  }>(
    '/communities/:community_id/places/:id',
    {
      preHandler: validateCommunity,
    },
    async (request, reply) => {
      const { community_id, id } = request.params;

      try {
        const placeRepository = new PlaceRepository(database);
        const placeService = new PlaceService(placeRepository);

        try {
          // Get place by ID
          const place = await placeService.getPlaceById(
            parseInt(id, 10),
            parseInt(community_id, 10),
            'viewer'
          );

          return {
            data: toPublicPlace(place),
          };
        } catch (placeError: unknown) {
          // Handle specific place service errors
          const errorMessage =
            placeError instanceof Error ? placeError.message : '';
          const errorName =
            placeError instanceof Error ? placeError.constructor.name : '';

          if (
            errorMessage.includes('not found') ||
            errorName === 'PlaceNotFoundError'
          ) {
            return reply.status(404).send({
              error: 'Place not found',
            });
          }
          // Re-throw other errors to be handled by outer catch
          throw placeError;
        }
      } catch (error) {
        console.error('Public place retrieval error:', error);
        return reply.status(500).send({
          error: 'Internal server error',
        });
      }
    }
  );
}
