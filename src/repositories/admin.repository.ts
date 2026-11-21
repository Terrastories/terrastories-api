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
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
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
import {
  communityUnclaimedAndEmptySql,
  isCommunityUnclaimedAndEmpty,
  isCommunityUnclaimedAndEmptySync,
} from './bootstrap.repository.js';
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

export interface UpdateCommunityStatusInput {
  actorId: number;
  communityId: number;
  status: CommunityStatus;
  now: Date;
}

export type UpdateCommunityStatusResult =
  | { outcome: 'updated'; community: OperationalCommunityRow }
  | { outcome: 'not_found' }
  | { outcome: 'authority_lost' };

export interface DeprovisionCommunityInput {
  actorId: number;
  communityId: number;
  now: Date;
}

export type DeprovisionCommunityResult =
  | { outcome: 'deprovisioned' }
  | { outcome: 'not_found' }
  | { outcome: 'authority_lost' }
  | { outcome: 'conflict' };

export interface SystemAuditEntryRow {
  id: number;
  communityId: null;
  actorId: number | null;
  action: string;
  resourceType: string | null;
  resourceIds: Array<number | string>;
  outcome: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface ListSystemAuditEntriesInput {
  limit: number;
  offset: number;
  action?: string;
  outcome?: string;
}

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
   * Compute operational `claimStatus` without reading or projecting any
   * descriptive or cultural values (`communityUnclaimedAndEmptySql` evaluates
   * nullity/defaultness of descriptive fields solely as a boolean SQL
   * predicate). Uses zero boolean literals so SQLite, D1, and PostgreSQL
   * evaluate identically.
   */
  private claimStatusExpression(
    communityIdExpr: SQL | number,
    nowMs: number
  ): SQL<AdminCommunityClaimStatus> {
    return sql<AdminCommunityClaimStatus>`case
      when not ${communityUnclaimedAndEmptySql(communityIdExpr)} then 'claimed'
      when exists (
        select 1 from claim_tokens ct
        inner join communities c_active on c_active.id = ct.community_id
        where ct.community_id = ${communityIdExpr}
          and c_active.is_active
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

  /**
   * Atomically update a community's operational lifecycle `status`
   * (`active | disabled`), purge every session of that community and supersede
   * outstanding unconsumed `ClaimToken`s when setting `disabled` (SPEC-V2
   * §6.2, §6.8, §7 — re-enabling never revives pre-disable tokens), and write
   * the content-free system `AuditEntry` in the same atomic unit. Never reads
   * or writes descriptive community fields or content.
   */
  async setCommunityStatusAtomically(
    input: UpdateCommunityStatusInput
  ): Promise<UpdateCommunityStatusResult> {
    const action =
      input.status === 'disabled'
        ? 'system.community.status.disabled'
        : 'system.community.status.active';
    const auditTemplate: ValidatedAuditEntryRecord =
      validateContentFreeAuditEntry({
        communityId: null,
        actorId: input.actorId,
        action,
        resourceType: 'system',
        resourceIds: [input.communityId],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      });

    const db = this.db;
    const { communities, users, sessions, claimTokens, auditEntries } =
      this.tables;
    const nextIsActive = communityStatusToPhysical(input.status);
    const nowMs = input.now.getTime();

    if (typeof db.batch === 'function') {
      const actorGuard = sql`exists (
        select 1 from users a
        where a.id = ${input.actorId}
          and a.role = 'super_admin'
          and a.community_id is null
          and a.is_active = 1
      )`;

      const updateCommStmt = db
        .update(communities)
        .set({ isActive: nextIsActive, updatedAt: input.now })
        .where(and(eq(communities.id, input.communityId), actorGuard))
        .returning({
          id: communities.id,
          slug: communities.slug,
          isActive: communities.isActive,
          claimStatus: this.claimStatusExpression(input.communityId, nowMs),
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
        where c.id = ${input.communityId}
          and ${actorGuard}`
      );

      const statements: unknown[] = [];
      if (input.status === 'disabled') {
        // Supersede before `updateCommStmt` so its RETURNING projection sees
        // both `is_active = 0` and `superseded_at` set.
        statements.push(
          db
            .update(claimTokens)
            .set({ supersededAt: nowMs })
            .where(
              and(
                eq(claimTokens.communityId, input.communityId),
                isNull(claimTokens.consumedAt),
                isNull(claimTokens.supersededAt),
                actorGuard,
                sql`exists (select 1 from communities c where c.id = ${input.communityId})`
              )
            )
        );
      }
      const updateIdx = statements.length;
      statements.push(updateCommStmt);
      if (input.status === 'disabled') {
        statements.push(
          db
            .delete(sessions)
            .where(
              and(
                sql`${sessions.userId} in (select id from users where community_id = ${input.communityId})`,
                actorGuard,
                sql`exists (select 1 from communities c where c.id = ${input.communityId})`
              )
            )
        );
      }
      statements.push(insertAuditStmt);

      const results = (await db.batch(statements)) as Array<
        Array<Record<string, unknown>>
      >;
      const commRow = results[updateIdx]?.[0];
      if (commRow) {
        return {
          outcome: 'updated',
          community: this.toOperationalRow(
            commRow as Parameters<AdminRepository['toOperationalRow']>[0]
          ),
        };
      }

      const [actorRow] = await db
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
        .limit(1);
      if (!actorRow) return { outcome: 'authority_lost' };
      return { outcome: 'not_found' };
    }

    if (dialectOf(db) === 'postgresql') {
      return db.transaction(
        async (tx: Executor): Promise<UpdateCommunityStatusResult> => {
          // Lock order: communities (FOR UPDATE) -> actor users (FOR SHARE) -> claim_tokens -> sessions.
          const [existingComm] = await tx
            .select({ id: communities.id })
            .from(communities)
            .where(eq(communities.id, input.communityId))
            .for('update')
            .limit(1);
          if (!existingComm) return { outcome: 'not_found' };

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
          if (!actorRow) return { outcome: 'authority_lost' };

          const [commRow] = await tx
            .update(communities)
            .set({ isActive: nextIsActive, updatedAt: input.now })
            .where(eq(communities.id, input.communityId))
            .returning({
              id: communities.id,
              slug: communities.slug,
              isActive: communities.isActive,
              createdAt: communities.createdAt,
              updatedAt: communities.updatedAt,
            });

          if (input.status === 'disabled') {
            await tx
              .update(claimTokens)
              .set({ supersededAt: nowMs })
              .where(
                and(
                  eq(claimTokens.communityId, input.communityId),
                  isNull(claimTokens.consumedAt),
                  isNull(claimTokens.supersededAt)
                )
              );
            await tx
              .delete(sessions)
              .where(
                inArray(
                  sessions.userId,
                  tx
                    .select({ id: users.id })
                    .from(users)
                    .where(eq(users.communityId, input.communityId))
                )
              );
          }

          const [claimRow] = await tx
            .select({
              claimStatus: this.claimStatusExpression(input.communityId, nowMs),
            })
            .from(communities)
            .where(eq(communities.id, input.communityId))
            .limit(1);

          await buildAuditEntryInsert(
            tx,
            {
              communityId: null,
              actorId: input.actorId,
              action: auditTemplate.action,
              resourceType: 'system',
              resourceIds: [input.communityId],
              outcome: 'success',
              ipAddress: null,
              userAgent: null,
            },
            input.now
          );

          return {
            outcome: 'updated',
            community: this.toOperationalRow({
              ...commRow,
              claimStatus: claimRow?.claimStatus ?? 'unclaimed',
            }),
          };
        }
      );
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    return db.transaction((tx: Executor): UpdateCommunityStatusResult => {
      const existingComm = tx
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.id, input.communityId))
        .limit(1)
        .all()[0];
      if (!existingComm) return { outcome: 'not_found' };

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
      if (!actorRow) return { outcome: 'authority_lost' };

      const [commRow] = tx
        .update(communities)
        .set({ isActive: nextIsActive, updatedAt: input.now })
        .where(eq(communities.id, input.communityId))
        .returning({
          id: communities.id,
          slug: communities.slug,
          isActive: communities.isActive,
          createdAt: communities.createdAt,
          updatedAt: communities.updatedAt,
        })
        .all();

      if (input.status === 'disabled') {
        tx.update(claimTokens)
          .set({ supersededAt: nowMs })
          .where(
            and(
              eq(claimTokens.communityId, input.communityId),
              isNull(claimTokens.consumedAt),
              isNull(claimTokens.supersededAt)
            )
          )
          .run();
        tx.delete(sessions)
          .where(
            inArray(
              sessions.userId,
              tx
                .select({ id: users.id })
                .from(users)
                .where(eq(users.communityId, input.communityId))
            )
          )
          .run();
      }

      const claimRow = tx
        .select({
          claimStatus: this.claimStatusExpression(input.communityId, nowMs),
        })
        .from(communities)
        .where(eq(communities.id, input.communityId))
        .limit(1)
        .all()[0];

      buildAuditEntryInsert(
        tx,
        {
          communityId: null,
          actorId: input.actorId,
          action: auditTemplate.action,
          resourceType: 'system',
          resourceIds: [input.communityId],
          outcome: 'success',
          ipAddress: null,
          userAgent: null,
        },
        input.now
      ).run();

      return {
        outcome: 'updated',
        community: this.toOperationalRow({
          ...commRow,
          claimStatus: claimRow?.claimStatus ?? 'unclaimed',
        }),
      };
    });
  }

  /**
   * Atomically deprovision a still-empty, never-administered community
   * (SPEC-V2 §7). `AuditEntry` is append-only (§6.8): pre-claim
   * `claim_token.issue` and failed `claim_token.consume` rows are preserved by
   * re-scoping their `communityId` to `null` (keeping `ipAddress`, `userAgent`,
   * and all other fields intact) in the same atomic unit that removes claim
   * throttles, unconsumed claim tokens, and the community row, and writes the
   * system-level `system.community.deprovision` entry (`communityId: null`).
   */
  async deprovisionCommunityAtomically(
    input: DeprovisionCommunityInput
  ): Promise<DeprovisionCommunityResult> {
    const auditTemplate: ValidatedAuditEntryRecord =
      validateContentFreeAuditEntry({
        communityId: null,
        actorId: input.actorId,
        action: 'system.community.deprovision',
        resourceType: 'system',
        resourceIds: [input.communityId],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      });

    const db = this.db;
    const { communities, users, claimTokens, authThrottle, auditEntries } =
      this.tables;
    const nowMs = input.now.getTime();
    const preClaimAuditFilter = or(
      eq(auditEntries.action, 'claim_token.issue'),
      and(
        eq(auditEntries.action, 'claim_token.consume'),
        eq(auditEntries.outcome, 'failure')
      )
    );

    if (typeof db.batch === 'function') {
      const actorGuard = sql`exists (
        select 1 from users a
        where a.id = ${input.actorId}
          and a.role = 'super_admin'
          and a.community_id is null
          and a.is_active = 1
      )`;
      const eligibleGuard = sql`${actorGuard}
        and exists (select 1 from communities c where c.id = ${input.communityId})
        and ${communityUnclaimedAndEmptySql(input.communityId)}`;

      // Order is load-bearing on D1:
      // 1. Insert the system audit row while `communities` still exists so the
      //    guarded SELECT finds `c.id` and `eligibleGuard` still passes.
      // 2. Preserve append-only pre-claim audit entries by re-scoping them to
      //    system (`community_id = NULL`, keeping `ip_address`/`user_agent`) so
      //    the `ON DELETE NO ACTION` FK allows deleting the community in step 5
      //    while `eligibleGuard` remains satisfied for steps 3-5.
      // 3-4. Delete claim throttles and unconsumed claim tokens.
      // 5. Delete the community row last.
      const insertAuditStmt = db.insert(auditEntries).select(
        sql`select
          ${null}, ${null}, ${input.actorId}, ${auditTemplate.action},
          ${auditTemplate.resourceType}, '[' || c.id || ']',
          ${auditTemplate.outcome}, ${auditTemplate.ipAddress},
          ${auditTemplate.userAgent}, ${nowMs}
        from communities c
        where c.id = ${input.communityId}
          and ${actorGuard}
          and ${communityUnclaimedAndEmptySql(input.communityId)}`
      );

      const rescopePreClaimAuditsStmt = db
        .update(auditEntries)
        .set({ communityId: null })
        .where(
          and(
            eq(auditEntries.communityId, input.communityId),
            preClaimAuditFilter,
            eligibleGuard
          )
        );

      const deleteClaimThrottleStmt = db
        .delete(authThrottle)
        .where(
          and(
            eq(authThrottle.communityId, input.communityId),
            eq(authThrottle.kind, 'claim'),
            eligibleGuard
          )
        );

      const deleteUnconsumedTokensStmt = db
        .delete(claimTokens)
        .where(
          and(
            eq(claimTokens.communityId, input.communityId),
            isNull(claimTokens.consumedAt),
            eligibleGuard
          )
        );

      const deleteCommunityStmt = db
        .delete(communities)
        .where(and(eq(communities.id, input.communityId), eligibleGuard))
        .returning({ id: communities.id });

      const results = (await db.batch([
        insertAuditStmt,
        rescopePreClaimAuditsStmt,
        deleteClaimThrottleStmt,
        deleteUnconsumedTokensStmt,
        deleteCommunityStmt,
      ])) as Array<Array<Record<string, unknown>>>;

      const deleted = results[4] ?? [];
      if (deleted.length > 0) {
        return { outcome: 'deprovisioned' };
      }

      const [actorRow, commRow] = await Promise.all([
        db
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
          .limit(1),
        db
          .select({ id: communities.id })
          .from(communities)
          .where(eq(communities.id, input.communityId))
          .limit(1),
      ]);
      if (actorRow.length === 0) return { outcome: 'authority_lost' };
      if (commRow.length === 0) return { outcome: 'not_found' };
      return { outcome: 'conflict' };
    }

    if (dialectOf(db) === 'postgresql') {
      return db.transaction(
        async (tx: Executor): Promise<DeprovisionCommunityResult> => {
          // Lock order: communities (FOR UPDATE) -> actor users (FOR SHARE) -> child cleanup -> delete.
          const [commRow] = await tx
            .select({ id: communities.id })
            .from(communities)
            .where(eq(communities.id, input.communityId))
            .for('update')
            .limit(1);
          if (!commRow) return { outcome: 'not_found' };

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
          if (!actorRow) return { outcome: 'authority_lost' };

          if (!(await isCommunityUnclaimedAndEmpty(tx, input.communityId))) {
            return { outcome: 'conflict' };
          }

          await tx
            .update(auditEntries)
            .set({ communityId: null })
            .where(
              and(
                eq(auditEntries.communityId, input.communityId),
                preClaimAuditFilter
              )
            );
          await tx
            .delete(authThrottle)
            .where(
              and(
                eq(authThrottle.communityId, input.communityId),
                eq(authThrottle.kind, 'claim')
              )
            );
          await tx
            .delete(claimTokens)
            .where(
              and(
                eq(claimTokens.communityId, input.communityId),
                isNull(claimTokens.consumedAt)
              )
            );
          await tx
            .delete(communities)
            .where(eq(communities.id, input.communityId));

          await buildAuditEntryInsert(
            tx,
            {
              communityId: null,
              actorId: input.actorId,
              action: auditTemplate.action,
              resourceType: 'system',
              resourceIds: [input.communityId],
              outcome: 'success',
              ipAddress: null,
              userAgent: null,
            },
            input.now
          );

          return { outcome: 'deprovisioned' };
        }
      );
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    return db.transaction((tx: Executor): DeprovisionCommunityResult => {
      const commRow = tx
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.id, input.communityId))
        .limit(1)
        .all()[0];
      if (!commRow) return { outcome: 'not_found' };

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
      if (!actorRow) return { outcome: 'authority_lost' };

      if (!isCommunityUnclaimedAndEmptySync(tx, input.communityId)) {
        return { outcome: 'conflict' };
      }

      tx.update(auditEntries)
        .set({ communityId: null })
        .where(
          and(
            eq(auditEntries.communityId, input.communityId),
            preClaimAuditFilter
          )
        )
        .run();
      tx.delete(authThrottle)
        .where(
          and(
            eq(authThrottle.communityId, input.communityId),
            eq(authThrottle.kind, 'claim')
          )
        )
        .run();
      tx.delete(claimTokens)
        .where(
          and(
            eq(claimTokens.communityId, input.communityId),
            isNull(claimTokens.consumedAt)
          )
        )
        .run();
      tx.delete(communities).where(eq(communities.id, input.communityId)).run();

      buildAuditEntryInsert(
        tx,
        {
          communityId: null,
          actorId: input.actorId,
          action: auditTemplate.action,
          resourceType: 'system',
          resourceIds: [input.communityId],
          outcome: 'success',
          ipAddress: null,
          userAgent: null,
        },
        input.now
      ).run();

      return { outcome: 'deprovisioned' };
    });
  }

  /**
   * Read system-level `AuditEntry` records (`communityId IS NULL`, including
   * append-only pre-claim audit entries re-scoped on deprovision of an
   * unclaimed community) in deterministic `createdAt DESC, id DESC` order.
   * Never returns live community audit rows (`communityId IS NOT NULL`). Uses
   * `idx_audit_entries_community_created_at`.
   */
  async listSystemAuditEntries(
    input: ListSystemAuditEntriesInput
  ): Promise<{ rows: SystemAuditEntryRow[]; total: number }> {
    const { auditEntries } = this.tables;
    const predicates: SQL[] = [isNull(auditEntries.communityId)];
    if (input.action !== undefined) {
      predicates.push(eq(auditEntries.action, input.action));
    }
    if (input.outcome !== undefined) {
      predicates.push(eq(auditEntries.outcome, input.outcome));
    }
    const whereClause =
      predicates.length === 1 ? predicates[0] : and(...predicates);

    const [rows, totalRows] = await Promise.all([
      this.db
        .select({
          id: auditEntries.id,
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
        .offset(input.offset),
      this.db.select({ total: count() }).from(auditEntries).where(whereClause),
    ]);

    const normalized = (
      rows as Array<{
        id: number | string;
        actorId: number | string | null;
        action: string;
        resourceType: string | null;
        resourceIds: unknown;
        outcome: string;
        ipAddress: string | null;
        userAgent: string | null;
        createdAt: Date | number | string;
      }>
    ).map((row): SystemAuditEntryRow => {
      let parsedIds: unknown = row.resourceIds;
      if (typeof parsedIds === 'string') {
        try {
          parsedIds = JSON.parse(parsedIds);
        } catch {
          parsedIds = [];
        }
      }
      const resourceIds = Array.isArray(parsedIds)
        ? parsedIds.filter(
            (v): v is number | string =>
              (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ||
              (typeof v === 'string' && v.length > 0)
          )
        : [];
      return {
        id: Number(row.id),
        communityId: null,
        actorId:
          row.actorId === null || row.actorId === undefined
            ? null
            : Number(row.actorId),
        action: String(row.action),
        resourceType:
          row.resourceType === null ||
          row.resourceType === undefined ||
          row.resourceType === ''
            ? null
            : String(row.resourceType),
        resourceIds,
        outcome: String(row.outcome),
        ipAddress:
          row.ipAddress === null ||
          row.ipAddress === undefined ||
          row.ipAddress === ''
            ? null
            : String(row.ipAddress),
        userAgent:
          row.userAgent === null ||
          row.userAgent === undefined ||
          row.userAgent === ''
            ? null
            : String(row.userAgent),
        createdAt: toDate(row.createdAt),
      };
    });

    return {
      rows: normalized,
      total: Number(totalRows[0]?.total ?? 0),
    };
  }
}
