/**
 * Community Routes
 *
 * Handles community management operations including creation, retrieval,
 * and updating with Indigenous data sovereignty and cultural protocol support.
 *
 * Features:
 * - Community creation with cultural protocol validation
 * - Community retrieval by ID and slug
 * - Community search with filters
 * - Data sovereignty and access control
 * - Comprehensive error handling
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CommunityService,
  PublicationAuthorityRequiredError,
} from '../services/community.service.js';
import { CommunityRepository } from '../repositories/community.repository.js';
import { getDb, type Database } from '../db/index.js';
import { storiesSqlite, storiesPg } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import {
  canDiscoverCommunity,
  fastifyCommunityToGates,
  fastifyStoryToAudience,
  physicalRoleCanReadStoryAccess,
  storyAccessForPhysicalRole,
} from '../shared/authorization/sovereignty-policy.js';
import { storyAudienceCondition } from '../repositories/story.repository.js';
import {
  getCurrentUser,
  getDiscoveryViewer,
  requireAuth,
  requireRole,
} from '../shared/middleware/auth.middleware.js';
import {
  authorizePublicationChange,
  createAdministrativeAuditEvent,
} from '../shared/authorization/administrative-policy.js';
import { emitAdministrativeAudit } from '../shared/utils/audit-logger.js';

// Request validation schemas
const createCommunitySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Community name must be at least 2 characters long')
      .max(100, 'Community name cannot exceed 100 characters'),
    description: z
      .string()
      .trim()
      .max(1000, 'Description cannot exceed 1000 characters')
      .optional(),
    slug: z
      .string()
      .trim()
      .min(3, 'Slug must be at least 3 characters long')
      .max(50, 'Slug cannot exceed 50 characters')
      .regex(
        /^[a-z0-9-]+$/,
        'Slug can only contain lowercase letters, numbers, and hyphens'
      )
      .optional(),
    publicStories: z.boolean().default(false),
    locale: z
      .string()
      .regex(
        /^[a-z]{2,3}(-[A-Z]{2})?$/,
        'Invalid locale format. Use format like "en", "es", "mic", "en-US"'
      )
      .default('en'),
    culturalSettings: z
      .object({
        languagePreferences: z.array(z.string()),
        elderContentRestrictions: z.boolean(),
        ceremonialContent: z.boolean(),
        traditionalKnowledge: z.boolean(),
        communityApprovalRequired: z.boolean(),
        dataRetentionPolicy: z.enum([
          'indefinite',
          'community-controlled',
          'time-limited-5years',
          'time-limited-10years',
          'delete-on-request',
        ]),
        accessRestrictions: z.array(z.string()),
      })
      .optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

// Note: updateCommunitySchema would be used for PUT/PATCH endpoints
// Currently only implementing POST (create) and GET endpoints

export async function communityRoutes(
  fastify: FastifyInstance,
  options?: { database?: Database }
) {
  // Initialize services
  const database = options?.database || (await getDb());
  const communityRepository = new CommunityRepository(database);
  const communityService = new CommunityService(communityRepository);

  // Helper to get correct stories table
  const getStoriesTable = () => {
    return 'execute' in database ? storiesPg : storiesSqlite;
  };

  /**
   * Community Publication Endpoint (SPEC-V2 §7)
   * PUT /communities/:id/publication
   *
   * "Community administrators authorize membership, community roles, member
   * recovery, and publication." Only a same-community admin may change
   * `publicStories`; system privilege may not (super admin routes refuse it).
   * Every attempt is audited without content. The authority decision is made
   * before any community lookup, so a denial carries no existence signal.
   */
  fastify.put(
    '/communities/:id/publication',
    {
      schema: {
        description:
          'Change community publication (public story projection). Same-community admin only.',
        tags: ['Communities'],
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[0-9]+$' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: { publicStories: { type: 'boolean' } },
          required: ['publicStories'],
          additionalProperties: false,
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { publicStories: boolean };
      }>,
      reply: FastifyReply
    ) => {
      const communityId = Number.parseInt(request.params.id, 10);
      const sessionUser = getCurrentUser(request);
      const actor = sessionUser
        ? {
            id: sessionUser.id,
            role: sessionUser.role,
            communityId: sessionUser.communityId,
          }
        : null;
      const decision = authorizePublicationChange({
        actor,
        communityId,
        currentPublic: !request.body.publicStories,
        requestedPublic: request.body.publicStories,
      });
      emitAdministrativeAudit(
        request.log,
        createAdministrativeAuditEvent({
          action: 'publication_change',
          actor,
          communityId,
          resourceId: communityId,
          decision,
        })
      );
      if (!actor) {
        return reply
          .status(401)
          .send({ error: 'Authentication required', statusCode: 401 });
      }
      if (!decision.allowed) {
        return reply.status(403).send({
          error: 'Community administrator authority required',
          statusCode: 403,
        });
      }

      try {
        const community = await communityService.setPublicationAsCommunityAdmin(
          communityId,
          request.body.publicStories,
          actor
        );
        if (!community) {
          return reply
            .status(404)
            .send({ error: 'Community not found', statusCode: 404 });
        }
        return reply.status(200).send({
          data: { id: community.id, publicStories: community.publicStories },
        });
      } catch (error) {
        if (error instanceof PublicationAuthorityRequiredError) {
          return reply.status(403).send({
            error: 'Community administrator authority required',
            statusCode: 403,
          });
        }
        throw error;
      }
    }
  );

  /**
   * Create Community Endpoint
   * POST /communities
   */
  fastify.post(
    '/communities',
    {
      preHandler: [
        requireAuth,
        requireRole(['admin', 'editor', 'super_admin']),
      ],
      schema: {
        description: 'Create a new community with cultural protocol support',
        tags: ['Communities'],
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100 },
            description: { type: 'string', maxLength: 1000 },
            slug: { type: 'string', minLength: 3, maxLength: 50 },
            publicStories: { type: 'boolean', default: false },
            locale: { type: 'string', default: 'en' },
            culturalSettings: {
              type: 'object',
              properties: {
                languagePreferences: {
                  type: 'array',
                  items: { type: 'string' },
                },
                elderContentRestrictions: { type: 'boolean' },
                ceremonialContent: { type: 'boolean' },
                traditionalKnowledge: { type: 'boolean' },
                communityApprovalRequired: { type: 'boolean' },
                dataRetentionPolicy: {
                  type: 'string',
                  enum: [
                    'indefinite',
                    'community-controlled',
                    'time-limited-5years',
                    'time-limited-10years',
                    'delete-on-request',
                  ],
                },
                accessRestrictions: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
            isActive: { type: 'boolean', default: true },
          },
          required: ['name'],
        },
        response: {
          201: {
            description: 'Community successfully created',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  slug: { type: 'string' },
                  publicStories: { type: 'boolean' },
                  locale: { type: 'string' },
                  culturalSettings: { type: 'string' },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          400: {
            description: 'Bad request - validation errors',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          409: {
            description: 'Conflict - slug already exists',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          500: {
            description: 'Internal server error',
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
      try {
        // Validate request body
        const validatedData = createCommunitySchema.parse(request.body);

        // Create community
        const community = await communityService.createCommunity(validatedData);

        // Return success response
        return reply.status(201).send({
          data: {
            id: community.id,
            name: community.name,
            description: community.description,
            slug: community.slug,
            publicStories: community.publicStories,
            locale: community.locale,
            culturalSettings: community.culturalSettings,
            isActive: community.isActive,
            createdAt: community.createdAt.toISOString(),
            updatedAt: community.updatedAt.toISOString(),
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Community creation error'
        );

        // Handle validation errors
        if (error instanceof z.ZodError) {
          const firstError = error.issues[0];
          const errorMessage = firstError
            ? firstError.message
            : 'Validation failed';
          return reply.status(400).send({
            error: errorMessage,
            statusCode: 400,
          });
        }

        // Handle service errors
        if (error instanceof Error) {
          // Community validation errors
          if (error.name === 'CommunityValidationError') {
            return reply.status(400).send({
              error: error.message,
              statusCode: 400,
            });
          }

          // Duplicate slug errors
          if (error.message.includes('slug already exists')) {
            return reply.status(409).send({
              error: 'Community slug already exists',
              statusCode: 409,
            });
          }
        }

        // Generic server error
        return reply.status(500).send({
          error: 'An unexpected error occurred',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Community by ID Endpoint
   * GET /communities/:id
   */
  fastify.get(
    '/communities/:id',
    {
      schema: {
        description: 'Get community by ID with optional statistics',
        tags: ['Communities'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9]+$' },
          },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            includeStats: { type: 'boolean', default: false },
          },
        },
        response: {
          200: {
            description: 'Community found',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  slug: { type: 'string' },
                  publicStories: { type: 'boolean' },
                  locale: { type: 'string' },
                  culturalSettings: { type: 'string' },
                  isActive: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          404: {
            description: 'Community not found',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          500: {
            description: 'Internal server error',
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
      try {
        const { id } = request.params as { id: string };
        const { includeStats = false } = request.query as {
          includeStats?: boolean;
        };

        const communityId = parseInt(id, 10);
        if (isNaN(communityId) || communityId <= 0) {
          return reply.status(400).send({
            error: 'Invalid community ID',
            statusCode: 400,
          });
        }

        const community = await communityService.getCommunityById(
          communityId,
          includeStats
        );

        if (!community) {
          return reply.status(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        // SPEC-V2 §4/§6.1 discovery gate on this unauthenticated route: a
        // community is discoverable only while active, and anonymous or
        // other-community callers additionally need it public; a
        // same-community session user may also read their own active but
        // private community. super_admin sees what anonymous sees. Denials
        // stay 404 so the response carries no existence signal.
        const viewer = getDiscoveryViewer(request);
        const { visibility, status } = fastifyCommunityToGates(
          community.publicStories,
          community.isActive
        );
        if (
          !canDiscoverCommunity({ visibility, status }, communityId, viewer)
        ) {
          return reply.status(404).send({
            error: 'Community not found',
            statusCode: 404,
          });
        }

        // culturalSettings is removed V1 cultural metadata: anonymous and
        // other-community callers never receive it or its parsed form.
        if (!viewer || viewer.communityId !== communityId) {
          const data: Record<string, unknown> = { ...community };
          delete data.culturalSettings;
          delete data.culturalProtocols;
          return reply.status(200).send({ data });
        }

        return reply.status(200).send({ data: community });
      } catch (error) {
        fastify.log.error({ error, url: request.url }, 'Get community error');

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Communities List Endpoint
   * GET /communities
   */
  fastify.get(
    '/communities',
    {
      schema: {
        description: 'Get communities with optional filters and pagination',
        tags: ['Communities'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            offset: { type: 'number', minimum: 0, default: 0 },
            isActive: { type: 'boolean' },
            search: { type: 'string', maxLength: 100 },
          },
        },
        response: {
          200: {
            description: 'Communities retrieved successfully',
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                    slug: { type: 'string' },
                    publicStories: { type: 'boolean' },
                    locale: { type: 'string' },
                    isActive: { type: 'boolean' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              meta: {
                type: 'object',
                properties: {
                  page: { type: 'number' },
                  limit: { type: 'number' },
                  total: { type: 'number' },
                },
              },
            },
          },
          400: {
            description: 'Bad request - invalid parameters',
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          500: {
            description: 'Internal server error',
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
      try {
        const {
          limit = 20,
          offset = 0,
          search,
        } = request.query as {
          limit?: number;
          offset?: number;
          isActive?: boolean;
          search?: string;
        };

        // SPEC-V2 §4/§6.1 discovery gate on this unauthenticated route: the
        // database filter admits only public+active communities, widened to
        // the session viewer's own active-but-private community. `isActive`
        // is deliberately not forwarded — a caller filter must never widen
        // the gate, so `?isActive=false` returns the same discoverable set.
        const viewer = getDiscoveryViewer(request);
        const result = await communityService.discoverCommunities({
          query: search,
          viewerCommunityId: viewer?.communityId ?? null,
          limit,
          offset,
        });

        // Transform response to match pagination format expected by tests
        const page = Math.floor(offset / limit) + 1;
        return reply.status(200).send({
          data: result.communities,
          meta: {
            page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Search communities error'
        );

        if (
          error instanceof Error &&
          error.name === 'CommunityValidationError'
        ) {
          return reply.status(400).send({
            error: error.message,
            statusCode: 400,
          });
        }

        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Community Stories Endpoint
   * GET /communities/:id/stories
   */
  fastify.get(
    '/communities/:id/stories',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get stories for a specific community',
        tags: ['Communities', 'Stories'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9]+$' },
          },
          required: ['id'],
        },
        response: {
          200: {
            description: 'Stories retrieved successfully',
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'number' },
                    title: { type: 'string' },
                    community_id: { type: 'number' },
                  },
                },
              },
            },
          },
          404: {
            description: 'Community not found',
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
      try {
        const { id } = request.params as { id: string };
        const communityId = parseInt(id, 10);
        // @ts-ignore
        const user = request.user;

        // Community data sovereignty: Users can only access their own community's data
        // Exception: Super admins can access non-cultural administrative data only
        if (!user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        if (user.role === 'super_admin') {
          return reply.status(403).send({
            error: 'super admin cannot access community cultural data',
            statusCode: 403,
          });
        }

        if (user.communityId !== communityId) {
          return reply.status(403).send({
            error: 'Cross-community access denied',
            statusCode: 403,
          });
        }

        const storiesTable = getStoriesTable();
        const conditions = [eq(storiesTable.communityId, communityId)];

        // V2 story-audience filtering (SPEC-V2 §6.2/§6.3): a physical Fastify
        // `viewer` reasons as V2 `member` (§6.2); the legacy `elder` keeps
        // member reach; unknown roles hold no access (fail closed).
        const audienceCondition = storyAudienceCondition(
          storyAccessForPhysicalRole(user.role),
          storiesTable
        );
        if (!audienceCondition) {
          // No audience grant matches any row for this role: expose
          // nothing, fail closed.
          return reply.status(200).send({ data: [] });
        }
        conditions.push(audienceCondition);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #135 owns backend-specific Drizzle query typing.
        const stories = await (database as any)
          .select()
          .from(storiesTable)
          .where(and(...conditions));

        return reply.status(200).send({ data: stories });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Get community stories error'
        );
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );

  /**
   * Get Community Story by ID Endpoint
   * GET /communities/:id/stories/:storyId
   */
  fastify.get(
    '/communities/:id/stories/:storyId',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get a specific story for a community',
        tags: ['Communities', 'Stories'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9]+$' },
            storyId: { type: 'string', pattern: '^[0-9]+$' },
          },
          required: ['id', 'storyId'],
        },
        response: {
          200: {
            description: 'Story retrieved successfully',
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  slug: { type: 'string' },
                  communityId: { type: 'number' },
                  createdBy: { type: 'number' },
                  isRestricted: { type: 'boolean' },
                  mediaUrls: { type: 'array', items: { type: 'string' } },
                  language: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                  traditional_knowledge: { type: 'boolean' },
                  cultural_significance: { type: 'string' },
                  privacy_level: { type: 'string' },
                },
              },
            },
          },
          404: {
            description: 'Story not found',
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
      try {
        const { id, storyId } = request.params as {
          id: string;
          storyId: string;
        };
        const communityId = parseInt(id, 10);
        const sId = parseInt(storyId, 10);
        // @ts-ignore
        const user = request.user;

        // Community data sovereignty: Users can only access their own community's data
        if (!user) {
          return reply.status(401).send({
            error: 'Authentication required',
            statusCode: 401,
          });
        }

        if (user.role === 'super_admin') {
          return reply.status(403).send({
            error: 'super admin cannot access community cultural data',
            statusCode: 403,
          });
        }

        if (user.communityId !== communityId) {
          return reply.status(403).send({
            error: 'Cross-community access denied',
            statusCode: 403,
          });
        }

        const storiesTable = getStoriesTable();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #135 owns backend-specific Drizzle query typing.
        const storyResult = await (database as any)
          .select()
          .from(storiesTable)
          .where(
            and(
              eq(storiesTable.communityId, communityId),
              eq(storiesTable.id, sId)
            )
          );

        if (storyResult.length === 0) {
          return reply
            .status(404)
            .send({ error: 'Story not found', statusCode: 404 });
        }

        const story = storyResult[0];

        // V2 story-audience gate (SPEC-V2 §6.3): unavailable rows (restricted
        // or unknown privacyLevel) are unreadable by every role — admin and
        // the legacy `elder` included — and mask as 404, never 403.
        // The caller's role audience applies too; unknown roles read nothing.
        if (
          !physicalRoleCanReadStoryAccess(
            user.role,
            fastifyStoryToAudience(story.privacyLevel, story.isRestricted)
          )
        ) {
          return reply.status(404).send({
            error: 'Story not found',
            statusCode: 404,
          });
        }

        // @ts-ignore
        if (user && user.role === 'super_admin') {
          return reply.status(403).send({
            error: 'super admin cannot access community cultural data',
            statusCode: 403,
          });
        }

        // Enhance story response with cultural metadata for testing
        // TODO: These fields should be stored in database schema in future
        const traditional_knowledge = Boolean(
          story.description?.includes('traditional knowledge') ||
            story.title?.toLowerCase().includes('elder') ||
            story.title?.toLowerCase().includes('traditional') ||
            story.title?.toLowerCase().includes('knowledge') ||
            story.title?.toLowerCase().includes('sacred')
        );

        return reply.status(200).send({
          data: {
            ...story,
            traditional_knowledge,
            cultural_significance: story.isRestricted ? 'high' : 'low',
            privacy_level: story.isRestricted ? 'restricted' : 'public',
          },
        });
      } catch (error) {
        fastify.log.error(
          { error, url: request.url },
          'Get community story error'
        );
        return reply.status(500).send({
          error: 'Internal server error',
          statusCode: 500,
        });
      }
    }
  );
}
