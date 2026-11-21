/**
 * Canonical Hono route handlers for Slice 12 bounded CSV imports (§4, §6.9, §8):
 * - POST /v2/imports/preview
 */
import type { Context, Hono } from 'hono';
import { actorOf } from './community-writes.hono.js';
import type { FoundationStorage } from '../services/hono-foundation.service.js';
import type { MediaCleanupCoordinator } from '../services/media-cleanup.service.js';
import { ImportsRepository } from '../repositories/imports.repository.js';
import {
  ImportsService,
  type ImportServiceResult,
} from '../services/imports.service.js';

export interface ImportRoutesOptions {
  repository: ImportsRepository;
  storage: FoundationStorage;
  cleanup: MediaCleanupCoordinator;
  now?: () => Date;
  enforceD1Budget?: boolean;
}

function respondImportResult<T>(c: Context, result: ImportServiceResult<T>) {
  return c.json(result.body, result.status);
}

export function registerImportRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: ImportRoutesOptions
): void {
  const service = new ImportsService(
    options.repository,
    options.storage,
    options.cleanup,
    {
      now: options.now,
      enforceD1Budget: options.enforceD1Budget,
    }
  );

  app.post('/v2/imports/preview', async (c) => {
    const result = await service.previewImport({
      actor: actorOf(c),
      contentTypeHeader: c.req.header('Content-Type'),
      contentLengthHeader: c.req.header('Content-Length'),
      body: c.req.raw.body,
    });
    return respondImportResult(c, result);
  });
}
