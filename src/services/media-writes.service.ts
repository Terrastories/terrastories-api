/**
 * Canonical V2 service layer for Slice 9 media upload, metadata, serving,
 * deletion, and content-free file-authorization audit logging (§5, §6.4a, §6.7, §7).
 */

import { z } from 'zod';
import {
  MediaUploadResponseSchema,
  MediaMetadataResponseSchema,
  CreateAttachmentRequestSchema,
  ReorderAttachmentsRequestSchema,
  AttachmentResponseSchema,
  AttachmentListResponseSchema,
  ALLOWED_UPLOAD_FIELDS,
  MAGIC_SNIFF_BYTES,
  MAX_MEDIA_UPLOAD_BYTES,
  MAX_METADATA_JSON_LENGTH,
  validateMediaHeaderBytes,
} from '../shared/schemas/media-v2.js';
import { streamAuthorizedMediaResponse } from '../shared/utils/media-stream-response.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import {
  StorageChecksumMismatchError,
  StorageLengthRequiredError,
  type FoundationStorage,
} from './hono-foundation.service.js';
import {
  FORBIDDEN_BODY,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
  authenticatedMediaUrl,
} from './public-communities.service.js';
import {
  CONFLICT_BODY,
  type CommunityWriteResult,
} from './community-writes.service.js';
import type { V2ErrorResponse } from '../shared/schemas/public-communities.js';
import { isDatabaseIdString } from '../shared/types/public.js';

export type MediaWriteResult<T> =
  | CommunityWriteResult<T>
  | { status: 411 | 413 | 415; body: V2ErrorResponse };
import {
  makeValidationErrorBody,
  type V2ValidationErrorResponse,
} from '../shared/schemas/community-writes.js';
import {
  MediaWritesRepository,
  buildMediaAuditEntry,
} from '../repositories/media-writes.repository.js';
import { type MediaCleanupCoordinator } from './media-cleanup.service.js';

class UploadCategoryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadCategoryLimitError';
  }
}

class EarlyUploadRejectionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 413,
    public readonly body: unknown
  ) {
    super('Upload rejected');
    this.name = 'EarlyUploadRejectionError';
  }
}

/**
 * A direct upload whose bytes are already attached to another owner, and that
 * this actor may not re-publish (§6.7 reuse rule). The partial bytes are
 * cleaned up like any rejected upload; the caller maps this to 404.
 */
export class ReusedMediaRejectionError extends Error {
  constructor() {
    super('Media bytes are not reusable by this actor');
    this.name = 'ReusedMediaRejectionError';
  }
}

const UploadMetadataSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])
  )
  .refine((obj) => !Object.prototype.hasOwnProperty.call(obj, '__proto__'), {
    message: 'Invalid metadata key',
  })
  .refine((obj) => Object.keys(obj).length <= 16, {
    message: 'Metadata may contain at most 16 properties',
  });

function serializeMetadataRecord(
  file: {
    id: string;
    originalName: string;
    mimeType: string;
    byteSize: number;
    checksum: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  },
  origin: string
) {
  return {
    id: file.id,
    originalName: file.originalName,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    checksum: file.checksum,
    metadata: file.metadata,
    url: authenticatedMediaUrl(origin, file.id),
    createdAt: file.createdAt.toISOString(),
  };
}

export class MediaWritesService {
  constructor(
    private readonly repository: MediaWritesRepository,
    private readonly storage: FoundationStorage,
    private readonly cleanup: MediaCleanupCoordinator
  ) {}

  async auditDecision(input: {
    communityId: number | null;
    actorId: number;
    action: string;
    resourceIds: Array<string | number>;
    outcome: 'success' | 'denied';
    kind?: 'file' | 'attachment';
  }): Promise<void> {
    try {
      const entry = buildMediaAuditEntry(input);
      await this.repository.insertAuditEntry(entry);
    } catch {
      // Never let audit persistence failures leak internal details or mask auth denials.
    }
  }

  private async resolveAuthorizedFile(
    actor: FoundationUser,
    rawFileId: string,
    auditAction: 'media.read' | 'media.metadata'
  ) {
    const parsedId = z.string().uuid().safeParse(rawFileId);
    if (!parsedId.success) {
      return null;
    }
    const fileId = parsedId.data;
    const file = await this.repository.resolveAuthorizedMedia(fileId, actor);
    if (!file) {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: auditAction,
        resourceIds: [fileId],
        outcome: 'denied',
      });
      return null;
    }
    await this.auditDecision({
      communityId: file.communityId,
      actorId: actor.id,
      action: auditAction,
      resourceIds: [fileId],
      outcome: 'success',
    });
    return file;
  }

  async serveMedia(
    actor: FoundationUser,
    rawFileId: string,
    rangeHeader: string | undefined
  ): Promise<Response | null> {
    const file = await this.resolveAuthorizedFile(
      actor,
      rawFileId,
      'media.read'
    );
    if (!file) {
      return null;
    }

    let expectedPrefix = '';
    if (file.communityId !== null) {
      expectedPrefix = `communities/${file.communityId}/`;
    } else if (file.uploadedBy !== null) {
      expectedPrefix = `users/${file.uploadedBy}/`;
    } else if (actor.role === 'super_admin' && actor.communityId === null) {
      // Imported null-community super_admin own user_photo whose
      // `uploadedBy` is null: the authorized account owner is the actor
      // itself (the own-account user_photo exception), so the prefix is
      // that actor's `users/<id>/` — never another account's. Other
      // accounts still 404.
      expectedPrefix = `users/${actor.id}/`;
    }

    if (!expectedPrefix) {
      return null;
    }

    return streamAuthorizedMediaResponse(
      this.storage,
      {
        storageKey: file.storageKey,
        expectedPrefix,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
      },
      rangeHeader
    );
  }

  async getMetadata(
    actor: FoundationUser,
    rawFileId: string,
    origin: string
  ): Promise<
    | { status: 200; body: z.infer<typeof MediaMetadataResponseSchema> }
    | { status: 404; body: typeof NOT_FOUND_BODY }
    | { status: 500; body: typeof INTERNAL_ERROR_BODY }
  > {
    const file = await this.resolveAuthorizedFile(
      actor,
      rawFileId,
      'media.metadata'
    );
    if (!file) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const checked = MediaMetadataResponseSchema.safeParse({
      data: serializeMetadataRecord(file, origin),
    });
    if (!checked.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 200, body: checked.data };
  }

  parseUploadBindingFields(
    actor: FoundationUser,
    fields: ReadonlyMap<string, string>
  ):
    | {
        ok: true;
        userPhotoTargetUserId: number | null;
        metadata: Record<string, unknown> | null;
      }
    | {
        ok: false;
        status: 400 | 403;
        body: V2ValidationErrorResponse | typeof FORBIDDEN_BODY;
      } {
    for (const key of fields.keys()) {
      if (!ALLOWED_UPLOAD_FIELDS.has(key)) {
        return {
          ok: false,
          status: 400,
          body: makeValidationErrorBody([
            { path: key, message: 'Unrecognized upload parameter' },
          ]),
        };
      }
    }

    const role = fields.get('role');
    const ownerType = fields.get('ownerType');
    const ownerIdRaw = fields.get('ownerId');
    const metadataRaw = fields.get('metadata');

    let parsedMetadata: Record<string, unknown> | null = null;
    if (metadataRaw !== undefined && metadataRaw.trim() !== '') {
      if (metadataRaw.length > MAX_METADATA_JSON_LENGTH) {
        return {
          ok: false,
          status: 400,
          body: makeValidationErrorBody([
            { path: 'metadata', message: 'Metadata exceeds maximum length' },
          ]),
        };
      }
      let jsonVal: unknown;
      try {
        jsonVal = JSON.parse(metadataRaw);
      } catch {
        return {
          ok: false,
          status: 400,
          body: makeValidationErrorBody([
            { path: 'metadata', message: 'Metadata must be valid JSON' },
          ]),
        };
      }
      const validMeta = UploadMetadataSchema.safeParse(jsonVal);
      if (!validMeta.success) {
        return {
          ok: false,
          status: 400,
          body: makeValidationErrorBody([
            { path: 'metadata', message: 'Invalid metadata payload' },
          ]),
        };
      }
      parsedMetadata = validMeta.data;
    }

    const requiresOwnUserPhoto =
      actor.role === 'super_admin' ||
      actor.communityId === null ||
      actor.role === 'viewer' ||
      actor.role === 'member';

    if (requiresOwnUserPhoto) {
      if (role !== 'user_photo') {
        return { ok: false, status: 403, body: FORBIDDEN_BODY };
      }
      if (ownerType !== undefined && ownerType !== 'user') {
        return { ok: false, status: 403, body: FORBIDDEN_BODY };
      }
      if (ownerIdRaw !== undefined && ownerIdRaw !== String(actor.id)) {
        return { ok: false, status: 403, body: FORBIDDEN_BODY };
      }
      return {
        ok: true,
        userPhotoTargetUserId: actor.id,
        metadata: parsedMetadata,
      };
    }

    if (actor.role !== 'editor' && actor.role !== 'admin') {
      return { ok: false, status: 403, body: FORBIDDEN_BODY };
    }

    if (role === undefined) {
      if (ownerType !== undefined || ownerIdRaw !== undefined) {
        return {
          ok: false,
          status: 400,
          body: makeValidationErrorBody([
            {
              path: 'role',
              message: 'role=user_photo is required when specifying owner',
            },
          ]),
        };
      }
      return {
        ok: true,
        userPhotoTargetUserId: null,
        metadata: parsedMetadata,
      };
    }

    if (role !== 'user_photo') {
      return {
        ok: false,
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'role',
            message:
              'Direct upload binding only supports user_photo; use POST /v2/attachments',
          },
        ]),
      };
    }

    if (ownerType !== undefined && ownerType !== 'user') {
      return {
        ok: false,
        status: 400,
        body: makeValidationErrorBody([
          { path: 'ownerType', message: 'user_photo requires ownerType=user' },
        ]),
      };
    }

    let targetUserId = actor.id;
    if (ownerIdRaw !== undefined) {
      if (!isDatabaseIdString(ownerIdRaw)) {
        return {
          ok: false,
          status: 400,
          body: makeValidationErrorBody([
            { path: 'ownerId', message: 'Invalid ownerId' },
          ]),
        };
      }
      targetUserId = Number(ownerIdRaw);
      if (targetUserId !== actor.id && actor.role !== 'admin') {
        return { ok: false, status: 403, body: FORBIDDEN_BODY };
      }
    }

    return {
      ok: true,
      userPhotoTargetUserId: targetUserId,
      metadata: parsedMetadata,
    };
  }

  /**
   * Account/community gate shared by `POST /v2/media` and the direct upload
   * routes: an active community, or a null-community super_admin.
   */
  async uploadGate(
    actor: FoundationUser
  ): Promise<{ status: 403; body: typeof FORBIDDEN_BODY } | null> {
    if (actor.communityId !== null) {
      if (!(await this.repository.isCommunityActive(actor.communityId))) {
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.upload',
          resourceIds: [actor.id],
          outcome: 'denied',
        });
        return { status: 403, body: FORBIDDEN_BODY };
      }
    } else if (actor.role !== 'super_admin') {
      return { status: 403, body: FORBIDDEN_BODY };
    }
    return null;
  }

  async uploadMedia(input: {
    actor: FoundationUser;
    /** Declared media type of the raw body. */
    contentTypeHeader: string | undefined;
    contentLengthHeader: string | undefined;
    /** Client-computed lowercase/uppercase hex SHA-256 of the body bytes. */
    checksumHeader: string | undefined;
    /** Upload parameters: filename, role, ownerType, ownerId, metadata. */
    params: URLSearchParams;
    body: ReadableStream<Uint8Array> | null;
    origin: string;
  }): Promise<MediaWriteResult<z.infer<typeof MediaUploadResponseSchema>>> {
    const { actor } = input;
    if (!this.storage.put) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    if (actor.communityId !== null) {
      const communityActive = await this.repository.isCommunityActive(
        actor.communityId
      );
      if (!communityActive) {
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.upload',
          resourceIds: [actor.id],
          outcome: 'denied',
        });
        return { status: 403, body: FORBIDDEN_BODY };
      }
    } else if (actor.role !== 'super_admin') {
      return { status: 403, body: FORBIDDEN_BODY };
    }

    let contentLength: number | undefined;
    if (input.contentLengthHeader !== undefined) {
      const parsedLength = Number(input.contentLengthHeader);
      if (Number.isSafeInteger(parsedLength) && parsedLength >= 0) {
        contentLength = parsedLength;
      }
      if (parsedLength > MAX_MEDIA_UPLOAD_BYTES) {
        return { status: 413, body: { error: 'Request too large' } };
      }
    }

    // Upload parameters arrive up front (query + headers), so authorization and
    // binding are decided before any byte is read or stored.
    const fields = new Map<string, string>();
    for (const [key, value] of input.params) {
      if (fields.has(key)) {
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: key, message: 'Duplicate upload parameter' },
          ]),
        };
      }
      fields.set(key, value);
    }
    const binding = this.parseUploadBindingFields(actor, fields);
    if (!binding.ok) {
      if (binding.status === 403) {
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.upload',
          resourceIds: [actor.id],
          outcome: 'denied',
        });
      }
      return { status: binding.status, body: binding.body };
    }

    const filename = fields.get('filename');
    if (!filename || filename.trim() === '') {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'filename', message: 'Filename is required' },
        ]),
      };
    }
    const expectedSha256 = input.checksumHeader?.trim().toLowerCase();
    if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          {
            path: 'x-content-sha256',
            message: 'x-content-sha256 must be a 64-character hex SHA-256',
          },
        ]),
      };
    }
    if (!input.body || contentLength === 0) {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'file', message: 'Uploaded file must not be empty' },
        ]),
      };
    }

    // Native-stream storage (R2 on Workers) takes the request body without any
    // per-chunk JavaScript: require a valid Content-Length before reading a byte,
    // tee the native body, sniff 8 KiB off one branch, and hand the other
    // branch straight to storage (#249 CPU budget).
    const nativeStream = this.storage.nativeStreamPut === true;
    if (nativeStream && contentLength === undefined) {
      return { status: 411, body: { error: 'Content-Length required' } };
    }

    let storageKey: string | null = null;

    const cleanupPartialStorage = async (key: string | null) => {
      if (!key) return;
      // Staging bytes have no `files` row (rolled-back upload). Delete them
      // best-effort; any leftover is removed by the orphan sweeper once it ages
      // past the grace window.
      await this.cleanup.deleteStorageBestEffort(key, 'upload_rollback');
    };

    let uploadBranch: ReadableStream<Uint8Array> | null = null;
    let sniffSource: ReadableStream<Uint8Array> = input.body;
    if (nativeStream) {
      const [sniffBranch, passBranch] = input.body.tee();
      sniffSource = sniffBranch;
      uploadBranch = passBranch;
    }
    const streamReader = sniffSource.getReader();
    try {
      // Sniff only the first MAGIC_SNIFF_BYTES for type detection; every other
      // byte is passed through to storage unread (no TypeScript hashing/parsing).
      const initialChunks: Uint8Array[] = [];
      let initialLen = 0;
      while (initialLen < MAGIC_SNIFF_BYTES) {
        const { done, value } = await streamReader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          initialChunks.push(value);
          initialLen += value.byteLength;
        }
      }
      if (initialLen === 0) {
        throw new EarlyUploadRejectionError(
          400,
          makeValidationErrorBody([
            { path: 'file', message: 'Uploaded file must not be empty' },
          ])
        );
      }

      const headerLen = Math.min(initialLen, MAGIC_SNIFF_BYTES);
      let headerBytes: Uint8Array;
      if (initialChunks.length === 1) {
        // One chunk holds the whole prefix (the common case): view it, no copy.
        headerBytes = initialChunks[0]!.subarray(0, headerLen);
      } else {
        headerBytes = new Uint8Array(headerLen);
        let copyPos = 0;
        for (const chunk of initialChunks) {
          if (copyPos >= headerLen) break;
          const take = Math.min(chunk.byteLength, headerLen - copyPos);
          headerBytes.set(chunk.subarray(0, take), copyPos);
          copyPos += take;
        }
      }

      const headerCheck = await validateMediaHeaderBytes({
        headerBytes,
        declaredMime: input.contentTypeHeader ?? '',
        filename,
      });
      if (!headerCheck.ok) {
        throw new EarlyUploadRejectionError(
          400,
          makeValidationErrorBody([
            { path: 'file', message: headerCheck.message },
          ])
        );
      }
      if (
        binding.userPhotoTargetUserId !== null &&
        headerCheck.rule.category !== 'image'
      ) {
        throw new EarlyUploadRejectionError(
          400,
          makeValidationErrorBody([
            { path: 'file', message: 'user_photo requires an image file' },
          ])
        );
      }
      const maxBytes = headerCheck.rule.maxBytes;
      if (initialLen > maxBytes || (contentLength ?? 0) > maxBytes) {
        throw new EarlyUploadRejectionError(413, {
          error: 'File exceeds maximum allowed size for media type',
        });
      }

      const fileId = crypto.randomUUID();
      storageKey =
        actor.communityId !== null
          ? `communities/${actor.communityId}/media/${fileId}`
          : `users/${actor.id}/media/${fileId}`;

      if (nativeStream) {
        // Sniff branch is done; cancelling it drops its buffering and leaves the
        // other native branch flowing to storage.
        await streamReader.cancel().catch(() => {});
      }
      // JS pass-through (Node): only chunk *lengths* are inspected (for the size
      // cap when Content-Length is absent); chunk contents are never read.
      const buildPassThrough = (): ReadableStream<Uint8Array> => {
        let byteSize = initialLen;
        let initialIndex = 0;
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (initialIndex < initialChunks.length) {
              controller.enqueue(initialChunks[initialIndex]!);
              initialChunks[initialIndex] = new Uint8Array(0);
              initialIndex += 1;
              return;
            }
            try {
              const { done, value } = await streamReader.read();
              if (done) {
                controller.close();
                return;
              }
              if (value && value.byteLength > 0) {
                byteSize += value.byteLength;
                if (byteSize > maxBytes) {
                  controller.error(
                    new UploadCategoryLimitError(
                      'File exceeds maximum allowed size for media type'
                    )
                  );
                  return;
                }
                controller.enqueue(value);
              }
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            await streamReader.cancel().catch(() => {});
          },
        });
      };
      const passThrough = uploadBranch ?? buildPassThrough();

      let stored: { size: number };
      try {
        stored = await this.storage.put!(storageKey, passThrough, {
          contentType: headerCheck.mimeType,
          sha256: expectedSha256,
          ...(contentLength !== undefined ? { contentLength } : {}),
        });
      } catch (error) {
        // Cancel unread input while the reader is still attached; releasing
        // first would make the cancel a no-op and leave the request open.
        await streamReader.cancel().catch(() => {});
        await uploadBranch?.cancel().catch(() => {});
        throw error;
      } finally {
        try {
          streamReader.releaseLock();
        } catch {
          /* already released */
        }
      }

      // Post-put size check: the stored object's real size, not the declared one.
      if (stored.size > maxBytes) {
        throw new UploadCategoryLimitError(
          'File exceeds maximum allowed size for media type'
        );
      }
      if (
        stored.size <= 0 ||
        (contentLength !== undefined && stored.size !== contentLength)
      ) {
        throw new EarlyUploadRejectionError(
          400,
          makeValidationErrorBody([
            { path: 'file', message: 'Body does not match Content-Length' },
          ])
        );
      }

      return await this.registerStagedUpload({
        actor,
        fileId,
        storageKey,
        originalName: headerCheck.originalName,
        mimeType: headerCheck.mimeType,
        byteSize: stored.size,
        // Verified by storage against the client digest before the row exists.
        checksum: expectedSha256,
        binding,
        origin: input.origin,
      });
    } catch (error) {
      await streamReader.cancel().catch(() => {});
      await uploadBranch?.cancel().catch(() => {});
      try {
        streamReader.releaseLock();
      } catch {
        /* already released */
      }
      await cleanupPartialStorage(storageKey);

      if (error instanceof EarlyUploadRejectionError) {
        if (error.status === 403) {
          await this.auditDecision({
            communityId: actor.communityId,
            actorId: actor.id,
            action: 'media.upload',
            resourceIds: [actor.id],
            outcome: 'denied',
          });
        }
        return {
          status: error.status,
          body: error.body as V2ValidationErrorResponse,
        };
      }
      if (error instanceof ReusedMediaRejectionError) {
        // Content-free: the rejection is indistinguishable from a missing
        // resource, so it must not reveal that the bytes exist elsewhere.
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.upload',
          resourceIds: [actor.id],
          outcome: 'denied',
        });
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (error instanceof UploadCategoryLimitError) {
        return { status: 413, body: { error: 'Request too large' } };
      }
      if (error instanceof StorageChecksumMismatchError) {
        return {
          status: 422,
          body: makeValidationErrorBody([
            {
              path: 'x-content-sha256',
              message: 'Body does not match x-content-sha256',
            },
          ]),
        };
      }
      if (error instanceof StorageLengthRequiredError) {
        return { status: 411, body: { error: 'Content-Length required' } };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  /**
   * Shared tail of every upload path (§6.7): bytes are already staged at
   * `storageKey`; apply the reuse rule and create the `File` row (and
   * `user_photo` binding) atomically. Throws `ReusedMediaRejectionError`;
   * callers own staged-byte cleanup on every non-201 outcome.
   */
  async registerStagedUpload(input: {
    actor: FoundationUser;
    fileId: string;
    storageKey: string;
    originalName: string;
    mimeType: string;
    byteSize: number;
    checksum: string | null;
    binding: {
      userPhotoTargetUserId: number | null;
      metadata: Record<string, unknown> | null;
    };
    origin: string;
  }): Promise<MediaWriteResult<z.infer<typeof MediaUploadResponseSchema>>> {
    const { actor, fileId, storageKey, binding } = input;
    const cleanupPartialStorage = async (key: string | null) => {
      if (!key) return;
      await this.cleanup.deleteStorageBestEffort(key, 'upload_rollback');
    };
    // §6.7 reuse rule: a direct upload binds brand-new bytes to the target
    // account. Re-uploading bytes that already carry relations is only
    // allowed when this actor may re-publish every affected owner; the
    // repository's attach reuse check is the single source of that rule.
    const reuse = await this.repository.authorizeAttachReuse({
      actor,
      communityId: actor.communityId,
      file: { id: fileId, uploadedBy: actor.id },
    });
    if (!reuse.ok) {
      throw new ReusedMediaRejectionError();
    }

    const dbOutcome = await this.repository.createUploadedMedia({
      fileId,
      actor,
      storageKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      checksum: input.checksum,
      metadata: binding.metadata,
      userPhotoTargetUserId: binding.userPhotoTargetUserId,
    });

    if (dbOutcome.status === 'forbidden') {
      await cleanupPartialStorage(storageKey);
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'media.upload',
        resourceIds: [fileId],
        outcome: 'denied',
      });
      return { status: 403, body: FORBIDDEN_BODY };
    }

    if (dbOutcome.status === 'invalid_target') {
      await cleanupPartialStorage(storageKey);
      return { status: 404, body: NOT_FOUND_BODY };
    }

    const { file, attachment } = dbOutcome.record;
    const responsePayload = MediaUploadResponseSchema.safeParse({
      data: {
        ...serializeMetadataRecord(file, input.origin),
        attachment: attachment
          ? {
              id: attachment.id,
              fileId: attachment.fileId,
              ownerType: attachment.ownerType,
              ownerId: attachment.ownerId,
              role: attachment.role,
              ordinal: attachment.ordinal,
              url: authenticatedMediaUrl(input.origin, attachment.fileId),
              mimeType: attachment.mimeType,
              byteSize: attachment.byteSize,
              originalName: attachment.originalName,
              createdAt: attachment.createdAt.toISOString(),
            }
          : null,
      },
    });
    if (!responsePayload.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 201, body: responsePayload.data };
  }

  async deleteFile(
    actor: FoundationUser,
    rawFileId: string
  ): Promise<CommunityWriteResult<never>> {
    const parsedId = z.string().uuid().safeParse(rawFileId);
    if (!parsedId.success) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const fileId = parsedId.data;

    try {
      const outcome = await this.repository.deleteUnreferencedFile(
        fileId,
        actor
      );
      if (outcome.status === 'not_found') {
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.delete',
          resourceIds: [fileId],
          outcome: 'denied',
        });
        return { status: 404, body: NOT_FOUND_BODY };
      }
      if (outcome.status === 'forbidden') {
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.delete',
          resourceIds: [fileId],
          outcome: 'denied',
        });
        return { status: 403, body: FORBIDDEN_BODY };
      }
      if (outcome.status === 'conflict') {
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.delete',
          resourceIds: [fileId],
          outcome: 'denied',
        });
        return {
          status: 409,
          body: {
            ...CONFLICT_BODY,
            error: 'File is still referenced by one or more attachments',
          },
        };
      }

      // The files row is already removed by the delete above; drop the bytes
      // best-effort. Any leftover (storage delete failed / process died) is
      // removed by the restart-safe orphan sweeper.
      await this.cleanup.deleteStorageBestEffort(
        outcome.storageKey,
        'file_deleted'
      );
      return { status: 204 };
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
  }

  async createAttachment(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<
    | { status: 201; body: z.infer<typeof AttachmentResponseSchema> }
    | { status: 400 | 403 | 404 | 409 | 500; body: unknown }
  > {
    const parsed = CreateAttachmentRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }))
        ),
      };
    }

    let outcome;
    try {
      outcome = await this.repository.createAttachment({
        actor,
        ...parsed.data,
      });
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    if (outcome.status === 'forbidden') {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'attachment.create',
        resourceIds: [parsed.data.fileId, parsed.data.ownerId],
        outcome: 'denied',
        kind: 'attachment',
      });
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (outcome.status === 'not_found') {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'attachment.create',
        resourceIds: [parsed.data.fileId, parsed.data.ownerId],
        outcome: 'denied',
        kind: 'attachment',
      });
      return { status: 404, body: NOT_FOUND_BODY };
    }
    if (outcome.status === 'type_mismatch') {
      return {
        status: 400,
        body: makeValidationErrorBody([
          { path: 'file', message: 'File type does not match attachment role' },
        ]),
      };
    }
    if (outcome.status !== 'created') {
      return { status: 400, body: NOT_FOUND_BODY };
    }

    const checked = AttachmentResponseSchema.safeParse({
      data: {
        ...outcome.attachment,
        url: authenticatedMediaUrl(origin, outcome.attachment.fileId),
        createdAt: outcome.attachment.createdAt.toISOString(),
      },
    });
    if (!checked.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 201, body: checked.data };
  }

  async reorderAttachments(
    actor: FoundationUser,
    rawBody: unknown,
    origin: string
  ): Promise<
    | { status: 200; body: z.infer<typeof AttachmentListResponseSchema> }
    | { status: 400 | 403 | 404 | 500; body: unknown }
  > {
    const parsed = ReorderAttachmentsRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: makeValidationErrorBody(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }))
        ),
      };
    }

    let outcome;
    try {
      outcome = await this.repository.reorderAttachments({
        actor,
        ownerType: parsed.data.ownerType,
        ownerId: parsed.data.ownerId,
        role: parsed.data.role,
        attachmentIds: parsed.data.attachmentIds,
      });
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    if (outcome.status === 'forbidden') {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'attachment.reorder',
        resourceIds: parsed.data.attachmentIds,
        outcome: 'denied',
        kind: 'attachment',
      });
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (outcome.status === 'not_found' || outcome.status === 'invalid_set') {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'attachment.reorder',
        resourceIds: parsed.data.attachmentIds,
        outcome: 'denied',
        kind: 'attachment',
      });
      return { status: 404, body: NOT_FOUND_BODY };
    }

    if (outcome.status !== 'reordered') {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    const checked = AttachmentListResponseSchema.safeParse({
      data: outcome.attachments.map((attachment) => ({
        ...attachment,
        url: authenticatedMediaUrl(origin, attachment.fileId),
        createdAt: attachment.createdAt.toISOString(),
      })),
    });
    if (!checked.success) {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
    return { status: 200, body: checked.data };
  }

  async deleteAttachment(
    actor: FoundationUser,
    rawAttachmentId: string
  ): Promise<CommunityWriteResult<never>> {
    if (!isDatabaseIdString(rawAttachmentId)) {
      return { status: 404, body: NOT_FOUND_BODY };
    }
    const attachmentId = Number(rawAttachmentId);

    let outcome;
    try {
      outcome = await this.repository.deleteAttachment(actor, attachmentId);
    } catch {
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }

    if (outcome.status === 'forbidden') {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'attachment.delete',
        resourceIds: [attachmentId],
        outcome: 'denied',
        kind: 'attachment',
      });
      return { status: 403, body: FORBIDDEN_BODY };
    }
    if (outcome.status !== 'deleted') {
      await this.auditDecision({
        communityId: actor.communityId,
        actorId: actor.id,
        action: 'attachment.delete',
        resourceIds: [attachmentId],
        outcome: 'denied',
        kind: 'attachment',
      });
      return { status: 404, body: NOT_FOUND_BODY };
    }

    // The files row for an unreferenced last relation was removed in the same
    // transaction as this delete; drop its bytes best-effort. Any leftover is
    // removed by the restart-safe orphan sweeper.
    if (outcome.removedFile) {
      await this.cleanup.deleteFilesBestEffort([outcome.removedFile]);
    }
    return { status: 204 };
  }
}
