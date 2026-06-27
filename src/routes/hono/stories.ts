/**
 * Hono Stories Routes
 *
 * V2 equivalent of Fastify stories routes.
 * CRUD for stories with relations (places, speakers) and cultural protocols.
 * Mounted at /v2/stories/*
 *
 * Pattern: auth middleware → Zod validation → service layer → JSON response
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  StoryService,
  type StoryCreateInput,
} from '../../services/story.service.js';
import {
  StoryRepository,
  type StoryWithRelations,
} from '../../repositories/story.repository.js';
import { FileRepository } from '../../repositories/file.repository.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { getDb, type Database } from '../../db/index.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  requireAuth,
  requireCommunityAccess,
  getCurrentUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import { getConfig } from '../../shared/config/index.js';
import type { AppEnv } from '../../hono-app.js';
import { handleHonoError } from '../../shared/middleware/hono-error.middleware.js';

// ========================================
// DEPRECATION WARNINGS (Issue #89)
// ========================================

/**
 * Add deprecation warnings to API responses for legacy file fields
 * Issue #89: Mark mediaUrls as deprecated when FILES_NATIVE_ENABLED=true
 */
function addDeprecationWarnings() {
  const config = getConfig();
  const warnings = [];

  if (config.features.filesNativeEnabled) {
    warnings.push({
      field: 'mediaUrls',
      message: 'DEPRECATED: Use imageUrl and audioUrl fields instead',
      deprecatedIn: 'v2.0.0',
      removedIn: 'v3.0.0',
    });
  }

  return warnings.length > 0 ? warnings : undefined;
}

// ========================================
// VALIDATION SCHEMAS
// ========================================

const createStorySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  communityId: z.number().int().positive(),
  mediaUrls: z.array(z.string().url()).optional(),
  // Direct file URL fields for dual-read capability (Issue #89)
  imageUrl: z.string().url().optional(),
  audioUrl: z.string().url().optional(),
  language: z.string().min(2).max(10).default('en'),
  tags: z.array(z.string()).optional(),
  culturalProtocols: z
    .object({
      permissionLevel: z
        .enum(['public', 'community', 'restricted', 'elder_only'])
        .optional(),
      culturalSignificance: z.string().optional(),
      restrictions: z.array(z.string()).optional(),
      ceremonialContent: z.boolean().optional(),
      elderApprovalRequired: z.boolean().optional(),
      accessNotes: z.string().optional(),
    })
    .optional(),
  placeIds: z.array(z.number().int().positive()).optional(),
  speakerIds: z.array(z.number().int().positive()).optional(),
  placeContexts: z.array(z.string()).optional(),
  speakerRoles: z.array(z.string()).optional(),
  // Interview metadata for Indigenous storytelling context
  dateInterviewed: z.coerce.date().optional(),
  interviewLocationId: z.number().int().positive().optional(),
  interviewerId: z.number().int().positive().optional(),
});

const updateStorySchema = createStorySchema.partial().omit({
  communityId: true,
});

const storyParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const slugParamsSchema = z.object({
  slug: z.string().min(1).max(100),
  communityId: z.coerce.number().int().positive(),
});

const listStoriesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  isRestricted: z.coerce.boolean().optional(),
  tags: z
    .string()
    .optional()
    .transform((str) => {
      if (!str) return undefined;
      return str
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    }),
  createdBy: z.coerce.number().int().positive().optional(),
  language: z.string().optional(),
  sortBy: z.enum(['createdAt', 'title', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

// ========================================
// ROUTE SETUP
// ========================================

export async function createStoriesRoutes(
  database?: Database
): Promise<Hono<AppEnv>> {
  const stories = new Hono<AppEnv>();

  // Initialize services
  const db: Database = database ?? (await getDb());

  // StoryRepository requires BetterSQLite3Database, using type casting
  const storyRepository = new StoryRepository(
    db as unknown as BetterSQLite3Database<Record<string, unknown>>
  );
  const fileRepository = new FileRepository(db);
  const userRepository = new UserRepository(db);
  const storyService = new StoryService(
    storyRepository,
    fileRepository,
    userRepository,
    {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    }
  );

  // POST /stories — Create story (requires community access)
  stories.post(
    '/',
    requireAuth,
    requireCommunityAccess(),
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const body = await c.req.json();
        const input = createStorySchema.parse(body);

        const story = await storyService.createStory(
          { ...input, createdBy: user.id } as StoryCreateInput,
          user.id,
          user.role,
          user.communityId
        );

        return c.json(
          {
            data: {
              id: story.id,
              title: story.title,
              description: story.description,
              slug: story.slug,
              communityId: story.communityId,
              createdBy: story.createdBy,
              dateInterviewed: story.dateInterviewed,
              interviewLocationId: story.interviewLocationId,
              interviewerId: story.interviewerId,
              interviewLocation: story.interviewLocation,
              interviewer: story.interviewer,
            },
            message: 'Story created successfully',
          },
          201
        );
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // GET /stories — List stories with search/filter/pagination
  stories.get('/', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const filters = listStoriesQuerySchema.parse(c.req.query());

      const { tags, sortBy, sortOrder, ...otherFilters } = filters;

      const pagination = {
        page: filters.page,
        limit: filters.limit,
        sortBy,
        sortOrder,
      };

      const result = await storyService.listStories(
        { ...otherFilters, tags },
        pagination,
        user.id,
        user.role,
        user.communityId
      );

      const warnings = addDeprecationWarnings();
      return c.json({
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
        ...(warnings && { deprecations: warnings }),
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /stories/slug/:slug/community/:communityId — Get story by slug
  // MUST come before /:id
  stories.get(
    '/slug/:slug/community/:communityId',
    requireAuth,
    async (c) => {
      try {
        const user = getCurrentUser(c)!;
        const { slug, communityId } = slugParamsSchema.parse({
          slug: c.req.param('slug'),
          communityId: c.req.param('communityId'),
        });

        const story = await storyService.getStoryBySlug(
          slug,
          communityId,
          user.id,
          user.role
        );

        if (!story) {
          return c.json({ error: 'Story not found' }, 404);
        }

        const warnings = addDeprecationWarnings();
        return c.json({
          data: story,
          ...(warnings && { deprecations: warnings }),
        });
      } catch (error) {
        return handleHonoError(c, error);
      }
    }
  );

  // GET /stories/:id — Get story by ID
  stories.get('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = storyParamsSchema.parse({ id: c.req.param('id') });

      const story = await storyService.getStoryById(
        id,
        user.id,
        user.role,
        user.communityId
      );

      if (!story) {
        return c.json({ error: 'Story not found' }, 404);
      }

      const warnings = addDeprecationWarnings();
      return c.json({
        data: story,
        ...(warnings && { deprecations: warnings }),
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // PATCH /stories/:id — Update story
  stories.patch('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = storyParamsSchema.parse({ id: c.req.param('id') });
      const body = await c.req.json();
      const updates = updateStorySchema.parse(body);

      const story = await storyService.updateStory(
        id,
        updates as Partial<StoryCreateInput>,
        user.id,
        user.role
      );

      // Enforce community isolation: verify the story belongs to user's community
      if ((story as { communityId?: number }).communityId !== undefined &&
          (story as { communityId: number }).communityId !== user.communityId &&
          user.role !== 'super_admin') {
        return c.json({ error: 'Access denied - community data isolation' }, 403);
      }

      const warnings = addDeprecationWarnings();
      return c.json({
        data: story,
        message: 'Story updated successfully',
        ...(warnings && { deprecations: warnings }),
      });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // DELETE /stories/:id — Delete story
  stories.delete('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = storyParamsSchema.parse({ id: c.req.param('id') });

      // Verify story belongs to user's community before deleting
      const existing = await storyService.getStoryById(id, user.id, user.role, user.communityId);
      if (!existing) {
        return c.json({ error: 'Story not found' }, 404);
      }
      await storyService.deleteStory(id, user.id, user.role);

      return c.body(null, 204);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // ========================================
  // STORY RELATION ENDPOINTS
  // story-place and story-speaker associations.
  // Registered after the core /:id routes. Hono matches by full path,
  // so /:id/places and /:id/speakers are distinct from /:id.
  // ========================================

  // GET /stories/:id/places — List places associated with a story
  stories.get('/:id/places', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = storyParamsSchema.parse({ id: c.req.param('id') });

      const story = await storyService.getStoryById(
        id,
        user.id,
        user.role,
        user.communityId
      );

      if (!story) {
        return c.json({ error: 'Story not found' }, 404);
      }

      const places =
        (story as StoryWithRelations & { places?: unknown[] }).places ?? [];
      return c.json({ data: places });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // GET /stories/:id/speakers — List speakers associated with a story
  stories.get('/:id/speakers', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = storyParamsSchema.parse({ id: c.req.param('id') });

      const story = await storyService.getStoryById(
        id,
        user.id,
        user.role,
        user.communityId
      );

      if (!story) {
        return c.json({ error: 'Story not found' }, 404);
      }

      const speakers =
        (story as StoryWithRelations & { speakers?: unknown[] }).speakers ??
        [];
      return c.json({ data: speakers });
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  return stories;
}
