import Fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { registerRoutes } from './routes/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    routerOptions: {
      ignoreTrailingSlash: true,
      caseSensitive: false,
    },
    disableRequestLogging: process.env.NODE_ENV === 'test',
  });

  // Security plugins
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
      },
    },
  });
  await app.register(cors);

  // Swagger documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Terrastories API',
        description:
          'TypeScript backend for Terrastories geostorytelling platform',
        version: '1.0.0',
      },
      servers: [
        {
          url: 'http://localhost:3000',
          description: 'Development server',
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false,
    },
    uiHooks: {
      onRequest: function (_request, _reply, next) {
        next();
      },
      preHandler: function (_request, _reply, next) {
        next();
      },
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, _request, _reply) => {
      return swaggerObject;
    },
    transformSpecificationClone: true,
  });

  // Global error handler
  app.setErrorHandler(async (error, request, reply) => {
    const { method, url } = request;

    app.log.error({ error, method, url }, 'Request error');

    // Don't leak internal errors in production
    const isDevelopment = process.env.NODE_ENV === 'development';

    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: error.message,
        statusCode: error.statusCode,
      });
    }

    return reply.status(500).send({
      error: isDevelopment ? error.message : 'Internal Server Error',
      statusCode: 500,
    });
  });

  // Register application routes
  await app.register(registerRoutes);

  return app;
}
