/**
 * Files V2 Routes
 *
 * TypeScript-native file service API endpoints for ActiveStorage replacement.
 * Provides entity-based file operations with community scoping and security.
 *
 * This is Phase 1 of the ActiveStorage replacement strategy outlined in Issue #86.
 * These routes work with the new FileServiceV2 and storage adapter architecture.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FileServiceV2 } from '../services/file-v2.service.js';
import { LocalStorageAdapter } from '../services/storage/local-storage.adapter.js';
import { getConfig } from '../shared/config/index.js';
import {
  requireAuth,
  requireCommunityAccess,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';

// Request validation schemas
const uploadRequestSchema = z.object({
  community: z.string().min(1, 'Community is required'),
  entity: z.enum(['stories', 'places', 'speakers']),
  entityId: z.coerce
    .number()
    .int()
    .positive('Entity ID must be a positive integer'),
});

const pathParamsSchema = z.object({
  community: z.string().min(1, 'Community is required'),
  entity: z.enum(['stories', 'places', 'speakers']),
  entityId: z.coerce
    .number()
    .int()
    .positive('Entity ID must be a positive integer'),
  filename: z.string().min(1, 'Filename is required'),
});

const listQuerySchema = z.object({
  community: z.string().min(1, 'Community is required'),
  entity: z.enum(['stories', 'places', 'speakers']).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Register Files V2 routes
 */
export async function filesV2Routes(fastify: FastifyInstance) {
  const config = getConfig();

  // Initialize storage adapter and file service
  const storageAdapter = new LocalStorageAdapter({
    baseDir: config.fileUpload?.uploadDir || 'uploads',
    maxFileSize: Math.max(
      ...Object.values(
        config.fileUpload?.maxFileSizes || {
          image: 25 * 1024 * 1024,
          audio: 50 * 1024 * 1024,
          video: 100 * 1024 * 1024,
        }
      )
    ),
    generateEtags: true,
  });

  const fileService = new FileServiceV2(storageAdapter, {
    maxFileSize: Math.max(
      ...Object.values(
        config.fileUpload?.maxFileSizes || {
          image: 25 * 1024 * 1024,
          audio: 50 * 1024 * 1024,
          video: 100 * 1024 * 1024,
        }
      )
    ),
    allowedMimeTypes: {
      image: config.fileUpload?.allowedImageTypes || [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
      ],
      audio: config.fileUpload?.allowedAudioTypes || [
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'audio/m4a',
      ],
      video: config.fileUpload?.allowedVideoTypes || [
        'video/mp4',
        'video/webm',
        'video/ogg',
      ],
    },
    enableVideo: process.env.FILES_ENABLE_VIDEO === 'true' || false,
    rateLimiting: {
      windowMs: 60000, // 1 minute
      maxUploads: 10,
    },
  });

  /**
   * Upload file endpoint
   */
  fastify.post(
    '/upload',
    {
      preHandler: [requireAuth, requireCommunityAccess()],
      schema: {
        description:
          'Upload a file with entity-based organization for ActiveStorage replacement',
        summary: 'Upload file (V2)',
        tags: ['Files V2'],
        consumes: ['multipart/form-data'],
        response: {
          201: {
            description: 'File uploaded successfully',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  filename: { type: 'string' },
                  originalName: { type: 'string' },
                  path: { type: 'string' },
                  url: { type: 'string' },
                  size: { type: 'number' },
                  mimeType: { type: 'string' },
                  community: { type: 'string' },
                  entity: {
                    type: 'string',
                    enum: ['stories', 'places', 'speakers'],
                  },
                  entityId: { type: 'number' },
                  uploadedBy: { type: 'number' },
                  createdAt: { type: 'string', format: 'date-time' },
                  etag: { type: 'string' },
                },
                required: [
                  'filename',
                  'originalName',
                  'path',
                  'url',
                  'size',
                  'mimeType',
                  'community',
                  'entity',
                  'entityId',
                  'uploadedBy',
                  'createdAt',
                ],
              },
            },
          },
          400: {
            description: 'Bad request - validation error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 400 },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 401 },
            },
          },
          403: {
            description:
              'Forbidden - insufficient permissions or community access denied',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 403 },
            },
          },
          413: {
            description: 'Payload too large - file size exceeded',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 413 },
            },
          },
          415: {
            description: 'Unsupported media type',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 415 },
            },
          },
          429: {
            description: 'Too many requests - rate limit exceeded',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 429 },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        // Get multipart file
        const file = await request.file();
        if (!file) {
          return reply.status(400).send({
            error: 'No file provided',
            statusCode: 400,
          });
        }

        // Parse form fields from multipart data
        // For now, we'll use query parameters like the existing file service
        // In a production implementation, proper multipart field parsing would be needed
        const query = request.query as Record<string, unknown>;

        const fields = {
          community: query.community,
          entity: query.entity,
          entityId: query.entityId,
        };

        const validatedFields = uploadRequestSchema.parse(fields);

        // Verify community access - for now, we'll use simple community ID comparison
        // In a real implementation, this would check community membership properly
        if (
          authRequest.session.user.communityId.toString() !==
          validatedFields.community
        ) {
          return reply.status(403).send({
            error: 'Access denied: insufficient community access',
            statusCode: 403,
          });
        }

        // Upload file
        const result = await fileService.uploadFile(file, {
          community: validatedFields.community,
          entity: validatedFields.entity,
          entityId: validatedFields.entityId,
          uploadedBy: authRequest.session.user.id,
        });

        return reply.status(201).send({
          data: result,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        // Handle specific error types
        if (
          errorMessage.includes('File size exceeds') ||
          errorMessage.includes('too large')
        ) {
          return reply.status(413).send({
            error: errorMessage,
            statusCode: 413,
          });
        }

        if (
          errorMessage.includes('File type not allowed') ||
          errorMessage.includes('Video files not enabled')
        ) {
          return reply.status(415).send({
            error: errorMessage,
            statusCode: 415,
          });
        }

        if (errorMessage.includes('Rate limit exceeded')) {
          return reply.status(429).send({
            error: errorMessage,
            statusCode: 429,
          });
        }

        if (
          errorMessage.includes('Invalid entity') ||
          errorMessage.includes('validation')
        ) {
          return reply.status(400).send({
            error: errorMessage,
            statusCode: 400,
          });
        }

        fastify.log.error(error, 'File upload error (V2)');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Download file endpoint
   */
  fastify.get(
    '/:community/:entity/:entityId/:filename',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'Download file with entity-based path and community scoping',
        summary: 'Download file (V2)',
        tags: ['Files V2'],
        params: {
          type: 'object',
          properties: {
            community: { type: 'string', description: 'Community identifier' },
            entity: {
              type: 'string',
              enum: ['stories', 'places', 'speakers'],
              description: 'Entity type',
            },
            entityId: { type: 'number', description: 'Entity ID' },
            filename: { type: 'string', description: 'Filename' },
          },
          required: ['community', 'entity', 'entityId', 'filename'],
        },
        response: {
          200: {
            description: 'File content',
            type: 'string',
            format: 'binary',
          },
          400: {
            description: 'Bad request - invalid parameters',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 400 },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 401 },
            },
          },
          403: {
            description: 'Forbidden - access denied',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 403 },
            },
          },
          404: {
            description: 'File not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 404 },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const params = pathParamsSchema.parse(request.params);

        // Verify community access - for now, we'll use simple community ID comparison
        // In a real implementation, this would check community membership properly
        if (
          authRequest.session.user.communityId.toString() !== params.community
        ) {
          return reply.status(403).send({
            error: 'Access denied: insufficient community access',
            statusCode: 403,
          });
        }

        // Download file
        const result = await fileService.downloadFile({
          community: params.community,
          entity: params.entity,
          entityId: params.entityId,
          filename: params.filename,
        });

        // Set response headers
        reply.header('Content-Type', result.metadata.mimeType);
        reply.header('Content-Length', result.metadata.size);
        reply.header(
          'Content-Disposition',
          `inline; filename="${result.metadata.originalName}"`
        );

        if (result.metadata.etag) {
          reply.header('ETag', result.metadata.etag);
        }

        reply.header('Cache-Control', 'public, max-age=31536000'); // 1 year cache

        return reply.send(result.buffer);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        if (errorMessage.includes('File not found')) {
          return reply.status(404).send({
            error: errorMessage,
            statusCode: 404,
          });
        }

        if (
          errorMessage.includes('Invalid entity') ||
          errorMessage.includes('validation')
        ) {
          return reply.status(400).send({
            error: errorMessage,
            statusCode: 400,
          });
        }

        fastify.log.error(error, 'File download error (V2)');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Delete file endpoint
   */
  fastify.delete(
    '/:community/:entity/:entityId/:filename',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Delete file with entity-based path and community scoping',
        summary: 'Delete file (V2)',
        tags: ['Files V2'],
        params: {
          type: 'object',
          properties: {
            community: { type: 'string', description: 'Community identifier' },
            entity: {
              type: 'string',
              enum: ['stories', 'places', 'speakers'],
              description: 'Entity type',
            },
            entityId: { type: 'number', description: 'Entity ID' },
            filename: { type: 'string', description: 'Filename' },
          },
          required: ['community', 'entity', 'entityId', 'filename'],
        },
        response: {
          204: {
            description: 'File deleted successfully',
            type: 'null',
          },
          400: {
            description: 'Bad request - invalid parameters',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 400 },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 401 },
            },
          },
          403: {
            description: 'Forbidden - access denied',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 403 },
            },
          },
          404: {
            description: 'File not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 404 },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const params = pathParamsSchema.parse(request.params);

        // Verify community access - for now, we'll use simple community ID comparison
        // In a real implementation, this would check community membership properly
        if (
          authRequest.session.user.communityId.toString() !== params.community
        ) {
          return reply.status(403).send({
            error: 'Access denied: insufficient community access',
            statusCode: 403,
          });
        }

        // Delete file
        await fileService.deleteFile({
          community: params.community,
          entity: params.entity,
          entityId: params.entityId,
          filename: params.filename,
        });

        return reply.status(204).send();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        if (errorMessage.includes('File not found')) {
          return reply.status(404).send({
            error: errorMessage,
            statusCode: 404,
          });
        }

        if (
          errorMessage.includes('Invalid entity') ||
          errorMessage.includes('validation')
        ) {
          return reply.status(400).send({
            error: errorMessage,
            statusCode: 400,
          });
        }

        fastify.log.error(error, 'File deletion error (V2)');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * List files endpoint
   */
  fastify.get(
    '/list',
    {
      preHandler: [requireAuth],
      schema: {
        description:
          'List files with community scoping, entity filtering, and pagination',
        summary: 'List files (V2)',
        tags: ['Files V2'],
        querystring: {
          type: 'object',
          properties: {
            community: { type: 'string', description: 'Community identifier' },
            entity: {
              type: 'string',
              enum: ['stories', 'places', 'speakers'],
              description: 'Filter by entity type',
            },
            entityId: { type: 'number', description: 'Filter by entity ID' },
            page: {
              type: 'number',
              minimum: 1,
              default: 1,
              description: 'Page number',
            },
            limit: {
              type: 'number',
              minimum: 1,
              maximum: 100,
              default: 20,
              description: 'Items per page',
            },
          },
          required: ['community'],
        },
        response: {
          200: {
            description: 'Paginated list of files',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  files: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        filename: { type: 'string' },
                        originalName: { type: 'string' },
                        path: { type: 'string' },
                        url: { type: 'string' },
                        size: { type: 'number' },
                        mimeType: { type: 'string' },
                        community: { type: 'string' },
                        entity: {
                          type: 'string',
                          enum: ['stories', 'places', 'speakers'],
                        },
                        entityId: { type: 'number' },
                        uploadedBy: { type: 'number' },
                        createdAt: { type: 'string', format: 'date-time' },
                        etag: { type: 'string' },
                      },
                    },
                  },
                  total: { type: 'number' },
                  page: { type: 'number' },
                  totalPages: { type: 'number' },
                },
              },
            },
          },
          400: {
            description: 'Bad request - invalid query parameters',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 400 },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 401 },
            },
          },
          403: {
            description: 'Forbidden - access denied',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number', example: 403 },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const query = listQuerySchema.parse(request.query);

        // Verify community access - for now, we'll use simple community ID comparison
        // In a real implementation, this would check community membership properly
        if (
          authRequest.session.user.communityId.toString() !== query.community
        ) {
          return reply.status(403).send({
            error: 'Access denied: insufficient community access',
            statusCode: 403,
          });
        }

        // List files
        const result = await fileService.listFiles({
          community: query.community,
          entity: query.entity,
          entityId: query.entityId,
          page: query.page,
          limit: query.limit,
        });

        return reply.send({
          data: result,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        if (
          errorMessage.includes('Invalid entity') ||
          errorMessage.includes('validation')
        ) {
          return reply.status(400).send({
            error: errorMessage,
            statusCode: 400,
          });
        }

        fastify.log.error(error, 'File listing error (V2)');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );
}
