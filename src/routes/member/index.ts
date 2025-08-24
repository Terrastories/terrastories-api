/**
 * Member Dashboard Routes - Index
 *
 * Main registration file for all authenticated member dashboard endpoints.
 * Provides centralized registration with consistent prefix, middleware, and configuration.
 */

import { FastifyInstance } from 'fastify';
import { memberStoriesRoutes } from './stories.js';
import { memberPlacesRoutes } from './places.js';
import { memberSpeakersRoutes } from './speakers.js';

export interface MemberRoutesOptions {
  database?: unknown;
}

/**
 * Register all member dashboard routes
 * Routes are mounted under /api/v1/member prefix
 */
export async function memberRoutes(
  app: FastifyInstance,
  options?: MemberRoutesOptions
) {
  // Add rate limiting for all member routes
  app.addHook(
    'preHandler',
    app.rateLimit({
      max: 100, // 100 requests per minute for member dashboard
      timeWindow: '1 minute',
    })
  );

  // Register member stories routes at /api/v1/member/stories
  await app.register(memberStoriesRoutes, {
    prefix: '/stories',
    ...options,
  });

  // Register member places routes at /api/v1/member/places
  await app.register(memberPlacesRoutes, {
    prefix: '/places',
    ...options,
  });

  // Register member speakers routes at /api/v1/member/speakers
  await app.register(memberSpeakersRoutes, {
    prefix: '/speakers',
    ...options,
  });
}
