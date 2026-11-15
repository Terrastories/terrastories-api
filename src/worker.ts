import type {
  D1Database,
  R2Bucket,
  R2MultipartUpload,
  R2UploadedPart,
} from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import {
  validStorageKey,
  type PasswordVerifier,
} from './services/hono-foundation.service.js';
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
        async read(key, range) {
          const object = range
            ? await env.MEDIA.get(key, {
                range: {
                  offset: range.start,
                  length: range.end - range.start + 1,
                },
              })
            : await env.MEDIA.get(key);
          if (!object) return null;
          const reader = object.body.getReader();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            cancel: (reason) => reader.cancel(reason),
          });
          // workerd strips Content-Length on untyped ReadableStreams; FixedLengthStream
          // preserves exact Content-Length on 200 and 206 without buffering.
          const FixedLength = (
            globalThis as {
              FixedLengthStream?: new (
                expectedLength: number
              ) => TransformStream<Uint8Array, Uint8Array>;
            }
          ).FixedLengthStream;
          const expectedLength = range
            ? Math.min(
                range.end - range.start + 1,
                Math.max(0, object.size - range.start)
              )
            : object.size;
          if (
            FixedLength &&
            Number.isSafeInteger(expectedLength) &&
            expectedLength >= 0
          ) {
            const fixed = new FixedLength(expectedLength);
            void stream.pipeTo(fixed.writable).catch(() => {});
            return { body: fixed.readable, size: object.size };
          }
          return { body: stream, size: object.size };
        },
        async put(key, body, options) {
          if (!validStorageKey(key)) {
            throw new Error('Invalid storage key');
          }
          const httpMetadata = options?.contentType
            ? { contentType: options.contentType }
            : undefined;
          if (body instanceof Uint8Array) {
            await env.MEDIA.put(key, body, { httpMetadata });
            return { size: body.byteLength };
          }
          // R2 minimum part size for multipart uploads is 5 MiB; uploads <= 5 MiB
          // complete with a single put, while larger streams use R2 multipart parts
          // so isolate memory remains bounded well below Workers Free limits.
          const PART_SIZE = 5 * 1024 * 1024;
          const reader = body.getReader();
          const buffer = new Uint8Array(PART_SIZE);
          let buffered = 0;
          let totalSize = 0;
          let upload: R2MultipartUpload | null = null;
          const uploadedParts: R2UploadedPart[] = [];
          let partNumber = 1;
          try {
            const flushPart = async (length: number) => {
              const slice = buffer.slice(0, length);
              if (!upload) {
                upload = await env.MEDIA.createMultipartUpload(key, {
                  httpMetadata,
                });
              }
              uploadedParts.push(await upload.uploadPart(partNumber++, slice));
              buffered = 0;
            };
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;
              let offset = 0;
              while (offset < value.byteLength) {
                const space = PART_SIZE - buffered;
                const copyLen = Math.min(space, value.byteLength - offset);
                buffer.set(value.subarray(offset, offset + copyLen), buffered);
                buffered += copyLen;
                offset += copyLen;
                totalSize += copyLen;
                if (buffered === PART_SIZE) {
                  await flushPart(PART_SIZE);
                }
              }
            }
            if (!upload) {
              await env.MEDIA.put(key, buffer.slice(0, buffered), {
                httpMetadata,
              });
            } else {
              if (buffered > 0) {
                await flushPart(buffered);
              }
              await (upload as R2MultipartUpload).complete(uploadedParts);
            }
            return { size: totalSize };
          } catch (error) {
            if (upload) {
              await (upload as R2MultipartUpload).abort().catch(() => {});
            }
            throw error;
          } finally {
            reader.releaseLock();
          }
        },
        async delete(key) {
          if (!validStorageKey(key)) return;
          await env.MEDIA.delete(key);
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
