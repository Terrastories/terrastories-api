/**
 * Hono routes for Slice 13a community export & authenticated single-artifact
 * download (SPEC-V2 §6.2, §7, #187; route registry §9).
 *
 * Mounted after the `/v2/*` session gate in `src/hono-app.ts`:
 * - `POST /v2/community/export`
 * - `GET /v2/community/export/download/:token`
 */

import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CommunityExportRepository } from '../repositories/community-export.repository.js';
import type { FoundationStorage } from '../services/hono-foundation.service.js';
import {
  CommunityExportService,
  type CommunityExportCreateResult,
} from '../services/community-export.service.js';
import { CreateCommunityExportRequestSchema } from '../shared/schemas/community-export.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
} from '../shared/schemas/community-writes.js';
import type {
  ExportLimits,
  ExportRateLimits,
} from '../shared/export-policy.js';
import { actorOf } from './community-writes.hono.js';
import { BAD_REQUEST_BODY } from '../services/public-communities.service.js';

export interface CommunityExportRoutesOptions {
  repository: CommunityExportRepository;
  storage: FoundationStorage;
  isWorkers?: boolean;
  now?: () => Date;
  limits?: Partial<ExportLimits>;
  rateLimits?: Partial<ExportRateLimits>;
}

const jsonBody4k = bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ error: 'Request too large' }, 413),
});

function respondCreateExport(c: Context, result: CommunityExportCreateResult) {
  if (result.status === 429) {
    c.header('Retry-After', result.headers['Retry-After']);
  }
  return c.json(result.body, result.status);
}

export function registerCommunityExportRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: CommunityExportRoutesOptions
): void {
  const service = new CommunityExportService(
    options.repository,
    options.storage,
    {
      isWorkers: options.isWorkers,
      now: options.now,
      limits: options.limits,
      rateLimits: options.rateLimits,
    }
  );

  app.post('/v2/community/export', jsonBody4k, async (c) => {
    const contentType = c.req.header('Content-Type');
    let body: unknown;
    if (contentType !== undefined) {
      if (
        contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      ) {
        return c.json({ error: 'Expected JSON' }, 415);
      }
      const rawText = await c.req.text();
      if (rawText.trim().length === 0) {
        body = {};
      } else {
        try {
          body = JSON.parse(rawText) as unknown;
        } catch {
          return c.json({ error: BAD_REQUEST_BODY.error }, 400);
        }
      }
    } else {
      const rawText = await c.req.text();
      if (rawText.length === 0) {
        body = {};
      } else {
        return c.json({ error: 'Expected JSON' }, 415);
      }
    }

    const parsed = CreateCommunityExportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
        400
      );
    }

    const result = await service.createExport(actorOf(c));
    return respondCreateExport(c, result);
  });

  app.get('/v2/community/export/download/:token', async (c) => {
    return service.downloadExportArtifact(
      actorOf(c),
      c.req.param('token'),
      c.req.header('Range')
    );
  });
}
