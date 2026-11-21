/**
 * Data access for Slice 13a community-scoped AuditEntry read
 * (`GET /v2/community/audit-entries`; SPEC-V2 §6.8, §7).
 */

import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { tablesFor } from '../db/dialect.js';
import type { AuditResourceId } from '../db/schema/audit_entries.js';
import { parseJsonColumn } from '../shared/utils/canonical-json.js';

export interface CommunityAuditEntryRow {
  id: number;
  communityId: number;
  actorId: number | null;
  action: string;
  resourceType: string | null;
  resourceIds: AuditResourceId[];
  outcome: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface CommunityAuditListQuery {
  communityId: number;
  limit: number;
  offset: number;
  action?: string;
  resourceType?: string;
  outcome?: string;
  actorId?: number;
  from?: Date;
  to?: Date;
}

function normalizeResourceIds(value: unknown): AuditResourceId[] {
  const parsed = parseJsonColumn(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is AuditResourceId =>
      typeof item === 'number' || typeof item === 'string'
  );
}

export class CommunityAuditRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
  }

  /** Own-community lifecycle flag, or null when the community row is gone. */
  async communityIsActive(communityId: number): Promise<boolean | null> {
    const { communities } = this.tables;
    const rows = await this.db
      .select({ isActive: communities.isActive })
      .from(communities)
      .where(eq(communities.id, communityId))
      .limit(1);
    const value = rows[0]?.isActive;
    if (value === undefined) return null;
    return value === true || value === 1;
  }

  async listCommunityAuditEntries(
    input: CommunityAuditListQuery
  ): Promise<{ rows: CommunityAuditEntryRow[]; total: number }> {
    const { auditEntries } = this.tables;
    const conditions: SQL[] = [eq(auditEntries.communityId, input.communityId)];
    if (input.action !== undefined) {
      conditions.push(eq(auditEntries.action, input.action));
    }
    if (input.resourceType !== undefined) {
      conditions.push(eq(auditEntries.resourceType, input.resourceType));
    }
    if (input.outcome !== undefined) {
      conditions.push(eq(auditEntries.outcome, input.outcome));
    }
    if (input.actorId !== undefined) {
      conditions.push(eq(auditEntries.actorId, input.actorId));
    }
    if (input.from !== undefined) {
      conditions.push(gte(auditEntries.createdAt, input.from));
    }
    if (input.to !== undefined) {
      conditions.push(lte(auditEntries.createdAt, input.to));
    }

    const whereClause = and(...conditions);

    const countQuery = this.db
      .select({ total: sql<number>`count(*)` })
      .from(auditEntries)
      .where(whereClause);

    const pageQuery = this.db
      .select({
        id: auditEntries.id,
        communityId: auditEntries.communityId,
        actorId: auditEntries.actorId,
        action: auditEntries.action,
        resourceType: auditEntries.resourceType,
        resourceIds: auditEntries.resourceIds,
        outcome: auditEntries.outcome,
        ipAddress: auditEntries.ipAddress,
        userAgent: auditEntries.userAgent,
        createdAt: auditEntries.createdAt,
      })
      .from(auditEntries)
      .where(whereClause)
      .orderBy(desc(auditEntries.createdAt), desc(auditEntries.id))
      .limit(input.limit)
      .offset(input.offset);

    const [countRows, rawRows] =
      typeof this.db.batch === 'function'
        ? await this.db.batch([countQuery, pageQuery])
        : await Promise.all([countQuery, pageQuery]);

    const total = Number(countRows[0]?.total ?? 0);
    const rows = (rawRows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      communityId: Number(row.communityId),
      actorId:
        row.actorId === null || row.actorId === undefined
          ? null
          : Number(row.actorId),
      action: String(row.action),
      resourceType:
        row.resourceType === null || row.resourceType === undefined
          ? null
          : String(row.resourceType),
      resourceIds: normalizeResourceIds(row.resourceIds),
      outcome: String(row.outcome),
      ipAddress:
        row.ipAddress === null || row.ipAddress === undefined
          ? null
          : String(row.ipAddress),
      userAgent:
        row.userAgent === null || row.userAgent === undefined
          ? null
          : String(row.userAgent),
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt
          : new Date(Number(row.createdAt)),
    }));

    return { rows, total };
  }
}
