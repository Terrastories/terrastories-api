/**
 * Repository for Slice 9 media upload, authorization resolution, metadata,
 * file deletion, and content-free file-authorization audit entries (§6.4a, §6.7, §7).
 */

import { and, eq, exists, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor, type DialectTables } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import type { FoundationUser } from './hono-foundation.repository.js';
import type {
  AttachmentOwnerType,
  AttachmentRole,
} from '../db/schema/attachments.js';
import {
  ATTACHMENT_ROLE_ALLOWED_CATEGORIES,
  MEDIA_MIME_RULES,
} from '../shared/schemas/media-v2.js';
import {
  activeUnrestrictedFileCondition,
  ownCommunityViewerForRole,
  readablePlaceConditionForViewer,
  readableSpeakerConditionForViewer,
  storyConditionForViewer,
} from './public-visibility.js';
import { readRuleOutcome, type ReadRuleViewer } from '../policy/read-rules.js';
import { communityFromPhysical } from '../policy/canonical-state.js';
import {
  buildUnreferencedFilesDelete,
  lockFileRowsForCleanup,
  toFileByteCleanups,
  type FileByteCleanup,
} from '../services/media-cleanup.service.js';
import {
  validateContentFreeAuditEntry,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import {
  isForeignKeyConstraintError,
  isNotNullConstraintError,
} from './community-writes.repository.js';

export interface StoredFileRecord {
  id: string;
  communityId: number | null;
  storageKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksum: string | null;
  uploadedBy: number | null;
  metadata: Record<string, unknown> | null;
  isActive: boolean;
  culturalRestrictions: unknown;
  createdAt: Date;
}

export interface CreatedUploadedFileResult {
  file: StoredFileRecord;
  attachment: {
    id: number;
    fileId: string;
    ownerType: 'user';
    ownerId: number;
    role: 'user_photo';
    ordinal: number;
    mimeType: string;
    byteSize: number;
    originalName: string;
    createdAt: Date;
  } | null;
}

export type CreateUploadedMediaDbOutcome =
  | { status: 'created'; record: CreatedUploadedFileResult }
  | { status: 'forbidden' }
  | { status: 'invalid_target' };

export type DeleteFileDbOutcome =
  | { status: 'deleted'; storageKey: string; communityId: number | null }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'conflict' };

export interface AttachmentRecord {
  id: number;
  fileId: string;
  ownerType: AttachmentOwnerType;
  ownerId: number;
  role: AttachmentRole;
  ordinal: number;
  mimeType: string;
  byteSize: number;
  originalName: string;
  createdAt: Date;
}

export type AttachmentWriteOutcome =
  | { status: 'created'; attachment: AttachmentRecord }
  | { status: 'reordered'; attachments: AttachmentRecord[] }
  | {
      status: 'deleted';
      fileId: string;
      storageKey: string;
      communityId: number | null;
      /** Set when this delete also removed the now-unreferenced `files` row. */
      removedFile: FileByteCleanup | null;
    }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'type_mismatch' }
  | { status: 'invalid_set' };

type AttachmentOwnerResolution =
  | { status: 'ok'; communityId: number | null }
  | { status: 'forbidden' }
  | { status: 'not_found' };

function parseMetadataField(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') return new Date(value);
  return new Date();
}

export function buildMediaAuditEntry(input: {
  communityId: number | null;
  actorId: number | null;
  action: string;
  resourceIds: Array<string | number>;
  outcome: 'success' | 'denied';
  kind?: 'file' | 'attachment';
}): ValidatedAuditEntryRecord {
  const resourceType =
    input.communityId === null ? 'super_admin' : (input.kind ?? 'file');
  return validateContentFreeAuditEntry({
    communityId: input.communityId,
    actorId: input.actorId,
    action: input.action,
    resourceType,
    resourceIds: input.resourceIds,
    outcome: input.outcome,
    ipAddress: null,
    userAgent: null,
  });
}

export class MediaWritesRepository {
  readonly tables: DialectTables;
  private readonly communityMedia:
    | typeof communityMediaPg
    | typeof communityMediaSqlite;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.tables = tablesFor(connection);
    this.communityMedia =
      dialectOf(connection) === 'postgresql'
        ? communityMediaPg
        : communityMediaSqlite;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): any {
    return this.connection;
  }

  private hasD1Batch(): boolean {
    return typeof this.db?.batch === 'function';
  }

  async isCommunityActive(
    communityId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor?: any
  ): Promise<boolean> {
    const exec = executor ?? this.db;
    const rows = (await this.fetchAll(
      exec
        .select({
          publicStories: this.tables.communities.publicStories,
          isActive: this.tables.communities.isActive,
        })
        .from(this.tables.communities)
        .where(eq(this.tables.communities.id, communityId))
        .limit(1)
    )) as Array<
      | { publicStories: boolean | number; isActive: boolean | number }
      | undefined
    >;
    const row = rows[0];
    if (!row) return false;
    return (
      communityFromPhysical({
        publicStories: row.publicStories,
        isActive: row.isActive,
      }).status === 'active'
    );
  }

  async findActiveUserInCommunity(
    communityId: number | null,
    userId: number
  ): Promise<{ id: number; role: string } | null> {
    const scope =
      communityId === null
        ? and(
            eq(this.tables.users.id, userId),
            isNull(this.tables.users.communityId),
            eq(this.tables.users.role, 'super_admin'),
            eq(this.tables.users.isActive, true)
          )
        : and(
            eq(this.tables.users.id, userId),
            eq(this.tables.users.communityId, communityId),
            eq(this.tables.users.isActive, true)
          );
    const rows = await this.db
      .select({
        id: this.tables.users.id,
        role: this.tables.users.role,
      })
      .from(this.tables.users)
      .where(scope)
      .limit(1);
    return rows[0] ?? null;
  }

  async insertAuditEntry(
    entry: ValidatedAuditEntryRecord,
    now: Date = new Date()
  ): Promise<void> {
    await this.db.insert(this.tables.auditEntries).values({
      ...entry,
      createdAt: now,
    });
  }

  async createUploadedMedia(input: {
    fileId: string;
    actor: FoundationUser;
    storageKey: string;
    originalName: string;
    mimeType: string;
    byteSize: number;
    /** Null when the bytes were not hashed server-side (Workers direct upload). */
    checksum: string | null;
    metadata: Record<string, unknown> | null;
    userPhotoTargetUserId: number | null;
    now?: Date;
  }): Promise<CreateUploadedMediaDbOutcome> {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const isPg = dialectOf(this.connection) === 'postgresql';
    const metadataValue = isPg
      ? input.metadata
      : input.metadata
        ? JSON.stringify(input.metadata)
        : null;
    const communityId = input.actor.communityId;
    const targetUserId = input.userPhotoTargetUserId;

    const audit = buildMediaAuditEntry({
      communityId,
      actorId: input.actor.id,
      action:
        targetUserId !== null ? 'media.upload.user_photo' : 'media.upload',
      resourceIds: [input.fileId],
      outcome: 'success',
    });

    if (this.hasD1Batch()) {
      const metadataSql =
        input.metadata !== null ? JSON.stringify(input.metadata) : null;
      const fileUrl = `/v2/media/${input.fileId}`;

      if (communityId === null) {
        if (targetUserId === null || targetUserId !== input.actor.id) {
          return { status: 'forbidden' };
        }
        const insertFile = this.db
          .insert(this.tables.files)
          .select(
            this.db
              .select({
                id: sql`${input.fileId}`.as('id'),
                filename: sql`${input.fileId}`.as('filename'),
                originalName: sql`${input.originalName}`.as('original_name'),
                path: sql`${input.storageKey}`.as('path'),
                storageKey: sql`${input.storageKey}`.as('storage_key'),
                url: sql`${fileUrl}`.as('url'),
                mimeType: sql`${input.mimeType}`.as('mime_type'),
                size: sql`${input.byteSize}`.as('size'),
                byteSize: sql`${input.byteSize}`.as('byte_size'),
                checksum: sql`${input.checksum}`.as('checksum'),
                communityId: sql`NULL`.as('community_id'),
                uploadedBy: this.tables.users.id,
                metadata: sql`${metadataSql}`.as('metadata'),
                culturalRestrictions: sql`NULL`.as('cultural_restrictions'),
                isActive: sql`1`.as('is_active'),
                createdAt: sql`${nowMs}`.as('created_at'),
                updatedAt: sql`${nowMs}`.as('updated_at'),
              })
              .from(this.tables.users)
              .where(
                and(
                  eq(this.tables.users.id, input.actor.id),
                  isNull(this.tables.users.communityId),
                  eq(this.tables.users.role, 'super_admin'),
                  eq(this.tables.users.isActive, true)
                )
              )
          )
          .returning({
            id: this.tables.files.id,
            createdAt: this.tables.files.createdAt,
          });

        const insertAttachment = this.db
          .insert(this.tables.attachments)
          .select(
            this.db
              .select({
                id: sql`NULL`.as('id'),
                communityId: sql`NULL`.as('community_id'),
                fileId: this.tables.files.id,
                ownerType: sql`${'user'}`.as('owner_type'),
                ownerId: sql`${targetUserId}`.as('owner_id'),
                role: sql`${'user_photo'}`.as('role'),
                ordinal: sql`COALESCE(
                  (
                    SELECT MAX(a.ordinal) + 1
                    FROM attachments a
                    WHERE a.community_id IS NULL
                      AND a.owner_type = 'user'
                      AND a.owner_id = ${targetUserId}
                      AND a.role = 'user_photo'
                  ),
                  0
                )`.as('ordinal'),
                attachableId: sql`NULL`.as('attachable_id'),
                attachableType: sql`NULL`.as('attachable_type'),
                url: sql`NULL`.as('url'),
                filename: sql`NULL`.as('filename'),
                contentType: sql`NULL`.as('content_type'),
                fileSize: sql`NULL`.as('file_size'),
                createdAt: sql`${nowMs}`.as('created_at'),
              })
              .from(this.tables.files)
              .where(eq(this.tables.files.id, input.fileId))
          )
          .returning({
            id: this.tables.attachments.id,
            ordinal: this.tables.attachments.ordinal,
            createdAt: this.tables.attachments.createdAt,
          });

        const insertAudit = this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: sql`NULL`.as('community_id'),
              actorId: sql`${audit.actorId}`.as('actor_id'),
              action: sql`${audit.action}`.as('action'),
              resourceType: sql`${audit.resourceType}`.as('resource_type'),
              resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
                'resource_ids'
              ),
              outcome: sql`${audit.outcome}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.files)
            .where(eq(this.tables.files.id, input.fileId))
        );

        const [fileRows, attRows] = await this.db.batch([
          insertFile,
          insertAttachment,
          insertAudit,
        ]);
        const insertedFile = Array.isArray(fileRows) ? fileRows[0] : undefined;
        const insertedAtt = Array.isArray(attRows) ? attRows[0] : undefined;
        if (!insertedFile || !insertedAtt) {
          return { status: 'forbidden' };
        }
        return {
          status: 'created',
          record: {
            file: {
              id: input.fileId,
              communityId: null,
              storageKey: input.storageKey,
              originalName: input.originalName,
              mimeType: input.mimeType,
              byteSize: input.byteSize,
              checksum: input.checksum,
              uploadedBy: input.actor.id,
              metadata: input.metadata,
              isActive: true,
              culturalRestrictions: null,
              createdAt: toDate(insertedFile.createdAt),
            },
            attachment: {
              id: insertedAtt.id,
              fileId: input.fileId,
              ownerType: 'user',
              ownerId: targetUserId,
              role: 'user_photo',
              ordinal: Number(insertedAtt.ordinal ?? 0),
              mimeType: input.mimeType,
              byteSize: input.byteSize,
              originalName: input.originalName,
              createdAt: toDate(insertedAtt.createdAt),
            },
          },
        };
      }

      const communityGuards = [
        eq(this.tables.communities.id, communityId),
        eq(this.tables.communities.isActive, true),
        sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${input.actor.id} AND u.community_id = ${communityId} AND u.is_active = 1)`,
      ];
      if (targetUserId !== null) {
        communityGuards.push(
          sql`EXISTS (SELECT 1 FROM users tu WHERE tu.id = ${targetUserId} AND tu.community_id = ${communityId} AND tu.is_active = 1)`
        );
      }

      const insertFile = this.db
        .insert(this.tables.files)
        .select(
          this.db
            .select({
              id: sql`${input.fileId}`.as('id'),
              filename: sql`${input.fileId}`.as('filename'),
              originalName: sql`${input.originalName}`.as('original_name'),
              path: sql`${input.storageKey}`.as('path'),
              storageKey: sql`${input.storageKey}`.as('storage_key'),
              url: sql`${fileUrl}`.as('url'),
              mimeType: sql`${input.mimeType}`.as('mime_type'),
              size: sql`${input.byteSize}`.as('size'),
              byteSize: sql`${input.byteSize}`.as('byte_size'),
              checksum: sql`${input.checksum}`.as('checksum'),
              communityId: this.tables.communities.id,
              uploadedBy: sql`${input.actor.id}`.as('uploaded_by'),
              metadata: sql`${metadataSql}`.as('metadata'),
              culturalRestrictions: sql`NULL`.as('cultural_restrictions'),
              isActive: sql`1`.as('is_active'),
              createdAt: sql`${nowMs}`.as('created_at'),
              updatedAt: sql`${nowMs}`.as('updated_at'),
            })
            .from(this.tables.communities)
            .where(and(...communityGuards))
        )
        .returning({
          id: this.tables.files.id,
          createdAt: this.tables.files.createdAt,
        });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statements: any[] = [insertFile];
      if (targetUserId !== null) {
        statements.push(
          this.db
            .insert(this.tables.attachments)
            .select(
              this.db
                .select({
                  id: sql`NULL`.as('id'),
                  communityId: this.tables.files.communityId,
                  fileId: this.tables.files.id,
                  ownerType: sql`${'user'}`.as('owner_type'),
                  ownerId: sql`${targetUserId}`.as('owner_id'),
                  role: sql`${'user_photo'}`.as('role'),
                  ordinal: sql`COALESCE(
                    (
                      SELECT MAX(a.ordinal) + 1
                      FROM attachments a
                      WHERE a.community_id = ${communityId}
                        AND a.owner_type = 'user'
                        AND a.owner_id = ${targetUserId}
                        AND a.role = 'user_photo'
                    ),
                    0
                  )`.as('ordinal'),
                  attachableId: sql`NULL`.as('attachable_id'),
                  attachableType: sql`NULL`.as('attachable_type'),
                  url: sql`NULL`.as('url'),
                  filename: sql`NULL`.as('filename'),
                  contentType: sql`NULL`.as('content_type'),
                  fileSize: sql`NULL`.as('file_size'),
                  createdAt: sql`${nowMs}`.as('created_at'),
                })
                .from(this.tables.files)
                .where(
                  and(
                    eq(this.tables.files.id, input.fileId),
                    eq(this.tables.files.communityId, communityId)
                  )
                )
            )
            .returning({
              id: this.tables.attachments.id,
              ordinal: this.tables.attachments.ordinal,
              createdAt: this.tables.attachments.createdAt,
            })
        );
      }

      statements.push(
        this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId: this.tables.files.communityId,
              actorId: sql`${audit.actorId}`.as('actor_id'),
              action: sql`${audit.action}`.as('action'),
              resourceType: sql`${audit.resourceType}`.as('resource_type'),
              resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
                'resource_ids'
              ),
              outcome: sql`${audit.outcome}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${nowMs}`.as('created_at'),
            })
            .from(this.tables.files)
            .where(eq(this.tables.files.id, input.fileId))
        )
      );

      const batchResults = await this.db.batch(statements);
      const insertedFile = Array.isArray(batchResults[0])
        ? batchResults[0][0]
        : undefined;
      if (!insertedFile) {
        const active = await this.isCommunityActive(communityId);
        return { status: active ? 'invalid_target' : 'forbidden' };
      }
      const insertedAtt =
        targetUserId !== null && Array.isArray(batchResults[1])
          ? batchResults[1][0]
          : undefined;
      if (targetUserId !== null && !insertedAtt) {
        return { status: 'invalid_target' };
      }

      return {
        status: 'created',
        record: {
          file: {
            id: input.fileId,
            communityId,
            storageKey: input.storageKey,
            originalName: input.originalName,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            checksum: input.checksum,
            uploadedBy: input.actor.id,
            metadata: input.metadata,
            isActive: true,
            culturalRestrictions: null,
            createdAt: toDate(insertedFile.createdAt),
          },
          attachment: insertedAtt
            ? {
                id: insertedAtt.id,
                fileId: input.fileId,
                ownerType: 'user',
                ownerId: targetUserId!,
                role: 'user_photo',
                ordinal: Number(insertedAtt.ordinal ?? 0),
                mimeType: input.mimeType,
                byteSize: input.byteSize,
                originalName: input.originalName,
                createdAt: toDate(insertedAtt.createdAt),
              }
            : null,
        },
      };
    }

    const executeInTx = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx: any,
      pgLock: boolean
    ): Promise<CreateUploadedMediaDbOutcome> => {
      if (communityId === null) {
        if (targetUserId === null || targetUserId !== input.actor.id) {
          return { status: 'forbidden' };
        }
        const userQuery = tx
          .select({ id: this.tables.users.id })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actor.id),
              isNull(this.tables.users.communityId),
              eq(this.tables.users.role, 'super_admin'),
              eq(this.tables.users.isActive, true)
            )
          )
          .limit(1);
        const userRows = pgLock
          ? await userQuery.for('share')
          : await userQuery;
        if (userRows.length === 0) {
          return { status: 'forbidden' };
        }
      } else {
        const commQuery = tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .limit(1);
        const commRows = pgLock
          ? await commQuery.for('share')
          : await commQuery;
        if (commRows.length === 0) {
          return { status: 'forbidden' };
        }
        if (targetUserId !== null) {
          const targetQuery = tx
            .select({ id: this.tables.users.id })
            .from(this.tables.users)
            .where(
              and(
                eq(this.tables.users.id, targetUserId),
                eq(this.tables.users.communityId, communityId),
                eq(this.tables.users.isActive, true)
              )
            )
            .limit(1);
          const targetRows = pgLock
            ? await targetQuery.for('share')
            : await targetQuery;
          if (targetRows.length === 0) {
            return { status: 'invalid_target' };
          }
        }
      }

      await tx.insert(this.tables.files).values({
        id: input.fileId,
        filename: input.fileId,
        originalName: input.originalName,
        path: input.storageKey,
        storageKey: input.storageKey,
        url: `/v2/media/${input.fileId}`,
        mimeType: input.mimeType,
        size: input.byteSize,
        byteSize: input.byteSize,
        checksum: input.checksum,
        communityId,
        uploadedBy: input.actor.id,
        metadata: metadataValue,
        culturalRestrictions: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });

      let attachment: CreatedUploadedFileResult['attachment'] = null;
      if (targetUserId !== null) {
        const existingMaxRows = await tx
          .select({
            maxOrd: sql<number>`COALESCE(MAX(${this.tables.attachments.ordinal}), -1)`,
          })
          .from(this.tables.attachments)
          .where(
            and(
              communityId === null
                ? isNull(this.tables.attachments.communityId)
                : eq(this.tables.attachments.communityId, communityId),
              eq(this.tables.attachments.ownerType, 'user'),
              eq(this.tables.attachments.ownerId, targetUserId),
              eq(this.tables.attachments.role, 'user_photo')
            )
          );
        const nextOrdinal = Number(existingMaxRows[0]?.maxOrd ?? -1) + 1;
        const [insertedAtt] = await tx
          .insert(this.tables.attachments)
          .values({
            communityId,
            fileId: input.fileId,
            ownerType: 'user',
            ownerId: targetUserId,
            role: 'user_photo',
            ordinal: nextOrdinal,
            createdAt: now,
          })
          .returning({
            id: this.tables.attachments.id,
            ordinal: this.tables.attachments.ordinal,
            createdAt: this.tables.attachments.createdAt,
          });
        attachment = {
          id: insertedAtt.id,
          fileId: input.fileId,
          ownerType: 'user',
          ownerId: targetUserId,
          role: 'user_photo',
          ordinal: Number(insertedAtt.ordinal ?? nextOrdinal),
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          originalName: input.originalName,
          createdAt: toDate(insertedAtt.createdAt),
        };
      }

      await tx.insert(this.tables.auditEntries).values({
        ...audit,
        createdAt: now,
      });

      return {
        status: 'created',
        record: {
          file: {
            id: input.fileId,
            communityId,
            storageKey: input.storageKey,
            originalName: input.originalName,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            checksum: input.checksum,
            uploadedBy: input.actor.id,
            metadata: input.metadata,
            isActive: true,
            culturalRestrictions: null,
            createdAt: now,
          },
          attachment,
        },
      };
    };

    if (isPg) {
      return this.db.transaction((tx: typeof this.db) => executeInTx(tx, true));
    }

    return this.db.transaction((tx: typeof this.db) => {
      if (communityId === null) {
        if (targetUserId === null || targetUserId !== input.actor.id) {
          return { status: 'forbidden' };
        }
        const userRows = tx
          .select({ id: this.tables.users.id })
          .from(this.tables.users)
          .where(
            and(
              eq(this.tables.users.id, input.actor.id),
              isNull(this.tables.users.communityId),
              eq(this.tables.users.role, 'super_admin'),
              eq(this.tables.users.isActive, true)
            )
          )
          .limit(1)
          .all();
        if (userRows.length === 0) {
          return { status: 'forbidden' };
        }
      } else {
        const commRows = tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(
            and(
              eq(this.tables.communities.id, communityId),
              eq(this.tables.communities.isActive, true)
            )
          )
          .limit(1)
          .all();
        if (commRows.length === 0) {
          return { status: 'forbidden' };
        }
        if (targetUserId !== null) {
          const targetRows = tx
            .select({ id: this.tables.users.id })
            .from(this.tables.users)
            .where(
              and(
                eq(this.tables.users.id, targetUserId),
                eq(this.tables.users.communityId, communityId),
                eq(this.tables.users.isActive, true)
              )
            )
            .limit(1)
            .all();
          if (targetRows.length === 0) {
            return { status: 'invalid_target' };
          }
        }
      }

      tx.insert(this.tables.files)
        .values({
          id: input.fileId,
          filename: input.fileId,
          originalName: input.originalName,
          path: input.storageKey,
          storageKey: input.storageKey,
          url: `/v2/media/${input.fileId}`,
          mimeType: input.mimeType,
          size: input.byteSize,
          byteSize: input.byteSize,
          checksum: input.checksum,
          communityId,
          uploadedBy: input.actor.id,
          metadata: metadataValue,
          culturalRestrictions: null,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      let attachment: CreatedUploadedFileResult['attachment'] = null;
      if (targetUserId !== null) {
        const existingMaxRows = tx
          .select({
            maxOrd: sql<number>`COALESCE(MAX(${this.tables.attachments.ordinal}), -1)`,
          })
          .from(this.tables.attachments)
          .where(
            and(
              communityId === null
                ? isNull(this.tables.attachments.communityId)
                : eq(this.tables.attachments.communityId, communityId),
              eq(this.tables.attachments.ownerType, 'user'),
              eq(this.tables.attachments.ownerId, targetUserId),
              eq(this.tables.attachments.role, 'user_photo')
            )
          )
          .all();
        const nextOrdinal = Number(existingMaxRows[0]?.maxOrd ?? -1) + 1;
        const insertedAtt = tx
          .insert(this.tables.attachments)
          .values({
            communityId,
            fileId: input.fileId,
            ownerType: 'user',
            ownerId: targetUserId,
            role: 'user_photo',
            ordinal: nextOrdinal,
            createdAt: now,
          })
          .returning({
            id: this.tables.attachments.id,
            ordinal: this.tables.attachments.ordinal,
            createdAt: this.tables.attachments.createdAt,
          })
          .get();
        attachment = {
          id: insertedAtt.id,
          fileId: input.fileId,
          ownerType: 'user',
          ownerId: targetUserId,
          role: 'user_photo',
          ordinal: Number(insertedAtt.ordinal ?? nextOrdinal),
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          originalName: input.originalName,
          createdAt: toDate(insertedAtt.createdAt),
        };
      }

      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();

      return {
        status: 'created',
        record: {
          file: {
            id: input.fileId,
            communityId,
            storageKey: input.storageKey,
            originalName: input.originalName,
            mimeType: input.mimeType,
            byteSize: input.byteSize,
            checksum: input.checksum,
            uploadedBy: input.actor.id,
            metadata: input.metadata,
            isActive: true,
            culturalRestrictions: null,
            createdAt: now,
          },
          attachment,
        },
      };
    });
  }

  async resolveAuthorizedMedia(
    fileId: string,
    actor: FoundationUser
  ): Promise<StoredFileRecord | null> {
    const fileRows = await this.db
      .select({
        id: this.tables.files.id,
        communityId: this.tables.files.communityId,
        storageKey: this.tables.files.storageKey,
        path: this.tables.files.path,
        originalName: this.tables.files.originalName,
        mimeType: this.tables.files.mimeType,
        byteSize: this.tables.files.byteSize,
        size: this.tables.files.size,
        checksum: this.tables.files.checksum,
        uploadedBy: this.tables.files.uploadedBy,
        metadata: this.tables.files.metadata,
        isActive: this.tables.files.isActive,
        culturalRestrictions: this.tables.files.culturalRestrictions,
        createdAt: this.tables.files.createdAt,
      })
      .from(this.tables.files)
      .where(eq(this.tables.files.id, fileId))
      .limit(1);

    const fileRow = fileRows[0];
    if (
      !fileRow ||
      !fileRow.isActive ||
      fileRow.culturalRestrictions !== null
    ) {
      return null;
    }

    const record: StoredFileRecord = {
      id: fileRow.id,
      communityId: fileRow.communityId,
      storageKey: fileRow.storageKey ?? fileRow.path,
      originalName: fileRow.originalName,
      mimeType: fileRow.mimeType,
      byteSize: Number(fileRow.byteSize ?? fileRow.size),
      checksum: fileRow.checksum,
      uploadedBy: fileRow.uploadedBy,
      metadata: parseMetadataField(fileRow.metadata),
      isActive: fileRow.isActive,
      culturalRestrictions: fileRow.culturalRestrictions,
      createdAt: toDate(fileRow.createdAt),
    };

    // Null-community super_admin exception: own null-community user_photo only.
    if (actor.role === 'super_admin' || actor.communityId === null) {
      if (
        actor.role !== 'super_admin' ||
        actor.communityId !== null ||
        record.communityId !== null
      ) {
        return null;
      }
      const ownPhotoRows = await this.db
        .select({ id: this.tables.attachments.id })
        .from(this.tables.attachments)
        .where(
          and(
            isNull(this.tables.attachments.communityId),
            eq(this.tables.attachments.fileId, fileId),
            eq(this.tables.attachments.ownerType, 'user'),
            eq(this.tables.attachments.ownerId, actor.id),
            eq(this.tables.attachments.role, 'user_photo')
          )
        )
        .limit(1);
      return ownPhotoRows.length > 0 ? record : null;
    }

    // Community-scoped authenticated media resolution.
    if (record.communityId !== actor.communityId) {
      return null;
    }
    const viewer = ownCommunityViewerForRole(actor.role);
    if (!viewer) {
      return null;
    }
    const communityActive = await this.isCommunityActive(actor.communityId);
    if (!communityActive) {
      return null;
    }

    const communityId = actor.communityId;
    const viewerAuthorities: readonly string[] =
      viewer === 'own-admin' ? ['user-management'] : [];

    // 1. Static map on CommunityMapConfig (§6.4a community-branding)
    const [staticMapRow] = await this.db
      .select({ communityId: this.tables.communityMapConfigs.communityId })
      .from(this.tables.communityMapConfigs)
      .where(
        and(
          eq(this.tables.communityMapConfigs.communityId, communityId),
          eq(this.tables.communityMapConfigs.staticMapFileId, fileId)
        )
      )
      .limit(1);

    if (staticMapRow) {
      return readRuleOutcome({
        resource: 'media',
        association: 'community-branding',
        viewer,
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      }) === 'visible'
        ? record
        : null;
    }

    // 2. Legacy/coexistence community_media branding fallback
    const [brandingRow] = await this.db
      .select({ fileId: this.communityMedia.fileId })
      .from(this.communityMedia)
      .where(
        and(
          eq(this.communityMedia.communityId, communityId),
          eq(this.communityMedia.fileId, fileId),
          eq(this.communityMedia.kind, 'branding')
        )
      )
      .limit(1);

    if (brandingRow) {
      return readRuleOutcome({
        resource: 'media',
        association: 'community-branding',
        viewer,
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      }) === 'visible'
        ? record
        : null;
    }

    // 3. Canonical Attachment relations
    const attachmentRows: Array<{
      ownerType: string | null;
      ownerId: number | null;
      role: string | null;
    }> = await this.db
      .select({
        ownerType: this.tables.attachments.ownerType,
        ownerId: this.tables.attachments.ownerId,
        role: this.tables.attachments.role,
      })
      .from(this.tables.attachments)
      .where(
        and(
          eq(this.tables.attachments.communityId, communityId),
          eq(this.tables.attachments.fileId, fileId)
        )
      );

    if (attachmentRows.length === 0) {
      // Unattached private staging object (§6.7): visible only to same-community
      // admin (readRuleOutcome 'unattached-staging') or the active community
      // uploader (own-editor). Imported files with uploadedBy = null fail closed
      // for non-admin callers.
      if (
        readRuleOutcome({
          resource: 'media',
          association: 'unattached-staging',
          viewer,
          privacyEvidence: 'clear',
          viewerIsOwner: false,
        }) === 'visible'
      ) {
        return record;
      }
      if (
        viewer === 'own-editor' &&
        record.uploadedBy !== null &&
        record.uploadedBy === actor.id
      ) {
        return record;
      }
      return null;
    }

    for (const att of attachmentRows) {
      if (
        await this.isAttachmentReadableByViewer(
          communityId,
          actor.id,
          viewer,
          viewerAuthorities,
          att
        )
      ) {
        return record;
      }
    }

    return null;
  }

  private async isAttachmentReadableByViewer(
    communityId: number,
    actorId: number,
    viewer: ReadRuleViewer,
    viewerAuthorities: readonly string[],
    att: {
      ownerType: string | null;
      ownerId: number | null;
      role: string | null;
    }
  ): Promise<boolean> {
    if (
      (att.ownerType === 'community' &&
        att.ownerId === communityId &&
        (att.role === 'community_display_image' ||
          att.role === 'community_background_image' ||
          att.role === 'sponsor_logo')) ||
      (att.ownerType === 'map_config' &&
        att.ownerId === communityId &&
        att.role === 'static_map')
    ) {
      return (
        readRuleOutcome({
          resource: 'media',
          association: 'community-branding',
          viewer,
          privacyEvidence: 'clear',
          viewerIsOwner: false,
        }) === 'visible'
      );
    }

    if (
      att.ownerType === 'story' &&
      att.role === 'story_media' &&
      att.ownerId !== null
    ) {
      const rows = await this.db
        .select({ id: this.tables.stories.id })
        .from(this.tables.stories)
        .where(
          and(
            storyConditionForViewer(this.tables.stories, communityId, viewer),
            eq(this.tables.stories.id, att.ownerId)
          )
        )
        .limit(1);
      return rows.length > 0;
    }

    if (
      att.ownerType === 'place' &&
      (att.role === 'place_photo' || att.role === 'place_name_audio') &&
      att.ownerId !== null
    ) {
      const rows = await this.db
        .select({ id: this.tables.places.id })
        .from(this.tables.places)
        .where(
          and(
            readablePlaceConditionForViewer(
              this.db,
              this.tables,
              communityId,
              viewer
            ),
            eq(this.tables.places.id, att.ownerId)
          )
        )
        .limit(1);
      return rows.length > 0;
    }

    if (
      att.ownerType === 'speaker' &&
      att.role === 'speaker_photo' &&
      att.ownerId !== null
    ) {
      const rows = await this.db
        .select({ id: this.tables.speakers.id })
        .from(this.tables.speakers)
        .where(
          and(
            readableSpeakerConditionForViewer(
              this.db,
              this.tables,
              communityId,
              viewer
            ),
            eq(this.tables.speakers.id, att.ownerId)
          )
        )
        .limit(1);
      return rows.length > 0;
    }

    if (
      att.ownerType === 'user' &&
      att.role === 'user_photo' &&
      att.ownerId !== null
    ) {
      const userRows = await this.db
        .select({ id: this.tables.users.id })
        .from(this.tables.users)
        .where(
          and(
            eq(this.tables.users.id, att.ownerId),
            eq(this.tables.users.communityId, communityId)
          )
        )
        .limit(1);
      if (userRows.length === 0) return false;
      return (
        readRuleOutcome({
          resource: 'media',
          association: 'user-profile',
          viewer,
          privacyEvidence: 'clear',
          viewerIsOwner: att.ownerId === actorId,
          viewerAuthorities,
        }) === 'visible'
      );
    }

    return false;
  }

  /**
   * True when at least one of this file's attachments names an owner the
   * actor can read. Used to keep DELETE free of an existence oracle: without
   * a readable owner the caller behaves as if the file were absent.
   */
  private async hasReadableAttachmentOwner(
    fileId: string,
    communityId: number,
    actorId: number,
    viewer: ReadRuleViewer
  ): Promise<boolean> {
    // own-community context: 'own-admin' carries user-management authority.
    const viewerAuthorities: readonly string[] =
      viewer === 'own-admin' ? ['user-management'] : [];
    const attachmentRows: Array<{
      ownerType: string | null;
      ownerId: number | null;
      role: string | null;
    }> = await this.db
      .select({
        ownerType: this.tables.attachments.ownerType,
        ownerId: this.tables.attachments.ownerId,
        role: this.tables.attachments.role,
      })
      .from(this.tables.attachments)
      .where(
        and(
          eq(this.tables.attachments.communityId, communityId),
          eq(this.tables.attachments.fileId, fileId)
        )
      )
      .limit(25);
    for (const att of attachmentRows) {
      if (
        await this.isAttachmentReadableByViewer(
          communityId,
          actorId,
          viewer,
          viewerAuthorities,
          att
        )
      ) {
        return true;
      }
    }
    return false;
  }

  async deleteUnreferencedFile(
    fileId: string,
    actor: FoundationUser,
    now: Date = new Date()
  ): Promise<DeleteFileDbOutcome> {
    const fileRows = await this.db
      .select({
        id: this.tables.files.id,
        communityId: this.tables.files.communityId,
        storageKey: this.tables.files.storageKey,
        path: this.tables.files.path,
        uploadedBy: this.tables.files.uploadedBy,
        isActive: this.tables.files.isActive,
        culturalRestrictions: this.tables.files.culturalRestrictions,
      })
      .from(this.tables.files)
      .where(eq(this.tables.files.id, fileId))
      .limit(1);

    const file = fileRows[0];
    if (!file || !file.isActive || file.culturalRestrictions !== null) {
      return { status: 'not_found' };
    }

    if (actor.role === 'super_admin' || actor.communityId === null) {
      if (
        actor.role !== 'super_admin' ||
        actor.communityId !== null ||
        file.communityId !== null
      ) {
        return { status: 'not_found' };
      }
      if (file.uploadedBy !== actor.id) {
        // Check if attached to actor's own user_photo (would be 409 conflict) vs another super_admin (404)
        const ownPhoto = await this.db
          .select({ id: this.tables.attachments.id })
          .from(this.tables.attachments)
          .where(
            and(
              isNull(this.tables.attachments.communityId),
              eq(this.tables.attachments.fileId, fileId),
              eq(this.tables.attachments.ownerType, 'user'),
              eq(this.tables.attachments.ownerId, actor.id),
              eq(this.tables.attachments.role, 'user_photo')
            )
          )
          .limit(1);
        return ownPhoto.length > 0
          ? { status: 'conflict' }
          : { status: 'not_found' };
      }
    } else {
      const communityActive = await this.isCommunityActive(actor.communityId);
      if (!communityActive) {
        return { status: 'forbidden' };
      }
      if (file.communityId !== actor.communityId) {
        return { status: 'not_found' };
      }
      const viewer = ownCommunityViewerForRole(actor.role);
      if (!viewer) {
        return { status: 'forbidden' };
      }
      if (viewer !== 'own-admin') {
        if (file.uploadedBy !== actor.id) {
          // Non-admin without ownership cannot delete another user's staging or
          // media; the file's existence stays hidden unless at least one
          // attachment owner is readable by this actor.
          const readable = await this.hasReadableAttachmentOwner(
            fileId,
            actor.communityId,
            actor.id,
            viewer
          );
          return readable ? { status: 'forbidden' } : { status: 'not_found' };
        }
      }
    }

    const storageKey = file.storageKey ?? file.path;
    const audit = buildMediaAuditEntry({
      communityId: file.communityId,
      actorId: actor.id,
      action: 'media.delete',
      resourceIds: [fileId],
      outcome: 'success',
    });

    const unreferencedPredicate = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: any
    ) =>
      and(
        eq(this.tables.files.id, fileId),
        file.communityId === null
          ? isNull(this.tables.files.communityId)
          : eq(this.tables.files.communityId, file.communityId),
        eq(this.tables.files.isActive, true),
        isNull(this.tables.files.culturalRestrictions),
        notExists(
          executor
            .select({ id: this.tables.attachments.id })
            .from(this.tables.attachments)
            .where(eq(this.tables.attachments.fileId, this.tables.files.id))
        ),
        notExists(
          executor
            .select({
              communityId: this.tables.communityMapConfigs.communityId,
            })
            .from(this.tables.communityMapConfigs)
            .where(
              eq(
                this.tables.communityMapConfigs.staticMapFileId,
                this.tables.files.id
              )
            )
        ),
        notExists(
          executor
            .select({ fileId: this.communityMedia.fileId })
            .from(this.communityMedia)
            .where(eq(this.communityMedia.fileId, this.tables.files.id))
        ),
        notExists(
          executor
            .select({ id: this.tables.importManifests.id })
            .from(this.tables.importManifests)
            .where(
              eq(this.tables.importManifests.sourceFileId, this.tables.files.id)
            )
        )
      );

    if (this.hasD1Batch()) {
      const nowMs = now.getTime();
      const scope = unreferencedPredicate(this.db);
      const insertAudit = this.db.insert(this.tables.auditEntries).select(
        this.db
          .select({
            id: sql`NULL`.as('id'),
            communityId:
              file.communityId === null
                ? sql`NULL`.as('community_id')
                : this.tables.files.communityId,
            actorId: sql`${audit.actorId}`.as('actor_id'),
            action: sql`${audit.action}`.as('action'),
            resourceType: sql`${audit.resourceType}`.as('resource_type'),
            resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
              'resource_ids'
            ),
            outcome: sql`${audit.outcome}`.as('outcome'),
            ipAddress: sql`NULL`.as('ip_address'),
            userAgent: sql`NULL`.as('user_agent'),
            createdAt: sql`${nowMs}`.as('created_at'),
          })
          .from(this.tables.files)
          .where(scope)
      );
      const deleteRow = this.db
        .delete(this.tables.files)
        .where(scope)
        .returning({ id: this.tables.files.id });
      const checkExists = this.db
        .select({ id: this.tables.files.id })
        .from(this.tables.files)
        .where(
          and(
            eq(this.tables.files.id, fileId),
            activeUnrestrictedFileCondition(
              this.tables.files,
              file.communityId ?? undefined
            )
          )
        )
        .limit(1);

      const [, deletedRows, remainingRows] = await this.db.batch([
        insertAudit,
        deleteRow,
        checkExists,
      ]);
      if (Array.isArray(deletedRows) && deletedRows.length > 0) {
        return {
          status: 'deleted',
          storageKey,
          communityId: file.communityId,
        };
      }
      return Array.isArray(remainingRows) && remainingRows.length > 0
        ? { status: 'conflict' }
        : { status: 'not_found' };
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const locked = await tx
          .select({
            id: this.tables.files.id,
            isActive: this.tables.files.isActive,
            culturalRestrictions: this.tables.files.culturalRestrictions,
          })
          .from(this.tables.files)
          .where(
            and(
              eq(this.tables.files.id, fileId),
              file.communityId === null
                ? isNull(this.tables.files.communityId)
                : eq(this.tables.files.communityId, file.communityId)
            )
          )
          .for('update');
        const current = locked[0];
        if (
          !current ||
          !current.isActive ||
          current.culturalRestrictions !== null
        ) {
          return { status: 'not_found' };
        }
        try {
          const deleted = await tx
            .delete(this.tables.files)
            .where(unreferencedPredicate(tx))
            .returning({ id: this.tables.files.id });
          if (deleted.length === 0) {
            return { status: 'conflict' };
          }
          await tx.insert(this.tables.auditEntries).values({
            ...audit,
            createdAt: now,
          });
          return {
            status: 'deleted',
            storageKey,
            communityId: file.communityId,
          };
        } catch (error) {
          if (
            isForeignKeyConstraintError(error) ||
            isNotNullConstraintError(error)
          ) {
            return { status: 'conflict' };
          }
          throw error;
        }
      });
    }

    return this.db.transaction((tx: typeof this.db) => {
      const current = tx
        .select({
          id: this.tables.files.id,
          isActive: this.tables.files.isActive,
          culturalRestrictions: this.tables.files.culturalRestrictions,
        })
        .from(this.tables.files)
        .where(
          and(
            eq(this.tables.files.id, fileId),
            file.communityId === null
              ? isNull(this.tables.files.communityId)
              : eq(this.tables.files.communityId, file.communityId)
          )
        )
        .limit(1)
        .all()[0];
      if (
        !current ||
        !current.isActive ||
        current.culturalRestrictions !== null
      ) {
        return { status: 'not_found' };
      }
      const deleted = tx
        .delete(this.tables.files)
        .where(unreferencedPredicate(tx))
        .returning({ id: this.tables.files.id })
        .all();
      if (deleted.length === 0) {
        return { status: 'conflict' };
      }
      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();
      return {
        status: 'deleted',
        storageKey,
        communityId: file.communityId,
      };
    });
  }

  /**
   * §6.7 attachment change authority. Resolves the owning resource inside one
   * tenant and fails closed: an owner that exists but is restricted or has
   * unknown privacy is a 404 (never a 403 existence oracle), while a caller
   * without the owner's change authority is a 403.
   */
  private async authorizeAttachmentOwner(input: {
    actor: FoundationUser;
    ownerType: AttachmentOwnerType;
    ownerId: number;
    role: AttachmentRole;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor?: any;
    lock?: 'update' | 'share' | 'key share';
  }): Promise<AttachmentOwnerResolution> {
    const ex = input.executor ?? this.db;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lock = (query: any): any => {
      if (!input.lock) return query;
      // SQLite/D1 select builders have no `.for()` — row locks are a
      // PostgreSQL feature. Writers serialize there, so the lock is a no-op.
      if (typeof query.for !== 'function') return query;
      if (input.lock === 'update') return query.for('update');
      if (input.lock === 'key share') return query.for('key share');
      return query.for('share');
    };
    const one = async (query: {
      all?: () => Promise<unknown[]> | unknown[];
    }): Promise<boolean> => (await this.fetchAll(query)).length > 0;

    if (input.actor.communityId === null) {
      // Null-community exception: super_admin's own user_photo only.
      if (
        input.actor.role !== 'super_admin' ||
        input.ownerType !== 'user' ||
        input.role !== 'user_photo' ||
        input.ownerId !== input.actor.id
      ) {
        return { status: 'forbidden' };
      }
      const exists = await one(
        lock(
          ex
            .select({ id: this.tables.users.id })
            .from(this.tables.users)
            .where(
              and(
                eq(this.tables.users.id, input.actor.id),
                isNull(this.tables.users.communityId),
                eq(this.tables.users.role, 'super_admin'),
                eq(this.tables.users.isActive, true)
              )
            )
        ).limit(1)
      );
      return exists
        ? { status: 'ok', communityId: null }
        : { status: 'not_found' };
    }

    const communityId = input.actor.communityId;
    // The check must run on the caller's executor (usually the transaction's
    // reserved connection), otherwise a two-connection pool starves when the
    // other request holds the remaining connection: both wait forever.
    const active = await this.isCommunityActive(communityId, ex);
    if (!active) {
      return { status: 'forbidden' };
    }
    const viewer = ownCommunityViewerForRole(input.actor.role);
    if (!viewer) {
      return { status: 'forbidden' };
    }
    const isEditor = viewer === 'own-editor' || viewer === 'own-admin';
    const isAdmin = viewer === 'own-admin';

    if (input.ownerType === 'story') {
      if (!isEditor) return { status: 'forbidden' };
      if (input.role !== 'story_media') return { status: 'not_found' };
      const exists = await one(
        lock(
          ex
            .select({ id: this.tables.stories.id })
            .from(this.tables.stories)
            .where(
              and(
                storyConditionForViewer(
                  this.tables.stories,
                  communityId,
                  viewer
                ),
                eq(this.tables.stories.id, input.ownerId)
              )
            )
        ).limit(1)
      );
      return exists ? { status: 'ok', communityId } : { status: 'not_found' };
    }

    if (input.ownerType === 'place') {
      if (!isEditor) return { status: 'forbidden' };
      if (input.role !== 'place_photo' && input.role !== 'place_name_audio') {
        return { status: 'not_found' };
      }
      const exists = await one(
        lock(
          ex
            .select({ id: this.tables.places.id })
            .from(this.tables.places)
            .where(
              and(
                readablePlaceConditionForViewer(
                  ex,
                  this.tables,
                  communityId,
                  viewer
                ),
                eq(this.tables.places.id, input.ownerId)
              )
            )
        ).limit(1)
      );
      return exists ? { status: 'ok', communityId } : { status: 'not_found' };
    }

    if (input.ownerType === 'speaker') {
      if (!isEditor) return { status: 'forbidden' };
      if (input.role !== 'speaker_photo') return { status: 'not_found' };
      const exists = await one(
        lock(
          ex
            .select({ id: this.tables.speakers.id })
            .from(this.tables.speakers)
            .where(
              and(
                readableSpeakerConditionForViewer(
                  ex,
                  this.tables,
                  communityId,
                  viewer
                ),
                eq(this.tables.speakers.id, input.ownerId)
              )
            )
        ).limit(1)
      );
      return exists ? { status: 'ok', communityId } : { status: 'not_found' };
    }

    if (input.ownerType === 'user') {
      if (input.role !== 'user_photo') return { status: 'not_found' };
      // Account owner or same-community admin with user-management authority.
      if (input.actor.id !== input.ownerId && !isAdmin) {
        return { status: 'forbidden' };
      }
      const exists = await one(
        lock(
          ex
            .select({ id: this.tables.users.id })
            .from(this.tables.users)
            .where(
              and(
                eq(this.tables.users.id, input.ownerId),
                eq(this.tables.users.communityId, communityId),
                eq(this.tables.users.isActive, true)
              )
            )
        ).limit(1)
      );
      return exists ? { status: 'ok', communityId } : { status: 'not_found' };
    }

    if (input.ownerType === 'community') {
      if (!isAdmin) return { status: 'forbidden' };
      if (
        input.role !== 'community_display_image' &&
        input.role !== 'community_background_image' &&
        input.role !== 'sponsor_logo'
      ) {
        return { status: 'not_found' };
      }
      if (input.ownerId !== communityId) return { status: 'not_found' };
      return { status: 'ok', communityId };
    }

    // map_config: owner id is the owning community's id.
    if (!isAdmin) return { status: 'forbidden' };
    if (input.role !== 'static_map' || input.ownerId !== communityId) {
      return { status: 'not_found' };
    }
    const exists = await one(
      lock(
        ex
          .select({ communityId: this.tables.communityMapConfigs.communityId })
          .from(this.tables.communityMapConfigs)
          .where(eq(this.tables.communityMapConfigs.communityId, communityId))
      ).limit(1)
    );
    return exists ? { status: 'ok', communityId } : { status: 'not_found' };
  }

  /**
   * §6.7 reuse rule: adding/reusing a relation that broadens the bytes'
   * audience requires publishing authority over every affected owner.
   *
   * A file with no relations is private staging (§6.7): only its uploader or a
   * same-community admin may attach it. A file that already carries relations
   * may be reused only when the actor resolves `authorizeAttachmentOwner` on
   * every existing owner; a restricted, unknown-privacy or unreadable owner
   * fails closed as 404, uniformly with not-found. The caller must already
   * hold change authority on the target owner.
   *
   * PostgreSQL: the caller takes FOR UPDATE on the `files` row first and
   * re-runs this check under that lock, so concurrent attaches of the same
   * file serialize and authority is judged against the post-lock relation set.
   * D1/SQLite: no FOR UPDATE exists in those drivers, so this is a
   * check-then-act pair that cannot be made atomic with the insert — the
   * residual race is bounded: an interposed relation may only be added by an
   * actor who independently resolves their own attach authority over its
   * owner, and the staging branch only admits the uploader (or a
   * same-community admin), so the bytes never widen their audience beyond the
   * uploader's own choice.
   */
  async authorizeAttachReuse(input: {
    actor: FoundationUser;
    communityId: number | null;
    file: Pick<StoredFileRecord, 'id' | 'uploadedBy'>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor?: any;
    lock?: 'update' | 'share' | 'key share';
  }): Promise<
    { ok: true } | { ok: false; outcome: 'not_found' | 'forbidden' }
  > {
    const ex = input.executor ?? this.db;
    const rows = (await this.fetchAll(
      ex
        .select({
          ownerType: this.tables.attachments.ownerType,
          ownerId: this.tables.attachments.ownerId,
          role: this.tables.attachments.role,
        })
        .from(this.tables.attachments)
        .where(
          and(
            eq(this.tables.attachments.fileId, input.file.id),
            input.communityId === null
              ? isNull(this.tables.attachments.communityId)
              : eq(this.tables.attachments.communityId, input.communityId)
          )
        )
    )) as Array<{
      ownerType: AttachmentOwnerType | null;
      ownerId: number | null;
      role: AttachmentRole | null;
    }>;

    if (rows.length === 0) {
      // No usable relation evidence: fail closed. An unattached staging object
      // is only attachable by its uploader or a same-community admin; a row
      // with an unreadable owner shape never widens the bytes' audience.
      if (
        input.file.uploadedBy !== null &&
        input.file.uploadedBy === input.actor.id
      ) {
        return { ok: true };
      }
      const viewer = ownCommunityViewerForRole(input.actor.role);
      if (input.communityId !== null && viewer === 'own-admin') {
        return { ok: true };
      }
      return { ok: false, outcome: 'not_found' };
    }

    for (const row of rows) {
      if (!row.ownerType || row.ownerId === null || !row.role) {
        return { ok: false, outcome: 'not_found' };
      }
      const authority = await this.authorizeAttachmentOwner({
        actor: input.actor,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        role: row.role,
        executor: ex,
        lock: input.lock,
      });
      if (authority.status !== 'ok') return { ok: false, outcome: 'not_found' };
    }
    return { ok: true };
  }

  /**
   * Owner-row existence guard for D1 writes. The owner check and the write
   * run in separate statements, so an owner deleted between them would
   * otherwise let a write match nothing / a placeholder attach with no
   * owner. Every guarded D1 statement carries an EXISTS (or sources rows
   * from this select) straight inside its own SQL. Mirrors the readability
   * verdicts in `authorizeAttachmentOwner`: same community, same owner type,
   * same read gate. Anything unexpected fails closed (`1 = 0`).
   */
  private ownerSource(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    input: {
      ownerType: AttachmentOwnerType;
      ownerId: number;
      role: AttachmentRole;
      communityId: number | null;
      viewer: ReadRuleViewer | null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { table: any; where: any } {
    const t = this.tables;
    const cid = input.communityId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closed: { table: any; where: any } = {
      table: t.stories,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: sql`1 = 0` as any,
    };

    if (input.ownerType === 'story') {
      if (cid === null || !input.viewer) return closed;
      return {
        table: t.stories,
        where: and(
          eq(t.stories.id, input.ownerId),
          storyConditionForViewer(t.stories, cid, input.viewer)
        ),
      };
    }
    if (input.ownerType === 'place') {
      if (cid === null || !input.viewer) return closed;
      return {
        table: t.places,
        where: and(
          eq(t.places.id, input.ownerId),
          readablePlaceConditionForViewer(
            executor,
            this.tables,
            cid,
            input.viewer
          )
        ),
      };
    }
    if (input.ownerType === 'speaker') {
      if (cid === null || !input.viewer) return closed;
      return {
        table: t.speakers,
        where: and(
          eq(t.speakers.id, input.ownerId),
          readableSpeakerConditionForViewer(
            executor,
            this.tables,
            cid,
            input.viewer
          )
        ),
      };
    }
    if (input.ownerType === 'user') {
      if (cid !== null) {
        return {
          table: t.users,
          where: and(
            eq(t.users.id, input.ownerId),
            eq(t.users.communityId, cid),
            eq(t.users.isActive, true)
          ),
        };
      }
      return {
        table: t.users,
        where: and(
          eq(t.users.id, input.ownerId),
          isNull(t.users.communityId),
          eq(t.users.role, 'super_admin'),
          eq(t.users.isActive, true)
        ),
      };
    }
    if (input.ownerType === 'community') {
      if (cid === null) return closed;
      return {
        table: t.communities,
        where: and(
          eq(t.communities.id, input.ownerId),
          eq(t.communities.id, cid),
          eq(t.communities.isActive, true)
        ),
      };
    }
    // map_config: the owner row IS the map-config row for the community.
    if (cid === null) return closed;
    return {
      table: t.communityMapConfigs,
      where: and(
        eq(t.communityMapConfigs.communityId, cid),
        eq(t.communityMapConfigs.communityId, input.ownerId)
      ),
    };
  }

  /**
   * `EXISTS (owner still present, same community, still readable)` as a
   * condition to splice into a guarded UPDATE/DELETE WHERE clause.
   */
  private ownerExistsCondition(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    input: {
      ownerType: AttachmentOwnerType;
      ownerId: number;
      role: AttachmentRole;
      communityId: number | null;
      viewer: ReadRuleViewer | null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    const source = this.ownerSource(executor, input);
    return exists(
      executor
        .select({ one: sql`1` })
        .from(source.table)
        .where(source.where)
    );
  }

  private async resolveAttachableFile(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
    fileId: string,
    communityId: number | null
  ): Promise<StoredFileRecord | null> {
    const rows = (await this.fetchAll(
      executor
        .select({
          id: this.tables.files.id,
          communityId: this.tables.files.communityId,
          storageKey: this.tables.files.storageKey,
          path: this.tables.files.path,
          originalName: this.tables.files.originalName,
          mimeType: this.tables.files.mimeType,
          byteSize: this.tables.files.byteSize,
          size: this.tables.files.size,
          checksum: this.tables.files.checksum,
          uploadedBy: this.tables.files.uploadedBy,
          metadata: this.tables.files.metadata,
          isActive: this.tables.files.isActive,
          culturalRestrictions: this.tables.files.culturalRestrictions,
          createdAt: this.tables.files.createdAt,
        })
        .from(this.tables.files)
        .where(eq(this.tables.files.id, fileId))
        .limit(1)
    )) as Array<{
      id: string;
      communityId: number | null;
      storageKey: string | null;
      path: string;
      originalName: string;
      mimeType: string;
      byteSize: number | null;
      size: number | null;
      checksum: string | null;
      uploadedBy: number | null;
      metadata: unknown;
      isActive: boolean;
      culturalRestrictions: unknown;
      createdAt: Date | number | string;
    }>;
    const row = rows[0];
    if (!row || !row.isActive || row.culturalRestrictions !== null) {
      return null;
    }
    // §6.7 null-community check: a null-community attachment may only
    // reference a null-community file (super_admin own user_photo).
    if (row.communityId !== communityId) {
      return null;
    }
    return {
      id: row.id,
      communityId: row.communityId,
      storageKey: row.storageKey ?? row.path,
      originalName: row.originalName,
      mimeType: row.mimeType,
      byteSize: Number(row.byteSize ?? row.size),
      checksum: row.checksum,
      uploadedBy: row.uploadedBy,
      metadata: parseMetadataField(row.metadata),
      isActive: row.isActive,
      culturalRestrictions: row.culturalRestrictions,
      createdAt: toDate(row.createdAt),
    };
  }

  private attachmentScope(
    communityId: number | null,
    ownerType: AttachmentOwnerType,
    ownerId: number,
    role: AttachmentRole
  ) {
    return and(
      communityId === null
        ? isNull(this.tables.attachments.communityId)
        : eq(this.tables.attachments.communityId, communityId),
      eq(this.tables.attachments.ownerType, ownerType),
      eq(this.tables.attachments.ownerId, ownerId),
      eq(this.tables.attachments.role, role)
    );
  }

  private toAttachmentRecord(
    file: StoredFileRecord,
    row: {
      id: number;
      ordinal: number | null;
      createdAt: Date | number | string;
    },
    owner?: {
      ownerType: AttachmentOwnerType;
      ownerId: number;
      role: AttachmentRole;
    }
  ): AttachmentRecord {
    return {
      id: row.id,
      fileId: file.id,
      ownerType: owner?.ownerType ?? 'user',
      ownerId: owner?.ownerId ?? 0,
      role: owner?.role ?? 'user_photo',
      ordinal: Number(row.ordinal ?? 0),
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      originalName: file.originalName,
      createdAt: toDate(row.createdAt),
    };
  }

  /** Drizzle's SQLite/D1 builders expose `.all()`; PostgreSQL builders await. */
  private async fetchAll(query: {
    all?: () => Promise<unknown[]> | unknown[];
  }): Promise<unknown[]> {
    if (typeof query.all === 'function') {
      return await query.all();
    }
    return await (query as Promise<unknown[]>);
  }

  private attachmentTypeMatches(
    role: AttachmentRole,
    mimeType: string
  ): boolean {
    const allowed = ATTACHMENT_ROLE_ALLOWED_CATEGORIES[role];
    const rule = MEDIA_MIME_RULES[mimeType];
    return rule !== undefined && allowed.includes(rule.category);
  }

  /**
   * `files` row of an upload that is still active staging in this community
   * (#282). `createAttachment` resolves the upload before its write, and a
   * preview may hold the upload in between: the hold deactivates the row, and
   * a held upload must never be attached to. So every backend repeats this
   * condition at the write itself — under the row lock on PostgreSQL, inside
   * the transaction on SQLite, inside each statement of the batch on D1.
   */
  private stagingFileCondition(fileId: string, communityId: number | null) {
    const files = this.tables.files;
    return and(
      eq(files.id, fileId),
      eq(files.isActive, true),
      communityId === null
        ? isNull(files.communityId)
        : eq(files.communityId, communityId)
    );
  }

  async createAttachment(input: {
    actor: FoundationUser;
    fileId: string;
    ownerType: AttachmentOwnerType;
    ownerId: number;
    role: AttachmentRole;
    ordinal?: number;
    now?: Date;
  }): Promise<AttachmentWriteOutcome> {
    const now = input.now ?? new Date();
    const audit = buildMediaAuditEntry({
      communityId: input.actor.communityId,
      actorId: input.actor.id,
      action: 'attachment.create',
      resourceIds: [input.fileId, input.ownerId],
      outcome: 'success',
      kind: 'attachment',
    });

    if (this.hasD1Batch()) {
      const authority = await this.authorizeAttachmentOwner({
        actor: input.actor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        role: input.role,
      });
      if (authority.status !== 'ok') return authority;
      const file = await this.resolveAttachableFile(
        this.db,
        input.fileId,
        authority.communityId
      );
      if (!file) return { status: 'not_found' };
      const reuse = await this.authorizeAttachReuse({
        actor: input.actor,
        communityId: authority.communityId,
        file,
        executor: this.db,
        // D1/SQLite serialize writers and their select builders have no
        // `.for()`; row locks are PostgreSQL-only.
      });
      if (!reuse.ok) return { status: reuse.outcome };
      if (!this.attachmentTypeMatches(input.role, file.mimeType)) {
        return { status: 'type_mismatch' };
      }

      // INSERT ... SELECT with the owner still present in the same
      // statement, so an owner deleted between `authorizeAttachmentOwner` and
      // this batch makes the statement produce no row (mapped to 404) — a
      // missing owner can never leave an orphaned attachment behind. The
      // audit write carries the same guard.
      //
      // The upload, too, is read as active staging before this batch. A
      // preview that held it meanwhile deactivated the row (#282), and a held
      // upload must never be attached to: both statements carry that guard as
      // well, because a statement that matches no row is no error in a D1
      // batch, so neither the relation nor its success audit may be written
      // on its own.
      const ownerSource = this.ownerSource(this.db, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        role: input.role,
        communityId: authority.communityId,
        viewer: ownCommunityViewerForRole(input.actor.role),
      });
      const guarded = and(
        ownerSource.where,
        exists(
          this.db
            .select({ one: sql`1` })
            .from(this.tables.files)
            .where(
              this.stagingFileCondition(input.fileId, authority.communityId)
            )
        )
      );
      // The next ordinal is computed inside the statement (a scalar
      // subquery over the same owner/role in this transaction), so two
      // inserts reading the owner's current max in one batch — or two
      // sequential batches — cannot both take the same slot.
      const ordinalSql =
        input.ordinal !== undefined
          ? sql`${input.ordinal}`
          : sql`coalesce((select max(${this.tables.attachments.ordinal}) from ${this.tables.attachments} where ${this.attachmentScope(
              authority.communityId,
              input.ownerType,
              input.ownerId,
              input.role
            )}), -1) + 1`;
      const insertAttachment = this.db
        .insert(this.tables.attachments)
        .select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId:
                authority.communityId === null
                  ? sql`NULL`.as('community_id')
                  : sql`${authority.communityId}`.as('community_id'),
              fileId: sql`${input.fileId}`.as('file_id'),
              ownerType: sql`${input.ownerType}`.as('owner_type'),
              ownerId: sql`${input.ownerId}`.as('owner_id'),
              role: sql`${input.role}`.as('role'),
              ordinal: ordinalSql.as('ordinal'),
              attachableId: sql`NULL`.as('attachable_id'),
              attachableType: sql`NULL`.as('attachable_type'),
              url: sql`NULL`.as('url'),
              filename: sql`NULL`.as('filename'),
              contentType: sql`NULL`.as('content_type'),
              fileSize: sql`NULL`.as('file_size'),
              createdAt: sql`${now.getTime()}`.as('created_at'),
            })
            .from(ownerSource.table)
            .where(guarded)
        )
        .returning({
          id: this.tables.attachments.id,
          ordinal: this.tables.attachments.ordinal,
          createdAt: this.tables.attachments.createdAt,
        });
      const insertAudit = this.db.insert(this.tables.auditEntries).select(
        this.db
          .select({
            id: sql`NULL`.as('id'),
            communityId:
              authority.communityId === null
                ? sql`NULL`.as('community_id')
                : sql`${authority.communityId}`.as('community_id'),
            actorId: sql`${audit.actorId}`.as('actor_id'),
            action: sql`${audit.action}`.as('action'),
            resourceType: sql`${audit.resourceType}`.as('resource_type'),
            resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
              'resource_ids'
            ),
            outcome: sql`${audit.outcome}`.as('outcome'),
            ipAddress: sql`NULL`.as('ip_address'),
            userAgent: sql`NULL`.as('user_agent'),
            createdAt: sql`${now.getTime()}`.as('created_at'),
          })
          .from(ownerSource.table)
          .where(guarded)
      );
      try {
        const [attRows] = await this.db.batch([insertAttachment, insertAudit]);
        const att = Array.isArray(attRows) ? attRows[0] : undefined;
        if (!att) return { status: 'not_found' };
        return {
          status: 'created',
          attachment: {
            ...this.toAttachmentRecord(file, att),
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            role: input.role,
          },
        };
      } catch (error) {
        if (
          isForeignKeyConstraintError(error) ||
          isNotNullConstraintError(error)
        ) {
          return { status: 'not_found' };
        }
        throw error;
      }
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        // A disabled community is forbidden for every owner check (§6.5):
        // answer 403 uniformly before any lock or verdict runs — matching
        // D1/SQLite, whose target-first authority check yields the same 403 —
        // instead of leaking which non-target owners the actor may see.
        if (
          input.actor.communityId !== null &&
          !(await this.isCommunityActive(input.actor.communityId, tx))
        ) {
          return { status: 'forbidden' };
        }
        // §6.7: lock *every* owner involved in this attach in canonical
        // (ownerType, ownerId) order before anything else. The mutation target
        // locks FOR UPDATE as before; owners of the file's existing relations
        // lock FOR KEY SHARE (which only conflicts with UPDATE/DELETE) and are
        // taken in the same canonical order, so two cross-attaches of one file
        // walk the shared lock graph in an identical order and cannot deadlock
        // against each other.
        const actorCommunity = input.actor.communityId;
        const attachmentScope =
          actorCommunity === null
            ? isNull(this.tables.attachments.communityId)
            : eq(this.tables.attachments.communityId, actorCommunity);
        const existingRows = (await this.fetchAll(
          tx
            .select({
              ownerType: this.tables.attachments.ownerType,
              ownerId: this.tables.attachments.ownerId,
              role: this.tables.attachments.role,
            })
            .from(this.tables.attachments)
            .where(
              and(
                eq(this.tables.attachments.fileId, input.fileId),
                attachmentScope
              )
            )
        )) as Array<{
          ownerType: AttachmentOwnerType | null;
          ownerId: number | null;
          role: AttachmentRole | null;
        }>;
        const involved = new Map<
          string,
          {
            ownerType: AttachmentOwnerType;
            ownerId: number;
            role: AttachmentRole;
            isTarget: boolean;
          }
        >();
        involved.set(`${input.ownerType}:${input.ownerId}`, {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          role: input.role,
          isTarget: true,
        });
        for (const row of existingRows) {
          // Unreadable-shape relation: widens nothing (§6.7); fail closed.
          if (!row.ownerType || row.ownerId === null || !row.role) {
            return { status: 'not_found' };
          }
          const key = `${row.ownerType}:${row.ownerId}`;
          if (involved.has(key)) continue;
          involved.set(key, {
            ownerType: row.ownerType,
            ownerId: row.ownerId,
            role: row.role,
            isTarget: false,
          });
        }
        const owners = [...involved.values()].sort((a, b) =>
          a.ownerType === b.ownerType
            ? a.ownerId - b.ownerId
            : a.ownerType.localeCompare(b.ownerType)
        );
        let authority: AttachmentOwnerResolution | undefined;
        // Locks follow the canonical owner order, but verdicts do not: the
        // target owner's verdict decides first (as on D1/SQLite, which check
        // the target before reuse), and a failing non-target owner only
        // collapses to 404 once the target itself has been authorised.
        let nonTargetRejected = false;
        for (const owner of owners) {
          const resolved = await this.authorizeAttachmentOwner({
            actor: input.actor,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            role: owner.role,
            executor: tx,
            lock: owner.isTarget ? 'update' : 'key share',
          });
          if (owner.isTarget) {
            if (resolved.status !== 'ok') return resolved;
            authority = resolved;
            continue;
          }
          // An existing relation whose owner is restricted, unreadable, not
          // publishable by this actor — or simply not this actor's to authorise —
          // widens nothing (§6.7): 404, uniform with absence. A disabled
          // community was already answered 403 once, above the loop.
          if (resolved.status !== 'ok') nonTargetRejected = true;
        }
        if (!authority || authority.status !== 'ok' || nonTargetRejected) {
          return { status: 'not_found' };
        }
        const file = await this.resolveAttachableFile(
          tx,
          input.fileId,
          authority.communityId
        );
        if (!file) return { status: 'not_found' };
        if (!this.attachmentTypeMatches(input.role, file.mimeType)) {
          return { status: 'type_mismatch' };
        }
        // Serialize concurrent attaches of this file against its own row and
        // against an in-flight unreferenced-file delete, which also takes
        // FOR UPDATE before its guarded delete. Whichever transaction gets
        // the files row first wins: a delete that commits first makes this
        // attach fail closed with 404 instead of inserting a relation that
        // would be cascaded away.
        const lockedFiles = await tx
          .select({ id: this.tables.files.id })
          .from(this.tables.files)
          .where(eq(this.tables.files.id, input.fileId))
          .for('update');
        if (lockedFiles.length === 0) return { status: 'not_found' };
        // The upload was read as active staging before the lock, and the lock
        // may have waited for a preview that now holds it (#282): the hold
        // deactivates the row. Judge the upload again now that no other
        // writer can change it, so a held upload is never attached to.
        const [staging] = await tx
          .select({ id: this.tables.files.id })
          .from(this.tables.files)
          .where(this.stagingFileCondition(input.fileId, authority.communityId))
          .limit(1);
        if (!staging) return { status: 'not_found' };
        // Re-run the reuse check under the files row lock: any relation whose
        // attach committed before this statement's snapshot is visible now, so
        // §6.7 authority is judged against the post-lock state rather than a
        // stale pre-lock read. No owner lock is taken here: every PG attach
        // insert and every files delete already holds this files row FOR
        // UPDATE, so the relation set cannot grow while this transaction runs,
        // and acquiring an owner lock after the files lock would invert the
        // canonical owner-before-file order and could deadlock a concurrent
        // attach that holds that owner (#140).
        const reuse = await this.authorizeAttachReuse({
          actor: input.actor,
          communityId: authority.communityId,
          file,
          executor: tx,
        });
        if (!reuse.ok) return { status: reuse.outcome };
        const maxRows = await tx
          .select({
            maxOrd: sql<number>`COALESCE(MAX(${this.tables.attachments.ordinal}), -1)`,
          })
          .from(this.tables.attachments)
          .where(
            this.attachmentScope(
              authority.communityId,
              input.ownerType,
              input.ownerId,
              input.role
            )
          );
        const ordinal = input.ordinal ?? Number(maxRows[0]?.maxOrd ?? -1) + 1;
        try {
          const [att] = await tx
            .insert(this.tables.attachments)
            .values({
              communityId: authority.communityId,
              fileId: input.fileId,
              ownerType: input.ownerType,
              ownerId: input.ownerId,
              role: input.role,
              ordinal,
              createdAt: now,
            })
            .returning({
              id: this.tables.attachments.id,
              ordinal: this.tables.attachments.ordinal,
              createdAt: this.tables.attachments.createdAt,
            });
          await tx.insert(this.tables.auditEntries).values({
            ...audit,
            createdAt: now,
          });
          return {
            status: 'created',
            attachment: {
              ...this.toAttachmentRecord(file, att),
              ownerType: input.ownerType,
              ownerId: input.ownerId,
              role: input.role,
            },
          };
        } catch (error) {
          if (
            isForeignKeyConstraintError(error) ||
            isNotNullConstraintError(error)
          ) {
            return { status: 'not_found' };
          }
          throw error;
        }
      });
    }

    const authority = await this.authorizeAttachmentOwner({
      actor: input.actor,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      role: input.role,
    });
    if (authority.status !== 'ok') return authority;
    const file = await this.resolveAttachableFile(
      this.db,
      input.fileId,
      authority.communityId
    );
    if (!file) return { status: 'not_found' };
    const reuse = await this.authorizeAttachReuse({
      actor: input.actor,
      communityId: authority.communityId,
      file,
      executor: this.db,
    });
    if (!reuse.ok) return { status: reuse.outcome };
    if (!this.attachmentTypeMatches(input.role, file.mimeType)) {
      return { status: 'type_mismatch' };
    }

    return this.db.transaction((tx: typeof this.db) => {
      // The reads above run outside this transaction, so a preview may have
      // held the upload in between (#282): the hold deactivates the row, and
      // a held upload must never be attached to.
      const staging = tx
        .select({ id: this.tables.files.id })
        .from(this.tables.files)
        .where(this.stagingFileCondition(input.fileId, authority.communityId))
        .limit(1)
        .all();
      if (staging.length === 0) return { status: 'not_found' };
      const maxRows = tx
        .select({
          maxOrd: sql<number>`COALESCE(MAX(${this.tables.attachments.ordinal}), -1)`,
        })
        .from(this.tables.attachments)
        .where(
          this.attachmentScope(
            authority.communityId,
            input.ownerType,
            input.ownerId,
            input.role
          )
        )
        .all();
      const ordinal = input.ordinal ?? Number(maxRows[0]?.maxOrd ?? -1) + 1;
      try {
        const att = tx
          .insert(this.tables.attachments)
          .values({
            communityId: authority.communityId,
            fileId: input.fileId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            role: input.role,
            ordinal,
            createdAt: now,
          })
          .returning({
            id: this.tables.attachments.id,
            ordinal: this.tables.attachments.ordinal,
            createdAt: this.tables.attachments.createdAt,
          })
          .get();
        tx.insert(this.tables.auditEntries)
          .values({
            ...audit,
            createdAt: now,
          })
          .run();
        return {
          status: 'created',
          attachment: {
            ...this.toAttachmentRecord(file, att),
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            role: input.role,
          },
        };
      } catch (error) {
        if (
          isForeignKeyConstraintError(error) ||
          isNotNullConstraintError(error)
        ) {
          return { status: 'not_found' };
        }
        throw error;
      }
    });
  }

  async reorderAttachments(input: {
    actor: FoundationUser;
    ownerType: AttachmentOwnerType;
    ownerId: number;
    role: AttachmentRole;
    attachmentIds: number[];
    now?: Date;
  }): Promise<AttachmentWriteOutcome> {
    const now = input.now ?? new Date();
    const audit = buildMediaAuditEntry({
      communityId: input.actor.communityId,
      actorId: input.actor.id,
      action: 'attachment.reorder',
      resourceIds: input.attachmentIds,
      outcome: 'success',
      kind: 'attachment',
    });

    const scope = this.attachmentScope(
      input.actor.communityId,
      input.ownerType,
      input.ownerId,
      input.role
    );
    const scopeFor = (communityId: number | null) =>
      this.attachmentScope(
        communityId,
        input.ownerType,
        input.ownerId,
        input.role
      );

    const validateIds = (
      rows: Array<{ id: number; fileId: string | null }>
    ): boolean => {
      const existing = new Set(
        rows.filter((row) => row.fileId !== null).map((row) => row.id)
      );
      return (
        existing.size === input.attachmentIds.length &&
        input.attachmentIds.every((id) => existing.has(id))
      );
    };

    const readBack = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: any,
      communityId: number | null
    ): Promise<AttachmentRecord[]> => {
      const rows = (await executor
        .select({
          id: this.tables.attachments.id,
          fileId: this.tables.attachments.fileId,
          ordinal: this.tables.attachments.ordinal,
          createdAt: this.tables.attachments.createdAt,
        })
        .from(this.tables.attachments)
        .where(scopeFor(communityId))) as Array<{
        id: number;
        fileId: string | null;
        ordinal: number | null;
        createdAt: Date | number | string;
      }>;
      const fileIds = rows
        .map((row) => row.fileId)
        .filter((id): id is string => typeof id === 'string');
      const fileRows = fileIds.length
        ? ((await executor
            .select({
              id: this.tables.files.id,
              originalName: this.tables.files.originalName,
              mimeType: this.tables.files.mimeType,
              byteSize: this.tables.files.byteSize,
              size: this.tables.files.size,
            })
            .from(this.tables.files)
            .where(inArray(this.tables.files.id, fileIds))) as Array<{
            id: string;
            originalName: string;
            mimeType: string;
            byteSize: number | null;
            size: number | null;
          }>)
        : [];
      const byId = new Map(fileRows.map((row) => [row.id, row]));
      return rows
        .map((row) => {
          const file = row.fileId ? byId.get(row.fileId) : undefined;
          if (!file) return null;
          return {
            id: row.id,
            fileId: row.fileId as string,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            role: input.role,
            ordinal: Number(row.ordinal ?? 0),
            mimeType: file.mimeType,
            byteSize: Number(file.byteSize ?? file.size),
            originalName: file.originalName,
            createdAt: toDate(row.createdAt),
          } satisfies AttachmentRecord;
        })
        .filter((row): row is AttachmentRecord => row !== null)
        .sort((a, b) => a.ordinal - b.ordinal || a.id - b.id);
    };

    if (this.hasD1Batch()) {
      const authority = await this.authorizeAttachmentOwner({
        actor: input.actor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        role: input.role,
      });
      if (authority.status !== 'ok') return authority;
      const existing = (await this.db
        .select({
          id: this.tables.attachments.id,
          fileId: this.tables.attachments.fileId,
        })
        .from(this.tables.attachments)
        .where(scopeFor(authority.communityId))) as Array<{
        id: number;
        fileId: string | null;
      }>;
      if (!validateIds(existing)) {
        // Distinguish an invalid set from an owner deleted between the
        // authority check and this read.
        const ownerSource = this.ownerSource(this.db, {
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          role: input.role,
          communityId: authority.communityId,
          viewer: ownCommunityViewerForRole(input.actor.role),
        });
        const ownerRows = await this.db
          .select({ one: sql`1` })
          .from(ownerSource.table)
          .where(ownerSource.where)
          .limit(1);
        return Array.isArray(ownerRows) && ownerRows.length > 0
          ? { status: 'invalid_set' }
          : { status: 'not_found' };
      }
      const ownerExists = this.ownerExistsCondition(this.db, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        role: input.role,
        communityId: authority.communityId,
        viewer: ownCommunityViewerForRole(input.actor.role),
      });
      const ownerSource = this.ownerSource(this.db, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        role: input.role,
        communityId: authority.communityId,
        viewer: ownCommunityViewerForRole(input.actor.role),
      });
      // One bounded D1 batch: one UPDATE per attachment (<= 4 bound params
      // each) plus the content-free audit entry. Every statement re-checks
      // the owner (same transaction's snapshot), so an owner deleted
      // between `authorizeAttachmentOwner` and this batch makes the writes
      // no-ops and the delete verdict 404 — never a reordered orphan set.
      const statements = input.attachmentIds.map((id, index) =>
        this.db
          .update(this.tables.attachments)
          .set({ ordinal: index })
          .where(
            and(
              eq(this.tables.attachments.id, id),
              scopeFor(authority.communityId),
              ownerExists
            )
          )
      );
      statements.push(
        this.db.insert(this.tables.auditEntries).select(
          this.db
            .select({
              id: sql`NULL`.as('id'),
              communityId:
                authority.communityId === null
                  ? sql`NULL`.as('community_id')
                  : sql`${authority.communityId}`.as('community_id'),
              actorId: sql`${audit.actorId}`.as('actor_id'),
              action: sql`${audit.action}`.as('action'),
              resourceType: sql`${audit.resourceType}`.as('resource_type'),
              resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
                'resource_ids'
              ),
              outcome: sql`${audit.outcome}`.as('outcome'),
              ipAddress: sql`NULL`.as('ip_address'),
              userAgent: sql`NULL`.as('user_agent'),
              createdAt: sql`${now.getTime()}`.as('created_at'),
            })
            .from(ownerSource.table)
            .where(ownerSource.where)
        )
      );
      statements.push(
        this.db
          .select({ one: sql`1` })
          .from(ownerSource.table)
          .where(ownerSource.where)
          .limit(1)
      );
      const batchResults = await this.db.batch(statements);
      const ownerCheckRows = batchResults[batchResults.length - 1];
      if (!Array.isArray(ownerCheckRows) || ownerCheckRows.length === 0) {
        return { status: 'not_found' };
      }
      return {
        status: 'reordered',
        attachments: await readBack(this.db, authority.communityId),
      };
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        const authority = await this.authorizeAttachmentOwner({
          actor: input.actor,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          role: input.role,
          executor: tx,
          lock: 'update',
        });
        if (authority.status !== 'ok') return authority;
        const existing = (await tx
          .select({
            id: this.tables.attachments.id,
            fileId: this.tables.attachments.fileId,
          })
          .from(this.tables.attachments)
          .where(scopeFor(authority.communityId))) as Array<{
          id: number;
          fileId: string | null;
        }>;
        if (!validateIds(existing)) return { status: 'invalid_set' };
        for (let index = 0; index < input.attachmentIds.length; index++) {
          await tx
            .update(this.tables.attachments)
            .set({ ordinal: index })
            .where(
              and(
                eq(this.tables.attachments.id, input.attachmentIds[index]!),
                scopeFor(authority.communityId)
              )
            );
        }
        await tx.insert(this.tables.auditEntries).values({
          ...audit,
          createdAt: now,
        });
        return {
          status: 'reordered',
          attachments: await readBack(tx, authority.communityId),
        };
      });
    }

    const authority = await this.authorizeAttachmentOwner({
      actor: input.actor,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      role: input.role,
    });
    if (authority.status !== 'ok') return authority;
    return this.db.transaction((tx: typeof this.db) => {
      const existing = tx
        .select({
          id: this.tables.attachments.id,
          fileId: this.tables.attachments.fileId,
        })
        .from(this.tables.attachments)
        .where(scope)
        .all();
      if (!validateIds(existing)) return { status: 'invalid_set' };
      input.attachmentIds.forEach((id, index) => {
        tx.update(this.tables.attachments)
          .set({ ordinal: index })
          .where(and(eq(this.tables.attachments.id, id), scope))
          .run();
      });
      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();
      return {
        status: 'reordered',
        attachments: readBackSync(tx, {
          tables: this.tables,
          communityId: authority.communityId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          role: input.role,
        }),
      };
    });
  }

  async deleteAttachment(
    actor: FoundationUser,
    attachmentId: number,
    now: Date = new Date()
  ): Promise<AttachmentWriteOutcome> {
    const rows = (await this.fetchAll(
      this.db
        .select({
          id: this.tables.attachments.id,
          communityId: this.tables.attachments.communityId,
          fileId: this.tables.attachments.fileId,
          ownerType: this.tables.attachments.ownerType,
          ownerId: this.tables.attachments.ownerId,
          role: this.tables.attachments.role,
        })
        .from(this.tables.attachments)
        .where(eq(this.tables.attachments.id, attachmentId))
        .limit(1)
    )) as Array<{
      id: number;
      communityId: number | null;
      fileId: string | null;
      ownerType: AttachmentOwnerType | null;
      ownerId: number | null;
      role: AttachmentRole | null;
    }>;
    const attachment = rows[0];
    if (
      !attachment ||
      !attachment.fileId ||
      !attachment.ownerType ||
      !attachment.ownerId ||
      !attachment.role
    ) {
      return { status: 'not_found' };
    }

    // A null-community attachment is only ever the super_admin own photo.
    const authority = await this.authorizeAttachmentOwner({
      actor,
      ownerType: attachment.ownerType,
      ownerId: attachment.ownerId,
      role: attachment.role,
    });
    if (authority.status !== 'ok') return authority;
    if (authority.communityId !== attachment.communityId) {
      return { status: 'not_found' };
    }

    const fileId = attachment.fileId;
    const fileRows = (await this.fetchAll(
      this.db
        .select({
          id: this.tables.files.id,
          storageKey: this.tables.files.storageKey,
          path: this.tables.files.path,
          communityId: this.tables.files.communityId,
        })
        .from(this.tables.files)
        .where(eq(this.tables.files.id, fileId))
        .limit(1)
    )) as Array<{
      id: string;
      storageKey: string | null;
      path: string;
      communityId: number | null;
    }>;
    const file = fileRows[0];
    if (!file) return { status: 'not_found' };

    const audit = buildMediaAuditEntry({
      communityId: attachment.communityId,
      actorId: actor.id,
      action: 'attachment.delete',
      resourceIds: [attachmentId],
      outcome: 'success',
      kind: 'attachment',
    });
    const scope = and(
      eq(this.tables.attachments.id, attachmentId),
      attachment.communityId === null
        ? isNull(this.tables.attachments.communityId)
        : eq(this.tables.attachments.communityId, attachment.communityId)
    );

    if (this.hasD1Batch()) {
      // Record the success audit entry only when the attachment row still
      // exists, then delete it, then remove the now-unreferenced files row, all
      // in one D1 batch. The audit is an INSERT ... SELECT ... WHERE the
      // attachment row exists, placed BEFORE the DELETE, so a concurrent delete
      // that already removed the row (this DELETE then matches nothing -> 404)
      // writes no success audit. The files DELETE re-checks NOT EXISTS against
      // attachments so a concurrent relation added before this batch commits
      // keeps the row.
      // Owner still present in the same statement: the owner check ran
      // before the batch, so an owner deleted between it and this DELETE
      // makes the DELETE a no-op (404) instead of destroying the relation
      // after its owner vanished leaving an orphan.
      const d1Scope = and(
        eq(this.tables.attachments.id, attachmentId),
        attachment.communityId === null
          ? isNull(this.tables.attachments.communityId)
          : eq(this.tables.attachments.communityId, attachment.communityId),
        this.ownerExistsCondition(this.db, {
          ownerType: attachment.ownerType!,
          ownerId: attachment.ownerId!,
          role: attachment.role!,
          communityId: authority.communityId,
          viewer: ownCommunityViewerForRole(actor.role),
        })
      );
      const insertAudit = this.db.insert(this.tables.auditEntries).select(
        this.db
          .select({
            id: sql`NULL`.as('id'),
            communityId:
              attachment.communityId === null
                ? sql`NULL`.as('community_id')
                : this.tables.attachments.communityId,
            actorId: sql`${audit.actorId}`.as('actor_id'),
            action: sql`${audit.action}`.as('action'),
            resourceType: sql`${audit.resourceType}`.as('resource_type'),
            resourceIds: sql`${JSON.stringify(audit.resourceIds)}`.as(
              'resource_ids'
            ),
            outcome: sql`${audit.outcome}`.as('outcome'),
            ipAddress: sql`NULL`.as('ip_address'),
            userAgent: sql`NULL`.as('user_agent'),
            createdAt: sql`${now.getTime()}`.as('created_at'),
          })
          .from(this.tables.attachments)
          .where(d1Scope)
      );
      const deleteAttachment = this.db
        .delete(this.tables.attachments)
        .where(d1Scope)
        .returning({ id: this.tables.attachments.id });
      const deleteFiles = buildUnreferencedFilesDelete(
        this.db,
        this.connection,
        [fileId]
      );
      const [, deletedRows, ...fileResults] = await this.db.batch([
        insertAudit,
        deleteAttachment,
        ...deleteFiles,
      ]);
      if (!Array.isArray(deletedRows) || deletedRows.length === 0) {
        return { status: 'not_found' };
      }
      const removedRows = fileResults.flatMap((rows: unknown) =>
        Array.isArray(rows) ? rows : []
      ) as Array<{ id: string; storageKey: string | null; path: string }>;
      return {
        status: 'deleted',
        fileId,
        storageKey: file.storageKey ?? file.path,
        communityId: attachment.communityId,
        removedFile:
          toFileByteCleanups(removedRows).find((f) => f.fileId === fileId) ??
          null,
      };
    }

    if (dialectOf(this.connection) === 'postgresql') {
      return this.db.transaction(async (tx: typeof this.db) => {
        // Delete the attachment row before taking any files lock: every PG
        // delete path must order its locks attachments-then-files (the
        // story/place/speaker deletes do the same). Locking the files row first
        // here could deadlock against those paths under READ COMMITTED.
        const deleted = await tx
          .delete(this.tables.attachments)
          .where(scope)
          .returning({ id: this.tables.attachments.id });
        if (deleted.length === 0) return { status: 'not_found' };
        await tx.insert(this.tables.auditEntries).values({
          ...audit,
          createdAt: now,
        });
        // Now that the relation is gone, lock the files row so an attach that is
        // still uncommitted cannot have its relation cascaded away (see
        // lockFileRowsForCleanup). An empty set means the row is already gone, so
        // there is nothing left to clean up.
        const lockedFileIds = await lockFileRowsForCleanup(
          tx,
          this.connection,
          [fileId]
        );
        const removedRows = (
          await Promise.all(
            buildUnreferencedFilesDelete(tx, this.connection, lockedFileIds)
          )
        ).flat() as Array<{
          id: string;
          storageKey: string | null;
          path: string;
        }>;
        return {
          status: 'deleted',
          fileId,
          storageKey: file.storageKey ?? file.path,
          communityId: attachment.communityId,
          removedFile:
            toFileByteCleanups(removedRows).find((f) => f.fileId === fileId) ??
            null,
        };
      });
    }

    return this.db.transaction((tx: typeof this.db) => {
      const deleted = tx
        .delete(this.tables.attachments)
        .where(scope)
        .returning({ id: this.tables.attachments.id })
        .all();
      if (deleted.length === 0) return { status: 'not_found' };
      tx.insert(this.tables.auditEntries)
        .values({
          ...audit,
          createdAt: now,
        })
        .run();
      const removedRows = buildUnreferencedFilesDelete(tx, this.connection, [
        fileId,
      ]).flatMap(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (statement: any) => statement.returning().all()
      ) as Array<{ id: string; storageKey: string | null; path: string }>;
      return {
        status: 'deleted',
        fileId,
        storageKey: file.storageKey ?? file.path,
        communityId: attachment.communityId,
        removedFile:
          toFileByteCleanups(removedRows).find((f) => f.fileId === fileId) ??
          null,
      };
    });
  }
}

/**
 * Synchronous read-back for the better-sqlite3 transaction path: resolves
 * attachment rows and their file metadata in one pass without awaiting.
 */
function readBackSync(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  input: {
    tables: DialectTables;
    communityId: number | null;
    ownerType: AttachmentOwnerType;
    ownerId: number;
    role: AttachmentRole;
  }
): AttachmentRecord[] {
  const { tables } = input;
  const rows = tx
    .select({
      id: tables.attachments.id,
      fileId: tables.attachments.fileId,
      ordinal: tables.attachments.ordinal,
      createdAt: tables.attachments.createdAt,
    })
    .from(tables.attachments)
    .where(
      and(
        input.communityId === null
          ? isNull(tables.attachments.communityId)
          : eq(tables.attachments.communityId, input.communityId),
        eq(tables.attachments.ownerType, input.ownerType),
        eq(tables.attachments.ownerId, input.ownerId),
        eq(tables.attachments.role, input.role)
      )
    )
    .all();
  const fileIds = rows
    .map((row: { fileId: string | null }) => row.fileId)
    .filter((id: string | null): id is string => typeof id === 'string');
  const fileRows = fileIds.length
    ? tx
        .select({
          id: tables.files.id,
          originalName: tables.files.originalName,
          mimeType: tables.files.mimeType,
          byteSize: tables.files.byteSize,
          size: tables.files.size,
        })
        .from(tables.files)
        .where(inArray(tables.files.id, fileIds))
        .all()
    : [];
  const byId = new Map(fileRows.map((row: { id: string }) => [row.id, row]));
  return rows
    .map(
      (row: {
        id: number;
        fileId: string | null;
        ordinal: number | null;
        createdAt: Date | number | string;
      }) => {
        const file = row.fileId
          ? (byId.get(row.fileId) as
              | {
                  originalName: string;
                  mimeType: string;
                  byteSize: number | null;
                  size: number | null;
                }
              | undefined)
          : undefined;
        if (!file) return null;
        return {
          id: row.id,
          fileId: row.fileId as string,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          role: input.role,
          ordinal: Number(row.ordinal ?? 0),
          mimeType: file.mimeType,
          byteSize: Number(file.byteSize ?? file.size),
          originalName: file.originalName,
          createdAt: toDate(row.createdAt),
        } satisfies AttachmentRecord;
      }
    )
    .filter(
      (row: AttachmentRecord | null): row is AttachmentRecord => row !== null
    )
    .sort(
      (a: AttachmentRecord, b: AttachmentRecord) =>
        a.ordinal - b.ordinal || a.id - b.id
    );
}

export { inArray };
