/**
 * Transport-neutral Hono routes for canonical V2 `/v2/public/communities*`
 * (Slices 4 and 5, #145).
 *
 * Must be registered in `src/hono-app.ts` BEFORE the `/v2/*` session gate:
 * anonymous callers have full access, and authenticated callers (including
 * `super_admin`) receive the identical anonymous §6.4a projection.
 */
import type { Hono } from 'hono';
import { PublicCommunitiesRepository } from '../repositories/public-communities.repository.js';
import { PublicContentRepository } from '../repositories/public-content.repository.js';
import type { FoundationStorage } from '../services/hono-foundation.service.js';
import {
  NOT_FOUND_BODY,
  PublicCommunitiesService,
} from '../services/public-communities.service.js';
import { PublicContentService } from '../services/public-content.service.js';
import { PublicCommunitiesSearchQuerySchema } from '../shared/schemas/public-communities.js';

export interface PublicCommunityRoutesOptions {
  repository: PublicCommunitiesRepository;
  storage?: FoundationStorage;
  publicOrigin?: string;
  offlineMode?: boolean;
}

const emptyStorage: FoundationStorage = {
  async read() {
    return null;
  },
};

export function registerPublicCommunityRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: PublicCommunityRoutesOptions
): void {
  const service = new PublicCommunitiesService(options.repository, {
    offlineMode: options.offlineMode,
  });
  const contentRepository = new PublicContentRepository(
    options.repository.connection,
    options.repository
  );
  const contentService = new PublicContentService(
    contentRepository,
    options.storage ?? emptyStorage
  );
  const originOf = (url: string) => options.publicOrigin ?? new URL(url).origin;

  app.get('/v2/public/communities', async (c) => {
    const searchValues = new URL(c.req.url).searchParams.getAll('search');
    if (searchValues.length > 1) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const parsed = PublicCommunitiesSearchQuerySchema.safeParse({
      search: searchValues[0],
    });
    if (!parsed.success) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const result = await service.listCommunities(
      parsed.data.search,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug', async (c) => {
    const result = await service.getCommunityBySlug(
      c.req.param('slug'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/stories', async (c) => {
    const result = await contentService.listStories(
      c.req.param('slug'),
      new URL(c.req.url).searchParams,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/stories/:storyId', async (c) => {
    const result = await contentService.getStoryById(
      c.req.param('slug'),
      c.req.param('storyId'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/places', async (c) => {
    const result = await contentService.listPlaces(
      c.req.param('slug'),
      new URL(c.req.url).searchParams,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/places/:placeId', async (c) => {
    const result = await contentService.getPlaceById(
      c.req.param('slug'),
      c.req.param('placeId'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/speakers', async (c) => {
    const result = await contentService.listSpeakers(
      c.req.param('slug'),
      new URL(c.req.url).searchParams,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/speakers/:speakerId', async (c) => {
    const result = await contentService.getSpeakerById(
      c.req.param('slug'),
      c.req.param('speakerId'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/public/communities/:slug/media/:fileId', async (c) => {
    const response = await contentService.serveMedia(
      c.req.param('slug'),
      c.req.param('fileId'),
      c.req.header('Range')
    );
    if (!response) {
      return c.json(NOT_FOUND_BODY, 404);
    }
    return response;
  });
}
