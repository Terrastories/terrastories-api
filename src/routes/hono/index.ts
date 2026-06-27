/**
 * Hono Route Registration
 *
 * Mounts all V2 Hono routes at /v2/* prefix.
 * Coexists with Fastify routes at /api/v1/* during migration.
 */

import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import type { AppEnv } from '../../hono-app.js';
import { healthRoutes } from './health.js';
import { createAuthRoutes } from './auth.js';
import { createThemesRoutes } from './themes.js';
import { createCommunitiesRoutes } from './communities.js';
import { createStoriesRoutes } from './stories.js';
import { createUsersRoutes } from './users.js';
import { createPlacesRoutes } from './places.js';
import { createSpeakersRoutes } from './speakers.js';
import { createPublicApiRoutes } from './public-api.js';
import { createFilesRoutes } from './files.js';
import { createMemberRoutes } from './member/index.js';
import { createSuperAdminRoutes } from './super-admin.js';
import { createDevRoutes } from './dev.js';

export async function registerHonoRoutes(
  app: Hono<AppEnv>,
  database?: Database
): Promise<void> {
  // Health check at /v2/health
  app.route('/v2', healthRoutes);

  // Auth routes at /v2/auth/*
  app.route('/v2', await createAuthRoutes(database));

  // Public API at /v2/api/* (no auth)
  app.route('/v2/api', await createPublicApiRoutes(database));

  // CRUD routes (all require auth via middleware inside each route file)
  app.route('/v2/themes', await createThemesRoutes(database));
  app.route('/v2/places', await createPlacesRoutes(database));
  app.route('/v2/speakers', await createSpeakersRoutes(database));
  app.route('/v2/communities', await createCommunitiesRoutes(database));
  app.route('/v2/stories', await createStoriesRoutes(database));
  app.route('/v2/users', await createUsersRoutes(database));
  app.route('/v2/files', await createFilesRoutes(database));
  app.route('/v2/member', await createMemberRoutes(database));
  app.route('/v2/admin', await createSuperAdminRoutes(database));
  app.route('/v2/dev', await createDevRoutes(database));
}
