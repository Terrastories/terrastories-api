/**
 * File Upload Routes
 *
 * Handles file upload and management endpoints with comprehensive security,
 * community data sovereignty, and cultural protocol enforcement.
 *
 * Features:
 * - Multipart file upload with validation
 * - Secure file serving with access control
 * - Community-scoped file management
 * - Cultural restrictions support
 * - Comprehensive error handling and audit logging
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { FileService } from '../services/file.service.js';
import { FileRepository } from '../repositories/file.repository.js';
import { getDb } from '../db/index.js';
import { getConfig } from '../shared/config/index.js';
import {
  requireAuth,
  requireCommunityAccess,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';

// Request validation schemas
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
 * Register file upload routes
 */
export async function fileRoutes(fastify: FastifyInstance) {
  const db = await getDb();
  const config = getConfig();
  const fileRepository = new FileRepository(db);
  const fileService = new FileService(
    config.fileUpload.uploadDir,
    config.fileUpload,
    fileRepository
  );

  // Set up audit logging
  if (config.fileUpload.enableAuditLogging) {
    fileService.setLogger((entry) => {
      fastify.log.info(entry, 'File operation audit log');
    });
  }

  /**
   * Upload file endpoint
   */
  fastify.post(
    '/upload',
    {
      preHandler: [requireAuth, requireCommunityAccess()],
      schema: {
        description:
          'Upload a file with community scoping and cultural restrictions',
        tags: ['Files'],
        consumes: ['multipart/form-data'],
        querystring: uploadQuerySchema,
        response: {
          201: {
            description: 'File uploaded successfully',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  filename: { type: 'string' },
                  originalName: { type: 'string' },
                  url: { type: 'string' },
                  size: { type: 'number' },
                  mimeType: { type: 'string' },
                  communityId: { type: 'number' },
                  uploadedBy: { type: 'number' },
                  metadata: { type: 'object' },
                  culturalRestrictions: { type: 'object' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          400: {
            description: 'Bad request - validation error',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          401: {
            description: 'Unauthorized - authentication required',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          413: {
            description: 'Payload too large - file size exceeded',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          415: {
            description: 'Unsupported media type',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;

      try {
        // Parse query parameters for cultural restrictions
        const query = uploadQuerySchema.parse(request.query);

        // Get multipart file
        const file = await request.file();
        if (!file) {
          return reply.status(400).send({
            error: 'No file provided',
            statusCode: 400,
          });
        }

        // Validate file size against configured limits
        const maxSize = fileService.getMaxSizeForMimeType(file.mimetype);

        // Upload file with community scoping
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const result = await fileService.uploadFile(file, {
          communityId: authRequest.session.user.communityId,
          uploadedBy: authRequest.session.user.id,
          maxSize,
          culturalRestrictions: query.culturalRestrictions,
        });

        return reply.status(201).send({
          data: result,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';

        // Handle specific error types
        if (errorMessage.includes('File size exceeds')) {
          return reply.status(413).send({
            error: errorMessage,
            statusCode: 413,
          });
        }

        if (
          errorMessage.includes('File type not allowed') ||
          errorMessage.includes('Invalid file type')
        ) {
          return reply.status(415).send({
            error: errorMessage,
            statusCode: 415,
          });
        }

        fastify.log.error(error, 'File upload error');
        return reply.status(400).send({
          error: errorMessage,
          statusCode: 400,
        });
      }
    }
  );

  /**
   * Serve file endpoint with access control
   */
  fastify.get(
    '/:id',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Serve file with access control and community scoping',
        tags: ['Files'],
        params: fileParamsSchema,
        response: {
          200: {
            description: 'File content',
            type: 'string',
            format: 'binary',
          },
          403: {
            description: 'Forbidden - access denied',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          404: {
            description: 'File not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      const { id } = fileParamsSchema.parse(request.params);

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        // Get file metadata with access control
        const fileData = await fileService.getFile(
          id,
          authRequest.session.user.id,
          authRequest.session.user.communityId,
          authRequest.session.user.role
        );

        // Build file path
        const filePath = join(config.fileUpload.uploadDir, fileData.path);

        // Check if file exists on disk
        try {
          const stats = await stat(filePath);
          if (!stats.isFile()) {
            throw new Error('Not a file');
          }
        } catch {
          return reply.status(404).send({
            error: 'File not found on disk',
            statusCode: 404,
          });
        }

        // Set appropriate headers
        reply.header('Content-Type', fileData.mimeType);
        reply.header('Content-Length', fileData.size);
        reply.header(
          'Content-Disposition',
          `inline; filename="${fileData.originalName}"`
        );
        reply.header('Cache-Control', 'public, max-age=31536000'); // 1 year cache

        // Stream file to response
        const stream = createReadStream(filePath);
        return reply.send(stream);
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
          errorMessage.includes('Access denied') ||
          errorMessage.includes('cannot access')
        ) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        fastify.log.error(error, 'File serving error');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get file metadata endpoint
   */
  fastify.get(
    '/:id/info',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get file metadata with access control',
        tags: ['Files'],
        params: fileParamsSchema,
        response: {
          200: {
            description: 'File metadata',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  filename: { type: 'string' },
                  originalName: { type: 'string' },
                  url: { type: 'string' },
                  size: { type: 'number' },
                  mimeType: { type: 'string' },
                  communityId: { type: 'number' },
                  uploadedBy: { type: 'number' },
                  metadata: { type: 'object' },
                  culturalRestrictions: { type: 'object' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          403: {
            description: 'Forbidden - access denied',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          404: {
            description: 'File not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      const { id } = fileParamsSchema.parse(request.params);

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const fileData = await fileService.getFile(
          id,
          authRequest.session.user.id,
          authRequest.session.user.communityId,
          authRequest.session.user.role
        );

        return reply.send({
          data: fileData,
        });
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
          errorMessage.includes('Access denied') ||
          errorMessage.includes('cannot access')
        ) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        fastify.log.error(error, 'File info error');
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
    '/:id',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Delete file with authorization',
        tags: ['Files'],
        params: fileParamsSchema,
        response: {
          204: {
            description: 'File deleted successfully',
            type: 'null',
          },
          403: {
            description: 'Forbidden - insufficient permissions',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          404: {
            description: 'File not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      const { id } = fileParamsSchema.parse(request.params);

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        await fileService.deleteFile(
          id,
          authRequest.session.user.id,
          authRequest.session.user.communityId
        );

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
          errorMessage.includes('Access denied') ||
          errorMessage.includes('you can only delete')
        ) {
          return reply.status(403).send({
            error: errorMessage,
            statusCode: 403,
          });
        }

        fastify.log.error(error, 'File deletion error');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * List files endpoint with pagination and filtering
   */
  fastify.get(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'List files with community scoping and pagination',
        tags: ['Files'],
        querystring: listFilesQuerySchema,
        response: {
          200: {
            description: 'Paginated list of files',
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    filename: { type: 'string' },
                    originalName: { type: 'string' },
                    url: { type: 'string' },
                    size: { type: 'number' },
                    mimeType: { type: 'string' },
                    communityId: { type: 'number' },
                    uploadedBy: { type: 'number' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              meta: {
                type: 'object',
                properties: {
                  page: { type: 'number' },
                  limit: { type: 'number' },
                  total: { type: 'number' },
                  totalPages: { type: 'number' },
                  hasNextPage: { type: 'boolean' },
                  hasPreviousPage: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authRequest = request as AuthenticatedRequest;
      const query = listFilesQuerySchema.parse(request.query);

      try {
        if (!authRequest.session?.user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        const result = await fileService.listFiles(
          authRequest.session.user.communityId,
          authRequest.session.user.id,
          query
        );

        return reply.send(result);
      } catch (error) {
        fastify.log.error(error, 'File listing error');
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );
}
