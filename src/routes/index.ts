import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.js';
import { authRoutes } from './auth.js';
import { fileRoutes } from './files.js';
import { communityRoutes } from './communities.js';
import storiesRoutes from './stories.js';
import { placesRoutes } from './places.js';
import { speakerRoutes } from './speakers.js';
import { publicApiRoutes } from './public-api.js';
import { memberRoutes } from './member/index.js';

export interface RegisterRoutesOptions {
  database?: unknown;
}

export async function registerRoutes(
  app: FastifyInstance,
  options?: RegisterRoutesOptions
) {
  await app.register(healthRoute);

  // Public API routes (no authentication required)
  await app.register(publicApiRoutes, { prefix: '/api', ...options });

  // Authenticated API routes
  await app.register(authRoutes, { prefix: '/api/v1', ...options });
  await app.register(communityRoutes, { prefix: '/api/v1', ...options });
  await app.register(fileRoutes, { prefix: '/api/v1', ...options });
  await app.register(storiesRoutes, { prefix: '/api/v1/stories', ...options });
  await app.register(placesRoutes, { prefix: '/api/v1', ...options });
  await app.register(speakerRoutes, { prefix: '/api/v1', ...options });

  // Member dashboard routes (authenticated member endpoints)
  await app.register(memberRoutes, { prefix: '/api/v1/member', ...options });
}
