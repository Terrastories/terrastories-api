import { FastifyInstance, type RouteOptions } from 'fastify';
import {
  requireV2CommunityContentAccess,
  type AuthenticatedRequest,
} from '../shared/middleware/auth.middleware.js';
import {
  isV2CommunityRole,
  projectCommunityResourceFields,
  type AuthorizationActor,
  type ContentRouteFamily,
  type ProtectedSurface,
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

    scope.addHook('preSerialization', async (request, reply, payload) => {
      if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;

      const authRequest = request as AuthenticatedRequest;
      const user = authRequest.user || authRequest.session?.user;
      if (!user || !isV2CommunityRole(user.role)) return payload;

      const actor: AuthorizationActor = {
        id: user.id,
        role: user.role,
        communityId: user.communityId,
        // #137 owns revalidation of already-issued sessions. This hook only
        // projects responses after the authenticated route guard has succeeded.
        active: true,
      };

      return projectCommunityPayload(family, payload, actor);
    });

    await register(scope);
  });
}

function projectCommunityPayload(
  family: ContentRouteFamily,
  payload: unknown,
  actor: AuthorizationActor
): unknown {
  if (
    !isRecord(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, 'data')
  ) {
    return payload;
  }

  const projectResource = (resource: unknown): unknown => {
    if (!isRecord(resource)) return resource;
    return projectCommunityResourceFields(
      family,
      resource,
      actor,
      actor.communityId
    );
  };

  const data = payload.data;
  return {
    ...payload,
    data: Array.isArray(data)
      ? data.map(projectResource)
      : projectResource(data),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
