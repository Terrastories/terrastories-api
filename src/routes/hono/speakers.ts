/**
 * Hono Speakers Routes
 *
 * V2 equivalent of Fastify speakers routes.
 * CRUD + search + stats for speakers.
 * Mounted at /v2/speakers/*
 *
 * Pattern: auth middleware → Zod validation → service layer → JSON response
 *
 * IMPORTANT: Static routes (/search, /stats) MUST be registered
 * before the /:id route so Hono does not match them as params.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { SpeakerRepository } from '../../repositories/speaker.repository.js';
import { SpeakerService } from '../../services/speaker.service.js';
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

// Create speaker request schema
const CreateSpeakerSchema = z.object({
  name: z.string().min(1).max(200).describe('Speaker name'),
  bio: z.string().max(2000).optional().describe('Speaker biography'),
  photoUrl: z
    .string()
    .transform((val) => (val === '' ? undefined : val))
    .pipe(z.string().url().optional())
    .describe('Speaker photo URL'),
  birthYear: z
    .number()
    .int()
    .min(1900)
    .max(new Date().getFullYear())
    .optional()
    .describe('Birth year'),
  elderStatus: z.boolean().optional().default(false).describe('Elder status'),
  culturalRole: z
    .string()
    .max(100)
    .optional()
    .describe('Cultural role in community'),
  isActive: z.boolean().optional().default(true).describe('Active status'),
});

// Update speaker request schema - Remove defaults to avoid triggering permission checks
const UpdateSpeakerSchema = z.object({
  name: z.string().min(1).max(200).optional().describe('Speaker name'),
  bio: z.string().max(2000).optional().describe('Speaker biography'),
  photoUrl: z
    .union([z.string().url(), z.literal(''), z.undefined()])
    .optional()
    .transform((val) => (val === '' ? undefined : val))
    .describe('Speaker photo URL'),
  birthYear: z
    .number()
    .int()
    .min(1900)
    .max(new Date().getFullYear())
    .optional()
    .describe('Birth year'),
  elderStatus: z.boolean().optional().describe('Elder status'),
  culturalRole: z
    .string()
    .max(100)
    .optional()
    .describe('Cultural role in community'),
  isActive: z.boolean().optional().describe('Active status'),
});

// Query parameter schemas
const PaginationSchema = z.object({
  page: z.coerce.number().min(1).optional().default(1).describe('Page number'),
  limit: z.coerce
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Items per page'),
});

const SpeakerListQuerySchema = PaginationSchema.extend({
  elderOnly: z.coerce.boolean().optional().describe('Filter elders only'),
  culturalRole: z.string().optional().describe('Filter by cultural role'),
  activeOnly: z.coerce
    .boolean()
    .optional()
    .describe('Filter active speakers only'),
  sortBy: z
    .enum(['name', 'created_at', 'updated_at'])
    .optional()
    .default('name')
    .describe('Sort field'),
  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .default('asc')
    .describe('Sort order'),
});

const SearchQuerySchema = PaginationSchema.extend({
  q: z.string().min(2).describe('Search query (minimum 2 characters)'),
});

// Path parameter schemas
const SpeakerIdSchema = z.object({
  id: z.coerce.number().min(1).describe('Speaker ID'),
});

// ========================================
// ROUTE SETUP
// ========================================

export function createSpeakersRoutes(database?: Database): Hono<AppEnv> {
  const speakers = new Hono<AppEnv>();

  const db = database;
  if (!db) return speakers;

  const speakerRepository = new SpeakerRepository(db);
  const speakerService = new SpeakerService(speakerRepository);

  // POST /speakers — Create (admin/editor only)
  speakers.post(
    '/',
    requireAuth,
    requireRole(['admin', 'editor']),
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const body = await c.req.json();
        const data = CreateSpeakerSchema.parse(body);

        const speaker = await speakerService.createSpeaker(
          data,
          user.communityId,
          user.id,
          user.role
        );

        return c.json(
          {
            data: speaker,
            meta: { message: 'Speaker created successfully' },
          },
          201
        );
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // GET /speakers/search — Search speakers
  // MUST come before /:id
  speakers.get('/search', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const params = SearchQuerySchema.parse(c.req.query());

      const result = await speakerService.searchSpeakers(
        user.communityId,
        params.q,
        {
          page: params.page,
          limit: params.limit,
        },
        user.id,
        user.role
      );

      return c.json({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          pages: result.pages,
        },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /speakers/stats — Community speaker statistics
  // MUST come before /:id
  speakers.get('/stats', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const stats = await speakerService.getCommunityStats(user.communityId);

      return c.json({ data: stats });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /speakers — List community speakers
  speakers.get('/', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const params = SpeakerListQuerySchema.parse(c.req.query());

      const result = await speakerService.getSpeakersByCommunity(
        user.communityId,
        params,
        user.id,
        user.role
      );

      return c.json({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          pages: result.pages,
        },
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /speakers/:id
  speakers.get('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = SpeakerIdSchema.parse({ id: c.req.param('id') });

      const speaker = await speakerService.getSpeakerById(
        id,
        user.communityId
      );

      return c.json({ data: speaker });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PUT /speakers/:id — Update (admin/editor only)
  speakers.put(
    '/:id',
    requireAuth,
    requireRole(['admin', 'editor']),
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const { id } = SpeakerIdSchema.parse({ id: c.req.param('id') });
        const body = await c.req.json();
        const data = UpdateSpeakerSchema.parse(body);

        const speaker = await speakerService.updateSpeaker(
          id,
          data,
          user.communityId,
          user.id,
          user.role
        );

        return c.json({
          data: speaker,
          meta: { message: 'Speaker updated successfully' },
        });
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // PATCH /speakers/:id — Partially update (admin/editor only)
  speakers.patch(
    '/:id',
    requireAuth,
    requireRole(['admin', 'editor']),
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const { id } = SpeakerIdSchema.parse({ id: c.req.param('id') });
        const body = await c.req.json();
        const data = UpdateSpeakerSchema.parse(body);

        const speaker = await speakerService.updateSpeaker(
          id,
          data,
          user.communityId,
          user.id,
          user.role
        );

        return c.json({
          data: speaker,
          meta: { message: 'Speaker updated successfully' },
        });
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // DELETE /speakers/:id — Delete (admin only)
  speakers.delete('/:id', requireAuth, requireRole(['admin']), async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = SpeakerIdSchema.parse({ id: c.req.param('id') });

      await speakerService.deleteSpeaker(
        id,
        user.communityId,
        user.id,
        user.role
      );

      return c.body(null, 204);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  return speakers;
}
