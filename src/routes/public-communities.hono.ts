/**
 * Transport-neutral Hono routes for canonical V2 `/v2/public/communities*`
 * (Slice 4, #145).
 *
 * Must be registered in `src/hono-app.ts` BEFORE the `/v2/*` session gate:
 * anonymous callers have full access, and authenticated callers (including
 * `super_admin`) receive the identical anonymous §6.4a projection.
 */
import type { Hono } from 'hono';
import { PublicCommunitiesRepository } from '../repositories/public-communities.repository.js';
import { PublicCommunitiesService } from '../services/public-communities.service.js';
import { PublicCommunitiesSearchQuerySchema } from '../shared/schemas/public-communities.js';

export interface PublicCommunityRoutesOptions {
  repository: PublicCommunitiesRepository;
  publicOrigin?: string;
}

export function registerPublicCommunityRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: PublicCommunityRoutesOptions
): void {
  const service = new PublicCommunitiesService(options.repository);
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
}
