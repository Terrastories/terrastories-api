import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { registerRoutes } from './routes/index.js';
import { getConfig } from './shared/config/index.js';
import { swaggerSchemas } from './shared/schemas/index.js';

export async function buildApp() {
  const config = getConfig();

  const app = Fastify({
    logger: {
      level: config.logging.level,
    },
    // @ts-expect-error - Fastify v5 types don't yet properly export routerOptions interface
    routerOptions: {
      ignoreTrailingSlash: true,
      caseSensitive: false,
    },
    disableRequestLogging: config.environment === 'test',
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
      components: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schemas: swaggerSchemas as any,
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [
        {
          bearerAuth: [],
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
    const isDevelopment = config.environment === 'development';

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
