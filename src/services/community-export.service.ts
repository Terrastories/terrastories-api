/**
 * Service layer for Slice 13a community export & authenticated single-artifact
 * download + restart-safe per-object expiry cleanup (SPEC-V2 §6.2, §7, #187).
 *
 * Security & sovereignty invariants:
 * - Only `own-admin` (`actor.role === 'admin' && actor.communityId !== null`)
 *   may initiate exports or download artifacts, including when the community is
 *   disabled (§6.2/§7 explicit exception). `super_admin` and non-admin community
 *   roles receive 403.
 * - Tokens are 256-bit random values, stored only as SHA-256 hashes, shown once,
 *   and bound strictly to the requesting admin + community + single artifact.
 * - Expired, missing, malformed, cross-community, or wrong-admin tokens return
 *   uniform 404 `{ error: 'Not found' }`. Expired tokens for the requesting
 *   admin trigger immediate per-object storage cleanup and multipart abort.
 * - Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
 *   `Content-Security-Policy: default-src 'none'; sandbox`, and
 *   `Content-Disposition: attachment`.
 */

import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import {
  validStorageKey,
  type FoundationStorage,
} from './hono-foundation.service.js';
import { CommunityExportRepository } from '../repositories/community-export.repository.js';
import type { ExportJobStatus } from '../db/schema/community_exports.js';
import {
  buildCommunityExportManifest,
  countSnapshotRows,
} from './community-export-manifest.js';
import {
  COMMUNITY_EXPORT_FORMAT_VERSION,
  COMMUNITY_EXPORT_SCHEMA_VERSION,
  EXPORT_GENERATION_STALE_MS,
  EXPORT_RATE_LIMIT_PER_ACCOUNT,
  EXPORT_RATE_LIMIT_PER_COMMUNITY,
  EXPORT_RATE_LIMIT_WINDOW_MS,
  EXPORT_SWEEP_BATCH_LIMIT,
  EXPORT_TOKEN_ENTROPY_BYTES,
  EXPORT_TOKEN_PATTERN,
  EXPORT_TOKEN_TTL_MS,
  EXPORT_EXPIRY_GRACE_MS,
  exportArchivePathForFile,
  exportArtifactStorageKeys,
  exportLimitsForProfile,
  type ExportLimits,
  type ExportRateLimits,
} from '../shared/export-policy.js';
import {
  createDeterministicZipStream,
  ExportLimitExceededError,
} from '../shared/utils/deterministic-zip.js';
import { constantTimeEqual, sha256Hex, toHex } from '../shared/auth-crypto.js';
import {
  parseByteRange,
  toResponseBody,
} from '../shared/utils/media-stream-response.js';
import {
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import { CONFLICT_BODY } from './community-writes.service.js';
import type { CreateCommunityExportResponse } from '../shared/schemas/community-export.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import type { WorkersPlan } from '../config/v2-runtime.js';

export type CommunityExportCreateResult =
  | { status: 201; body: CreateCommunityExportResponse }
  | {
      status: 403 | 404 | 409 | 422 | 503;
      body: V2ErrorResponse;
    }
  | {
      status: 429;
      body: V2ErrorResponse;
      headers: { 'Retry-After': string };
    };

export interface CommunityExportServiceOptions {
  isWorkers?: boolean;
  workersPlan?: WorkersPlan;
  now?: () => Date;
  limits?: Partial<ExportLimits>;
  rateLimits?: Partial<ExportRateLimits>;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
} as const;

function jsonErrorResponse(
  status: 403 | 404 | 500,
  body: V2ErrorResponse
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...SECURITY_HEADERS,
    },
  });
}

function authorizeCommunityAdmin(
  actor: FoundationUser
): { actorId: number; communityId: number } | null {
  if (actor.role !== 'admin' || actor.communityId === null) {
    return null;
  }
  return { actorId: actor.id, communityId: actor.communityId };
}

class ExportWriterFencedError extends Error {}

export class CommunityExportService {
  private readonly isWorkers: boolean;
  private readonly now: () => Date;
  private readonly limits: ExportLimits;
  private readonly rateLimits: ExportRateLimits;

  constructor(
    private readonly repository: CommunityExportRepository,
    private readonly storage: FoundationStorage,
    options: CommunityExportServiceOptions = {}
  ) {
    this.isWorkers = options.isWorkers ?? false;
    this.now = options.now ?? (() => new Date());
    const defaults = exportLimitsForProfile(
      this.isWorkers,
      options.workersPlan
    );
    this.limits = {
      maxRows: options.limits?.maxRows ?? defaults.maxRows,
      maxManifestBytes:
        options.limits?.maxManifestBytes ?? defaults.maxManifestBytes,
      maxFiles: options.limits?.maxFiles ?? defaults.maxFiles,
      maxMediaBytes: options.limits?.maxMediaBytes ?? defaults.maxMediaBytes,
      maxArchiveBytes:
        options.limits?.maxArchiveBytes ?? defaults.maxArchiveBytes,
    };
    this.rateLimits = {
      windowMs: options.rateLimits?.windowMs ?? EXPORT_RATE_LIMIT_WINDOW_MS,
      maxPerCommunity:
        options.rateLimits?.maxPerCommunity ?? EXPORT_RATE_LIMIT_PER_COMMUNITY,
      maxPerAccount:
        options.rateLimits?.maxPerAccount ?? EXPORT_RATE_LIMIT_PER_ACCOUNT,
    };
  }

  async createExport(
    actor: FoundationUser
  ): Promise<CommunityExportCreateResult> {
    const caller = authorizeCommunityAdmin(actor);
    if (!caller) {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (!this.storage.put) {
      return {
        status: 503,
        body: { error: 'Service unavailable', code: 'export_unavailable' },
      };
    }

    // Reclaim expired or crashed stale-generating jobs before reserving.
    await this.cleanupExpiredExports({
      communityId: caller.communityId,
      limit: 10,
    }).catch(() => {});

    const requestTime = this.now();
    const nowMs = requestTime.getTime();
    const jobId = globalThis.crypto.randomUUID();
    const { manifestStorageKey, zipStorageKey } = exportArtifactStorageKeys(
      caller.communityId,
      jobId
    );

    const reserved = await this.repository.reserveExportJob({
      jobId,
      communityId: caller.communityId,
      requestedBy: caller.actorId,
      manifestStorageKey,
      zipStorageKey,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + EXPORT_TOKEN_TTL_MS,
      windowStartMs: nowMs - this.rateLimits.windowMs,
      windowMs: this.rateLimits.windowMs,
      maxPerCommunity: this.rateLimits.maxPerCommunity,
      maxPerAccount: this.rateLimits.maxPerAccount,
      now: requestTime,
    });

    if (reserved.status === 'not_found') {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (reserved.status === 'in_progress') {
      return {
        status: 409,
        body: {
          error: 'Export already in progress',
          code: 'export_in_progress',
        },
      };
    }
    if (reserved.status === 'rate_limited') {
      return {
        status: 429,
        body: {
          error: 'Export rate limit exceeded',
          code: 'export_rate_limited',
        },
        headers: { 'Retry-After': String(reserved.retryAfterSeconds) },
      };
    }

    let activeUploadId: string | null = null;

    try {
      const snapshot = await this.repository.readCommunityExportSnapshot(
        caller.communityId,
        {
          maxRows: this.isWorkers ? this.limits.maxRows : undefined,
          maxBytes: this.limits.maxManifestBytes,
        }
      );
      if (!snapshot) {
        throw new Error('Community missing during export snapshot');
      }

      const rowCount = countSnapshotRows(snapshot);
      if (rowCount > this.limits.maxRows) {
        throw new ExportLimitExceededError(
          'maxRows',
          'Export row count exceeds Workers Free limit'
        );
      }
      if (snapshot.files.length > this.limits.maxFiles) {
        throw new ExportLimitExceededError(
          'maxFiles',
          'Export file count exceeds Workers Free limit'
        );
      }
      const declaredMediaBytes = snapshot.files.reduce(
        (sum, file) =>
          sum +
          (Number.isSafeInteger(file.byteSize) && file.byteSize > 0
            ? file.byteSize
            : 0),
        0
      );
      if (declaredMediaBytes > this.limits.maxMediaBytes) {
        throw new ExportLimitExceededError(
          'maxMediaBytes',
          'Export media bytes exceed Workers Free limit'
        );
      }

      const zipEntries = snapshot.files.map((file) => ({
        id: file.id,
        storageKey: file.storageKey,
        archivePath: exportArchivePathForFile(file.id),
        expectedByteSize: file.byteSize,
        expectedChecksum: file.checksum,
        read: async () => {
          if (
            !validStorageKey(file.storageKey) ||
            !file.storageKey.startsWith(`communities/${caller.communityId}/`)
          ) {
            return null;
          }
          const stored = await this.storage.read(file.storageKey);
          return stored ? stored.body : null;
        },
      }));

      const { stream: zipStream, summary: zipSummaryPromise } =
        createDeterministicZipStream(zipEntries, {
          maxTotalMediaBytes: this.limits.maxMediaBytes,
          maxArchiveBytes: this.limits.maxArchiveBytes,
        });

      await this.storage.put(zipStorageKey, zipStream, {
        contentType: 'application/zip',
        useMultipart: this.isWorkers,
        onMultipartUploadCreated: async (uploadId) => {
          activeUploadId = uploadId;
          if (!(await this.repository.recordZipUploadId(jobId, uploadId))) {
            throw new ExportWriterFencedError();
          }
        },
      });
      activeUploadId = null;

      const zipSummary = await zipSummaryPromise;
      const manifestBuilt = await buildCommunityExportManifest(
        snapshot,
        zipSummary.entries,
        {
          checksum: zipSummary.archiveChecksum,
          byteSize: zipSummary.archiveByteSize,
          fileCount: zipSummary.entries.length,
        },
        Math.min(this.limits.maxManifestBytes, this.limits.maxArchiveBytes)
      );

      if (manifestBuilt.byteSize > this.limits.maxArchiveBytes) {
        throw new ExportLimitExceededError(
          'maxArchiveBytes',
          'Export manifest exceeds archive size limit'
        );
      }

      await this.storage.put(manifestStorageKey, manifestBuilt.bytes, {
        contentType: 'application/json; charset=utf-8',
      });

      const manifestToken = toHex(
        globalThis.crypto.getRandomValues(
          new Uint8Array(EXPORT_TOKEN_ENTROPY_BYTES)
        )
      );
      const zipToken = toHex(
        globalThis.crypto.getRandomValues(
          new Uint8Array(EXPORT_TOKEN_ENTROPY_BYTES)
        )
      );
      const [manifestTokenHash, zipTokenHash] = await Promise.all([
        sha256Hex(manifestToken),
        sha256Hex(zipToken),
      ]);

      const completedAt = this.now();
      const completedAtMs = completedAt.getTime();
      const expiresAtMs = completedAtMs + EXPORT_TOKEN_TTL_MS;

      const completed = await this.repository.completeExportJob({
        jobId,
        communityId: caller.communityId,
        requestedBy: caller.actorId,
        manifestByteSize: manifestBuilt.byteSize,
        manifestChecksum: manifestBuilt.checksum,
        zipByteSize: zipSummary.archiveByteSize,
        zipChecksum: zipSummary.archiveChecksum,
        manifestTokenHash,
        zipTokenHash,
        completedAtMs,
        expiresAtMs,
        now: completedAt,
      });

      if (!completed) {
        throw new ExportWriterFencedError();
      }

      if (!this.isWorkers) this.scheduleExpiry(caller.communityId, expiresAtMs);

      return {
        status: 201,
        body: {
          data: {
            exportId: jobId,
            exportFormatVersion: COMMUNITY_EXPORT_FORMAT_VERSION,
            schemaVersion: COMMUNITY_EXPORT_SCHEMA_VERSION,
            createdAt: completedAt.toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
            artifacts: {
              manifest: {
                token: manifestToken,
                downloadPath: `/v2/community/export/download/${manifestToken}`,
                contentType: 'application/json; charset=utf-8',
                byteSize: manifestBuilt.byteSize,
                checksum: manifestBuilt.checksum,
              },
              mediaZip: {
                token: zipToken,
                downloadPath: `/v2/community/export/download/${zipToken}`,
                contentType: 'application/zip',
                byteSize: zipSummary.archiveByteSize,
                checksum: zipSummary.archiveChecksum,
                fileCount: zipSummary.entries.length,
              },
            },
          },
        },
      };
    } catch (error) {
      let abortFailed = false;
      let allCleaned = true;
      if (activeUploadId) {
        if (this.storage.abortMultipartUpload) {
          try {
            await this.storage.abortMultipartUpload(
              zipStorageKey,
              activeUploadId
            );
          } catch {
            abortFailed = true;
            allCleaned = false;
          }
        } else {
          abortFailed = true;
          allCleaned = false;
        }
      }
      // A put may have persisted bytes before throwing. Delete both keys even
      // when no successful put was observed, and persist every deletion failure.
      for (const key of [zipStorageKey, manifestStorageKey]) {
        if (!(await this.deleteObjectBestEffort(key))) allCleaned = false;
      }

      const failTime = this.now();
      await this.repository
        .failExportJob({
          jobId,
          communityId: caller.communityId,
          requestedBy: caller.actorId,
          cleanedUpAtMs: allCleaned ? failTime.getTime() : null,
          clearUploadId: !abortFailed,
          persistUploadId: abortFailed ? activeUploadId : null,
          now: failTime,
        })
        .catch(() => {});

      if (error instanceof ExportWriterFencedError) {
        return { status: 409, body: CONFLICT_BODY };
      }
      if (error instanceof ExportLimitExceededError) {
        return {
          status: 422,
          body: {
            error: this.isWorkers
              ? `Export exceeds Workers Free ${error.limitName} limit; run export from a self-hosted or field-kit deployment profile`
              : `Export exceeds ${error.limitName} archive limit`,
            code: 'export_limit_exceeded',
          },
        };
      }
      return {
        status: 503,
        body: { error: 'Service unavailable', code: 'export_failed' },
      };
    }
  }

  async downloadExportArtifact(
    actor: FoundationUser,
    rawToken: string,
    rangeHeader?: string
  ): Promise<Response> {
    const caller = authorizeCommunityAdmin(actor);
    if (!caller) {
      return jsonErrorResponse(403, FORBIDDEN_BODY);
    }

    await this.cleanupExpiredExports({ communityId: caller.communityId }).catch(
      () => {}
    );

    if (!EXPORT_TOKEN_PATTERN.test(rawToken)) {
      return jsonErrorResponse(404, NOT_FOUND_BODY);
    }

    const tokenHash = await sha256Hex(rawToken);
    const record = await this.repository.findTokenWithJobByHash(tokenHash);
    if (
      !record ||
      !constantTimeEqual(record.tokenHash, tokenHash) ||
      record.communityId !== caller.communityId ||
      record.requestedBy !== caller.actorId
    ) {
      return jsonErrorResponse(404, NOT_FOUND_BODY);
    }

    const now = this.now();
    const nowMs = now.getTime();
    const expired =
      nowMs >= record.tokenExpiresAt || nowMs >= record.jobExpiresAt;

    if (
      expired ||
      record.jobStatus !== 'ready' ||
      record.cleanedUpAt !== null
    ) {
      if (record.cleanedUpAt === null) {
        await this.cleanupSingleJob(
          {
            id: record.jobId,
            status: record.jobStatus,
          },
          nowMs
        ).catch(() => {});
      }
      await this.repository
        .recordDownloadFailureAudit({
          communityId: caller.communityId,
          actorId: caller.actorId,
          jobId: record.jobId,
          now,
        })
        .catch(() => {});
      return jsonErrorResponse(404, NOT_FOUND_BODY);
    }

    const isManifest = record.artifact === 'manifest';
    const storageKey = isManifest
      ? record.manifestStorageKey
      : record.zipStorageKey;
    const totalLength = isManifest
      ? record.manifestByteSize
      : record.zipByteSize;
    const contentType = isManifest
      ? 'application/json; charset=utf-8'
      : 'application/zip';
    const filename = isManifest
      ? 'community-export-manifest.json'
      : 'community-export-media.zip';

    if (
      !storageKey ||
      !validStorageKey(storageKey) ||
      !storageKey.startsWith(`communities/${caller.communityId}/`) ||
      totalLength === null ||
      !Number.isSafeInteger(totalLength) ||
      totalLength < 0
    ) {
      await this.repository
        .recordDownloadFailureAudit({
          communityId: caller.communityId,
          actorId: caller.actorId,
          jobId: record.jobId,
          now,
        })
        .catch(() => {});
      return jsonErrorResponse(404, NOT_FOUND_BODY);
    }

    const range = parseByteRange(rangeHeader, totalLength);
    if (range.kind === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          ...SECURITY_HEADERS,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${totalLength}`,
        },
      });
    }

    const stored =
      range.kind === 'slice'
        ? await this.storage.read(storageKey, {
            start: range.start,
            end: range.end,
          })
        : await this.storage.read(storageKey);

    if (!stored) {
      await this.repository
        .recordDownloadFailureAudit({
          communityId: caller.communityId,
          actorId: caller.actorId,
          jobId: record.jobId,
          now,
        })
        .catch(() => {});
      return jsonErrorResponse(404, NOT_FOUND_BODY);
    }

    if (!Number.isSafeInteger(stored.size) || stored.size !== totalLength) {
      if (stored.body instanceof ReadableStream) {
        await stored.body.cancel().catch(() => {});
      }
      return jsonErrorResponse(500, INTERNAL_ERROR_BODY);
    }

    try {
      await this.repository.recordTokenDownload({
        tokenId: record.tokenId,
        jobId: record.jobId,
        communityId: caller.communityId,
        actorId: caller.actorId,
        artifact: record.artifact,
        now,
      });
    } catch (error) {
      if (stored.body instanceof ReadableStream) {
        await stored.body.cancel().catch(() => {});
      }
      throw error;
    }

    if (range.kind === 'slice') {
      const contentLength = range.end - range.start + 1;
      return new Response(toResponseBody(stored.body), {
        status: 206,
        headers: {
          ...SECURITY_HEADERS,
          'Accept-Ranges': 'bytes',
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Range': `bytes ${range.start}-${range.end}/${stored.size}`,
          'Content-Length': String(contentLength),
        },
      });
    }

    return new Response(toResponseBody(stored.body), {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(stored.size),
      },
    });
  }

  /**
   * Restart-safe per-object expiry & failed/stale-job cleanup (§7):
   * aborts any recorded multipart upload id and deletes generated manifest/ZIP
   * objects. Leaves `cleanedUpAt = null` whenever any storage operation fails
   * so the next sweep retries.
   */
  async cleanupExpiredExports(
    opts: { communityId?: number; limit?: number } = {}
  ): Promise<{ cleanedCount: number; failedCount: number }> {
    const nowMs = this.now().getTime();
    const staleBeforeMs = nowMs - EXPORT_GENERATION_STALE_MS;
    const jobs = await this.repository.findJobsNeedingCleanup({
      nowMs,
      staleBeforeMs,
      communityId: opts.communityId,
      limit: opts.limit ?? EXPORT_SWEEP_BATCH_LIMIT,
    });

    let cleanedCount = 0;
    let failedCount = 0;
    for (const job of jobs) {
      const outcome = await this.cleanupSingleJob(job, nowMs);
      if (outcome === 'cleaned') cleanedCount += 1;
      else if (outcome === 'failed') failedCount += 1;
    }
    return { cleanedCount, failedCount };
  }

  private async cleanupSingleJob(
    job: {
      id: string;
      status: ExportJobStatus;
    },
    nowMs: number
  ): Promise<'cleaned' | 'failed' | 'skipped'> {
    const claim = await this.repository.claimJobForCleanup({
      jobId: job.id,
      status: job.status,
      nowMs,
      staleBeforeMs: nowMs - EXPORT_GENERATION_STALE_MS,
    });
    if (!claim) {
      return 'skipped';
    }

    let allSucceeded = true;
    let abortSucceeded = true;

    if (claim.zipUploadId && claim.zipStorageKey) {
      if (this.storage.abortMultipartUpload) {
        try {
          await this.storage.abortMultipartUpload(
            claim.zipStorageKey,
            claim.zipUploadId
          );
        } catch {
          allSucceeded = false;
          abortSucceeded = false;
        }
      } else {
        allSucceeded = false;
        abortSucceeded = false;
      }
    }

    if (claim.manifestStorageKey && validStorageKey(claim.manifestStorageKey)) {
      const ok = await this.deleteObjectBestEffort(claim.manifestStorageKey);
      if (!ok) allSucceeded = false;
    }
    if (claim.zipStorageKey && validStorageKey(claim.zipStorageKey)) {
      const ok = await this.deleteObjectBestEffort(claim.zipStorageKey);
      if (!ok) allSucceeded = false;
    }

    const markResult = await this.repository.markJobCleanedUp({
      jobId: job.id,
      nextStatus: claim.status,
      expectedCompletedAt: claim.completedAt,
      cleanedUpAtMs: allSucceeded ? nowMs : null,
      clearUploadId: abortSucceeded,
    });
    if (!allSucceeded) return 'failed';
    return markResult.updated ? 'cleaned' : 'skipped';
  }

  private scheduleExpiry(communityId: number, expiresAtMs: number): void {
    const timer = setTimeout(
      async () => {
        try {
          const result = await this.cleanupExpiredExports({ communityId });
          if (result.failedCount > 0) {
            this.scheduleExpiry(
              communityId,
              this.now().getTime() + EXPORT_EXPIRY_GRACE_MS
            );
          }
        } catch {
          this.scheduleExpiry(
            communityId,
            this.now().getTime() + EXPORT_EXPIRY_GRACE_MS
          );
        }
      },
      Math.max(0, expiresAtMs - this.now().getTime())
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private async deleteObjectBestEffort(storageKey: string): Promise<boolean> {
    if (!this.storage.delete) return false;
    try {
      await this.storage.delete(storageKey);
      return true;
    } catch {
      return false;
    }
  }
}
