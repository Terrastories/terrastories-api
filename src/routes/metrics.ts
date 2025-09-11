/**
 * Metrics API Routes (Issue #89)
 *
 * Internal metrics endpoints for file operations observability.
 * These endpoints should be restricted to admin users in production.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fileOperationsMetrics } from '../shared/metrics/file-operations.js';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';

const metricsQuerySchema = z.object({
  reset: z.enum(['true', 'false']).optional(),
});

export default async function metricsRoutes(fastify: FastifyInstance) {
  // File operations metrics endpoint
  fastify.get<{
    Querystring: z.infer<typeof metricsQuerySchema>;
    Reply: {
      200: {
        data: Record<string, any>;
        timestamp: string;
        message?: string;
      };
      401: { error: string };
      403: { error: string };
    };
  }>(
    '/file-operations',
    {
      preHandler: [requireAuth],
      schema: {
        description: 'Get file operations metrics (admin only)',
        tags: ['metrics'],
        querystring: metricsQuerySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'object' },
              timestamp: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['data', 'timestamp'],
          },
          401: {
            type: 'object',
            properties: { error: { type: 'string' } },
            required: ['error'],
          },
          403: {
            type: 'object',
            properties: { error: { type: 'string' } },
            required: ['error'],
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { reset } = metricsQuerySchema.parse(request.query);
        const { role } = (request as AuthenticatedRequest).session.user!;

        // Only allow admin and super_admin access
        if (role !== 'admin' && role !== 'super_admin') {
          return reply.status(403).send({
            error: 'Admin access required for metrics',
          });
        }

        const metrics = fileOperationsMetrics.getMetrics();
        let message;

        if (reset === 'true') {
          fileOperationsMetrics.reset();
          message = 'Metrics retrieved and reset';
        }

        const response: {
          data: Record<string, unknown>;
          timestamp: string;
          message?: string;
        } = {
          data: metrics,
          timestamp: new Date().toISOString(),
        };

        if (message) {
          response.message = message;
        }

        return reply.status(200).send(response);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        request.log.error(
          { error: errorMessage },
          'Error fetching file operations metrics'
        );
        return reply.status(403).send({ error: 'Metrics access error' });
      }
    }
  );
}
