/**
 * Canonical Hono route handlers for Slice 9 files and media (§7):
 * - GET /v2/media/:id/metadata
 * - GET /v2/media/:id
 * - POST /v2/media
 * - DELETE /v2/media/:id
 */

import type { Context, Hono } from 'hono';
import { actorOf } from './community-writes.hono.js';
import type { FoundationStorage } from '../services/hono-foundation.service.js';
import { MediaWritesRepository } from '../repositories/media-writes.repository.js';
import {
  MediaWritesService,
  type MediaWriteResult,
} from '../services/media-writes.service.js';
import type { MediaCleanupCoordinator } from '../services/media-cleanup.service.js';

function respondMediaResult<T>(c: Context, result: MediaWriteResult<T>) {
  if (result.status === 204) {
    return c.body(null, 204);
  }
  return c.json(result.body, result.status);
}

export interface MediaWriteRoutesOptions {
  repository: MediaWritesRepository;
  storage: FoundationStorage;
  cleanup: MediaCleanupCoordinator;
  publicOrigin?: string;
}

export function registerMediaRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: MediaWriteRoutesOptions
): void {
  const service = new MediaWritesService(
    options.repository,
    options.storage,
    options.cleanup
  );
  const originFor = (c: Context) =>
    options.publicOrigin ?? new URL(c.req.url).origin;

  app.get('/v2/media/:id/metadata', async (c) => {
    const result = await service.getMetadata(
      actorOf(c),
      c.req.param('id'),
      originFor(c)
    );
    return respondMediaResult(c, result);
  });

  app.get('/v2/media/:id', async (c) => {
    const response = await service.serveMedia(
      actorOf(c),
      c.req.param('id'),
      c.req.header('Range')
    );
    if (!response) {
      return c.json({ error: 'Not found' }, 404);
    }
    return response;
  });

  app.post('/v2/media', async (c) => {
    const result = await service.uploadMedia({
      actor: actorOf(c),
      contentTypeHeader: c.req.header('Content-Type'),
      contentLengthHeader: c.req.header('Content-Length'),
      body: c.req.raw.body,
      origin: originFor(c),
    });
    return respondMediaResult(c, result);
  });

  app.delete('/v2/media/:id', async (c) => {
    const result = await service.deleteFile(actorOf(c), c.req.param('id'));
    return respondMediaResult(c, result);
  });
}
