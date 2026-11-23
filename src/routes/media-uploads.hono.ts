/**
 * Direct multipart media upload routes (#286, SPEC-V2 §6.7):
 * - POST   /v2/media/uploads
 * - POST   /v2/media/uploads/:id/parts/presign       (re-issue part targets)
 * - PUT    /v2/media/uploads/:id/parts/:partNumber   (api mode only)
 * - POST   /v2/media/uploads/:id/complete
 * - DELETE /v2/media/uploads/:id
 */

import type { Context, Hono } from 'hono';
import {
  actorOf,
  jsonBodyLimit,
  parseJsonRequestBody,
} from './community-writes.hono.js';
import type { DirectUploadService } from '../services/direct-upload.service.js';

function respond(c: Context, result: { status: number; body?: unknown }) {
  if (result.status === 204) return c.body(null, 204);
  return c.json(result.body as never, result.status as 200);
}

export function registerMediaUploadRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: {
    service: DirectUploadService;
    originFor: (c: Context) => string;
  }
): void {
  const { service, originFor } = options;

  app.post('/v2/media/uploads', jsonBodyLimit, async (c) => {
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    return respond(
      c,
      await service.createUpload(actorOf(c), parsed.body, originFor(c))
    );
  });

  app.post('/v2/media/uploads/:id/parts/presign', async (c) =>
    respond(
      c,
      await service.reissueParts(actorOf(c), c.req.param('id'), originFor(c))
    )
  );

  app.put('/v2/media/uploads/:id/parts/:partNumber', async (c) => {
    const result = await service.putPart({
      actor: actorOf(c),
      sessionId: c.req.param('id'),
      partNumberRaw: c.req.param('partNumber'),
      contentLengthHeader: c.req.header('Content-Length'),
      checksumHeader: c.req.header('x-amz-checksum-sha256'),
      body: c.req.raw.body,
    });
    if (result.status === 200) {
      const body = result.body as { data: { etag: string } };
      return c.json(body, 200, { ETag: `"${body.data.etag}"` });
    }
    return respond(c, result);
  });

  app.post('/v2/media/uploads/:id/complete', jsonBodyLimit, async (c) => {
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    return respond(
      c,
      await service.completeUpload(
        actorOf(c),
        c.req.param('id'),
        parsed.body,
        originFor(c)
      )
    );
  });

  app.delete('/v2/media/uploads/:id', async (c) =>
    respond(c, await service.abortUpload(actorOf(c), c.req.param('id')))
  );
}
