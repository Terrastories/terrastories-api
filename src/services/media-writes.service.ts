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
  type MediaMimeRule,
} from '../shared/schemas/media-v2.js';
import {
  MultipartStreamError,
  parseMultipartMediaStream,
} from '../shared/utils/multipart-stream.js';
import { StreamingSha256 } from '../shared/utils/sha256-stream.js';
import { streamAuthorizedMediaResponse } from '../shared/utils/media-stream-response.js';
import type { FoundationUser } from '../repositories/hono-foundation.repository.js';
import type { FoundationStorage } from './hono-foundation.service.js';
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
  | { status: 413 | 415; body: V2ErrorResponse };
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
    public readonly status: 400 | 403 | 413,
    public readonly body: unknown
  ) {
    super('Upload rejected');
    this.name = 'EarlyUploadRejectionError';
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

  private async auditDecision(input: {
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

    const expectedPrefix =
      file.communityId !== null
        ? `communities/${file.communityId}/`
        : file.uploadedBy !== null
          ? `users/${file.uploadedBy}/`
          : '';

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

  private parseUploadBindingFields(
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
            { path: key, message: 'Unrecognized form field' },
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

  async uploadMedia(input: {
    actor: FoundationUser;
    contentTypeHeader: string | undefined;
    contentLengthHeader: string | undefined;
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

    if (input.contentLengthHeader !== undefined) {
      const contentLength = Number(input.contentLengthHeader);
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_MEDIA_UPLOAD_BYTES
      ) {
        return { status: 413, body: { error: 'Request too large' } };
      }
    }

    interface StreamedFileUpload {
      fileId: string;
      storageKey: string;
      mimeType: string;
      rule: MediaMimeRule;
      originalName: string;
      byteSize: number;
      checksum: string;
    }

    let streamedUpload: StreamedFileUpload | null = null;
    let partialStorageKey: string | null = null;

    const cleanupPartialStorage = async (key: string | null) => {
      if (!key) return;
      // Staging bytes have no `files` row (rolled-back upload). Delete them
      // best-effort; any leftover is removed by the orphan sweeper once it ages
      // past the grace window.
      await this.cleanup.deleteStorageBestEffort(key, 'upload_rollback');
    };

    try {
      const parsed = await parseMultipartMediaStream<StreamedFileUpload>(
        input.body,
        input.contentTypeHeader,
        MAX_MEDIA_UPLOAD_BYTES,
        async (part) => {
          // If restricted caller sent role/owner fields before `file`, fail fast
          // before touching storage.
          if (part.fieldsSoFar.size > 0) {
            for (const key of part.fieldsSoFar.keys()) {
              if (!ALLOWED_UPLOAD_FIELDS.has(key)) {
                throw new EarlyUploadRejectionError(
                  400,
                  makeValidationErrorBody([
                    { path: key, message: 'Unrecognized form field' },
                  ])
                );
              }
            }
            const preRole = part.fieldsSoFar.get('role');
            const requiresUserPhoto =
              actor.role === 'super_admin' ||
              actor.communityId === null ||
              actor.role === 'viewer' ||
              actor.role === 'member';
            if (
              requiresUserPhoto &&
              preRole !== undefined &&
              preRole !== 'user_photo'
            ) {
              throw new EarlyUploadRejectionError(403, FORBIDDEN_BODY);
            }
          }

          if (!part.filename || part.filename.trim() === '') {
            throw new EarlyUploadRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'file', message: 'Filename is required' },
              ])
            );
          }

          const streamReader = part.stream.getReader();
          const initialChunks: Uint8Array[] = [];
          let initialLen = 0;

          try {
            while (initialLen < MAGIC_SNIFF_BYTES) {
              const { done, value } = await streamReader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                initialChunks.push(value);
                initialLen += value.byteLength;
              }
            }
          } catch (error) {
            streamReader.releaseLock();
            throw error;
          }

          if (initialLen === 0) {
            streamReader.releaseLock();
            throw new EarlyUploadRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'file', message: 'Uploaded file must not be empty' },
              ])
            );
          }

          const headerBytes = new Uint8Array(initialLen);
          let copyPos = 0;
          for (const chunk of initialChunks) {
            headerBytes.set(chunk, copyPos);
            copyPos += chunk.byteLength;
          }

          const headerCheck = await validateMediaHeaderBytes({
            headerBytes,
            declaredMime: part.contentType,
            filename: part.filename,
          });
          if (!headerCheck.ok) {
            streamReader.releaseLock();
            await part.stream.cancel().catch(() => {});
            throw new EarlyUploadRejectionError(
              400,
              makeValidationErrorBody([
                { path: 'file', message: headerCheck.message },
              ])
            );
          }

          if (initialLen > headerCheck.rule.maxBytes) {
            streamReader.releaseLock();
            await part.stream.cancel().catch(() => {});
            throw new EarlyUploadRejectionError(413, {
              error: 'File exceeds maximum allowed size for media type',
            });
          }

          const fileId = crypto.randomUUID();
          const storageKey =
            actor.communityId !== null
              ? `communities/${actor.communityId}/media/${fileId}`
              : `users/${actor.id}/media/${fileId}`;
          partialStorageKey = storageKey;

          const hasher = new StreamingSha256();
          let byteSize = headerBytes.byteLength;
          hasher.update(headerBytes);
          let sentInitial = false;

          const hashedStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!sentInitial) {
                sentInitial = true;
                controller.enqueue(headerBytes);
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
                  if (byteSize > headerCheck.rule.maxBytes) {
                    const err = new UploadCategoryLimitError(
                      'File exceeds maximum allowed size for media type'
                    );
                    controller.error(err);
                    return;
                  }
                  hasher.update(value);
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

          try {
            await this.storage.put!(storageKey, hashedStream, {
              contentType: headerCheck.mimeType,
            });
          } finally {
            streamReader.releaseLock();
          }

          const result: StreamedFileUpload = {
            fileId,
            storageKey,
            mimeType: headerCheck.mimeType,
            rule: headerCheck.rule,
            originalName: headerCheck.originalName,
            byteSize,
            checksum: hasher.digestHex(),
          };
          streamedUpload = result;
          part.finish(result);
        }
      );

      const binding = this.parseUploadBindingFields(actor, parsed.fields);
      if (!binding.ok) {
        await cleanupPartialStorage(parsed.fileResult.storageKey);
        if (binding.status === 403) {
          await this.auditDecision({
            communityId: actor.communityId,
            actorId: actor.id,
            action: 'media.upload',
            resourceIds: [parsed.fileResult.fileId],
            outcome: 'denied',
          });
        }
        return { status: binding.status, body: binding.body };
      }

      if (
        binding.userPhotoTargetUserId !== null &&
        parsed.fileResult.rule.category !== 'image'
      ) {
        await cleanupPartialStorage(parsed.fileResult.storageKey);
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'file', message: 'user_photo requires an image file' },
          ]),
        };
      }

      const dbOutcome = await this.repository.createUploadedMedia({
        fileId: parsed.fileResult.fileId,
        actor,
        storageKey: parsed.fileResult.storageKey,
        originalName: parsed.fileResult.originalName,
        mimeType: parsed.fileResult.mimeType,
        byteSize: parsed.fileResult.byteSize,
        checksum: parsed.fileResult.checksum,
        metadata: binding.metadata,
        userPhotoTargetUserId: binding.userPhotoTargetUserId,
      });

      if (dbOutcome.status === 'forbidden') {
        await cleanupPartialStorage(parsed.fileResult.storageKey);
        await this.auditDecision({
          communityId: actor.communityId,
          actorId: actor.id,
          action: 'media.upload',
          resourceIds: [parsed.fileResult.fileId],
          outcome: 'denied',
        });
        return { status: 403, body: FORBIDDEN_BODY };
      }

      if (dbOutcome.status === 'invalid_target') {
        await cleanupPartialStorage(parsed.fileResult.storageKey);
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
    } catch (error) {
      const cleanupKey = streamedUpload
        ? (streamedUpload as StreamedFileUpload).storageKey
        : partialStorageKey;
      await cleanupPartialStorage(cleanupKey);

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
      if (error instanceof UploadCategoryLimitError) {
        return { status: 413, body: { error: 'Request too large' } };
      }
      if (error instanceof MultipartStreamError) {
        if (error.code === 'invalid_content_type') {
          return {
            status: 415,
            body: { error: 'Expected multipart/form-data' },
          };
        }
        if (error.code === 'payload_too_large') {
          return { status: 413, body: { error: 'Request too large' } };
        }
        return {
          status: 400,
          body: makeValidationErrorBody([
            { path: 'file', message: error.message },
          ]),
        };
      }
      return { status: 500, body: INTERNAL_ERROR_BODY };
    }
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
