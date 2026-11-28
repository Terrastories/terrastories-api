/**
 * Direct multipart media upload (#286, SPEC-V2 §6.7): create a session, accept
 * or presign parts, complete into a `File` row, or abort.
 *
 * Authorization, staging key scheme, type/extension rules, the §6.7 reuse rule
 * and the content-free audit are the same as `POST /v2/media`. Bytes are
 * staged under the tenant key before any row exists; every failure path
 * removes the staged object, and anything a crash leaves behind (journal,
 * incomplete multipart, orphan object) is reclaimed by the restart-safe
 * orphan sweep after its grace window.
 */

import type { z } from 'zod';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type { MediaWritesRepository } from '../repositories/media-writes.repository.js';
import {
  CompleteDirectUploadRequestSchema,
  CreateDirectUploadRequestSchema,
  DirectUploadPartResponseSchema,
  DirectUploadSessionResponseSchema,
} from '../shared/schemas/media-uploads-v2.js';
import {
  DIRECT_UPLOAD_MAX_PART_BYTES,
  DIRECT_UPLOAD_MIN_PART_BYTES,
  MAGIC_SNIFF_BYTES,
  MediaUploadResponseSchema,
  directUploadMaxBytes,
  validateDeclaredMediaType,
  validateMediaHeaderBytes,
} from '../shared/schemas/media-v2.js';
import {
  makeValidationErrorBody,
  zodErrorToValidationFields,
} from '../shared/schemas/community-writes.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import {
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
} from './public-communities.service.js';
import { CONFLICT_BODY } from './community-writes.service.js';
import type { FoundationStorage } from './hono-foundation.service.js';
import type { MediaCleanupCoordinator } from './media-cleanup.service.js';
import {
  ReusedMediaRejectionError,
  type MediaWriteResult,
  type MediaWritesService,
} from './media-writes.service.js';
import { createStorageDirectUploads } from './direct-upload-storage.js';
import {
  DirectUploadError,
  DIRECT_UPLOAD_COMPLETE_GRACE_SECONDS,
  DIRECT_UPLOAD_MAX_LIFETIME_SECONDS,
  directUploadPartSize,
  hexToBase64,
  type DirectUploadAdapter,
  type DirectUploadSession,
} from './direct-upload.types.js';

/** Presigned part URLs and the session itself expire together. */
export const DIRECT_UPLOAD_TTL_SECONDS = 2 * 60 * 60;

export type DirectUploadResult<T> =
  | MediaWriteResult<T>
  | { status: 410 | 501; body: V2ErrorResponse }
  | {
      status: 503;
      body: V2ErrorResponse;
      headers: { 'Retry-After': string };
    };

const NOT_CONFIGURED_BODY: V2ErrorResponse = Object.freeze({
  error: 'Direct upload is not available on this deployment',
});
const EXPIRED_BODY: V2ErrorResponse = Object.freeze({
  error: 'Upload session expired',
});
/** R2 assembled the object but the winner's `files` row is not visible yet. */
const COMPLETION_PENDING_BODY: V2ErrorResponse = Object.freeze({
  error: 'upload_completion_pending',
});

/**
 * A racing R2 completion reports "already completed/not found" before the
 * winner's `files` row commits. Re-read that row for a short bounded window
 * instead of turning the loser's race into a bad-parts 400.
 */
const COMPLETION_RACE_WAIT_MS = 2_000;
const COMPLETION_RACE_POLL_MS = 25;
/**
 * Cap the re-reads as well as the elapsed time: Workers Free allows 50 D1
 * queries per invocation, so a fast 2 s loop could exhaust the request budget.
 */
const COMPLETION_RACE_MAX_LOOKUPS = 20;
const COMPLETION_RACE_RETRY_AFTER_SECONDS = 2;

const DIRECT_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isDirectUploadId = (value: string): boolean =>
  DIRECT_UPLOAD_ID_PATTERN.test(value);

/** Stable, distinct File id for replay lookup after the journal is removed. */
export async function deriveDirectUploadFileId(
  uploadId: string
): Promise<string> {
  const input = new TextEncoder().encode(
    `terrastories:direct-upload-file:v1:${uploadId}`
  );
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  // Name-derived UUID stamped as version 5 (RFC 9562 variant bits), so every
  // existing v1-5 UUID check (e.g. CSV import media ids) accepts it.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const tenantPrefixOf = (actor: FoundationUser): string =>
  actor.communityId !== null
    ? `communities/${actor.communityId}`
    : `users/${actor.id}`;

export class DirectUploadService {
  private readonly adapter: DirectUploadAdapter | null;

  constructor(
    private readonly repository: MediaWritesRepository,
    private readonly storage: FoundationStorage,
    private readonly cleanup: MediaCleanupCoordinator,
    private readonly media: MediaWritesService,
    private readonly now: () => Date = () => new Date()
  ) {
    // `null` states the profile cannot offer direct upload (Workers without
    // R2 S3 credentials); `undefined` means "stream parts into this storage".
    this.adapter =
      storage.directUploads === undefined
        ? createStorageDirectUploads(storage)
        : storage.directUploads;
  }

  private audit(
    actor: FoundationUser,
    action: string,
    resourceId: string,
    outcome: 'success' | 'denied'
  ) {
    return this.media.auditDecision({
      communityId: actor.communityId,
      actorId: actor.id,
      action,
      resourceIds: [resourceId],
      outcome,
    });
  }

  /** Session owned by this actor (or an admin of the same community), else null. */
  private async resolveSession(
    actor: FoundationUser,
    rawId: string
  ): Promise<DirectUploadSession | null> {
    if (!this.adapter) return null;
    if (!isDirectUploadId(rawId)) return null;
    const session = await this.adapter.load(tenantPrefixOf(actor), rawId);
    if (!session) return null;
    const ownsIt = session.actorId === actor.id;
    const adminOfCommunity =
      actor.role === 'admin' &&
      actor.communityId !== null &&
      session.communityId === actor.communityId;
    return ownsIt || adminOfCommunity ? session : null;
  }

  async createUpload(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<
    DirectUploadResult<z.infer<typeof DirectUploadSessionResponseSchema>>
  > {
    if (!this.adapter) return { status: 501, body: NOT_CONFIGURED_BODY };
    const gate = await this.media.uploadGate(actor);
    if (gate) return gate;

    const parsed = CreateDirectUploadRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }
    const request = parsed.data;
    const bindingFields: Record<string, string> = {};
    if (request.role !== undefined) bindingFields.role = request.role;
    if (request.ownerType !== undefined)
      bindingFields.ownerType = request.ownerType;
    if (request.ownerId !== undefined)
      bindingFields.ownerId = String(request.ownerId);
    if (request.metadata !== undefined)
      bindingFields.metadata = JSON.stringify(request.metadata);
    const binding = this.media.parseUploadBindingFields(
      actor,
      new Map(Object.entries(bindingFields))
    );
    if (!binding.ok) {
      if (binding.status === 403) {
        await this.audit(actor, 'media.upload', String(actor.id), 'denied');
      }
      return { status: binding.status, body: binding.body };
    }

    const type = validateDeclaredMediaType({
      declaredMime: request.contentType,
      filename: request.filename,
    });
    if (!type.ok) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'contentType', message: type.message },
        ]),
      };
    }
    if (
      binding.userPhotoTargetUserId !== null &&
      type.rule.category !== 'image'
    ) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'contentType', message: 'user_photo requires an image file' },
        ]),
      };
    }
    const maxBytes = directUploadMaxBytes(type.rule);
    if (request.size > maxBytes) {
      return {
        status: 413,
        body: { error: 'File exceeds maximum allowed size for media type' },
      };
    }
    const partSize = request.partSize ?? DIRECT_UPLOAD_MIN_PART_BYTES;
    if (
      partSize < DIRECT_UPLOAD_MIN_PART_BYTES ||
      partSize > DIRECT_UPLOAD_MAX_PART_BYTES
    ) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'partSize',
            message: 'partSize must be between 16 MiB and 64 MiB',
          },
        ]),
      };
    }
    const partCount = Math.ceil(request.size / partSize);
    if (request.partSha256.length !== partCount) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'partSha256',
            message: `partSha256 must list ${partCount} digests (one per part)`,
          },
        ]),
      };
    }

    const id = crypto.randomUUID();
    const fileId = await deriveDirectUploadFileId(id);
    const now = this.now();
    const key =
      actor.communityId !== null
        ? `communities/${actor.communityId}/media/${fileId}`
        : `users/${actor.id}/media/${fileId}`;
    try {
      const session = await this.adapter.create({
        v: 1,
        id,
        key,
        actorId: actor.id,
        communityId: actor.communityId,
        fileId,
        originalName: type.originalName,
        mimeType: type.mimeType,
        byteSize: request.size,
        sha256: request.sha256,
        partSize,
        partSha256: request.partSha256,
        bindingFields,
        createdAt: now.getTime(),
        expiresAt: now.getTime() + DIRECT_UPLOAD_TTL_SECONDS * 1000,
      });
      const parts = await this.adapter.partTargets(session, {
        origin,
        now,
        ttlSeconds: DIRECT_UPLOAD_TTL_SECONDS,
      });
      const body = DirectUploadSessionResponseSchema.safeParse({
        data: {
          id: session.id,
          mode: session.mode,
          expiresAt: new Date(session.expiresAt).toISOString(),
          partSize,
          partCount,
          maxBytes,
          parts,
        },
      });
      if (!body.success) {
        await this.adapter.abort(session).catch(() => {});
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      await this.audit(actor, 'media.upload.session', session.id, 'success');
      return { status: 201, body: body.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  /** `api` mode only: one part streamed through this API into storage. */
  async putPart(input: {
    actor: FoundationUser;
    sessionId: string;
    partNumberRaw: string;
    contentLengthHeader: string | undefined;
    checksumHeader: string | undefined;
    body: ReadableStream<Uint8Array> | null;
  }): Promise<
    DirectUploadResult<z.infer<typeof DirectUploadPartResponseSchema>>
  > {
    const { actor } = input;
    const session = await this.resolveSession(actor, input.sessionId);
    // Only the uploader sends parts (an admin may abort, never write).
    if (!session || session.actorId !== actor.id) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (session.mode !== 'api' || !this.adapter?.putPart) {
      // Presigned sessions take their parts at the R2 URLs, never here.
      return { status: 409, body: CONFLICT_BODY };
    }
    if (session.expiresAt <= this.now().getTime()) {
      return { status: 410, body: EXPIRED_BODY };
    }
    const gate = await this.media.uploadGate(actor);
    if (gate) return gate;
    const count = Math.ceil(session.byteSize / session.partSize);
    const partNumber = /^[1-9][0-9]{0,4}$/.test(input.partNumberRaw)
      ? Number(input.partNumberRaw)
      : 0;
    if (partNumber < 1 || partNumber > count) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const expectedSize = directUploadPartSize(
      session.byteSize,
      session.partSize,
      partNumber
    );
    const declaredLength = Number(input.contentLengthHeader ?? '');
    if (input.contentLengthHeader === undefined) {
      return { status: 411, body: { error: 'Content-Length required' } };
    }
    if (declaredLength !== expectedSize) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'file', message: 'Part size does not match the session' },
        ]),
      };
    }
    const declaredChecksum = session.partSha256[partNumber - 1];
    if (
      !declaredChecksum ||
      input.checksumHeader?.trim() !== hexToBase64(declaredChecksum)
    ) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'x-amz-checksum-sha256',
            message: 'Header must carry the declared part digest',
          },
        ]),
      };
    }
    if (!input.body) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'file', message: 'Part must not be empty' },
        ]),
      };
    }
    try {
      const stored = await this.adapter.putPart(
        session,
        partNumber,
        input.body,
        { contentLength: expectedSize, sha256: declaredChecksum }
      );
      return {
        status: 200,
        body: DirectUploadPartResponseSchema.parse({
          data: { partNumber, etag: stored.etag },
        }),
      };
    } catch (error) {
      if (
        error instanceof DirectUploadError &&
        error.kind === 'part_checksum'
      ) {
        return {
          status: 422,
          body: makeValidationErrorBody([
            {
              path: 'x-amz-checksum-sha256',
              message: 'Part does not match its declared digest',
            },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  /**
   * Re-issue part targets (and extend the session) up to the absolute session
   * lifetime, so a slow upload can outlive the first 2 h URLs.
   */
  async reissueParts(
    actor: FoundationUser,
    rawId: string,
    origin: string
  ): Promise<
    DirectUploadResult<z.infer<typeof DirectUploadSessionResponseSchema>>
  > {
    const adapter = this.adapter;
    if (!adapter) return { status: 501, body: NOT_CONFIGURED_BODY };
    const session = await this.resolveSession(actor, rawId);
    if (!session || session.actorId !== actor.id) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const gate = await this.media.uploadGate(actor);
    if (gate) return gate;
    const now = this.now();
    const hardStop =
      session.createdAt + DIRECT_UPLOAD_MAX_LIFETIME_SECONDS * 1000;
    if (hardStop <= now.getTime()) return { status: 410, body: EXPIRED_BODY };
    try {
      session.expiresAt = Math.min(
        now.getTime() + DIRECT_UPLOAD_TTL_SECONDS * 1000,
        hardStop
      );
      await adapter.update(session);
      const parts = await adapter.partTargets(session, {
        origin,
        now,
        ttlSeconds: Math.max(
          1,
          Math.floor((session.expiresAt - now.getTime()) / 1000)
        ),
      });
      const partCount = Math.ceil(session.byteSize / session.partSize);
      const type = validateDeclaredMediaType({
        declaredMime: session.mimeType,
        filename: session.originalName,
      });
      const body = DirectUploadSessionResponseSchema.safeParse({
        data: {
          id: session.id,
          mode: session.mode,
          expiresAt: new Date(session.expiresAt).toISOString(),
          partSize: session.partSize,
          partCount,
          maxBytes: type.ok
            ? directUploadMaxBytes(type.rule)
            : session.byteSize,
          parts,
        },
      });
      if (!body.success) return { status: 500, body: INTERNAL_ERROR_BODY };
      return { status: 200, body: body.data };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  private async completedUploadConflict(
    actor: FoundationUser,
    session: DirectUploadSession
  ): Promise<{ status: 409; body: typeof CONFLICT_BODY } | null> {
    if (!(await this.repository.resolveUploaderMedia(session.fileId, actor))) {
      return null;
    }
    // The winning row owns the final object. Only staged parts/journal may be
    // discarded, and cleanup failure must not turn an idempotent replay into 500.
    await this.adapter!.discard(session).catch(() => {});
    return { status: 409, body: CONFLICT_BODY };
  }

  /** Bounded re-read of a winner whose R2 completion landed before its row. */
  private async waitForCompletedUploadConflict(
    actor: FoundationUser,
    session: DirectUploadSession
  ): Promise<{ status: 409; body: typeof CONFLICT_BODY } | null> {
    const deadline = Date.now() + COMPLETION_RACE_WAIT_MS;
    for (let lookups = 0; lookups < COMPLETION_RACE_MAX_LOOKUPS; lookups++) {
      const conflict = await this.completedUploadConflict(actor, session);
      if (conflict || Date.now() >= deadline) return conflict;
      await new Promise((resolve) =>
        setTimeout(resolve, COMPLETION_RACE_POLL_MS)
      );
    }
    return null;
  }

  async completeUpload(
    actor: FoundationUser,
    rawId: string,
    rawBody: unknown,
    origin: string
  ): Promise<DirectUploadResult<z.infer<typeof MediaUploadResponseSchema>>> {
    const adapter = this.adapter;
    if (!adapter) return { status: 501, body: NOT_CONFIGURED_BODY };
    const session = await this.resolveSession(actor, rawId);
    if (!session) {
      if (isDirectUploadId(rawId)) {
        const fileId = await deriveDirectUploadFileId(rawId);
        if (await this.repository.resolveUploaderMedia(fileId, actor)) {
          return { status: 409, body: CONFLICT_BODY };
        }
      }
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (session.actorId !== actor.id) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const gate = await this.media.uploadGate(actor);
    if (gate) return gate;
    const conflict = await this.completedUploadConflict(actor, session);
    if (conflict) return conflict;
    if (
      session.expiresAt + DIRECT_UPLOAD_COMPLETE_GRACE_SECONDS * 1000 <=
      this.now().getTime()
    ) {
      await this.discardStaged(actor, session, false);
      return { status: 410, body: EXPIRED_BODY };
    }
    const parsed = CompleteDirectUploadRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(zodErrorToValidationFields(parsed.error)),
      };
    }
    // Authorization is re-decided now: the actor's role may have changed.
    const binding = this.media.parseUploadBindingFields(
      actor,
      new Map(Object.entries(session.bindingFields))
    );
    if (!binding.ok) {
      if (binding.status === 403) {
        await this.audit(actor, 'media.upload', String(actor.id), 'denied');
      }
      await this.discardStaged(actor, session, false);
      return { status: binding.status, body: binding.body };
    }

    let completed = false;
    try {
      let size: number;
      try {
        ({ size } = await adapter.complete(session, parsed.data.parts));
        completed = true;
      } catch (error) {
        if (error instanceof DirectUploadError) {
          if (error.kind === 'already_completed') {
            // R2 says the object is already assembled: wait for the winner's
            // row (it may still be committing) and replay the same 409.
            const existing = await this.waitForCompletedUploadConflict(
              actor,
              session
            );
            if (existing) return existing;
            // No row is visible yet (the winner may be slow, or it crashed
            // after R2 assembled the object). Never answer 409 here: a 409
            // would read as a successful replay although no File row exists.
            return {
              status: 503,
              body: COMPLETION_PENDING_BODY,
              headers: {
                'Retry-After': String(COMPLETION_RACE_RETRY_AFTER_SECONDS),
              },
            };
          }
          if (error.kind === 'invalid_parts') {
            const existing = await this.completedUploadConflict(actor, session);
            if (existing) return existing;
            // Parts can be re-sent and completion retried; nothing is lost.
            return {
              status: 400,
              body: makeValidationErrorBody([
                {
                  path: 'parts',
                  message: 'Parts are missing, mismatched or already assembled',
                },
              ]),
            };
          }
          if (error.kind === 'checksum') {
            await this.discardStaged(actor, session, false);
            return {
              status: 422,
              body: makeValidationErrorBody([
                {
                  path: 'sha256',
                  message: 'Assembled bytes do not match the declared sha256',
                },
              ]),
            };
          }
        }
        throw error;
      }

      const existing = await this.completedUploadConflict(actor, session);
      if (existing) return existing;

      if (size !== session.byteSize) {
        await this.discardStaged(actor, session, true);
        return {
          status: 422,
          body: makeValidationErrorBody([
            {
              path: 'size',
              message: 'Uploaded size does not match the session',
            },
          ]),
        };
      }

      const header = await this.readHeaderBytes(session.key);
      const headerCheck = header
        ? await validateMediaHeaderBytes({
            headerBytes: header.bytes,
            declaredMime: session.mimeType,
            filename: session.originalName,
          })
        : ({ ok: false, message: 'Uploaded object is missing' } as const);
      if (!headerCheck.ok || header!.size !== session.byteSize) {
        await this.discardStaged(actor, session, true);
        return {
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'file',
              message: headerCheck.ok
                ? 'Uploaded size does not match the session'
                : headerCheck.message,
            },
          ]),
        };
      }
      if (
        binding.userPhotoTargetUserId !== null &&
        headerCheck.rule.category !== 'image'
      ) {
        await this.discardStaged(actor, session, true);
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'file', message: 'user_photo requires an image file' },
          ]),
        };
      }

      const result = await this.media.registerStagedUpload({
        actor,
        fileId: session.fileId,
        storageKey: session.key,
        originalName: headerCheck.originalName,
        mimeType: headerCheck.mimeType,
        byteSize: size,
        checksum: adapter.verifiesWholeFile ? session.sha256 : null,
        binding,
        origin,
      });
      if (result.status === 201) {
        await adapter.discard(session).catch(() => {});
      } else if (result.status === 409) {
        await adapter.discard(session).catch(() => {});
      } else {
        await this.discardStaged(actor, session, true);
      }
      return result;
    } catch (error) {
      const existing = await this.completedUploadConflict(actor, session);
      if (existing) return existing;
      await this.discardStaged(actor, session, completed);
      if (error instanceof ReusedMediaRejectionError) {
        await this.audit(actor, 'media.upload', String(actor.id), 'denied');
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (error instanceof DirectUploadError && error.kind === 'erasing') {
        return { status: 500, body: INTERNAL_ERROR_BODY };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async abortUpload(
    actor: FoundationUser,
    rawId: string
  ): Promise<DirectUploadResult<never>> {
    if (!this.adapter) return { status: 501, body: NOT_CONFIGURED_BODY };
    const session = await this.resolveSession(actor, rawId);
    if (!session) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    try {
      await this.discardStaged(actor, session, false);
      await this.audit(actor, 'media.upload.abort', session.id, 'success');
      return { status: 204 };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  /**
   * Abort the backend upload and drop the journal. The object is deleted only
   * when `removeBytes` (the caller's own completion produced it) and no
   * `files` row owns it; an abort or retried completion never deletes bytes.
   */
  private async discardStaged(
    actor: FoundationUser,
    session: DirectUploadSession,
    removeBytes: boolean
  ): Promise<void> {
    await this.adapter!.abort(session);
    if (
      removeBytes &&
      !(await this.repository.resolveAuthorizedMedia(session.fileId, actor))
    ) {
      await this.cleanup.deleteStorageBestEffort(
        session.key,
        'upload_rollback'
      );
    }
  }

  /** First 8 KiB of the stored object plus its total size (ranged read). */
  private async readHeaderBytes(
    key: string
  ): Promise<{ bytes: Uint8Array; size: number } | null> {
    const stored = await this.storage.read(key, {
      start: 0,
      end: MAGIC_SNIFF_BYTES - 1,
    });
    if (!stored) return null;
    if (stored.body instanceof Uint8Array) {
      return {
        bytes: stored.body.slice(0, MAGIC_SNIFF_BYTES),
        size: stored.size,
      };
    }
    const reader = stored.body.getReader();
    const bytes = new Uint8Array(MAGIC_SNIFF_BYTES);
    let filled = 0;
    try {
      while (filled < MAGIC_SNIFF_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const take = Math.min(value.byteLength, MAGIC_SNIFF_BYTES - filled);
        bytes.set(value.subarray(0, take), filled);
        filled += take;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { bytes: bytes.slice(0, filled), size: stored.size };
  }
}
