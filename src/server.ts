import { buildApp } from './app.js';
import { getConfig } from './shared/config/index.js';

const start = async () => {
  try {
    const config = getConfig();
    const app = await buildApp();
    const port = config.server.port;
    const host = config.server.host;

    // Graceful shutdown handling
    const gracefulShutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      try {
        await app.close();
        console.log('Server closed successfully');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    await app.listen({ port, host });

    console.log(`🚀 Server ready at http://localhost:${port}`);
    console.log(`📚 Swagger UI available at http://localhost:${port}/docs`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
};

start();
