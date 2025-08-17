import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.js';
import { authRoutes } from './auth.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoute);
  await app.register(authRoutes, { prefix: '/api/v1' });
}
