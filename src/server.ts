import { buildApp } from './app.js';
import { buildHonoApp } from './hono-app.js';
import { getConfig } from './shared/config/index.js';
import { serve } from '@hono/node-server';

const start = async () => {
  try {
    const config = getConfig();

    // Start Fastify app (V1 routes at /api/v1/*)
    const fastifyApp = await buildApp();
    const port = config.server.port;
    const host = config.server.host;

    // Build Hono app (V2 routes at /v2/*)
    const honoApp = await buildHonoApp();

    // Graceful shutdown handling
    const gracefulShutdown = async (signal: string) => {
      // eslint-disable-next-line no-console
      console.log(`Received ${signal}, shutting down gracefully...`);
      try {
        await fastifyApp.close();
        // eslint-disable-next-line no-console
        console.log('Servers closed successfully');
        process.exit(0);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Start Fastify on main port
    await fastifyApp.listen({ port, host });

    // Start Hono on port + 1 during coexistence phase
    // Both apps share the same database; Hono serves /v2/* routes
    const honoPort = port + 1;
    serve(
      {
        fetch: honoApp.fetch,
        port: honoPort,
        hostname: host,
      },
      (info) => {
        // eslint-disable-next-line no-console
        console.log(`🚀 Hono V2 server ready at http://localhost:${info.port}`);
      }
    );

    // eslint-disable-next-line no-console
    console.log(`🚀 Fastify V1 server ready at http://localhost:${port}`);
    // eslint-disable-next-line no-console
    console.log(`📚 Swagger UI available at http://localhost:${port}/docs`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error starting server:', err);
    process.exit(1);
  }
};

start();
