/**
 * Repository for Slice 9 media upload, authorization resolution, metadata,
 * file deletion, and content-free file-authorization audit entries (§6.4a, §6.7, §7).
 */

import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor, type DialectTables } from '../db/dialect.js';
import {
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';
import type { FoundationUser } from './hono-foundation.repository.js';
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

  async isCommunityActive(communityId: number): Promise<boolean> {
    const rows = await this.db
      .select({
        publicStories: this.tables.communities.publicStories,
        isActive: this.tables.communities.isActive,
      })
      .from(this.tables.communities)
      .where(eq(this.tables.communities.id, communityId))
      .limit(1);
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
    checksum: string;
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
          // Non-admin without ownership cannot delete another user's staging or media.
          const hasAnyAtt = await this.db
            .select({ id: this.tables.attachments.id })
            .from(this.tables.attachments)
            .where(
              and(
                eq(this.tables.attachments.communityId, actor.communityId),
                eq(this.tables.attachments.fileId, fileId)
              )
            )
            .limit(1);
          return hasAnyAtt.length > 0
            ? { status: 'forbidden' }
            : { status: 'not_found' };
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
}

export { inArray };
