/**
 * Transitional Explore read adapter routes (#198, docs/SPEC-V2.md §9).
 *
 * Serves the Rails-shaped JSON the current Explore client requests under
 * `/explore/*` (the client's configurable VITE_API_BASE points at this
 * namespace). GET only, anonymous public projections only: a session cookie
 * never widens access, and withheld/unknown ids answer the same 404 as
 * missing ids. Transport-neutral Hono handlers — no Node-only APIs — so the
 * same routes run on Workers and Node. Removed once the V2 frontend uses the
 * canonical API; it is not a second canonical namespace.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ExploreAdapterRepository } from './repositories/explore-adapter.repository.js';
import {
  ExploreAdapterService,
  parseStoriesQuery,
  type ExploreResult,
} from './services/explore-adapter.service.js';
import {
  validStorageKey,
  type FoundationStorage,
} from './services/hono-foundation.service.js';
import { isDatabaseIdString } from './shared/types/public.js';

export interface ExploreAdapterOptions {
  repository: ExploreAdapterRepository;
  storage: FoundationStorage;
  publicOrigin?: string;
}

const notFoundBody = Object.freeze({
  error: 'Not Found',
  message: 'The requested resource could not be found.',
});

// The adapter registers onto whatever typed Hono app the host built.

export function registerExploreAdapter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: ExploreAdapterOptions
): void {
  const service = new ExploreAdapterService(options.repository);
  const respond = (c: Context, result: ExploreResult) =>
    c.json(result.body, result.status);
  const originOf = (url: string) => options.publicOrigin ?? new URL(url).origin;

  app.get('/explore/communities', async (c) => {
    const search = new URL(c.req.url).searchParams.get('search') ?? undefined;
    return respond(
      c,
      await service.communitiesIndex(search, originOf(c.req.url))
    );
  });

  app.get('/explore/communities/:slug', async (c) =>
    respond(
      c,
      await service.communityShow(c.req.param('slug'), originOf(c.req.url))
    )
  );

  app.get('/explore/communities/:slug/stories', async (c) => {
    const parsed = parseStoriesQuery(new URL(c.req.url).searchParams);
    if (!parsed.ok) return c.json({ error: 'Invalid request' }, 400);
    return respond(c, await service.storiesIndex(c.req.param('slug'), parsed));
  });

  app.get('/explore/communities/:slug/stories/:storyId', async (c) => {
    const storyId = c.req.param('storyId');
    if (!isDatabaseIdString(storyId)) return c.json(notFoundBody, 404);
    return respond(
      c,
      await service.storyShow(c.req.param('slug'), Number(storyId))
    );
  });

  app.get('/explore/communities/:slug/places/:placeId', async (c) => {
    const placeId = c.req.param('placeId');
    if (!isDatabaseIdString(placeId)) return c.json(notFoundBody, 404);
    return respond(
      c,
      await service.placeShow(c.req.param('slug'), Number(placeId))
    );
  });

  /**
   * Public branding-media read for the URLs embedded above (displayImage).
   * Authorized only through the typed community branding relation of a
   * public active community; forbidden requests never touch stored bytes.
   */
  app.get('/explore/media/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    if (!z.string().uuid().safeParse(fileId).success)
      return c.json(notFoundBody, 404);
    const file = await options.repository.publicBrandingFile(fileId);
    if (
      !file ||
      !file.storageKey.startsWith(`communities/${file.communityId}/`) ||
      !validStorageKey(file.storageKey)
    )
      return c.json(notFoundBody, 404);
    const bytes = await options.storage.read(file.storageKey);
    if (bytes === null) return c.json(notFoundBody, 404);
    // Download disposition + sandbox prevents active branding formats executing.
    return new Response(
      bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes,
      {
        headers: {
          'Content-Type': file.mimeType,
          'Content-Disposition': 'attachment',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      }
    );
  });
}
