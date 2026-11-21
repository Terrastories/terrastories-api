import type {
  D1Database,
  ExecutionContext,
  R2Bucket,
  R2MultipartUpload,
  R2UploadedPart,
  ScheduledController,
} from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { createHonoApp } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import {
  validStorageKey,
  validSystemStorageKey,
  envFlagEnabled,
  type FoundationStorage,
} from './services/hono-foundation.service.js';
import {
  MediaCleanupCoordinator,
  WORKER_SWEEP_SUBREQUEST_BUDGET,
} from './services/media-cleanup.service.js';
import { WORKER_EXPORT_SWEEP_BATCH_LIMIT } from './shared/export-policy.js';
import {
  validateWorkerV2Runtime,
  V2RuntimeConfigError,
  v2RuntimeModeNotice,
} from './config/v2-runtime.js';
import { CommunitySovereigntyRepository } from './repositories/community-sovereignty.repository.js';
import { CommunityExportRepository } from './repositories/community-export.repository.js';
import { CommunityExportService } from './services/community-export.service.js';
import { runMaintenanceSweeps } from './services/maintenance-sweeps.js';

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
  /**
   * Prelogin HMAC key (SPEC-V2 §7 step 1), supplied with `wrangler secret
   * put` — never a `vars` value. Validated by the runtime gate in
   * production-like modes; prelogin fails closed when absent.
   */
  AUTH_SERVER_SECRET?: string;
  /**
   * Operator-provided installation bootstrap secret (SPEC-V2 §7
   * "Bootstrap and account lifecycle"; PR #252 bot finding 1), supplied with
   * `wrangler secret` put — never a `vars` value. Validated by the runtime gate
   * in production-like modes; an unset value keeps bootstrap fail-closed.
   */
  BOOTSTRAP_SECRET?: string;
  /**
   * Explicit restore hold for the orphan sweeper. `'true'` pauses sweeping;
   * unset/anything else leaves it running. A storage `system/orphan-sweep-hold`
   * marker pauses it independently of this binding.
   */
  ORPHAN_SWEEP_PAUSED?: string;
}

/**
 * The Workers entrypoint. Client-stretched authentication runs entirely in
 * the app (SPEC-V2 §7), so there is no auth method to inject here.
 */
export function createWorker() {
  const apps = new WeakMap<WorkerBindings, ReturnType<typeof createHonoApp>>();
  // Throttle the one-line refusal log per isolate: module state persists for
  // the isolate's lifetime, which is at least as stable a key as the `env`
  // object's identity across requests (PR #229 review).
  let reportedConfigRefusal = false;

  /** R2-backed storage adapter with object listing for the orphan sweeper. */
  const createR2Storage = (bucket: R2Bucket): FoundationStorage => ({
    async read(key, range) {
      const object = range
        ? await bucket.get(key, {
            range: {
              offset: range.start,
              length: range.end - range.start + 1,
            },
          })
        : await bucket.get(key);
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
        await bucket.put(key, body, { httpMetadata });
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
        const ensureMultipartUpload = async () => {
          if (!upload) {
            upload = await bucket.createMultipartUpload(key, {
              httpMetadata,
            });
            await options?.onMultipartUploadCreated?.(upload.uploadId);
          }
          return upload;
        };
        if (options?.useMultipart) {
          await ensureMultipartUpload();
        }
        const flushPart = async (length: number) => {
          const slice = buffer.slice(0, length);
          const activeUpload = await ensureMultipartUpload();
          uploadedParts.push(
            await activeUpload.uploadPart(partNumber++, slice)
          );
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
          await bucket.put(key, buffer.slice(0, buffered), {
            httpMetadata,
          });
        } else if (totalSize === 0 && uploadedParts.length === 0) {
          await (upload as R2MultipartUpload).abort().catch(() => {});
          await bucket.put(key, new Uint8Array(0), { httpMetadata });
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
      await bucket.delete(key);
    },
    async abortMultipartUpload(key, uploadId) {
      if (!validStorageKey(key) || !uploadId) return;
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /no\s*such\s*upload|not\s*found|does\s*not\s*exist|already\s*(completed|aborted)|10024/i.test(
            message
          )
        ) {
          // Upload may already be completed or aborted; treat missing upload idempotently.
          return;
        }
        throw error;
      }
    },
    async list(options) {
      const limit = options?.limit ?? 200;
      // Key-based pagination: the caller walks the prefix by last seen key,
      // never by R2's opaque cursor, so the sweeper can resume where it left
      // off with only the key (which it also persists between runs).
      const result = await bucket.list({
        prefix: options?.prefix,
        startAfter: options?.startAfter,
        limit,
      });
      const entries = result.objects.map((object) => ({
        key: object.key,
        uploaded: object.uploaded,
      }));
      return {
        entries,
        truncated: result.truncated,
        nextStartAfter:
          result.truncated && entries.length > 0
            ? entries[entries.length - 1]!.key
            : undefined,
      };
    },

    async getSystemObject(key) {
      if (!validSystemStorageKey(key)) return null;
      const object = await bucket.get(key);
      if (!object) return null;
      return new Uint8Array(await object.arrayBuffer());
    },

    async putSystemObject(key, bytes) {
      if (!validSystemStorageKey(key)) throw new Error('Invalid system key');
      await bucket.put(key, bytes);
    },
  });

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
      serverSecret: runtimeConfig.serverSecret,
      bootstrapSecret: runtimeConfig.bootstrapSecret,
      publicOrigin: runtimeConfig.publicOrigin,
      corsOrigins: runtimeConfig.corsOrigins,
      // workerd sets `cf-connecting-ip` and a client cannot forge it (finding E).
      isWorkers: true,
      storage: createR2Storage(env.MEDIA),
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
    /**
     * Hourly cron trigger: run the restart-safe orphan sweeper so bytes whose
     * `files` row is gone (failed storage delete, crash between commit and
     * delete) are eventually removed, plus the maintenance sweeps that touch
     * no bytes (audit IP/UA scrub, expired session rows, spent non-blocking
     * throttle rows). The orphan run is bounded by subrequests —
     * WORKER_SWEEP_SUBREQUEST_BUDGET, sized under the Workers Free 50 — so a
     * full keyspace pass takes several hourly runs, tracked by the cursor.
     * Referenced/fresh objects consume only their share of reference-query
     * subrequests, never a delete.
     *
     * Throughput math: one hourly run scans ~6 list pages (~1,200 keys) with
     * zero orphans — ~28,800 keys/day, i.e. even a 100k-key keyspace cycles
     * in under 4 days, inside the 30-day §6.7 bound; an all-orphan backlog
     * clears at ~34 deletes/run (~800/day). The maintenance sweeps add a
     * fixed three statements beyond that budget (one row-capped statement
     * each, MAINTENANCE_SWEEP_ROW_LIMIT rows, three subrequests at most) and
     * are not funded from it; they are not paused by ORPHAN_SWEEP_PAUSED
     * because they delete no bytes — the restore hold covers byte deletion
     * only. A failure is logged content-free rather than swallowed, and one
     * failing maintenance job never blocks the others.
     */
    scheduled: async (
      _controller: ScheduledController,
      env: WorkerBindings,
      ctx: ExecutionContext
    ) => {
      ctx.waitUntil(
        (async () => {
          const client = new Proxy(env.DB, {
            get(target, key, receiver) {
              const primary = env.DB.withSession('first-primary');
              if (key === 'prepare') return primary.prepare.bind(primary);
              if (key === 'batch') return primary.batch.bind(primary);
              return Reflect.get(target, key, receiver);
            },
          });
          const db = drizzle(client);
          const scheduledNow = () =>
            new Date(_controller.scheduledTime || Date.now());
          const r2Storage = createR2Storage(env.MEDIA);
          // The minute tick handles notices and export expiry. Keep the larger
          // orphan/metadata sweep hourly and within its existing budget.
          if (_controller.cron === '* * * * *') {
            try {
              await new CommunitySovereigntyRepository(db).applyDueWithdrawals(
                scheduledNow()
              );
            } catch {
              // eslint-disable-next-line no-console -- content-free operator channel
              console.warn('maintenance: sovereignty notice sweep failed');
            }
            try {
              await new CommunityExportService(
                new CommunityExportRepository(db),
                r2Storage,
                {
                  isWorkers: true,
                  now: scheduledNow,
                }
              ).cleanupExpiredExports({
                limit: WORKER_EXPORT_SWEEP_BATCH_LIMIT,
              });
            } catch {
              // eslint-disable-next-line no-console -- content-free operator channel
              console.warn('maintenance: expired export sweep failed');
            }
            return;
          }
          const cleanup = new MediaCleanupCoordinator(db, r2Storage, {
            now: scheduledNow,
            // Subrequest-budgeted run; the sweeper also honours an
            // ORPHAN_SWEEP_PAUSED binding / `system/orphan-sweep-hold`
            // marker for the restore hold.
            subrequestBudget: WORKER_SWEEP_SUBREQUEST_BUDGET,
            sweepPaused: envFlagEnabled(env.ORPHAN_SWEEP_PAUSED),
          });
          try {
            await cleanup.sweepOrphanObjects();
          } catch {
            // eslint-disable-next-line no-console -- workerd's only operator channel
            console.warn('media cleanup: scheduled orphan sweep failed');
          }
          // Maintenance sweeps: audit IP/UA scrub, expired sessions, spent
          // throttle rows, and expired export artifact cleanup.
          await runMaintenanceSweeps(db, {
            now: scheduledNow,
            storage: r2Storage,
            // The hourly orphan run spends up to 40 subrequests and metadata
            // uses 3. One export costs at most 6 (lookup, claim, abort, two
            // deletes, finalize), keeping the combined invocation below 50.
            // The dedicated minute tick handles the larger export batch.
            exportSweepLimit: 1,
            sovereigntyNotices: false,
          });
        })()
      );
    },
  };
}
export default createWorker();
