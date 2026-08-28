import { FastifyInstance, type RouteOptions } from 'fastify';
import { requireV2CommunityContentAccess } from '../shared/middleware/auth.middleware.js';
import type {
  ContentRouteFamily,
  ProtectedSurface,
} from '../shared/authorization/sovereignty-policy.js';
import { healthRoute } from './health.js';
import { authRoutes } from './auth.js';
import { fileRoutes } from './files.js';
import { communityRoutes } from './communities.js';
import storiesRoutes from './stories.js';
import { placesRoutes } from './places.js';
import { speakerRoutes } from './speakers.js';
import { themesRoutes } from './themes.js';
import { userRoutes } from './users.js';
import { publicApiRoutes } from './public-api.js';
import { memberRoutes } from './member/index.js';
import { superAdminRoutes } from './super_admin.js';
import { devRoutes } from './dev.js';

export interface RegisterRoutesOptions {
  database?: unknown;
}

async function registerCommunityContentRoutes(
  app: FastifyInstance,
  family: ContentRouteFamily,
  register: (scope: FastifyInstance) => Promise<unknown>
) {
  await app.register(async (scope) => {
    scope.addHook('onRoute', (routeOptions: RouteOptions) => {
      const existing = routeOptions.preHandler;
      const preHandlers = existing
        ? Array.isArray(existing)
          ? existing
          : [existing]
        : [];
      routeOptions.preHandler = [
        ...preHandlers,
        requireV2CommunityContentAccess(
          family,
          classifyProtectedSurface(routeOptions, family)
        ),
      ];
    });

    await register(scope);
  });
}

function classifyProtectedSurface(
  routeOptions: RouteOptions,
  family: ContentRouteFamily
): ProtectedSurface {
  const url = routeOptions.url;
  const methods = Array.isArray(routeOptions.method)
    ? routeOptions.method
    : [routeOptions.method];

  if (family === 'files') return 'file';
  if (url.includes('/stats')) return 'stats';
  if (
    url.includes('/search') ||
    url.includes('/near') ||
    url.includes('/bounds')
  ) {
    return 'search';
  }
  if (
    methods.every((method) => method === 'GET') &&
    !url.includes(':') &&
    !url.includes('*')
  ) {
    return 'list';
  }
  return 'crud';
}

export async function registerRoutes(
  app: FastifyInstance,
  options?: RegisterRoutesOptions
) {
  const opts = options || {};

  // Health check route (no authentication required) - at root level for monitoring
  await app.register(healthRoute, opts);

  // Development routes (no authentication required, development only)
  await app.register(devRoutes, opts);

  // Public API routes (no authentication required)
  await app.register(publicApiRoutes, { prefix: '/api', ...opts });

  // Authenticated API routes
  await app.register(authRoutes, { prefix: '/api/v1', ...opts });
  await app.register(communityRoutes, { prefix: '/api/v1', ...opts });
  await registerCommunityContentRoutes(app, 'files', async (scope) => {
    await scope.register(fileRoutes, { prefix: '/api/v1/files', ...opts });
  });
  await registerCommunityContentRoutes(app, 'stories', async (scope) => {
    await scope.register(storiesRoutes, { prefix: '/api/v1/stories', ...opts });
  });
  await registerCommunityContentRoutes(app, 'places', async (scope) => {
    await scope.register(placesRoutes, { prefix: '/api/v1', ...opts });
  });
  await registerCommunityContentRoutes(app, 'speakers', async (scope) => {
    await scope.register(speakerRoutes, { prefix: '/api/v1', ...opts });
  });
  await registerCommunityContentRoutes(app, 'themes', async (scope) => {
    await scope.register(themesRoutes, { prefix: '/api/v1/themes', ...opts });
  });
  await app.register(userRoutes, { prefix: '/api/v1/users', ...opts });

  // Member dashboard routes (authenticated member endpoints)
  await app.register(memberRoutes, { prefix: '/api/v1/member', ...opts });

  // Super admin routes (system-level administrative endpoints)
  await app.register(superAdminRoutes, {
    prefix: '/api/v1/super_admin',
    ...opts,
  });
}
