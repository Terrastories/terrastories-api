/**
 * Speakers API Routes
 *
 * RESTful API endpoints for speaker management with:
 * - Complete CRUD operations
 * - Cultural protocol enforcement (elder permissions)
 * - Community data isolation
 * - Comprehensive input validation
 * - Authentication middleware integration
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SpeakerService } from '../services/speaker.service.js';
import { SpeakerRepository } from '../repositories/speaker.repository.js';
import { getDb, type Database } from '../db/index.js';
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';
import { handleRouteError } from '../shared/middleware/error.middleware.js';

/**
 * Zod validation schemas
 */

// Create speaker request schema
const CreateSpeakerSchema = z.object({
  name: z.string().min(1).max(200).describe('Speaker name'),
  bio: z.string().max(2000).optional().describe('Speaker biography'),
  photoUrl: z.string().url().optional().describe('Speaker photo URL'),
  birthYear: z
    .number()
    .int()
    .min(1900)
    .max(new Date().getFullYear())
    .optional()
    .describe('Birth year'),
  elderStatus: z.boolean().optional().default(false).describe('Elder status'),
  culturalRole: z
    .string()
    .max(100)
    .optional()
    .describe('Cultural role in community'),
  isActive: z.boolean().optional().default(true).describe('Active status'),
});

// Update speaker request schema - Remove defaults to avoid triggering permission checks
const UpdateSpeakerSchema = z.object({
  name: z.string().min(1).max(200).optional().describe('Speaker name'),
  bio: z.string().max(2000).optional().describe('Speaker biography'),
  photoUrl: z.string().url().optional().describe('Speaker photo URL'),
  birthYear: z
    .number()
    .int()
    .min(1900)
    .max(new Date().getFullYear())
    .optional()
    .describe('Birth year'),
  elderStatus: z.boolean().optional().describe('Elder status'),
  culturalRole: z
    .string()
    .max(100)
    .optional()
    .describe('Cultural role in community'),
  isActive: z.boolean().optional().describe('Active status'),
});

// Query parameter schemas
const PaginationSchema = z.object({
  page: z.coerce.number().min(1).optional().default(1).describe('Page number'),
  limit: z.coerce
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Items per page'),
});

const SpeakerListQuerySchema = PaginationSchema.extend({
  elderOnly: z.coerce.boolean().optional().describe('Filter elders only'),
  culturalRole: z.string().optional().describe('Filter by cultural role'),
  activeOnly: z.coerce
    .boolean()
    .optional()
    .describe('Filter active speakers only'),
  sortBy: z
    .enum(['name', 'created_at', 'updated_at'])
    .optional()
    .default('name')
    .describe('Sort field'),
  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .default('asc')
    .describe('Sort order'),
});

const SearchQuerySchema = PaginationSchema.extend({
  q: z.string().min(2).describe('Search query (minimum 2 characters)'),
});

// Path parameter schemas
const SpeakerIdSchema = z.object({
  id: z.coerce.number().min(1).describe('Speaker ID'),
});

/**
 * Register Speaker routes with Fastify
 */
export async function speakerRoutes(
  fastify: FastifyInstance,
  options?: { database?: Database }
) {
  // Initialize service
  const database = options?.database || (await getDb());
  const repository = new SpeakerRepository(database);
  const service = new SpeakerService(repository);

  /**
   * POST /api/v1/speakers - Create new speaker
   */
  fastify.post('/speakers', {
    preHandler: [requireAuth, requireRole(['admin', 'editor'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = CreateSpeakerSchema.parse(request.body);
        const { user } = request as AuthenticatedRequest;

        const speaker = await service.createSpeaker(
          data,
          user.communityId,
          user.id,
          user.role
        );

        return reply.status(201).send({
          data: speaker,
          meta: { message: 'Speaker created successfully' },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * GET /api/v1/speakers/:id - Get speaker by ID
   */
  fastify.get('/speakers/:id', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = SpeakerIdSchema.parse(request.params);
        const { user } = request as AuthenticatedRequest;

        const speaker = await service.getSpeakerById(id, user.communityId);

        return reply.send({
          data: speaker,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * GET /api/v1/speakers - List community speakers
   */
  fastify.get('/speakers', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const params = SpeakerListQuerySchema.parse(request.query);
        const { user } = request as AuthenticatedRequest;

        const result = await service.getSpeakersByCommunity(
          user.communityId,
          params,
          user.id,
          user.role
        );

        return reply.send({
          data: result.data,
          meta: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            pages: result.pages,
          },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * PUT /api/v1/speakers/:id - Update speaker
   */
  fastify.put('/speakers/:id', {
    preHandler: [requireAuth, requireRole(['admin', 'editor'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = SpeakerIdSchema.parse(request.params);
        const data = UpdateSpeakerSchema.parse(request.body);
        const { user } = request as AuthenticatedRequest;

        const speaker = await service.updateSpeaker(
          id,
          data,
          user.communityId,
          user.id,
          user.role
        );

        return reply.send({
          data: speaker,
          meta: { message: 'Speaker updated successfully' },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * DELETE /api/v1/speakers/:id - Delete speaker
   */
  fastify.delete('/speakers/:id', {
    preHandler: [requireAuth, requireRole(['admin'])],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = SpeakerIdSchema.parse(request.params);
        const { user } = request as AuthenticatedRequest;

        await service.deleteSpeaker(id, user.communityId, user.id, user.role);

        return reply.status(204).send();
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * GET /api/v1/speakers/search - Search speakers
   */
  fastify.get('/speakers/search', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const params = SearchQuerySchema.parse(request.query);
        const { user } = request as AuthenticatedRequest;

        const result = await service.searchSpeakers(
          user.communityId,
          params.q,
          {
            page: params.page,
            limit: params.limit,
          },
          user.id,
          user.role
        );

        return reply.send({
          data: result.data,
          meta: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            pages: result.pages,
          },
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });

  /**
   * GET /api/v1/speakers/stats - Get community speaker statistics
   */
  fastify.get('/speakers/stats', {
    preHandler: [requireAuth],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { user } = request as AuthenticatedRequest;

        const stats = await service.getCommunityStats(user.communityId);

        return reply.send({
          data: stats,
        });
      } catch (error) {
        return handleRouteError(error, reply, request);
      }
    },
  });
}
