import { FastifyPluginAsync } from 'fastify';
import { getConfig, validateConfig } from '../shared/config/index.js';

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok'] },
              timestamp: { type: 'string', format: 'date-time' },
              version: { type: 'string' },
              environment: { type: 'string' },
              config: {
                type: 'object',
                properties: {
                  valid: { type: 'boolean' },
                  errors: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            required: [
              'status',
              'timestamp',
              'version',
              'environment',
              'config',
            ],
          },
        },
        tags: ['System'],
        summary: 'Health check endpoint with configuration status',
      },
    },
    async (_request, reply) => {
      const config = getConfig();
      const configValidation = validateConfig();

      reply.type('application/json');
      return {
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        environment: config.environment,
        config: configValidation,
      };
    }
  );
};
