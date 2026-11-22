/**
 * Hono route definitions for Slice 6 authenticated community read endpoints (#145).
 *
 * Mounted inside the `/v2/*` session gate in `src/hono-app.ts`:
 * - `GET /v2/community`
 * - `GET /v2/community/map-config`
 * - `GET /v2/stories`
 * - `GET /v2/stories/:id`
 * - `GET /v2/places`
 * - `GET /v2/places/:id`
 * - `GET /v2/speakers`
 * - `GET /v2/speakers/:id`
 */
import type { Hono } from 'hono';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import { CommunityReadsRepository } from '../repositories/community-reads.repository.js';
import { CommunityReadsService } from '../services/community-reads.service.js';

export interface CommunityReadRoutesOptions {
  repository: CommunityReadsRepository;
  publicOrigin?: string;
  mapboxAccessToken?: string;
  offlineMode?: boolean;
}

export function registerCommunityReadRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: CommunityReadRoutesOptions
): void {
  const service = new CommunityReadsService(options.repository, {
    mapboxAccessToken: options.mapboxAccessToken,
    offlineMode: options.offlineMode,
  });
  const originOf = (url: string) => options.publicOrigin ?? new URL(url).origin;
  const actorOf = (c: { get: (key: string) => unknown }): FoundationUser =>
    c.get('actor') as FoundationUser;

  app.get('/v2/community', async (c) => {
    const result = await service.getCommunity(actorOf(c), originOf(c.req.url));
    return c.json(result.body, result.status);
  });

  app.get('/v2/community/map-config', async (c) => {
    const result = await service.getMapConfig(actorOf(c), originOf(c.req.url));
    return c.json(result.body, result.status);
  });

  app.get('/v2/stories', async (c) => {
    const result = await service.listStories(
      actorOf(c),
      new URL(c.req.url).searchParams,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/stories/:id', async (c) => {
    const result = await service.getStoryById(
      actorOf(c),
      c.req.param('id'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/places', async (c) => {
    const result = await service.listPlaces(
      actorOf(c),
      new URL(c.req.url).searchParams,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/places/:id', async (c) => {
    const result = await service.getPlaceById(
      actorOf(c),
      c.req.param('id'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/speakers', async (c) => {
    const result = await service.listSpeakers(
      actorOf(c),
      new URL(c.req.url).searchParams,
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });

  app.get('/v2/speakers/:id', async (c) => {
    const result = await service.getSpeakerById(
      actorOf(c),
      c.req.param('id'),
      originOf(c.req.url)
    );
    return c.json(result.body, result.status);
  });
}
