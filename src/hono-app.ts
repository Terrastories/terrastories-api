/**
 * Hono App Builder
 *
 * Creates the Hono application with middleware, error handling,
 * and route registration. Runs on @hono/node-server.
 *
 * Phase 1: coexists with Fastify at /v2/* prefix.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { AppAuthVariables } from './shared/middleware/hono-auth.middleware.js';
import type { Database } from './db/index.js';
import { registerHonoRoutes } from './routes/hono/index.js';

export interface BuildHonoAppOptions {
  database?: unknown;
}

export type AppEnv = { Variables: AppAuthVariables };

export async function buildHonoApp(
  options?: BuildHonoAppOptions
): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use('*', logger());
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
      credentials: true,
    })
  );

  // Not found handler
  app.notFound((c) => {
    return c.json({ error: 'Not found', statusCode: 404 }, 404);
  });

  // Global error handler — matches V1 error envelope
  app.onError((err, c) => {
    console.error('Unhandled error:', err);

    // Zod validation errors
    if (err.name === 'ZodError') {
      return c.json(
        {
          error: 'Request validation failed',
          statusCode: 400,
          issues: (err as any).issues || (err as any).validationContext,
        },
        400
      );
    }

    // HTTP errors with status code
    const status = (err as any).statusCode || (err as any).status;
    if (status && status >= 400 && status < 500) {
      return c.json(
        {
          error: (err as Error).message,
          statusCode: status,
        },
        status
      );
    }

    // Generic 500
    const isDev = process.env.NODE_ENV === 'development';
    return c.json(
      {
        error: isDev ? (err as Error).message : 'Internal Server Error',
        statusCode: 500,
      },
      500
    );
  });

  // Register all Hono routes
  await registerHonoRoutes(app, options?.database as Database | undefined);

  return app;
}
