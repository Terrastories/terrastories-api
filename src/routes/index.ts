import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoute);
}
