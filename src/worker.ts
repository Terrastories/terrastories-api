import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import type { PasswordVerifier } from './services/hono-foundation.service.js';

export interface WorkerBindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  PUBLIC_ORIGIN?: string;
  CORS_ORIGINS?: string;
}

/** Auth method remains injectable pending the Workers Free measurements (#194). */
export function createWorker(
  verifier: PasswordVerifier = {
    async verify() {
      throw new Error('Worker verifier not configured');
    },
  }
) {
  const apps = new WeakMap<WorkerBindings, ReturnType<typeof createHonoApp>>();
  const appFor = (env: WorkerBindings) => {
    const cached = apps.get(env);
    if (cached) return cached;
    const client = new Proxy(env.DB, {
      get(target, key, receiver) {
        // App configuration is cached; every DB operation still starts primary-current.
        const primary = env.DB.withSession('first-primary');
        if (key === 'prepare') return primary.prepare.bind(primary);
        if (key === 'batch') return primary.batch.bind(primary);
        return Reflect.get(target, key, receiver);
      },
    });
    const app = createHonoApp({
      repository: new HonoFoundationRepository(drizzle(client)),
      verifier,
      publicOrigin: env.PUBLIC_ORIGIN,
      corsOrigins: env.CORS_ORIGINS?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      storage: {
        async read(key) {
          const object = await env.MEDIA.get(key);
          if (!object) return null;
          const reader = object.body.getReader();
          return new ReadableStream({
            async pull(controller) {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            cancel: (reason) => reader.cancel(reason),
          });
        },
      },
    });
    apps.set(env, app);
    return app;
  };
  return {
    fetch: (request: Request, env: WorkerBindings) =>
      appFor(env).fetch(request),
  };
}
export default createWorker();
