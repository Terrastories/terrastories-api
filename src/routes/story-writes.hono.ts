import type { Context, Hono } from 'hono';
import type { CommunityReadsRepository } from '../repositories/community-reads.repository.js';
import type { StoryWritesRepository } from '../repositories/story-writes.repository.js';
import { CommunityReadsService } from '../services/community-reads.service.js';
import { StoryWritesService } from '../services/story-writes.service.js';
import {
  actorOf,
  jsonBodyLimit,
  parseJsonRequestBody,
  respondWriteResult,
} from './community-writes.hono.js';

export interface StoryWriteRoutesOptions {
  repository: StoryWritesRepository;
  readsRepository: CommunityReadsRepository;
  publicOrigin?: string;
}

const respond = respondWriteResult;

export function registerStoryWriteRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: StoryWriteRoutesOptions
): void {
  const readsService = new CommunityReadsService(options.readsRepository);
  const service = new StoryWritesService(options.repository, readsService);
  const originFor = (c: Context) =>
    options.publicOrigin ?? new URL(c.req.url).origin;

  app.post('/v2/stories', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.createStory(actor, parsed.body, originFor(c));
    return respond(c, result);
  });

  app.patch('/v2/stories/:id', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.updateStory(
      actor,
      c.req.param('id'),
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.delete('/v2/stories/:id', async (c) => {
    const actor = actorOf(c);
    const result = await service.deleteStory(actor, c.req.param('id'));
    return respond(c, result);
  });

  app.put('/v2/stories/:id/places', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.replaceStoryPlaces(
      actor,
      c.req.param('id'),
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.put('/v2/stories/:id/speakers', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.replaceStorySpeakers(
      actor,
      c.req.param('id'),
      parsed.body,
      originFor(c)
    );
    return respond(c, result);
  });

  app.post('/v2/stories/:id/external-links', jsonBodyLimit, async (c) => {
    const actor = actorOf(c);
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const result = await service.addExternalLink(
      actor,
      c.req.param('id'),
      parsed.body
    );
    return respond(c, result);
  });

  app.patch(
    '/v2/stories/:id/external-links/reorder',
    jsonBodyLimit,
    async (c) => {
      const actor = actorOf(c);
      const parsed = await parseJsonRequestBody(c);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, parsed.status);
      }
      const result = await service.reorderExternalLinks(
        actor,
        c.req.param('id'),
        parsed.body
      );
      return respond(c, result);
    }
  );

  app.delete('/v2/stories/:id/external-links/:linkId', async (c) => {
    const actor = actorOf(c);
    const result = await service.deleteExternalLink(
      actor,
      c.req.param('id'),
      c.req.param('linkId')
    );
    return respond(c, result);
  });
}
