/**
 * Hono Member Routes
 *
 * V2 equivalent of Fastify member routes (member/places, member/speakers, member/stories).
 * Authenticated CRUD endpoints for member place, speaker, and story management with
 * comprehensive cultural protocols, community data sovereignty, and role-based access control.
 *
 * Mounted at /v2/member/* (sub-routes: /places, /speakers, /stories).
 *
 * Pattern: auth + data sovereignty → Zod validation → service layer → JSON response
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PlaceService } from '../../../services/place.service.js';
import { PlaceRepository } from '../../../repositories/place.repository.js';
import { SpeakerService } from '../../../services/speaker.service.js';
import { SpeakerRepository } from '../../../repositories/speaker.repository.js';
import { StoryService } from '../../../services/story.service.js';
import { StoryRepository } from '../../../repositories/story.repository.js';
import { FileRepository } from '../../../repositories/file.repository.js';
import { UserRepository } from '../../../repositories/user.repository.js';
import type { Database } from '../../../db/index.js';
import type { Logger } from '../../../shared/types/index.js';
import {
  toMemberPlace,
  toMemberSpeaker,
  toMemberStory,
  createPaginationMeta,
  type MemberListResponse,
  type MemberPlaceDTO,
  type MemberSpeakerDTO,
  type MemberStoryDTO,
  MemberIdParamSchema,
  MemberPaginationQuerySchema,
  CreatePlaceSchema,
  UpdatePlaceSchema,
  PlaceSearchQuerySchema,
  CreateSpeakerSchema,
  UpdateSpeakerSchema,
  SpeakerSearchQuerySchema,
  CreateStorySchema,
  UpdateStorySchema,
} from '../../../shared/types/member.js';
import {
  requireAuth,
  enforceDataSovereignty,
  getCurrentUser,
} from '../../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../../hono-app.js';
import { handleHonoError } from '../../../shared/middleware/hono-error.middleware.js';

const noopLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

// Stories-specific list query schema (extends pagination)
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

export function createMemberRoutes(database?: Database): Hono<AppEnv> {
  const member = new Hono<AppEnv>();

  const db = database;
  if (!db) return member;

  // Initialize repositories + services
  const placeRepository = new PlaceRepository(db);
  const placeService = new PlaceService(placeRepository);

  const speakerRepository = new SpeakerRepository(db);
  const speakerService = new SpeakerService(speakerRepository);

  const storyRepository = new StoryRepository(
    db as unknown as BetterSQLite3Database<Record<string, unknown>>
  );
  const fileRepository = new FileRepository(db);
  const userRepository = new UserRepository(db);
  const storyService = new StoryService(
    storyRepository,
    fileRepository,
    userRepository,
    noopLogger as never
  );

  // ============================================================
  // PLACES — /places/*
  // ============================================================

  // GET /places — List user's community places
  member.get('/places', requireAuth, enforceDataSovereignty, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const userCommunityId = user.communityId;
      const userRole = user.role;

      const query = PlaceSearchQuerySchema.parse(c.req.query());
      const page = parseInt(String(query.page), 10);
      const limit = parseInt(String(query.limit), 10);

      let result;
      if (query.lat && query.lng && query.radius) {
        result = await placeService.searchPlacesNear(
          {
            communityId: userCommunityId,
            latitude: Number(query.lat),
            longitude: Number(query.lng),
            radiusKm: Number(query.radius),
            page,
            limit,
          },
          userRole
        );
      } else {
        result = await placeService.getPlacesByCommunity(
          userCommunityId,
          { page, limit },
          userRole
        );
      }

      const placeDTOs = result.data.map((place) =>
        toMemberPlace(place, userRole)
      );

      const response: MemberListResponse<MemberPlaceDTO> = {
        data: placeDTOs,
        meta: createPaginationMeta(page, limit, result.total),
      };

      return c.json(response, 200);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /places/:id — Get specific place
  member.get(
    '/places/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const placeId = params.id;

        const place = await placeService.getPlaceById(
          placeId,
          userCommunityId,
          userRole
        );

        if (!place) {
          return c.json(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'Place not found in your community',
              },
            },
            404
          );
        }

        const placeDTO = toMemberPlace(place, userRole);
        return c.json({ data: placeDTO }, 200);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // POST /places — Create new place
  member.post('/places', requireAuth, enforceDataSovereignty, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const userCommunityId = user.communityId;
      const userRole = user.role;

      const body = await c.req.json();
      const data = CreatePlaceSchema.parse(body);

      const placeData = {
        name: data.name,
        description: data.description,
        latitude: data.lat,
        longitude: data.lng,
        culturalSignificance: data.culturalSignificance,
        region: data.region,
        isRestricted: data.isRestricted,
        mediaUrls: data.photoUrl ? [data.photoUrl] : [],
      };

      const place = await placeService.createPlace(
        placeData,
        userCommunityId,
        user.id,
        userRole
      );

      const placeDTO = toMemberPlace(place, userRole);
      return c.json({ data: placeDTO }, 201);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /places/:id — Update place
  member.put(
    '/places/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const placeId = params.id;
        const body = await c.req.json();
        const updates = UpdatePlaceSchema.parse(body);

        const updateData = {
          name: updates.name,
          description: updates.description,
          latitude: updates.lat,
          longitude: updates.lng,
          culturalSignificance: updates.culturalSignificance,
          region: updates.region,
          isRestricted: updates.isRestricted,
          mediaUrls: updates.photoUrl ? [updates.photoUrl] : undefined,
        };

        const place = await placeService.updatePlace(
          placeId,
          updateData,
          userCommunityId,
          user.id,
          userRole
        );

        const placeDTO = toMemberPlace(place, userRole);
        return c.json({ data: placeDTO }, 200);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // DELETE /places/:id — Delete place
  member.delete(
    '/places/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const placeId = params.id;

        await placeService.deletePlace(
          placeId,
          userCommunityId,
          user.id,
          userRole
        );

        return c.body(null, 204);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // ============================================================
  // SPEAKERS — /speakers/*
  // ============================================================

  // GET /speakers — List user's community speakers
  member.get('/speakers', requireAuth, enforceDataSovereignty, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const userCommunityId = user.communityId;
      const userRole = user.role;

      const query = SpeakerSearchQuerySchema.parse(c.req.query());
      const page = parseInt(String(query.page), 10);
      const limit = parseInt(String(query.limit), 10);

      const result = await speakerService.getSpeakersByCommunity(
        userCommunityId,
        {
          page,
          limit,
          elderOnly: query.isElder,
          culturalRole: query.culturalRole,
        },
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

      return c.json(response, 200);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /speakers/:id — Get specific speaker
  member.get(
    '/speakers/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const speakerId = params.id;

        const speaker = await speakerService.getSpeakerById(
          speakerId,
          userCommunityId
        );

        if (!speaker) {
          return c.json(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'Speaker not found in your community',
              },
            },
            404
          );
        }

        const speakerDTO = toMemberSpeaker(speaker, userRole);
        return c.json({ data: speakerDTO }, 200);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // POST /speakers — Create new speaker
  member.post('/speakers', requireAuth, enforceDataSovereignty, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const userCommunityId = user.communityId;
      const userRole = user.role;

      const body = await c.req.json();
      const data = CreateSpeakerSchema.parse(body);

      const speakerData = {
        name: data.name,
        bio: data.bio,
        birthYear: data.birthYear,
        photoUrl: data.photoUrl,
        elderStatus: data.isElder || false,
        culturalRole: data.culturalRole,
        isActive: true,
      };

      const speaker = await speakerService.createSpeaker(
        speakerData,
        userCommunityId,
        user.id,
        userRole
      );

      const speakerDTO = toMemberSpeaker(speaker, userRole);
      return c.json({ data: speakerDTO }, 201);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /speakers/:id — Update speaker
  member.put(
    '/speakers/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const speakerId = params.id;
        const body = await c.req.json();
        const updates = UpdateSpeakerSchema.parse(body);

        const updateData = {
          name: updates.name,
          bio: updates.bio,
          birthYear: updates.birthYear,
          photoUrl: updates.photoUrl,
          elderStatus: updates.isElder,
          culturalRole: updates.culturalRole,
        };

        const speaker = await speakerService.updateSpeaker(
          speakerId,
          updateData,
          userCommunityId,
          user.id,
          userRole
        );

        const speakerDTO = toMemberSpeaker(speaker, userRole);
        return c.json({ data: speakerDTO }, 200);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // DELETE /speakers/:id — Delete speaker
  member.delete(
    '/speakers/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const speakerId = params.id;

        await speakerService.deleteSpeaker(
          speakerId,
          userCommunityId,
          user.id,
          userRole
        );

        return c.body(null, 204);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // ============================================================
  // STORIES — /stories/*
  // ============================================================

  // GET /stories — List user's community stories
  member.get('/stories', requireAuth, enforceDataSovereignty, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const userCommunityId = user.communityId;
      const userRole = user.role;

      const query = listStoriesQuerySchema.parse(c.req.query());
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

      return c.json(response, 200);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /stories/:id — Get specific story
  member.get(
    '/stories/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userCommunityId = user.communityId;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const storyId = params.id;

        const story = await storyService.getStoryById(
          storyId,
          user.id,
          userRole,
          userCommunityId
        );

        if (!story) {
          return c.json(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'Story not found in your community',
              },
            },
            404
          );
        }

        const storyDTO = toMemberStory(story, userRole);
        return c.json({ data: storyDTO }, 200);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // POST /stories — Create new story
  member.post('/stories', requireAuth, enforceDataSovereignty, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const userCommunityId = user.communityId;
      const userRole = user.role;

      const body = await c.req.json();
      const data = CreateStorySchema.parse(body);

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
      return c.json({ data: storyDTO }, 201);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /stories/:id — Update story
  member.put(
    '/stories/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const storyId = params.id;
        const body = await c.req.json();
        const updates = UpdateStorySchema.parse(body);

        const updatedStory = await storyService.updateStory(
          storyId,
          updates,
          user.id,
          userRole
        );

        const storyDTO = toMemberStory(updatedStory, userRole);
        return c.json({ data: storyDTO }, 200);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // DELETE /stories/:id — Delete story
  member.delete(
    '/stories/:id',
    requireAuth,
    enforceDataSovereignty,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const userRole = user.role;

        const params = MemberIdParamSchema.parse({
          id: c.req.param('id'),
        });
        const storyId = params.id;

        await storyService.deleteStory(storyId, user.id, userRole);

        return c.body(null, 204);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  return member;
}
