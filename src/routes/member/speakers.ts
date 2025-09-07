/**
 * Member Speakers Routes
 *
 * Authenticated CRUD endpoints for member speaker management with comprehensive
 * cultural protocols, community data sovereignty, and Indigenous cultural sensitivity.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  requireAuth,
  requireCommunityAccess,
  type AuthenticatedRequest,
} from '../../shared/middleware/auth.middleware.js';
import { z } from 'zod';
import { SpeakerService } from '../../services/speaker.service.js';
import { SpeakerRepository } from '../../repositories/speaker.repository.js';
import { getDb, type Database } from '../../db/index.js';
import {
  toMemberSpeaker,
  createPaginationMeta,
  type MemberListResponse,
  type MemberSpeakerDTO,
  MemberIdParamSchema,
  CreateSpeakerSchema,
  UpdateSpeakerSchema,
  SpeakerSearchQuerySchema,
} from '../../shared/types/member.js';

export interface MemberSpeakersRoutesOptions {
  database?: Database;
}

export async function memberSpeakersRoutes(
  app: FastifyInstance,
  options?: MemberSpeakersRoutesOptions
) {
  const db = options?.database || (await getDb());
  const speakerRepository = new SpeakerRepository(db);
  const speakerService = new SpeakerService(speakerRepository);

  // GET /api/v1/member/speakers - List user's community speakers
  app.get('/', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: "List speakers in member's community",
      tags: ['Member Speakers'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          culturalRole: {
            type: 'string',
            enum: [
              'storyteller',
              'elder',
              'historian',
              'cultural_keeper',
              'ceremonial_leader',
            ],
          },
          isElder: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
            meta: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
                totalPages: { type: 'integer' },
                hasNextPage: { type: 'boolean' },
                hasPrevPage: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const query = SpeakerSearchQuerySchema.parse(request.query);
        const page = parseInt(String(query.page), 10);
        const limit = parseInt(String(query.limit), 10);

        const result = await speakerService.getSpeakersByCommunity(
          userCommunityId,
          {
            page,
            limit,
            elderOnly: query.isElder,
            culturalRole: query.culturalRole,
          },
          user.id,
          userRole
        );

        const speakerDTOs = result.data.map((speaker) =>
          toMemberSpeaker(speaker, userRole)
        );

        const response: MemberListResponse<MemberSpeakerDTO> = {
          data: speakerDTOs,
          meta: createPaginationMeta(page, limit, result.total),
        };

        return reply.code(200).send(response);
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid query parameters',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Error listing member speakers'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to retrieve speakers',
          },
        });
      }
    },
  });

  // GET /api/v1/member/speakers/:id - Get specific speaker
  app.get('/:id', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Get specific speaker by ID',
      tags: ['Member Speakers'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const params = MemberIdParamSchema.parse(request.params);
        const speakerId = params.id;

        const speaker = await speakerService.getSpeakerById(
          speakerId,
          userCommunityId
        );

        if (!speaker) {
          return reply.code(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Speaker not found in your community',
            },
          });
        }

        const speakerDTO = toMemberSpeaker(speaker, userRole);
        return reply.code(200).send({ data: speakerDTO });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid parameters',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          {
            error: errorMessage,
            speakerId: (request.params as { id: string }).id,
          },
          'Error getting member speaker'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to retrieve speaker',
          },
        });
      }
    },
  });

  // POST /api/v1/member/speakers - Create new speaker
  app.post('/', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Create new speaker',
      tags: ['Member Speakers'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          bio: { type: 'string' },
          birthYear: {
            type: 'integer',
            minimum: 1850,
            maximum: new Date().getFullYear(),
          },
          photoUrl: { type: 'string', format: 'uri' },
          culturalRole: {
            type: 'string',
            enum: [
              'storyteller',
              'elder',
              'historian',
              'cultural_keeper',
              'ceremonial_leader',
            ],
            default: 'storyteller',
          },
          isElder: { type: 'boolean', default: false },
          isRestricted: { type: 'boolean', default: false },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const data = CreateSpeakerSchema.parse(request.body);

        const speakerData = {
          name: data.name,
          bio: data.bio,
          birthYear: data.birthYear,
          photoUrl: data.photoUrl,
          elderStatus: data.isElder || false,
          culturalRole: data.culturalRole,
          isActive: true,
        };

        const speaker = await speakerService.createSpeaker(
          speakerData,
          userCommunityId,
          user.id,
          userRole
        );

        const speakerDTO = toMemberSpeaker(speaker, userRole);
        return reply.code(201).send({ data: speakerDTO });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request body',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Error creating member speaker'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to create speaker',
          },
        });
      }
    },
  });

  // PUT /api/v1/member/speakers/:id - Update speaker
  app.put('/:id', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Update speaker',
      tags: ['Member Speakers'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          bio: { type: 'string' },
          birthYear: {
            type: 'integer',
            minimum: 1850,
            maximum: new Date().getFullYear(),
          },
          photoUrl: { type: 'string', format: 'uri' },
          culturalRole: {
            type: 'string',
            enum: [
              'storyteller',
              'elder',
              'historian',
              'cultural_keeper',
              'ceremonial_leader',
            ],
          },
          isElder: { type: 'boolean' },
          isRestricted: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: { type: 'object' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const params = MemberIdParamSchema.parse(request.params);
        const speakerId = params.id;
        const updates = UpdateSpeakerSchema.parse(request.body);

        const updateData = {
          name: updates.name,
          bio: updates.bio,
          birthYear: updates.birthYear,
          photoUrl: updates.photoUrl,
          elderStatus: updates.isElder,
          culturalRole: updates.culturalRole,
        };

        const speaker = await speakerService.updateSpeaker(
          speakerId,
          updateData,
          userCommunityId,
          user.id,
          userRole
        );

        const speakerDTO = toMemberSpeaker(speaker, userRole);
        return reply.code(200).send({ data: speakerDTO });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          {
            error: errorMessage,
            speakerId: (request.params as { id: string }).id,
          },
          'Error updating member speaker'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to update speaker',
          },
        });
      }
    },
  });

  // DELETE /api/v1/member/speakers/:id - Delete speaker
  app.delete('/:id', {
    preHandler: [requireAuth, requireCommunityAccess()],
    schema: {
      description: 'Delete speaker',
      tags: ['Member Speakers'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
        },
        required: ['id'],
      },
      response: {
        204: {
          type: 'null',
          description: 'Speaker deleted successfully',
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = (request as AuthenticatedRequest).user;
        const userCommunityId = user.communityId;
        const userRole = user.role as
          | 'super_admin'
          | 'admin'
          | 'editor'
          | 'viewer'
          | 'elder';

        if (!user || !userCommunityId) {
          return reply.code(401).send({
            error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
          });
        }

        const params = MemberIdParamSchema.parse(request.params);
        const speakerId = params.id;

        await speakerService.deleteSpeaker(
          speakerId,
          userCommunityId,
          user.id,
          userRole
        );

        return reply.code(204).send();
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid parameters',
              details: error.issues,
            },
          });
        }

        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          {
            error: errorMessage,
            speakerId: (request.params as { id: string }).id,
          },
          'Error deleting member speaker'
        );
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to delete speaker',
          },
        });
      }
    },
  });
}
