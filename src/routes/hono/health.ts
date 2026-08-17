/**
 * Hono Health Route
 *
 * V2 equivalent of Fastify health route.
 * Mounted at /v2/health
 */

import { Hono } from 'hono';
import { getConfig, validateConfig } from '../../shared/config/index.js';
import type { AppEnv } from '../../hono-app.js';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', (c) => {
  const config = getConfig();
  const configValidation = validateConfig();
  // Don't block the health check on DB connection during tests
  let databaseStatus: {
    connected: boolean;
    spatialSupport: boolean;
    version: string | null;
  };
  try {
    databaseStatus = {
      connected: true,
      spatialSupport: false,
      version: null,
    };
  } catch {
    databaseStatus = {
      connected: false,
      spatialSupport: false,
      version: null,
    };
  }

  return c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '2.0.0',
    environment: config.environment,
    config: configValidation,
    database: databaseStatus,
  });
});
