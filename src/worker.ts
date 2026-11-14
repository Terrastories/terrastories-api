import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import type { PasswordVerifier } from './services/hono-foundation.service.js';
import {
  validateWorkerV2Runtime,
  V2RuntimeConfigError,
  v2RuntimeModeNotice,
} from './config/v2-runtime.js';

export interface WorkerBindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  /**
   * Runtime mode for the configuration gate (#150). Unset means production —
   * the strictest rules apply; only `development` and `test` relax them.
   */
  ENVIRONMENT?: string;
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
  // Throttle the one-line refusal log per isolate: module state persists for
  // the isolate's lifetime, which is at least as stable a key as the `env`
  // object's identity across requests (PR #229 review).
  let reportedConfigRefusal = false;
  const appFor = (env: WorkerBindings) => {
    const cached = apps.get(env);
    if (cached) return cached;
    // #150: fail closed at initialisation — insecure/default production
    // configuration refuses to serve. Throws before any adapter is built.
    const runtimeConfig = validateWorkerV2Runtime(env);
    // PR #229 review: a relaxed mode that reaches a deployment must be
    // visible — one content-free line naming the mode, once per binding set.
    const modeNotice = v2RuntimeModeNotice(runtimeConfig);
    if (modeNotice) {
      // eslint-disable-next-line no-console -- workerd's only operator channel
      console.warn(modeNotice);
    }
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
      publicOrigin: runtimeConfig.publicOrigin,
      corsOrigins: runtimeConfig.corsOrigins,
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
    fetch: (request: Request, env: WorkerBindings) => {
      try {
        return appFor(env).fetch(request);
      } catch (error) {
        if (!(error instanceof V2RuntimeConfigError)) throw error;
        // The refusal is operational state, not community content: log the
        // setting names once per isolate, then fail closed uniformly with a
        // stable content-free code so the refusal is identifiable from the
        // response alone, where no retained log store exists (PR #229 review).
        if (!reportedConfigRefusal) {
          reportedConfigRefusal = true;
          // eslint-disable-next-line no-console -- workerd's only operator channel
          console.error(error.message);
        }
        return Response.json(
          { error: 'Service unavailable', code: 'config-refused' },
          { status: 503, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    },
  };
}
export default createWorker();
