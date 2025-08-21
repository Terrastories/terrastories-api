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
import type { UserRole } from '../services/place.service.js';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../shared/middleware/auth.middleware.js';

/**
 * Zod validation schemas
 */

// Base coordinate validation
const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90).describe('Latitude (-90 to 90)'),
  longitude: z.number().min(-180).max(180).describe('Longitude (-180 to 180)'),
});

// Create place request schema
const CreatePlaceSchema = z.object({
  name: z.string().min(1).max(200).describe('Place name'),
  description: z.string().max(2000).optional().describe('Place description'),
  latitude: z.number().min(-90).max(90).describe('Latitude coordinate'),
  longitude: z.number().min(-180).max(180).describe('Longitude coordinate'),
  region: z.string().max(100).optional().describe('Regional classification'),
  mediaUrls: z.array(z.string().url()).max(10).optional().describe('Media URLs (max 10)'),
  culturalSignificance: z.string().max(1000).optional().describe('Cultural significance description'),
  isRestricted: z.boolean().optional().default(false).describe('Restricted access (elders only)'),
});

// Update place request schema
const UpdatePlaceSchema = CreatePlaceSchema.partial().omit({ latitude: true, longitude: true }).extend({
  latitude: z.number().min(-90).max(90).optional().describe('New latitude coordinate'),
  longitude: z.number().min(-180).max(180).optional().describe('New longitude coordinate'),
});

// Query parameters schemas
const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number'),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Items per page'),
});

const NearbySearchSchema = CoordinateSchema.extend({
  radius: z.coerce.number().min(0.1).max(1000).describe('Search radius in kilometers'),
}).merge(PaginationSchema);

const BoundsSearchSchema = z.object({
  north: z.coerce.number().min(-90).max(90).describe('Northern boundary'),
  south: z.coerce.number().min(-90).max(90).describe('Southern boundary'),
  east: z.coerce.number().min(-180).max(180).describe('Eastern boundary'),
  west: z.coerce.number().min(-180).max(180).describe('Western boundary'),
}).merge(PaginationSchema);

// Path parameters schema
const PlaceIdSchema = z.object({
  id: z.coerce.number().int().positive().describe('Place ID'),
});

/**
 * Register place routes with Fastify
 */
export async function placesRoutes(fastify: FastifyInstance) {
  // Initialize service
  const db = await getDb();
  const placeRepository = new PlaceRepository(db);
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
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: {
              message: 'Validation error',
              details: error.issues,
            },
          });
        }

        if (error instanceof Error) {
          if (error.message.includes('coordinate') || error.message.includes('URL')) {
            return reply.status(400).send({
              error: { message: error.message },
            });
          }

          if (error.message.includes('permission') || error.message.includes('Only')) {
            return reply.status(403).send({
              error: { message: error.message },
            });
          }
        }

        throw error;
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

        const place = await placeService.getPlaceById(id, user.communityId, user.role);

        return reply.send({
          data: place,
        });
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.status(404).send({
              error: { message: 'Place not found' },
            });
          }

          if (error.message.includes('restricted') || error.message.includes('Cultural')) {
            return reply.status(403).send({
              error: { message: error.message },
            });
          }
        }

        throw error;
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
      const { user } = request as AuthenticatedRequest;

      const result = await placeService.getPlacesByCommunity(
        user.communityId,
        params,
        user.role
      );

      return reply.send({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          pages: result.pages,
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
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: {
              message: 'Validation error',
              details: error.issues,
            },
          });
        }

        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.status(404).send({
              error: { message: 'Place not found' },
            });
          }

          if (error.message.includes('coordinate') || error.message.includes('URL')) {
            return reply.status(400).send({
              error: { message: error.message },
            });
          }

          if (error.message.includes('protocol') || error.message.includes('Only')) {
            return reply.status(403).send({
              error: { message: error.message },
            });
          }
        }

        throw error;
      }
    },
  });

  /**
   * Delete place by ID
   * DELETE /api/v1/places/:id
   */
  fastify.delete('/places/:id', {
    preHandler: [requireAuth, requireRole(['admin'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = PlaceIdSchema.parse(request.params);
        const { user } = request as AuthenticatedRequest;

        await placeService.deletePlace(id, user.communityId, user.id, user.role);

        return reply.status(204).send();
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes('not found')) {
            return reply.status(404).send({
              error: { message: 'Place not found' },
            });
          }

          if (error.message.includes('permission') || error.message.includes('Only')) {
            return reply.status(403).send({
              error: { message: error.message },
            });
          }
        }

        throw error;
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
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: {
              message: 'Invalid search parameters',
              details: error.issues,
            },
          });
        }

        if (error instanceof Error && error.message.includes('coordinate')) {
          return reply.status(400).send({
            error: { message: error.message },
          });
        }

        throw error;
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
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: {
              message: 'Invalid bounding box parameters',
              details: error.issues,
            },
          });
        }

        if (error instanceof Error && (
          error.message.includes('bounding box') || 
          error.message.includes('coordinate')
        )) {
          return reply.status(400).send({
            error: { message: error.message },
          });
        }

        throw error;
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