/**
 * Hono Route Registration
 *
 * Mounts all V2 Hono routes at /v2/* prefix.
 * Coexists with Fastify routes at /api/v1/* during migration.
 *
 * V2 namespace structure (per spec FR-018):
 *   /v2/health        — Health check
 *   /v2/auth/*        — Authentication
 *   /v2/api/*         — Public API (no auth)
 *   /v2/themes/*      — Themes CRUD
 *   /v2/places/*      — Places CRUD + spatial
 *   /v2/speakers/*    — Speakers CRUD + search
 *   /v2/communities/* — Communities CRUD
 *   /v2/stories/*     — Stories CRUD + relations
 *   /v2/users/*       — Users CRUD + roles
 *   /v2/files/*       — File upload/serve/delete
 *   /v2/member/*      — Member-scoped CRUD
 *   /v2/admin/*       — Super admin operations
 *   /v2/dev/*         — Dev/seed (dev-only)
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

  // Themes routes at /v2/themes/*
  app.route('/v2/themes', createThemesRoutes(database));

  // Places routes at /v2/places/*
  app.route('/v2/places', await createPlacesRoutes(database));

  // Speakers routes at /v2/speakers/*
  app.route('/v2/speakers', await createSpeakersRoutes(database));

  // Communities routes at /v2/communities/*
  app.route('/v2/communities', await createCommunitiesRoutes(database));

  // Stories routes at /v2/stories/*
  app.route('/v2/stories', await createStoriesRoutes(database));

  // Users routes at /v2/users/*
  app.route('/v2/users', await createUsersRoutes(database));

  // Files routes at /v2/files/*
  app.route('/v2/files', await createFilesRoutes(database));

  // Member routes at /v2/member/*
  app.route('/v2/member', await createMemberRoutes(database));

  // Super admin routes at /v2/admin/*
  app.route('/v2/admin', await createSuperAdminRoutes(database));

  // Dev routes at /v2/dev/*
  app.route('/v2/dev', await createDevRoutes(database));
}
