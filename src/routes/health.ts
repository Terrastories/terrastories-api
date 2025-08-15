import { FastifyPluginAsync } from 'fastify';

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
            },
            required: ['status', 'timestamp', 'version', 'environment'],
          },
        },
        tags: ['System'],
        summary: 'Health check endpoint',
      },
    },
    async (_request, reply) => {
      reply.type('application/json');
      return {
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
      };
    }
  );
};
