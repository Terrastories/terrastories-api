/**
 * Places API Routes - Simplified for Testing
 *
 * RESTful API endpoints for place management with:
 * - Complete CRUD operations
 * - Geographic search capabilities (distance, bounding box)
 * - Cultural protocol enforcement
 * - Community data isolation
 * - Comprehensive input validation
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PlaceService } from '../services/place.service.js';
import { PlaceRepository } from '../repositories/place.repository.js';
import { getDb, type Database } from '../db/index.js';
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';
import { handleRouteError } from '../shared/middleware/error.middleware.js';

/**
 * Zod validation schemas
 */

// Base coordinate validation (reusable for body validation)
const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90).describe('Latitude (-90 to 90)'),
  longitude: z.number().min(-180).max(180).describe('Longitude (-180 to 180)'),
});

// Create place request schema
const CreatePlaceSchema = CoordinateSchema.extend({
  name: z.string().min(1).max(200).describe('Place name'),
  description: z.string().max(2000).optional().describe('Place description'),
  region: z.string().max(100).optional().describe('Regional classification'),
  mediaUrls: z
    .array(z.string().url())
    .max(10)
    .optional()
    .describe('Media URLs (max 10)'),
  culturalSignificance: z
    .string()
    .max(1000)
    .optional()
    .describe('Cultural significance description'),
  isRestricted: z
    .boolean()
    .optional()
    .default(false)
    .describe('Restricted access (elders only)'),
});

// Update place request schema
const UpdatePlaceSchema = CreatePlaceSchema.partial()
  .omit({ latitude: true, longitude: true })
  .extend({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('New latitude coordinate'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('New longitude coordinate'),
  });

// Query parameters schemas
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Items per page'),
});

const NearbySearchSchema = z
  .object({
    latitude: z.coerce
      .number()
      .min(-90)
      .max(90)
      .describe('Latitude (-90 to 90)'),
    longitude: z.coerce
      .number()
      .min(-180)
      .max(180)
      .describe('Longitude (-180 to 180)'),
    radius: z.coerce
      .number()
      .min(0.1)
      .max(1000)
      .describe('Search radius in kilometers'),
  })
  .merge(PaginationSchema);

const BoundsSearchSchema = z
  .object({
    north: z.coerce.number().min(-90).max(90).describe('Northern boundary'),
    south: z.coerce.number().min(-90).max(90).describe('Southern boundary'),
    east: z.coerce.number().min(-180).max(180).describe('Eastern boundary'),
    west: z.coerce.number().min(-180).max(180).describe('Western boundary'),
  })
  .merge(PaginationSchema);

// Path parameters schema
const PlaceIdSchema = z.object({
  id: z.coerce.number().int().positive().describe('Place ID'),
});

/**
 * Register place routes with Fastify
 */
export async function placesRoutes(
  fastify: FastifyInstance,
  options?: { database?: Database }
) {
  // Initialize service - use provided database instance or default
  const database = options?.database || (await getDb());
  const placeRepository = new PlaceRepository(database);
  const placeService = new PlaceService(placeRepository);

  /**
   * Create a new place
   * POST /api/v1/places
   */
  fastify.post('/places', {
    preHandler: [requireAuth, requireRole(['admin', 'editor'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = CreatePlaceSchema.parse(request.body);
        const { user } = request as AuthenticatedRequest;

        const place = await placeService.createPlace(
          data,
          user.communityId,
          user.id,
          user.role
        );

        return reply.status(201).send({
          data: place,
          meta: { message: 'Place created successfully' },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * Get place by ID
   * GET /api/v1/places/:id
   */
  fastify.get('/places/:id', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = PlaceIdSchema.parse(request.params);
        const { user } = request as AuthenticatedRequest;

        const place = await placeService.getPlaceById(
          id,
          user.communityId,
          user.role
        );

        return reply.send({
          data: place,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * List places for community
   * GET /api/v1/places
   */
  fastify.get('/places', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = PaginationSchema.parse(request.query);
      const { community_id } = request.query as { community_id?: string };
      const { user } = request as AuthenticatedRequest;

      // Convert page-based params to offset-based for database queries
      const offset = (params.page - 1) * params.limit;
      const repositoryParams = {
        limit: params.limit,
        offset,
        page: params.page,
      };

      let result;
      if (community_id) {
        // If community_id is specified, filter by that community
        result = await placeService.getPlacesByCommunity(
          parseInt(community_id, 10),
          repositoryParams,
          'viewer' // Use minimal permissions for public access
        );
      } else {
        // Use the authenticated user's community ID as default
        result = await placeService.getPlacesByCommunity(
          user.communityId,
          repositoryParams,
          user.role
        );
      }

      return reply.send({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page || params.page, // Ensure page is always present
          limit: result.limit,
          pages: result.pages,
          filters: { communityId: community_id || user.communityId },
        },
      });
    },
  });

  /**
   * Update place by ID
   * PUT /api/v1/places/:id
   */
  fastify.put('/places/:id', {
    preHandler: [requireAuth, requireRole(['admin', 'editor'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = PlaceIdSchema.parse(request.params);
        const data = UpdatePlaceSchema.parse(request.body);
        const { user } = request as AuthenticatedRequest;

        const place = await placeService.updatePlace(
          id,
          data,
          user.communityId,
          user.id,
          user.role
        );

        return reply.send({
          data: place,
          meta: { message: 'Place updated successfully' },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * Delete place by ID
   * DELETE /api/v1/places/:id
   */
  fastify.delete('/places/:id', {
    preHandler: [requireAuth, requireRole(['admin', 'elder'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = PlaceIdSchema.parse(request.params);
        const { user } = request as AuthenticatedRequest;

        await placeService.deletePlace(
          id,
          user.communityId,
          user.id,
          user.role
        );

        return reply.status(204).send();
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * Search places near coordinates
   * GET /api/v1/places/near
   */
  fastify.get('/places/near', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const params = NearbySearchSchema.parse(request.query);
        const { user } = request as AuthenticatedRequest;

        const result = await placeService.searchPlacesNear(
          {
            communityId: user.communityId,
            latitude: params.latitude,
            longitude: params.longitude,
            radiusKm: params.radius,
            page: params.page,
            limit: params.limit,
          },
          user.role
        );

        return reply.send({
          data: result.data,
          meta: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            pages: result.pages,
            searchParams: {
              latitude: params.latitude,
              longitude: params.longitude,
              radius: params.radius,
            },
          },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * Search places within bounding box
   * GET /api/v1/places/bounds
   */
  fastify.get('/places/bounds', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const params = BoundsSearchSchema.parse(request.query);
        const { user } = request as AuthenticatedRequest;

        const result = await placeService.getPlacesByBounds(
          {
            communityId: user.communityId,
            north: params.north,
            south: params.south,
            east: params.east,
            west: params.west,
            page: params.page,
            limit: params.limit,
          },
          user.role
        );

        return reply.send({
          data: result.data,
          meta: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            pages: result.pages,
            searchParams: {
              bounds: {
                north: params.north,
                south: params.south,
                east: params.east,
                west: params.west,
              },
            },
          },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * Get community place statistics
   * GET /api/v1/places/stats
   */
  fastify.get('/places/stats', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const { user } = request as AuthenticatedRequest;

      const stats = await placeService.getCommunityPlaceStats(user.communityId);

      return reply.send({
        data: stats,
      });
    },
  });
}
