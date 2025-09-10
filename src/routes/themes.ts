/**
 * Themes API Routes - Complete Map Theme Management
 *
 * RESTful API endpoints for theme management with:
 * - Complete CRUD operations via service layer
 * - Geographic bounds management
 * - Mapbox style URL integration
 * - Cultural protocol enforcement
 * - Community data isolation
 * - Indigenous data sovereignty protection
 * - Comprehensive input validation
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ThemesRepository } from '../repositories/themes.repository.js';
import {
  ThemesService,
  type ThemeCreateInput,
  type ThemeUpdateInput,
  type ThemeSearchOptions,
} from '../services/themes.service.js';
import { getDb, type Database } from '../db/index.js';
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';
import { handleRouteError } from '../shared/middleware/error.middleware.js';
import { createThemeSchema, updateThemeSchema } from '../db/schema/themes.js';
import type { Logger } from '../shared/types/index.js';

/**
 * Additional Zod schemas for API operations
 */

// Query parameters for list/search operations
const ListThemesQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('Page number (1-based)'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Items per page (max 100)'),
  active: z.coerce.boolean().optional().describe('Filter by active status'),
  search: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Search theme names (partial match)'),
  sortBy: z
    .enum(['name', 'created_at', 'updated_at'])
    .optional()
    .describe('Sort field'),
  sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
});

// Path parameters
const ThemeIdParamSchema = z.object({
  id: z.coerce.number().int().min(1).describe('Theme ID'),
});

export async function themesRoutes(
  app: FastifyInstance,
  options?: { database?: Database }
) {
  const db = options?.database || (await getDb());
  const themesRepository = new ThemesRepository(db);

  // Initialize minimal logger for themes service
  const logger: Logger = {
    info: (_message: string, _meta?: Record<string, unknown>) => {
      // In production, this would integrate with proper logging system
    },
    debug: (_message: string, _meta?: Record<string, unknown>) => {
      // Debug logging disabled in routes
    },
    warn: (_message: string, _meta?: Record<string, unknown>) => {
      // Warning logging disabled in routes
    },
    error: (_message: string, _meta?: Record<string, unknown>) => {
      // Error logging disabled in routes - handled by route error handlers
    },
  };

  const themesService = new ThemesService(themesRepository, logger);

  /**
   * Create Theme
   * POST /api/v1/themes
   */
  app.post<{
    Body: z.infer<typeof createThemeSchema>;
  }>(
    '/',
    {
      preHandler: [requireAuth, requireRole(['admin'])],
      schema: {
        summary: 'Create a new map theme',
        description:
          'Creates a new theme for map visualization with geographic bounds and styling options.',
        tags: ['Themes'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description: 'Theme name',
            },
            description: {
              type: 'string',
              maxLength: 2000,
              description: 'Theme description',
            },
            active: {
              type: 'boolean',
              default: true,
              description: 'Whether theme is active',
            },
            centerLat: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Center latitude',
            },
            centerLong: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Center longitude',
            },
            swBoundaryLat: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Southwest boundary latitude',
            },
            swBoundaryLong: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Southwest boundary longitude',
            },
            neBoundaryLat: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Northeast boundary latitude',
            },
            neBoundaryLong: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Northeast boundary longitude',
            },
            zoom: {
              type: 'number',
              minimum: 1,
              maximum: 22,
              description: 'Default zoom level',
            },
            mapboxStyleUrl: {
              type: 'string',
              pattern: '^mapbox://styles/',
              description: 'Mapbox style URL (mapbox://styles/...)',
            },
            communityId: {
              type: 'number',
              minimum: 1,
              description: 'Community ID',
            },
          },
          required: ['name', 'communityId'],
        },
        response: {
          201: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  active: { type: 'boolean' },
                  centerLat: { type: 'number' },
                  centerLong: { type: 'number' },
                  swBoundaryLat: { type: 'number' },
                  swBoundaryLong: { type: 'number' },
                  neBoundaryLat: { type: 'number' },
                  neBoundaryLong: { type: 'number' },
                  zoom: { type: 'number' },
                  mapboxStyleUrl: { type: 'string' },
                  communityId: { type: 'number' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: {
                type: 'string',
                example: 'Invalid geographic boundaries',
              },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Unauthorized' },
            },
          },
          403: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Forbidden' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      try {
        // Validate input using createThemeSchema, then transform to service input
        const validatedData = createThemeSchema.parse(request.body);

        const themeInput: ThemeCreateInput = {
          name: validatedData.name,
          description: validatedData.description,
          mapboxStyleUrl: validatedData.mapboxStyleUrl,
          mapboxAccessToken: validatedData.mapboxAccessToken,
          centerLat: validatedData.centerLat,
          centerLong: validatedData.centerLong,
          swBoundaryLat: validatedData.swBoundaryLat,
          swBoundaryLong: validatedData.swBoundaryLong,
          neBoundaryLat: validatedData.neBoundaryLat,
          neBoundaryLong: validatedData.neBoundaryLong,
          active: validatedData.active,
          communityId: validatedData.communityId,
        };

        // Create theme via service layer (handles all validation and permissions)
        const theme = await themesService.createTheme(
          themeInput,
          authRequest.user.id,
          authRequest.user.role,
          authRequest.user.communityId
        );

        return reply.code(201).send({
          data: theme,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    }
  );

  /**
   * List Themes
   * GET /api/v1/themes
   */
  app.get<{
    Querystring: z.infer<typeof ListThemesQuerySchema>;
  }>(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        summary: 'List community themes',
        description:
          "Retrieves a paginated list of themes for the authenticated user's community.",
        tags: ['Themes'],
        security: [{ bearerAuth: [] }],
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
            active: { type: 'boolean', description: 'Filter by active status' },
            search: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              description: 'Search theme names',
            },
            sortBy: {
              type: 'string',
              enum: ['name', 'created_at', 'updated_at'],
              description: 'Sort field',
            },
            sortOrder: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort direction',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    active: { type: 'boolean' },
                    centerLat: { type: 'number' },
                    centerLong: { type: 'number' },
                    swBoundaryLat: { type: 'number' },
                    swBoundaryLong: { type: 'number' },
                    neBoundaryLat: { type: 'number' },
                    neBoundaryLong: { type: 'number' },
                    zoom: { type: 'number' },
                    mapboxStyleUrl: { type: 'string' },
                    communityId: { type: 'number' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
              meta: {
                type: 'object',
                properties: {
                  total: { type: 'number' },
                  page: { type: 'number' },
                  limit: { type: 'number' },
                  totalPages: { type: 'number' },
                },
              },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Unauthorized' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      try {
        const query = ListThemesQuerySchema.parse(request.query);

        const searchOptions: ThemeSearchOptions = {
          page: query.page,
          limit: query.limit,
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          activeOnly: query.active,
          searchTerm: query.search,
        };

        // Use service layer for complete business logic and validation
        const result = await themesService.listThemes(
          searchOptions,
          authRequest.user.id,
          authRequest.user.role,
          authRequest.user.communityId
        );

        return reply.send({
          data: result.data,
          meta: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            totalPages: result.pages,
          },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    }
  );

  /**
   * Get Active Themes
   * GET /api/v1/themes/active
   */
  app.get(
    '/active',
    {
      preHandler: [requireAuth],
      schema: {
        summary: 'List active themes',
        description:
          "Retrieves all active themes for the authenticated user's community.",
        tags: ['Themes'],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    active: { type: 'boolean' },
                    centerLat: { type: 'number' },
                    centerLong: { type: 'number' },
                    swBoundaryLat: { type: 'number' },
                    swBoundaryLong: { type: 'number' },
                    neBoundaryLat: { type: 'number' },
                    neBoundaryLong: { type: 'number' },
                    zoom: { type: 'number' },
                    mapboxStyleUrl: { type: 'string' },
                    communityId: { type: 'number' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Unauthorized' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      try {
        // Use service layer for active themes with full validation
        const themes = await themesService.getActiveThemes(
          authRequest.user.id,
          authRequest.user.role,
          authRequest.user.communityId
        );

        return reply.send({
          data: themes,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    }
  );

  /**
   * Get Theme by ID
   * GET /api/v1/themes/:id
   */
  app.get<{
    Params: z.infer<typeof ThemeIdParamSchema>;
  }>(
    '/:id',
    {
      preHandler: [requireAuth],
      schema: {
        summary: 'Get theme by ID',
        description: 'Retrieves a specific theme by ID (community-scoped).',
        tags: ['Themes'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1, description: 'Theme ID' },
          },
          required: ['id'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  active: { type: 'boolean' },
                  centerLat: { type: 'number' },
                  centerLong: { type: 'number' },
                  swBoundaryLat: { type: 'number' },
                  swBoundaryLong: { type: 'number' },
                  neBoundaryLat: { type: 'number' },
                  neBoundaryLong: { type: 'number' },
                  zoom: { type: 'number' },
                  mapboxStyleUrl: { type: 'string' },
                  communityId: { type: 'number' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Theme not found' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Unauthorized' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      try {
        const { id } = ThemeIdParamSchema.parse(request.params);

        // Use service layer with full validation and cultural protocol enforcement
        const theme = await themesService.getThemeById(
          id,
          authRequest.user.id,
          authRequest.user.role,
          authRequest.user.communityId
        );

        if (!theme) {
          return reply.code(404).send({ error: 'Theme not found' });
        }

        return reply.send({
          data: theme,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    }
  );

  /**
   * Update Theme
   * PUT /api/v1/themes/:id
   */
  app.put<{
    Params: z.infer<typeof ThemeIdParamSchema>;
    Body: z.infer<typeof updateThemeSchema>;
  }>(
    '/:id',
    {
      preHandler: [requireAuth, requireRole(['admin'])],
      schema: {
        summary: 'Update theme',
        description:
          'Updates an existing theme (admin only, community-scoped).',
        tags: ['Themes'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1, description: 'Theme ID' },
          },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description: 'Theme name',
            },
            description: {
              type: 'string',
              maxLength: 2000,
              description: 'Theme description',
            },
            active: { type: 'boolean', description: 'Whether theme is active' },
            centerLat: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Center latitude',
            },
            centerLong: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Center longitude',
            },
            swBoundaryLat: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Southwest boundary latitude',
            },
            swBoundaryLong: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Southwest boundary longitude',
            },
            neBoundaryLat: {
              type: 'number',
              minimum: -90,
              maximum: 90,
              description: 'Northeast boundary latitude',
            },
            neBoundaryLong: {
              type: 'number',
              minimum: -180,
              maximum: 180,
              description: 'Northeast boundary longitude',
            },
            zoom: {
              type: 'number',
              minimum: 1,
              maximum: 22,
              description: 'Default zoom level',
            },
            mapboxStyleUrl: {
              type: 'string',
              pattern: '^mapbox://styles/',
              description: 'Mapbox style URL (mapbox://styles/...)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  active: { type: 'boolean' },
                  centerLat: { type: 'number' },
                  centerLong: { type: 'number' },
                  swBoundaryLat: { type: 'number' },
                  swBoundaryLong: { type: 'number' },
                  neBoundaryLat: { type: 'number' },
                  neBoundaryLong: { type: 'number' },
                  zoom: { type: 'number' },
                  mapboxStyleUrl: { type: 'string' },
                  communityId: { type: 'number' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: {
                type: 'string',
                example: 'Invalid geographic boundaries',
              },
            },
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Theme not found' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Unauthorized' },
            },
          },
          403: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Forbidden' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      try {
        const { id } = ThemeIdParamSchema.parse(request.params);
        const validatedData = updateThemeSchema.parse(request.body);

        const updateInput: ThemeUpdateInput = {
          name: validatedData.name,
          description: validatedData.description,
          mapboxStyleUrl: validatedData.mapboxStyleUrl,
          mapboxAccessToken: validatedData.mapboxAccessToken,
          centerLat: validatedData.centerLat,
          centerLong: validatedData.centerLong,
          swBoundaryLat: validatedData.swBoundaryLat,
          swBoundaryLong: validatedData.swBoundaryLong,
          neBoundaryLat: validatedData.neBoundaryLat,
          neBoundaryLong: validatedData.neBoundaryLong,
          active: validatedData.active,
        };

        // Use service layer with full validation and cultural protocol enforcement
        const updatedTheme = await themesService.updateTheme(
          id,
          updateInput,
          authRequest.user.id,
          authRequest.user.role,
          authRequest.user.communityId
        );

        if (!updatedTheme) {
          return reply.code(404).send({ error: 'Theme not found' });
        }

        return reply.send({
          data: updatedTheme,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    }
  );

  /**
   * Delete Theme
   * DELETE /api/v1/themes/:id
   */
  app.delete<{
    Params: z.infer<typeof ThemeIdParamSchema>;
  }>(
    '/:id',
    {
      preHandler: [requireAuth, requireRole(['admin'])],
      schema: {
        summary: 'Delete theme',
        description: 'Deletes a theme (admin only, community-scoped).',
        tags: ['Themes'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          properties: {
            id: { type: 'integer', minimum: 1, description: 'Theme ID' },
          },
          required: ['id'],
        },
        response: {
          204: {
            type: 'null',
            description: 'Theme deleted successfully',
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Theme not found' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Unauthorized' },
            },
          },
          403: {
            type: 'object',
            properties: {
              error: { type: 'string', example: 'Forbidden' },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      try {
        const { id } = ThemeIdParamSchema.parse(request.params);

        // Use service layer with full validation and cultural protocol enforcement
        const deleted = await themesService.deleteTheme(
          id,
          authRequest.user.id,
          authRequest.user.role,
          authRequest.user.communityId
        );

        if (!deleted) {
          return reply.code(404).send({ error: 'Theme not found' });
        }

        return reply.code(204).send();
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    }
  );
}
