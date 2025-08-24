import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.js';
import { authRoutes } from './auth.js';
import { fileRoutes } from './files.js';
import { communityRoutes } from './communities.js';
import storiesRoutes from './stories.js';
import { placesRoutes } from './places.js';
import { speakerRoutes } from './speakers.js';

export interface RegisterRoutesOptions {
  database?: unknown;
}

export async function registerRoutes(
  app: FastifyInstance,
  options?: RegisterRoutesOptions
) {
  await app.register(healthRoute);
  await app.register(authRoutes, { prefix: '/api/v1', ...options });
  await app.register(communityRoutes, { prefix: '/api/v1', ...options });
  await app.register(fileRoutes, { prefix: '/api/v1', ...options });
  await app.register(storiesRoutes, { prefix: '/api/v1/stories', ...options });
  await app.register(placesRoutes, { prefix: '/api/v1', ...options });
  await app.register(speakerRoutes, { prefix: '/api/v1', ...options });
}
