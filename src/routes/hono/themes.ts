/**
 * Hono Themes Routes
 *
 * V2 equivalent of Fastify themes routes.
 * CRUD for map themes. Mounted at /v2/themes/*
 *
 * Pattern: auth middleware → Zod validation → service layer → JSON response
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ThemesRepository } from '../../repositories/themes.repository.js';
import {
  ThemesService,
  type ThemeCreateInput,
  type ThemeUpdateInput,
  type ThemeSearchOptions,
} from '../../services/themes.service.js';
import type { Database } from '../../db/index.js';
import { createThemeSchema, updateThemeSchema } from '../../db/schema/themes.js';
import {
  requireAuth,
  requireRole,
  getCurrentUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../hono-app.js';
import { handleHonoError } from '../../shared/middleware/hono-error.middleware.js';
import type { Logger } from '../../shared/types/index.js';

const ListThemesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  active: z.coerce.boolean().optional(),
  search: z.string().min(1).max(100).optional(),
  sortBy: z.enum(['name', 'created_at', 'updated_at']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const ThemeIdParamSchema = z.object({
  id: z.coerce.number().int().min(1),
});

const noopLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

export function createThemesRoutes(database?: Database): Hono<AppEnv> {
  const themes = new Hono<AppEnv>();

  const db = database;
  if (!db) return themes;

  const themesRepository = new ThemesRepository(db);
  const themesService = new ThemesService(themesRepository, noopLogger);

  // POST /themes — Create (admin only)
  themes.post('/', requireAuth, requireRole(['admin']), async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const body = await c.req.json();
      const validatedData = createThemeSchema.parse(body);

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

      const theme = await themesService.createTheme(
        themeInput,
        user.id,
        user.role,
        user.communityId
      );

      return c.json({ data: theme }, 201);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /themes/active — Must come before /:id
  themes.get('/active', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const activeThemes = await themesService.getActiveThemes(
        user.id,
        user.role,
        user.communityId
      );
      return c.json({ data: activeThemes });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /themes — List with pagination
  themes.get('/', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const query = ListThemesQuerySchema.parse(c.req.query());

      const searchOptions: ThemeSearchOptions = {
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        activeOnly: query.active,
        searchTerm: query.search,
      };

      const result = await themesService.listThemes(
        searchOptions,
        user.id,
        user.role,
        user.communityId
      );

      return c.json({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.pages,
        },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /themes/:id
  themes.get('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = ThemeIdParamSchema.parse({ id: c.req.param('id') });

      const theme = await themesService.getThemeById(
        id,
        user.id,
        user.role,
        user.communityId
      );

      if (!theme) {
        return c.json({ error: 'Theme not found' }, 404);
      }

      return c.json({ data: theme });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /themes/:id — Update (admin only)
  themes.put('/:id', requireAuth, requireRole(['admin']), async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = ThemeIdParamSchema.parse({ id: c.req.param('id') });
      const body = await c.req.json();
      const validatedData = updateThemeSchema.parse(body);

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

      const updatedTheme = await themesService.updateTheme(
        id,
        updateInput,
        user.id,
        user.role,
        user.communityId
      );

      if (!updatedTheme) {
        return c.json({ error: 'Theme not found' }, 404);
      }

      return c.json({ data: updatedTheme });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // DELETE /themes/:id — Delete (admin only)
  themes.delete('/:id', requireAuth, requireRole(['admin']), async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = ThemeIdParamSchema.parse({ id: c.req.param('id') });

      const deleted = await themesService.deleteTheme(
        id,
        user.id,
        user.role,
        user.communityId
      );

      if (!deleted) {
        return c.json({ error: 'Theme not found' }, 404);
      }

      return c.body(null, 204);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  return themes;
}
