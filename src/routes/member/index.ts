/**
 * Member Dashboard Routes
 *
 * Authenticated CRUD endpoints for member story, place, and speaker management
 * with comprehensive cultural protocols, community data sovereignty, and role-based access control.
 */

import { FastifyInstance } from 'fastify';
import { memberStoriesRoutes } from './stories.js';
import { memberPlacesRoutes } from './places.js';
import { memberSpeakersRoutes } from './speakers.js';
import { getDb, type Database } from '../../db/index.js';

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
  const db = (options?.database as Database) || (await getDb());

  // Register individual member route modules with proper prefixes
  await app.register(memberStoriesRoutes, { database: db, prefix: '/stories' });
  await app.register(memberPlacesRoutes, { database: db, prefix: '/places' });
  await app.register(memberSpeakersRoutes, {
    database: db,
    prefix: '/speakers',
  });
}
