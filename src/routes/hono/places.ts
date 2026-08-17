/**
 * Hono Places Routes
 *
 * V2 equivalent of Fastify places routes.
 * CRUD + spatial endpoints (near, bounds, stats) for places.
 * Mounted at /v2/places/*
 *
 * Pattern: auth middleware → Zod validation → service layer → JSON response
 *
 * IMPORTANT: Static routes (/near, /bounds, /stats) MUST be registered
 * before the /:id route so Hono does not match them as params.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { PlaceRepository } from '../../repositories/place.repository.js';
import { PlaceService } from '../../services/place.service.js';
import type { Database } from '../../db/index.js';
import {
  requireAuth,
  requireRole,
  getCurrentUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../hono-app.js';
import { handleHonoError } from '../../shared/middleware/hono-error.middleware.js';

// ========================================
// VALIDATION SCHEMAS
// ========================================

// Base coordinate validation (reusable for body validation)
const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90).describe('Latitude (-90 to 90)'),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe('Longitude (-180 to 180)'),
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

// Query parameter schemas
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

// ========================================
// ROUTE SETUP
// ========================================

export function createPlacesRoutes(database?: Database): Hono<AppEnv> {
  const places = new Hono<AppEnv>();

  const db = database;
  if (!db) return places;

  const placeRepository = new PlaceRepository(db);
  const placeService = new PlaceService(placeRepository);

  // POST /places — Create (admin/editor only)
  places.post('/', requireAuth, requireRole(['admin', 'editor']), async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const body = await c.req.json();
      const data = CreatePlaceSchema.parse(body);

      const place = await placeService.createPlace(
        data,
        user.communityId,
        user.id,
        user.role
      );

      return c.json(
        { data: place, meta: { message: 'Place created successfully' } },
        201
      );
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /places/near — Search places near coordinates
  // MUST come before /:id
  places.get('/near', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const params = NearbySearchSchema.parse(c.req.query());

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

      return c.json({
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
      return handleHonoError(c, error);
    }
  });

  // GET /places/bounds — Search places within bounding box
  // MUST come before /:id
  places.get('/bounds', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const params = BoundsSearchSchema.parse(c.req.query());

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

      return c.json({
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
      return handleHonoError(c, error);
    }
  });

  // GET /places/stats — Community place statistics
  // MUST come before /:id
  places.get('/stats', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const stats = await placeService.getCommunityPlaceStats(
        user.communityId
      );

      return c.json({ data: stats });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /places — List with pagination (always scoped to user's community)
  places.get('/', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const params = PaginationSchema.parse(c.req.query());

      // Convert page-based params to offset-based for database queries
      const offset = (params.page - 1) * params.limit;
      const repositoryParams = {
        limit: params.limit,
        offset,
        page: params.page,
      };

      // Always use the authenticated user's community ID — no cross-community access
      const result = await placeService.getPlacesByCommunity(
        user.communityId,
        repositoryParams,
        user.role
      );

      return c.json({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page || params.page, // Ensure page is always present
          limit: result.limit,
          pages: result.pages,
          filters: {
            communityId: user.communityId,
          },
        },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /places/:id
  places.get('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = PlaceIdSchema.parse({ id: c.req.param('id') });

      const place = await placeService.getPlaceById(
        id,
        user.communityId,
        user.role
      );

      return c.json({ data: place });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /places/:id — Update (admin/editor only)
  places.put('/:id', requireAuth, requireRole(['admin', 'editor']), async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = PlaceIdSchema.parse({ id: c.req.param('id') });
      const body = await c.req.json();
      const data = UpdatePlaceSchema.parse(body);

      const place = await placeService.updatePlace(
        id,
        data,
        user.communityId,
        user.id,
        user.role
      );

      return c.json({
        data: place,
        meta: { message: 'Place updated successfully' },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // DELETE /places/:id — Delete (admin/elder only)
  places.delete(
    '/:id',
    requireAuth,
    requireRole(['admin', 'elder']),
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const { id } = PlaceIdSchema.parse({ id: c.req.param('id') });

        await placeService.deletePlace(
          id,
          user.communityId,
          user.id,
          user.role
        );

        return c.body(null, 204);
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  return places;
}
