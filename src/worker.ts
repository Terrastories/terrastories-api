import { createWorkerErasureRecordStore } from './worker-erasure-record-store.js';
import {
  CommunityErasureService,
  workerErasureD1Budget,
  workerErasureStorageBudget,
} from './services/community-erasure.service.js';
import type {
  D1Database,
  ExecutionContext,
  R2Bucket,
  R2MultipartUpload,
  R2UploadedPart,
  ScheduledController,
} from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { createHonoApp, V2_BASELINE_SECURITY_HEADERS } from './hono-app.js';
import { HonoFoundationRepository } from './repositories/hono-foundation.repository.js';
import {
  validStorageKey,
  validLegacyStorageKey,
  validSystemStorageKey,
  envFlagEnabled,
  erasureFenceKey,
  StorageChecksumMismatchError,
  StorageLengthRequiredError,
  type FoundationStorage,
} from './services/hono-foundation.service.js';
import {
  MediaCleanupCoordinator,
  workerSweepSubrequestBudget,
} from './services/media-cleanup.service.js';
import { workerExportSweepBatchLimit } from './shared/export-policy.js';
import {
  parseWorkersPlan,
  validateWorkerV2Runtime,
  V2RuntimeConfigError,
  v2RuntimeModeNotice,
  type WorkersPlan,
} from './config/v2-runtime.js';
import { CommunitySovereigntyRepository } from './repositories/community-sovereignty.repository.js';
import { CommunityExportRepository } from './repositories/community-export.repository.js';
import { CommunityExportService } from './services/community-export.service.js';
import { runMaintenanceSweeps } from './services/maintenance-sweeps.js';
import {
  createR2DirectUploads,
  r2DirectUploadConfigFrom,
  type R2DirectUploadConfig,
} from './services/direct-upload-r2.js';

export interface WorkerBindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  ERASURE_RECORDS?: R2Bucket;
  /**
   * Runtime mode for the configuration gate (#150). Unset means production —
   * the strictest rules apply; only `development` and `test` relax them.
   */
  ENVIRONMENT?: string;
  /**
   * Optional Workers plan selector (`'free'` default | `'paid'`; #295,
   * docs/WORKERS-PAID-PROFILE.md §3 step 6).
   */
  WORKERS_PLAN?: string;
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
  /**
   * Optional instance-level public Mapbox token (`pk.*`) fallback used on
   * authenticated reads when a community configures no token of its own.
   */
  MAPBOX_ACCESS_TOKEN?: string;
  /**
   * R2 S3 API credentials for presigning direct multipart uploads (#286),
   * scoped to the media bucket and supplied with `wrangler secret put` —
   * never `vars`. `R2_BUCKET_NAME` is the bucket name var. All four unset
   * (or any one missing) keeps the direct-upload routes answering 501.
   */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

const MAX_JOURNAL_ABORT_ATTEMPTS = 5;

/** R2-backed storage adapter with object listing for the orphan sweeper. */
export const createR2Storage = (
  bucket: R2Bucket,
  directUploads: R2DirectUploadConfig | null = null
): FoundationStorage => ({
  nativeStreamPut: true,
  // null: this profile cannot stream parts through the Worker, so without S3
  // credentials the direct-upload routes answer 501 instead of falling back.
  directUploads: directUploads
    ? createR2DirectUploads(bucket, directUploads)
    : null,
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
    const communityId = key.startsWith('communities/')
      ? Number(key.split('/')[1])
      : null;
    const assertWritable = async () => {
      if (
        communityId !== null &&
        (await bucket.head(erasureFenceKey(communityId)))
      )
        throw new Error('Community storage is erasing');
    };
    await assertWritable();
    if (options?.sha256) {
      // Verified single put (#249): R2 checks the SHA-256 outside Worker CPU, so
      // no byte of the body is hashed or parsed in TypeScript. The body streams
      // straight through; a fence set while the put was in flight is detected
      // afterwards and the object removed (the put is atomic, so it either
      // exists before the fence's listing or is deleted here).
      let putBody: Parameters<R2Bucket['put']>[1] = body as Uint8Array;
      if (!(body instanceof Uint8Array)) {
        const FixedLength = (
          globalThis as {
            FixedLengthStream?: new (
              expectedLength: number
            ) => TransformStream<Uint8Array, Uint8Array>;
          }
        ).FixedLengthStream;
        const length = options.contentLength;
        if (
          !FixedLength ||
          length === undefined ||
          !Number.isSafeInteger(length) ||
          length < 0
        ) {
          throw new StorageLengthRequiredError();
        }
        const fixed = new FixedLength(length);
        void body.pipeTo(fixed.writable).catch(() => {});
        putBody = fixed.readable as unknown as Parameters<R2Bucket['put']>[1];
      }
      let stored: { size: number };
      try {
        stored = await bucket.put(key, putBody, {
          httpMetadata,
          sha256: options.sha256,
        });
      } catch (error) {
        if (
          /sha-?256|checksum|digest|10037/i.test(
            error instanceof Error ? error.message : ''
          )
        ) {
          throw new StorageChecksumMismatchError();
        }
        throw error;
      }
      try {
        await assertWritable();
      } catch (error) {
        await bucket.delete(key).catch(() => {});
        throw error;
      }
      return { size: stored.size };
    }
    if (body instanceof Uint8Array && communityId === null) {
      await bucket.put(key, body, { httpMetadata });
      return { size: body.byteLength };
    }
    if (body instanceof Uint8Array) {
      const bytes = body;
      body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    }
    // R2 parts are 5 MiB. Community writes always use abortable multipart;
    // larger streams remain bounded well below Workers Free memory limits.
    const PART_SIZE = 5 * 1024 * 1024;
    const reader = body.getReader();
    const buffer = new Uint8Array(PART_SIZE);
    let buffered = 0;
    let totalSize = 0;
    let upload: R2MultipartUpload | null = null;
    let multipartJournalKey: string | undefined;
    let multipartFinished = false;
    const uploadedParts: R2UploadedPart[] = [];
    let partNumber = 1;
    try {
      const ensureMultipartUpload = async () => {
        if (!upload) {
          upload = await bucket.createMultipartUpload(key, {
            httpMetadata,
          });
          // Persist the upload id before writing any part, including media/import
          // uploads with no database job. Parts cannot be found by object listing.
          multipartJournalKey = `${key.split('/').slice(0, 2).join('/')}/.multipart/${crypto.randomUUID()}.json`;
          await bucket.put(
            multipartJournalKey,
            JSON.stringify({ key, uploadId: upload.uploadId })
          );
          // No bytes precede the journal. If fencing raced upload creation,
          // this check aborts it; otherwise the sweeper can abort by journal.
          await assertWritable();
          await options?.onMultipartUploadCreated?.(upload.uploadId);
        }
        return upload;
      };
      if (options?.useMultipart || communityId !== null) {
        await ensureMultipartUpload();
      }
      const flushPart = async (length: number) => {
        const slice = buffer.slice(0, length);
        const activeUpload = await ensureMultipartUpload();
        uploadedParts.push(await activeUpload.uploadPart(partNumber++, slice));
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
        // Even empty community objects use multipart: a direct put could
        // race an abort and publish after the post-fence empty listing.
        await flushPart(0);
        await (upload as R2MultipartUpload).complete(uploadedParts);
        multipartFinished = true;
      } else {
        if (buffered > 0) {
          await flushPart(buffered);
        }
        await (upload as R2MultipartUpload).complete(uploadedParts);
        multipartFinished = true;
      }
      return { size: totalSize };
    } catch (error) {
      if (upload) {
        try {
          await (upload as R2MultipartUpload).abort();
          multipartFinished = true;
        } catch {
          /* journal remains for retry */
        }
      }
      throw error;
    } finally {
      reader.releaseLock();
      if (multipartFinished && multipartJournalKey)
        await bucket.delete(multipartJournalKey).catch(() => {});
    }
  },
  erasureDeleteCost: 3,
  async fenceCommunity(communityId) {
    await bucket.put(erasureFenceKey(communityId), new Uint8Array(0));
  },
  erasureBatchDeleteCost: (keys) =>
    1 + 2 * keys.filter((key) => key.includes('/.multipart/')).length,
  async deleteMany(keys) {
    if (keys.length > 1000 || keys.some((key) => !validStorageKey(key)))
      throw new Error('Invalid erasure batch');
    for (const key of keys.filter((key) => key.includes('/.multipart/'))) {
      const journal = await bucket.get(key);
      if (!journal) continue;
      const data = await journal.json<{ key: string; uploadId: string }>();
      const prefix = key.split('/').slice(0, 2).join('/') + '/';
      if (
        !validStorageKey(data.key) ||
        !data.key.startsWith(prefix) ||
        typeof data.uploadId !== 'string' ||
        !data.uploadId
      )
        throw new Error('Invalid multipart journal');
      try {
        await bucket.resumeMultipartUpload(data.key, data.uploadId).abort();
      } catch (error) {
        if (
          !/no\s*such\s*upload|not\s*found|does\s*not\s*exist|already\s*(completed|aborted)|10024/i.test(
            error instanceof Error ? error.message : ''
          )
        )
          throw error;
      }
    }
    if (keys.length) await bucket.delete(keys);
  },
  async delete(key) {
    if (!validStorageKey(key) && !validLegacyStorageKey(key)) return;
    if (
      /^(?:communities|users)\/[1-9][0-9]*\/\.multipart\/[^/]+\.json$/.test(key)
    ) {
      const journal = await bucket.get(key);
      if (journal) {
        const data = await journal.json<{ key: string; uploadId: string }>();
        const prefix = key.split('/').slice(0, 2).join('/') + '/';
        if (
          !validStorageKey(data.key) ||
          !data.key.startsWith(prefix) ||
          typeof data.uploadId !== 'string' ||
          !data.uploadId
        )
          throw new Error('Invalid multipart journal');
        try {
          await bucket.resumeMultipartUpload(data.key, data.uploadId).abort();
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (
            !/no\s*such\s*upload|not\s*found|does\s*not\s*exist|already\s*(completed|aborted)|10024/i.test(
              message
            )
          ) {
            // Never forget a journal whose abort keeps failing: R2 may still
            // hold parts that no listing shows. Count the failure, mark the
            // journal abandoned after MAX_JOURNAL_ABORT_ATTEMPTS, and rewrite
            // it (a put refreshes its upload time, so the 24 h sweep grace
            // restarts: a daily retry cap). The bucket lifecycle rule that
            // aborts incomplete multipart uploads is the backstop. The
            // content-free warning and the sweeper's failed count are the
            // operator signal.
            const attempts =
              ((data as { abortAttempts?: number }).abortAttempts ?? 0) + 1;
            const abandoned = attempts >= MAX_JOURNAL_ABORT_ATTEMPTS;
            await bucket
              .put(
                key,
                JSON.stringify({ ...data, abortAttempts: attempts, abandoned })
              )
              .catch(() => {});
            // eslint-disable-next-line no-console -- content-free operator channel
            console.warn(
              abandoned
                ? 'media cleanup: multipart abort abandoned; lifecycle rule is the backstop'
                : 'media cleanup: multipart abort failed; will retry'
            );
            throw error;
          }
        }
      }
    }
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

/** Workers entrypoint; client-stretched authentication runs in the app. */
export function createWorker() {
  const apps = new WeakMap<WorkerBindings, ReturnType<typeof createHonoApp>>();
  let lastApp:
    | { bindings: WorkerBindings; app: ReturnType<typeof createHonoApp> }
    | undefined;
  // Throttle the one-line refusal log per isolate: module state persists for
  // the isolate's lifetime, which is at least as stable a key as the `env`
  // object's identity across requests (PR #229 review).
  let reportedConfigRefusal = false;
  let reportedScheduledPlanWarning = false;

  const appFor = (env: WorkerBindings) => {
    const cached = apps.get(env);
    if (cached) return cached;
    // A fresh env wrapper can still carry exactly the same bindings.
    const keys = Object.keys(env) as (keyof WorkerBindings)[];
    const previous = lastApp;
    if (
      previous &&
      keys.length === Object.keys(previous.bindings).length &&
      keys.every(
        (key) =>
          Object.hasOwn(previous.bindings, key) &&
          env[key] === previous.bindings[key]
      )
    ) {
      apps.set(env, previous.app);
      return previous.app;
    }
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
    // Native D1 prepare/batch always use the primary and ignore bookmarks.
    // A first-primary Sessions API object would only pin its first query.
    const app = createHonoApp({
      repository: new HonoFoundationRepository(drizzle(env.DB)),
      serverSecret: runtimeConfig.serverSecret,
      bootstrapSecret: runtimeConfig.bootstrapSecret,
      requireRecoveryCodes: true,
      publicOrigin: runtimeConfig.publicOrigin,
      corsOrigins: runtimeConfig.corsOrigins,
      // workerd sets `cf-connecting-ip` and a client cannot forge it (finding E).
      isWorkers: true,
      workersPlan: runtimeConfig.workersPlan,
      storage: createR2Storage(env.MEDIA, r2DirectUploadConfigFrom(env)),
      erasureStore: env.ERASURE_RECORDS
        ? createWorkerErasureRecordStore(env.ERASURE_RECORDS)
        : undefined,
      mapboxAccessToken: runtimeConfig.mapboxAccessToken,
      offlineMode: runtimeConfig.environment === 'offline',
    });
    lastApp = { bindings: { ...env }, app };
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
          {
            status: 503,
            // The app (and its header middleware) never started, so the
            // baseline security headers are applied here.
            headers: {
              ...V2_BASELINE_SECURITY_HEADERS,
              'Cache-Control': 'no-store',
            },
          }
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
          let workersPlan: WorkersPlan = 'free';
          try {
            workersPlan = parseWorkersPlan(env.WORKERS_PLAN);
          } catch (error) {
            if (!(error instanceof V2RuntimeConfigError)) throw error;
            if (!reportedScheduledPlanWarning) {
              reportedScheduledPlanWarning = true;
              // eslint-disable-next-line no-console -- workerd's only operator channel
              console.warn(
                'WORKERS_PLAN invalid in scheduled(); falling back to free'
              );
            }
          }
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
          if (_controller.cron === '*/1 * * * *') {
            if (env.ERASURE_RECORDS) {
              try {
                await new CommunityErasureService(
                  new CommunitySovereigntyRepository(db),
                  r2Storage,
                  createWorkerErasureRecordStore(env.ERASURE_RECORDS)
                ).sweep(
                  scheduledNow(),
                  workerErasureStorageBudget(workersPlan),
                  workerErasureD1Budget(workersPlan),
                  workersPlan
                );
              } catch {
                // eslint-disable-next-line no-console -- content-free retry signal
                console.warn('maintenance: community erasure sweep failed');
              }
            }
            return;
          }
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
                  workersPlan,
                  now: scheduledNow,
                }
              ).cleanupExpiredExports({
                limit: workerExportSweepBatchLimit(workersPlan),
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
            subrequestBudget: workerSweepSubrequestBudget(workersPlan),
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
