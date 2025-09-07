/**
 * Member Places Routes
 *
 * Authenticated CRUD endpoints for member place management with comprehensive
 * cultural protocols, community data sovereignty, and PostGIS support.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  requireAuth,
  requireCommunityAccess,
  type AuthenticatedRequest,
} from '../../shared/middleware/auth.middleware.js';
import { z } from 'zod';
import { PlaceService } from '../../services/place.service.js';
import { PlaceRepository } from '../../repositories/place.repository.js';
import { getDb, type Database } from '../../db/index.js';
import {
  toMemberPlace,
  createPaginationMeta,
  type MemberListResponse,
  type MemberPlaceDTO,
  MemberIdParamSchema,
  CreatePlaceSchema,
  UpdatePlaceSchema,
  PlaceSearchQuerySchema,
} from '../../shared/types/member.js';

export interface MemberPlacesRoutesOptions {
  database?: Database;
}

export async function memberPlacesRoutes(
  app: FastifyInstance,
  options?: MemberPlacesRoutesOptions
) {
  const db = options?.database || (await getDb());
  const placeRepository = new PlaceRepository(db);
  const placeService = new PlaceService(placeRepository);

  // GET /api/v1/member/places - List user's community places
  app.get('/', {
    preHandler: [requireAuth, requireCommunityAccess()],
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

        const query = PlaceSearchQuerySchema.parse(request.query);
        const page = parseInt(String(query.page), 10);
        const limit = parseInt(String(query.limit), 10);

        let result;
        if (query.lat && query.lng && query.radius) {
          // Geographic search
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
          // Regular community listing
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
          'Error listing member places'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to retrieve places',
          },
        });
      }
    },
  });

  // GET /api/v1/member/places/:id - Get specific place
  app.get('/:id', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Get specific place by ID',
      tags: ['Member Places'],
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
        const placeId = params.id;

        const place = await placeService.getPlaceById(
          placeId,
          userCommunityId,
          userRole
        );

        if (!place) {
          return reply.code(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Place not found in your community',
            },
          });
        }

        const placeDTO = toMemberPlace(place, userRole);
        return reply.code(200).send({ data: placeDTO });
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
            placeId: (request.params as { id: string }).id,
          },
          'Error getting member place'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to retrieve place',
          },
        });
      }
    },
  });

  // POST /api/v1/member/places - Create new place
  app.post('/', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Create new place',
      tags: ['Member Places'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'lat', 'lng'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          culturalSignificance: {
            type: 'string',
            enum: ['general', 'significant', 'sacred', 'restricted'],
            default: 'general',
          },
          photoUrl: { type: 'string', format: 'uri' },
          nameAudioUrl: { type: 'string', format: 'uri' },
          region: { type: 'string', maxLength: 100 },
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

        const data = CreatePlaceSchema.parse(request.body);

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
        return reply.code(201).send({ data: placeDTO });
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
          'Error creating member place'
        );
        return reply.code(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create place' },
        });
      }
    },
  });

  // PUT /api/v1/member/places/:id - Update place
  app.put('/:id', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Update place',
      tags: ['Member Places'],
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
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string' },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          culturalSignificance: {
            type: 'string',
            enum: ['general', 'significant', 'sacred', 'restricted'],
          },
          photoUrl: { type: 'string', format: 'uri' },
          nameAudioUrl: { type: 'string', format: 'uri' },
          region: { type: 'string', maxLength: 100 },
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
        const placeId = params.id;
        const updates = UpdatePlaceSchema.parse(request.body);

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
        return reply.code(200).send({ data: placeDTO });
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
            placeId: (request.params as { id: string }).id,
          },
          'Error updating member place'
        );
        return reply.code(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to update place' },
        });
      }
    },
  });

  // DELETE /api/v1/member/places/:id - Delete place
  app.delete('/:id', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Delete place',
      tags: ['Member Places'],
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
          description: 'Place deleted successfully',
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
        const placeId = params.id;

        await placeService.deletePlace(
          placeId,
          userCommunityId,
          user.id,
          userRole
        );

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
            placeId: (request.params as { id: string }).id,
          },
          'Error deleting member place'
        );
        return reply.code(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete place' },
        });
      }
    },
  });
}
