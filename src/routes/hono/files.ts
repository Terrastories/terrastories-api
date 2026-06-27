/**
 * Hono Files Routes
 *
 * V2 equivalent of Fastify file routes.
 * Handles file upload, serving, metadata, deletion, and listing with
 * community data sovereignty and cultural protocol enforcement.
 * Mounted at /v2/files/*
 *
 * Pattern: auth middleware → service layer → JSON response
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { FileService } from '../../services/file.service.js';
import { FileRepository } from '../../repositories/file.repository.js';
import type { Database } from '../../db/index.js';
import { getConfig } from '../../shared/config/index.js';
import {
  requireAuth,
  getCurrentUser,
} from '../../shared/middleware/hono-auth.middleware.js';
import type { AppEnv } from '../../hono-app.js';
import { handleHonoError } from '../../shared/middleware/hono-error.middleware.js';

// ========================================
// VALIDATION SCHEMAS
// ========================================

const uploadQuerySchema = z.object({
  culturalRestrictions: z
    .string()
    .optional()
    .transform((str) => {
      if (!str) return undefined;
      try {
        return JSON.parse(str);
      } catch {
        throw new Error('Invalid cultural restrictions JSON');
      }
    }),
});

const fileParamsSchema = z.object({
  id: z.string().uuid('Invalid file ID'),
});

const listFilesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  type: z.enum(['image', 'audio', 'video']).optional(),
  search: z.string().optional(),
});

/**
 * Detect a MIME type from a file extension (used for field-kit static serving).
 */
function mimeTypeForExtension(ext: string | undefined): string {
  switch (ext) {
    case 'txt':
      return 'text/plain';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'mp3':
      return 'audio/mpeg';
    case 'mp4':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

export function createFilesRoutes(database?: Database): Hono<AppEnv> {
  const files = new Hono<AppEnv>();

  const db = database;
  if (!db) return files;

  const config = getConfig();
  const fileRepository = new FileRepository(db);
  const fileService = new FileService(
    config.fileUpload.uploadDir,
    config.fileUpload,
    fileRepository
  );

  // ========================================
  // POST /files/upload — Upload a file (multipart)
  // POST /files/upload — Upload a file (multipart)
  // Enforces body size limits BEFORE full parse to prevent memory exhaustion
  files.post('/upload', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const query = uploadQuerySchema.parse(c.req.query());

      // Check Content-Length before parsing to reject oversized uploads early
      const contentLength = parseInt(c.req.header('content-length') || '0', 10);
      const MAX_UPLOAD = 10 * 1024 * 1024; // 10MB limit (matches V1 Fastify multipart)
      if (contentLength > MAX_UPLOAD) {
        return c.json({ error: 'File size exceeds 10MB limit' }, 413);
      }

      // Parse multipart form data with size limit
      const body = await c.req.parseBody({
        all: true,
      });
      const file = body['file'];

      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }

      // Handle case where multiple files are uploaded — take the first
      const fileObj = Array.isArray(file) ? file[0] : file;

      if (!(fileObj instanceof File)) {
        return c.json({ error: 'Invalid file upload' }, 400);
      }

      // Double-check actual file size (Content-Length can be spoofed)
      if (fileObj.size > MAX_UPLOAD) {
        return c.json({ error: 'File size exceeds 10MB limit' }, 413);
      }

      const maxSize = fileService.getMaxSizeForMimeType(fileObj.type);

      // Build a Fastify-compatible file object for the service
      const fastifyCompatibleFile = {
        file: fileObj,
        mimetype: fileObj.type,
        filename: fileObj.name,
        fields: body,
      };

      const result = await fileService.uploadFile(
        fastifyCompatibleFile as never,
        {
          communityId: user.communityId,
          uploadedBy: user.id,
          maxSize,
          culturalRestrictions: query.culturalRestrictions,
        }
      );

      return c.json({ data: result }, 201);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Handle specific error types (matching Fastify behavior)
      if (errorMessage.includes('File size exceeds')) {
        return c.json({ error: errorMessage }, 413);
      }

      if (
        errorMessage.includes('File type not allowed') ||
        errorMessage.includes('Invalid file type') ||
        errorMessage.includes('not allowed') ||
        errorMessage.includes('Could not detect file type')
      ) {
        return c.json({ error: errorMessage }, 415);
      }

      return handleHonoError(c, error);
    }
  });

  // ========================================
  // GET /files/uploads/* — Serve static files for field-kit mode
  // NOTE: Must come before /:id routes.
  // ========================================
  files.get('/uploads/*', requireAuth, async (c) => {
    try {
      // Extract file path from URL
      const requestUrl = c.req.url;
      const pathMatch = requestUrl.match(/\/uploads\/(.+)$/);
      if (!pathMatch) {
        return c.json({ error: 'Invalid file path' }, 404);
      }

      const filePath = pathMatch[1];
      const fullPath = join(config.fileUpload.uploadDir, filePath);

      // Check if file exists on disk
      let stats;
      try {
        stats = await stat(fullPath);
        if (!stats.isFile()) {
          throw new Error('Not a file');
        }
      } catch {
        return c.json({ error: 'File not found' }, 404);
      }

      // Field-kit mode serves files directly; otherwise not supported
      const isFieldKitMode = config.environment === 'field-kit';

      if (!isFieldKitMode) {
        return c.json(
          { error: 'File access method not supported in this environment' },
          404
        );
      }

      const ext = filePath.split('.').pop()?.toLowerCase();
      const mimeType = mimeTypeForExtension(ext);

      c.header('Content-Type', mimeType);
      c.header('Cache-Control', 'public, max-age=31536000');

      const stream = createReadStream(fullPath);
      return c.body(stream as never);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // ========================================
  // GET /files/ — List community files with pagination
  // NOTE: Must come before /:id routes.
  // ========================================
  files.get('/', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const query = listFilesQuerySchema.parse(c.req.query());

      const result = await fileService.listFiles(
        user.communityId,
        user.id,
        query as never
      );

      return c.json(result);
    } catch (error) {
      return handleHonoError(c, error);
    }
  });

  // ========================================
  // GET /files/:id/info — Get file metadata
  // NOTE: Must come before /files/:id (content) to avoid route shadowing.
  // ========================================
  files.get('/:id/info', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = fileParamsSchema.parse({ id: c.req.param('id') });

      const fileData = await fileService.getFile(
        id,
        user.id,
        user.communityId,
        user.role
      );

      return c.json({ data: fileData });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('File not found')) {
        return c.json({ error: errorMessage }, 404);
      }

      if (
        errorMessage.includes('Access denied') ||
        errorMessage.includes('cannot access')
      ) {
        return c.json({ error: errorMessage }, 403);
      }

      return handleHonoError(c, error);
    }
  });

  // ========================================
  // GET /files/:id — Serve file content with access control
  // ========================================
  files.get('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = fileParamsSchema.parse({ id: c.req.param('id') });

      const fileData = await fileService.getFile(
        id,
        user.id,
        user.communityId,
        user.role
      );

      const filePath = join(config.fileUpload.uploadDir, fileData.path);

      // Check if file exists on disk
      try {
        const stats = await stat(filePath);
        if (!stats.isFile()) {
          throw new Error('Not a file');
        }
      } catch {
        return c.json({ error: 'File not found on disk' }, 404);
      }

      c.header('Content-Type', fileData.mimeType);
      c.header('Content-Length', String(fileData.size));
      c.header(
        'Content-Disposition',
        `inline; filename="${fileData.originalName}"`
      );
      c.header('Cache-Control', 'public, max-age=31536000');

      const stream = createReadStream(filePath);
      return c.body(stream as never);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('File not found')) {
        return c.json({ error: errorMessage }, 404);
      }

      if (
        errorMessage.includes('Access denied') ||
        errorMessage.includes('cannot access')
      ) {
        return c.json({ error: errorMessage }, 403);
      }

      return handleHonoError(c, error);
    }
  });

  // ========================================
  // DELETE /files/:id — Delete file
  // ========================================
  files.delete('/:id', requireAuth, async (c) => {
    try {
      const user = getCurrentUser(c)!;
      const { id } = fileParamsSchema.parse({ id: c.req.param('id') });

      await fileService.deleteFile(id, user.id, user.communityId);

      return c.body(null, 204);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('File not found')) {
        return c.json({ error: errorMessage }, 404);
      }

      if (
        errorMessage.includes('Access denied') ||
        errorMessage.includes('you can only delete')
      ) {
        return c.json({ error: errorMessage }, 403);
      }

      return handleHonoError(c, error);
    }
  });

  return files;
}
