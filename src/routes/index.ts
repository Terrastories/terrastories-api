import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.js';
import { authRoutes } from './auth.js';

export interface RegisterRoutesOptions {
  database?: unknown;
}

export async function registerRoutes(
  app: FastifyInstance,
  options?: RegisterRoutesOptions
) {
  await app.register(healthRoute);
  await app.register(authRoutes, { prefix: '/api/v1', ...options });
}
