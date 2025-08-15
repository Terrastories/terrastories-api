import * as dotenv from 'dotenv';
import { buildApp } from './app.js';

dotenv.config();

const start = async () => {
  try {
    const app = await buildApp();
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';

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
