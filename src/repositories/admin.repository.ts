/**
 * System administration data access (`/v2/admin/*`, Slice 14; SPEC-V2 §6.2,
 * §6.8, §7; route registry §10).
 *
 * Strictly operational columns only: queries never select, insert, or update
 * descriptive community fields (`description`, `description_plain`, `locale`,
 * `country`, `visibility`) or community content rows. Mutating operations
 * commit their content-free `AuditEntry` in the same atomic unit (D1
 * `db.batch()`, PG transaction, or SQLite sync transaction).
 */
import { and, asc, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  communityStatusFromPhysical,
  communityStatusToPhysical,
  type CommunityStatus,
} from '../policy/canonical-state.js';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import type { AdminCommunityClaimStatus } from '../shared/schemas/admin.js';
import {
  validateContentFreeAuditEntry,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';
import { communityUnclaimedAndEmptySql } from './bootstrap.repository.js';
import { isUniqueConstraintError } from './user-management.repository.js';

export interface OperationalCommunityRow {
  id: number;
  slug: string;
  status: CommunityStatus;
  claimStatus: AdminCommunityClaimStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListOperationalCommunitiesInput {
  limit: number;
  offset: number;
  status?: CommunityStatus;
  nowMs: number;
}

export interface ProvisionCommunityInput {
  actorId: number;
  slug: string;
  now: Date;
}

export type ProvisionCommunityResult =
  | { outcome: 'provisioned'; community: OperationalCommunityRow }
  | { outcome: 'slug_conflict' }
  | { outcome: 'authority_lost' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

const isTrue = (value: unknown): boolean => value === true || value === 1;

const toDate = (value: Date | number | string): Date => {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
};

export class AdminRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
  }

  /**
   * Compute operational `claimStatus` without reading any descriptive or
   * cultural columns. Uses zero boolean literals so SQLite, D1, and
   * PostgreSQL evaluate identically.
   */
  private claimStatusExpression(
    communityIdExpr: SQL | number,
    nowMs: number
  ): SQL<AdminCommunityClaimStatus> {
    return sql<AdminCommunityClaimStatus>`case
      when not ${communityUnclaimedAndEmptySql(communityIdExpr)} then 'claimed'
      when exists (
        select 1 from claim_tokens ct
        where ct.community_id = ${communityIdExpr}
          and ct.consumed_at is null
          and ct.superseded_at is null
          and ct.expires_at > ${nowMs}
      ) then 'claim_pending'
      else 'unclaimed'
    end`;
  }

  private toOperationalRow(row: {
    id: number | string;
    slug: string;
    isActive: unknown;
    claimStatus: unknown;
    createdAt: Date | number | string;
    updatedAt: Date | number | string;
  }): OperationalCommunityRow {
    const claimStatus = String(row.claimStatus);
    return {
      id: Number(row.id),
      slug: String(row.slug),
      status: communityStatusFromPhysical(isTrue(row.isActive)),
      claimStatus:
        claimStatus === 'claim_pending' || claimStatus === 'claimed'
          ? claimStatus
          : 'unclaimed',
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    };
  }

  /**
   * List operational community lifecycle records in deterministic `id ASC`
   * order. Selects strictly operational fields + computed `claimStatus`.
   */
  async listOperationalCommunities(
    input: ListOperationalCommunitiesInput
  ): Promise<{ rows: OperationalCommunityRow[]; total: number }> {
    const { communities } = this.tables;
    const whereClause =
      input.status === undefined
        ? undefined
        : eq(communities.isActive, communityStatusToPhysical(input.status));

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          id: communities.id,
          slug: communities.slug,
          isActive: communities.isActive,
          claimStatus: this.claimStatusExpression(
            sql.raw('"communities"."id"'),
            input.nowMs
          ),
          createdAt: communities.createdAt,
          updatedAt: communities.updatedAt,
        })
        .from(communities)
        .where(whereClause)
        .orderBy(asc(communities.id))
        .limit(input.limit)
        .offset(input.offset),
      this.db.select({ total: count() }).from(communities).where(whereClause),
    ]);

    return {
      rows: (
        rows as Array<Parameters<AdminRepository['toOperationalRow']>[0]>
      ).map((row) => this.toOperationalRow(row)),
      total: Number(totalRows[0]?.total ?? 0),
    };
  }

  /**
   * Provision a new empty hosted community with an atomic
   * `system.community.provision` audit entry (`communityId: null`).
   *
   * Physical `communities.name` is NOT NULL in the shared schema, so the
   * operational `slug` fills that column without inventing descriptive text;
   * `/v2/admin/*` never reads or projects `name`.
   */
  async provisionCommunityAtomically(
    input: ProvisionCommunityInput
  ): Promise<ProvisionCommunityResult> {
    const auditTemplate: ValidatedAuditEntryRecord =
      validateContentFreeAuditEntry({
        communityId: null,
        actorId: input.actorId,
        action: 'system.community.provision',
        resourceType: 'system',
        resourceIds: [1],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      });

    const db = this.db;
    const { communities, users, auditEntries } = this.tables;
    const nowMs = input.now.getTime();

    if (typeof db.batch === 'function') {
      const actorGuard = sql`exists (
        select 1 from users a
        where a.id = ${input.actorId}
          and a.role = 'super_admin'
          and a.community_id is null
          and a.is_active = 1
      )`;

      const insertCommunityStmt = db
        .insert(communities)
        .select(
          sql`select
            ${null}, ${input.slug}, ${null}, ${null}, ${input.slug},
            0, ${'en'}, ${null}, 1, ${null}, 0, ${nowMs}, ${nowMs}
          where ${actorGuard}`
        )
        .returning({
          id: communities.id,
          slug: communities.slug,
          isActive: communities.isActive,
          createdAt: communities.createdAt,
          updatedAt: communities.updatedAt,
        });

      const insertAuditStmt = db.insert(auditEntries).select(
        sql`select
          ${null}, ${null}, ${input.actorId}, ${auditTemplate.action},
          ${auditTemplate.resourceType}, '[' || c.id || ']',
          ${auditTemplate.outcome}, ${auditTemplate.ipAddress},
          ${auditTemplate.userAgent}, ${nowMs}
        from communities c
        where c.slug = ${input.slug}
          and ${actorGuard}`
      );

      let results: Array<Array<Record<string, unknown>>>;
      try {
        results = (await db.batch([
          insertCommunityStmt,
          insertAuditStmt,
        ])) as Array<Array<Record<string, unknown>>>;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return { outcome: 'slug_conflict' };
        }
        throw error;
      }

      const commRow = results[0]?.[0];
      if (!commRow) {
        return { outcome: 'authority_lost' };
      }

      return {
        outcome: 'provisioned',
        community: this.toOperationalRow({
          ...(commRow as Omit<
            Parameters<AdminRepository['toOperationalRow']>[0],
            'claimStatus'
          >),
          claimStatus: 'unclaimed',
        }),
      };
    }

    const communityValues = {
      name: input.slug,
      description: null,
      descriptionPlain: null,
      slug: input.slug,
      publicStories: false,
      locale: 'en',
      culturalSettings: null,
      isActive: true,
      country: null,
      beta: false,
      createdAt: input.now,
      updatedAt: input.now,
    };

    if (dialectOf(db) === 'postgresql') {
      try {
        return await db.transaction(
          async (tx: Executor): Promise<ProvisionCommunityResult> => {
            const [actorRow] = await tx
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.id, input.actorId),
                  eq(users.role, 'super_admin'),
                  isNull(users.communityId),
                  eq(users.isActive, true)
                )
              )
              .for('share')
              .limit(1);
            if (!actorRow) {
              return { outcome: 'authority_lost' };
            }

            const [commRow] = await tx
              .insert(communities)
              .values(communityValues)
              .returning({
                id: communities.id,
                slug: communities.slug,
                isActive: communities.isActive,
                createdAt: communities.createdAt,
                updatedAt: communities.updatedAt,
              });
            const communityId = Number(commRow.id);

            await buildAuditEntryInsert(
              tx,
              {
                communityId: null,
                actorId: input.actorId,
                action: 'system.community.provision',
                resourceType: 'system',
                resourceIds: [communityId],
                outcome: 'success',
                ipAddress: null,
                userAgent: null,
              },
              input.now
            );

            return {
              outcome: 'provisioned',
              community: this.toOperationalRow({
                ...commRow,
                claimStatus: 'unclaimed',
              }),
            };
          }
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return { outcome: 'slug_conflict' };
        }
        throw error;
      }
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    try {
      return db.transaction((tx: Executor): ProvisionCommunityResult => {
        const actorRow = tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, input.actorId),
              eq(users.role, 'super_admin'),
              isNull(users.communityId),
              eq(users.isActive, true)
            )
          )
          .limit(1)
          .all()[0];
        if (!actorRow) {
          return { outcome: 'authority_lost' };
        }

        const [commRow] = tx
          .insert(communities)
          .values(communityValues)
          .returning({
            id: communities.id,
            slug: communities.slug,
            isActive: communities.isActive,
            createdAt: communities.createdAt,
            updatedAt: communities.updatedAt,
          })
          .all();
        const communityId = Number(commRow.id);

        buildAuditEntryInsert(
          tx,
          {
            communityId: null,
            actorId: input.actorId,
            action: 'system.community.provision',
            resourceType: 'system',
            resourceIds: [communityId],
            outcome: 'success',
            ipAddress: null,
            userAgent: null,
          },
          input.now
        ).run();

        return {
          outcome: 'provisioned',
          community: this.toOperationalRow({
            ...commRow,
            claimStatus: 'unclaimed',
          }),
        };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { outcome: 'slug_conflict' };
      }
      throw error;
    }
  }
}
