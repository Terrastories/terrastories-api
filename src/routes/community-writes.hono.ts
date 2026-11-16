import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type { CommunityReadsRepository } from '../repositories/community-reads.repository.js';
import type { MediaCleanupCoordinator } from '../services/media-cleanup.service.js';
import type { CommunityWritesRepository } from '../repositories/community-writes.repository.js';
import { CommunityReadsService } from '../services/community-reads.service.js';
import {
  CommunityWritesService,
  type CommunityWriteResult,
} from '../services/community-writes.service.js';
import { BAD_REQUEST_BODY } from '../services/public-communities.service.js';

export interface CommunityWriteRoutesOptions {
  repository: CommunityWritesRepository;
  readsRepository: CommunityReadsRepository;
  publicOrigin?: string;
  mediaCleanup?: MediaCleanupCoordinator;
}

const MAX_WRITE_JSON_BYTES = 256 * 1024; // Accommodates DESCRIPTION_MAX_RAW_LENGTH (80k UTF-16 chars)

export const jsonBodyLimit = bodyLimit({
  maxSize: MAX_WRITE_JSON_BYTES,
  onError: (c) => c.json({ error: 'Request too large' }, 413),
});

export async function parseJsonRequestBody(
  c: Context
): Promise<
  { ok: true; body: unknown } | { ok: false; status: 400 | 415; error: string }
> {
  const contentType = c.req
    .header('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, status: 415, error: 'Expected JSON' };
  }
  try {
    const body = await c.req.json();
    return { ok: true, body };
  } catch {
    return { ok: false, status: 400, error: BAD_REQUEST_BODY.error };
  }
}

export function actorOf(c: Context): FoundationUser {
  return (
    c as unknown as Context<{ Variables: { actor: FoundationUser } }>
  ).get('actor');
}

export function respondWriteResult<T>(
  c: Context,
  result: CommunityWriteResult<T>
) {
  if (result.status === 204) {
    return c.body(null, 204);
  }
  return c.json(result.body, result.status);
}

const respond = respondWriteResult;

export function registerCommunityWriteRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: CommunityWriteRoutesOptions
): void {
  const readsService = new CommunityReadsService(options.readsRepository);
  const service = new CommunityWritesService(
    options.repository,
    readsService,
    options.mediaCleanup
  );
  const originFor = (c: Context) =>
    options.publicOrigin ?? new URL(c.req.url).origin;

  app.patch('/v2/community', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.updateCommunity(
      actor,
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.put('/v2/community/map-config', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.upsertMapConfig(
      actor,
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.post('/v2/places', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.createPlace(actor, parsed.body, originFor(c));
    return respond(c, result);
  });

  app.patch('/v2/places/:id', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.updatePlace(
      actor,
      c.req.param('id'),
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.delete('/v2/places/:id', async (c) => {
    const actor = actorOf(c);
    const result = await service.deletePlace(actor, c.req.param('id'));
    return respond(c, result);
  });

  app.post('/v2/speakers', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.createSpeaker(
      actor,
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.patch('/v2/speakers/:id', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.updateSpeaker(
      actor,
      c.req.param('id'),
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.delete('/v2/speakers/:id', async (c) => {
    const actor = actorOf(c);
    const result = await service.deleteSpeaker(actor, c.req.param('id'));
    return respond(c, result);
  });
}
