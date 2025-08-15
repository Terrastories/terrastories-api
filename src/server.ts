import * as dotenv from 'dotenv';
import { buildApp } from './app.js';

dotenv.config();

const start = async () => {
  try {
    const app = await buildApp();
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });

    console.log(`🚀 Server ready at http://localhost:${port}`);
    console.log(`📚 Swagger UI available at http://localhost:${port}/docs`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
};

start();
