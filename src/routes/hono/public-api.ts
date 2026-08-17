/**
 * Hono Public API Routes
 *
 * V2 equivalent of Fastify public-api routes.
 * Community-scoped public read-only API endpoints. NO authentication required.
 * Mounted at /v2/communities/*
 *
 * Features:
 * - Community-scoped story and place access
 * - No authentication required (public access)
 * - Community data sovereignty enforcement
 * - Cultural protocol compliance (elder content filtering)
 * - Pagination and error handling
 */

import { Hono } from 'hono';
import { StoryService } from '../../services/story.service.js';
import { PlaceService } from '../../services/place.service.js';
import { CommunityService } from '../../services/community.service.js';
import { StoryRepository } from '../../repositories/story.repository.js';
import { PlaceRepository } from '../../repositories/place.repository.js';
import { CommunityRepository } from '../../repositories/community.repository.js';
import { FileRepository } from '../../repositories/file.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import type { Database } from '../../db/index.js';
import {
  toPublicStory,
  toPublicPlace,
  CommunityIdParamSchema,
  PaginationQuerySchema,
} from '../../shared/types/public.js';
import type { AppEnv } from '../../hono-app.js';
import type { Logger } from '../../shared/types/index.js';

const noopLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export function createPublicApiRoutes(database?: Database): Hono<AppEnv> {
  const publicApi = new Hono<AppEnv>();

  const db = database;
  if (!db) return publicApi;

  // GET /communities — List all communities
  publicApi.get('/communities', async (c) => {
    try {
      const query = PaginationQuerySchema.parse(c.req.query());
      const page = parseInt(query.page, 10);
      const limit = parseInt(query.limit, 10);

      const communityRepository = new CommunityRepository(db);

      // Get active communities directly from repository (simpler for public API)
      const communities = await communityRepository.findAllActive();

      // Simple pagination on results
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedCommunities = communities.slice(startIndex, endIndex);

      return c.json({
        data: paginatedCommunities,
        meta: {
          page,
          limit,
          total: communities.length,
        },
      });
    } catch (error) {
      console.error('Public communities listing error:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // GET /communities/:community_id/stories
  publicApi.get(
    '/communities/:community_id/stories',
    async (c) => {
      try {
        const params = CommunityIdParamSchema.parse({
          community_id: c.req.param('community_id'),
        });
        const query = PaginationQuerySchema.parse(c.req.query());

        const { community_id } = params;
        const page = parseInt(query.page, 10);
        const limit = parseInt(query.limit, 10);

        // Validate community exists
        const communityRepository = new CommunityRepository(db);
        const communityService = new CommunityService(communityRepository);
        const community = await communityService.getCommunityById(
          parseInt(community_id, 10)
        );

        if (!community) {
          return c.json({ error: 'Community not found' }, 404);
        }

        const storyRepository = new StoryRepository(db as never);
        const fileRepository = new FileRepository(db as never);
        const userRepository = new UserRepository(db);
        const storyService = new StoryService(
          storyRepository,
          fileRepository,
          userRepository,
          noopLogger
        );

        // Get public stories for the community
        const result = await storyService.getPublicStoriesByCommunity(
          community_id,
          {
            page,
            limit,
          }
        );

        return c.json({
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
        });
      } catch (error) {
        console.error('Public stories listing error:', error);
        if (error instanceof Error && error.message.includes('Invalid')) {
          return c.json({ error: error.message }, 400);
        }
        return c.json({ error: 'Internal server error' }, 500);
      }
    }
  );

  // GET /communities/:community_id/stories/:id
  publicApi.get(
    '/communities/:community_id/stories/:id',
    async (c) => {
      const community_id = c.req.param('community_id');
      const id = c.req.param('id');

      try {
        // Validate community exists
        const communityRepository = new CommunityRepository(db);
        const communityService = new CommunityService(communityRepository);
        const community = await communityService.getCommunityById(
          parseInt(community_id, 10)
        );

        if (!community) {
          return c.json({ error: 'Community not found' }, 404);
        }

        const storyRepository = new StoryRepository(db as never);
        const fileRepository = new FileRepository(db as never);
        const userRepository = new UserRepository(db);
        const storyService = new StoryService(
          storyRepository,
          fileRepository,
          userRepository,
          noopLogger
        );

        // Get public story by ID with community validation
        const story = await storyService.getPublicStoryById(
          id,
          community_id
        );

        if (!story) {
          return c.json({ error: 'Story not found or not public' }, 404);
        }

        return c.json({ data: toPublicStory(story) });
      } catch (error) {
        console.error('Public story retrieval error:', error);
        return c.json({ error: 'Internal server error' }, 500);
      }
    }
  );

  // GET /communities/:community_id/places
  publicApi.get('/communities/:community_id/places', async (c) => {
    const community_id = c.req.param('community_id');
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '20', 10);

    // Validate pagination parameters
    if (page < 1 || limit < 1 || limit > 100) {
      return c.json({ error: 'Invalid pagination parameters' }, 400);
    }

    try {
      // Validate community exists
      const communityRepository = new CommunityRepository(db);
      const communityService = new CommunityService(communityRepository);
      const community = await communityService.getCommunityById(
        parseInt(community_id, 10)
      );

      if (!community) {
        return c.json({ error: 'Community not found' }, 404);
      }

      const placeRepository = new PlaceRepository(db);
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

      return c.json({
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
      });
    } catch (error) {
      console.error('Public places listing error:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // GET /communities/:community_id/places/:id
  publicApi.get('/communities/:community_id/places/:id', async (c) => {
    const community_id = c.req.param('community_id');
    const id = c.req.param('id');

    try {
      // Validate community exists
      const communityRepository = new CommunityRepository(db);
      const communityService = new CommunityService(communityRepository);
      const community = await communityService.getCommunityById(
        parseInt(community_id, 10)
      );

      if (!community) {
        return c.json({ error: 'Community not found' }, 404);
      }

      const placeRepository = new PlaceRepository(db);
      const placeService = new PlaceService(placeRepository);

      try {
        // Get place by ID
        const place = await placeService.getPlaceById(
          parseInt(id, 10),
          parseInt(community_id, 10),
          'viewer'
        );

        return c.json({ data: toPublicPlace(place) });
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
          return c.json({ error: 'Place not found' }, 404);
        }
        // Re-throw other errors to be handled by outer catch
        throw placeError;
      }
    } catch (error) {
      console.error('Public place retrieval error:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return publicApi;
}
