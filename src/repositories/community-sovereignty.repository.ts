/**
 * Community sovereignty data access (Slice 13b, #187; SPEC-V2 §6.2, §6.8, §7):
 * - Community steward designation, replacement, and removal (with automatic
 *   cancellation of pending steward notice requests on change/removal);
 * - Sovereignty status & history projection (`GET /v2/community/sovereignty`);
 * - Shared atomic step-up enforcement across D1 (`db.batch()`), PostgreSQL
 *   (`communities FOR UPDATE -> advisory lock -> users FOR UPDATE -> sessions ->
 *   community_stewards -> ... -> audit_entries`), and SQLite sync transactions.
 */

import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  communityStatusFromPhysical,
  userStatusFromPhysical,
  type CommunityStatus,
  type UserStatus,
} from '../policy/canonical-state.js';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  parseV2Role,
  type V2CommunityRole,
} from '../shared/authorization/sovereignty-policy.js';
import {
  SOVEREIGNTY_AUDIT_ACTIONS,
  SOVEREIGNTY_PG_ADVISORY_LOCK_NS,
  SOVEREIGNTY_RECENT_REQUESTS_LIMIT,
  type ArchiveCustodyStatus,
  type ArchiveCustodyType,
  type SovereigntyInitiatorRole,
  type SovereigntyRequestKind,
  type SovereigntyRequestState,
} from '../shared/sovereignty-policy.js';
import {
  validateContentFreeAuditEntry,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';

export type SovereigntyStepUp =
  | {
      mode: 'password';
      passwordHash: string;
      expectedVerifier: string;
      sessionTokenHash?: string;
    }
  | {
      mode: 'admin_issued_session';
      sessionTokenHash: string;
    };

export interface SovereigntyAuditMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface StewardRecord {
  userId: number;
  role: V2CommunityRole;
  status: UserStatus;
  sameCommunity: boolean;
  designatedBy: number | null;
  designatedAt: Date;
}

export interface SovereigntyRequestRecord {
  id: string;
  communityId: number;
  kind: SovereigntyRequestKind;
  state: SovereigntyRequestState;
  initiatedBy: number | null;
  initiatedByRole: SovereigntyInitiatorRole;
  requestedAt: Date;
  noticeEndsAt: Date | null;
  effectiveAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: number | null;
  completedAt: Date | null;
}

export interface ArchiveCustodyRecord {
  communityId: number;
  custodianType: ArchiveCustodyType;
  custodianUserId: number | null;
  status: ArchiveCustodyStatus;
  retentionUntil: Date;
  destroyedAt: Date | null;
  destructionAttestationRef: string | null;
}

export interface CommunitySovereigntyState {
  communityId: number;
  status: CommunityStatus;
  steward: StewardRecord | null;
  pendingRequests: SovereigntyRequestRecord[];
  recentRequests: SovereigntyRequestRecord[];
  archiveCustody: ArchiveCustodyRecord | null;
}

export interface StewardCommunityTarget {
  communityId: number;
  slug: string;
  status: CommunityStatus;
}

export type SetStewardOutcome =
  | {
      outcome: 'updated';
      steward: StewardRecord | null;
      cancelledRequestIds: string[];
    }
  | { outcome: 'not_found' }
  | { outcome: 'target_not_found' }
  | { outcome: 'authority_lost' }
  | { outcome: 'step_up_failed' }
  | { outcome: 'erasure_in_progress' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

const isTrue = (value: unknown): boolean => value === true || value === 1;

const toOptionalDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(Number(value));
};

const toDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(Number(value));

const toOptionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return Number(value);
};

export class CommunitySovereigntyRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;
  private readonly dialect;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
    this.dialect = dialectOf(connection);
  }

  private d1AuditInsert(
    database: Executor,
    record: ValidatedAuditEntryRecord,
    createdAtMs: number,
    gate: ReturnType<typeof sql>
  ) {
    const { auditEntries } = tablesFor(database);
    return database.insert(auditEntries).select(
      sql`select
        ${null}, ${record.communityId}, ${record.actorId}, ${record.action},
        ${record.resourceType}, ${JSON.stringify(record.resourceIds)},
        ${record.outcome}, ${record.ipAddress}, ${record.userAgent},
        ${createdAtMs}
      where ${gate}`
    );
  }

  private toRequestRecord(row: {
    id: unknown;
    communityId: unknown;
    kind: unknown;
    state: unknown;
    initiatedBy: unknown;
    initiatedByRole: unknown;
    requestedAt: unknown;
    noticeEndsAt: unknown;
    effectiveAt: unknown;
    cancelledAt: unknown;
    cancelledBy: unknown;
    completedAt: unknown;
  }): SovereigntyRequestRecord {
    return {
      id: String(row.id),
      communityId: Number(row.communityId),
      kind: String(row.kind) as SovereigntyRequestKind,
      state: String(row.state) as SovereigntyRequestState,
      initiatedBy: toOptionalNumber(row.initiatedBy),
      initiatedByRole: String(row.initiatedByRole) as SovereigntyInitiatorRole,
      requestedAt: toDate(row.requestedAt),
      noticeEndsAt: toOptionalDate(row.noticeEndsAt),
      effectiveAt: toOptionalDate(row.effectiveAt),
      cancelledAt: toOptionalDate(row.cancelledAt),
      cancelledBy: toOptionalNumber(row.cancelledBy),
      completedAt: toOptionalDate(row.completedAt),
    };
  }

  private toArchiveCustodyRecord(row: {
    communityId: unknown;
    custodianType: unknown;
    custodianUserId: unknown;
    status: unknown;
    retentionUntil: unknown;
    destroyedAt: unknown;
    destructionAttestationRef: unknown;
  }): ArchiveCustodyRecord {
    return {
      communityId: Number(row.communityId),
      custodianType: String(row.custodianType) as ArchiveCustodyType,
      custodianUserId: toOptionalNumber(row.custodianUserId),
      status: String(row.status) as ArchiveCustodyStatus,
      retentionUntil: toDate(row.retentionUntil),
      destroyedAt: toOptionalDate(row.destroyedAt),
      destructionAttestationRef:
        row.destructionAttestationRef === null ||
        row.destructionAttestationRef === undefined
          ? null
          : String(row.destructionAttestationRef),
    };
  }

  /**
   * Read own-community sovereignty status, designated steward, pending/recent
   * requests, and legacy archive custody metadata. Returns `null` if the
   * community is absent or logically deprovisioned.
   */
  async getSovereigntyState(
    communityId: number
  ): Promise<CommunitySovereigntyState | null> {
    const {
      communities,
      communityStewards,
      communitySovereigntyRequests,
      communityArchiveCustody,
      users,
    } = this.tables;

    const commRows = await this.db
      .select({
        id: communities.id,
        isActive: communities.isActive,
        deprovisionedAt: communities.deprovisionedAt,
      })
      .from(communities)
      .where(eq(communities.id, communityId))
      .limit(1);
    const commRow = commRows[0];
    if (!commRow || commRow.deprovisionedAt !== null) {
      return null;
    }

    const stewardRows = await this.db
      .select({
        userId: communityStewards.userId,
        designatedBy: communityStewards.designatedBy,
        designatedAt: communityStewards.designatedAt,
        userRole: users.role,
        userIsActive: users.isActive,
        userCommunityId: users.communityId,
      })
      .from(communityStewards)
      .innerJoin(users, eq(users.id, communityStewards.userId))
      .where(eq(communityStewards.communityId, communityId))
      .limit(1);

    let steward: StewardRecord | null = null;
    const rawSteward = stewardRows[0];
    if (rawSteward) {
      const parsedRole = parseV2Role(rawSteward.userRole);
      const userCommId = toOptionalNumber(rawSteward.userCommunityId);
      const validPairing =
        parsedRole !== null &&
        ((userCommId === communityId && parsedRole !== 'super_admin') ||
          (userCommId === null && parsedRole === 'super_admin'));
      if (validPairing) {
        steward = {
          userId: Number(rawSteward.userId),
          role: parsedRole,
          status: userStatusFromPhysical(isTrue(rawSteward.userIsActive)),
          sameCommunity: userCommId === communityId,
          designatedBy: toOptionalNumber(rawSteward.designatedBy),
          designatedAt: toDate(rawSteward.designatedAt),
        };
      }
    }

    const requestCols = {
      id: communitySovereigntyRequests.id,
      communityId: communitySovereigntyRequests.communityId,
      kind: communitySovereigntyRequests.kind,
      state: communitySovereigntyRequests.state,
      initiatedBy: communitySovereigntyRequests.initiatedBy,
      initiatedByRole: communitySovereigntyRequests.initiatedByRole,
      requestedAt: communitySovereigntyRequests.requestedAt,
      noticeEndsAt: communitySovereigntyRequests.noticeEndsAt,
      effectiveAt: communitySovereigntyRequests.effectiveAt,
      cancelledAt: communitySovereigntyRequests.cancelledAt,
      cancelledBy: communitySovereigntyRequests.cancelledBy,
      completedAt: communitySovereigntyRequests.completedAt,
    };

    const [pendingRows, recentRows, custodyRows] = await Promise.all([
      this.db
        .select(requestCols)
        .from(communitySovereigntyRequests)
        .where(
          and(
            eq(communitySovereigntyRequests.communityId, communityId),
            inArray(communitySovereigntyRequests.state, [
              'notice',
              'requested',
              'executing',
            ])
          )
        )
        .orderBy(
          desc(communitySovereigntyRequests.requestedAt),
          desc(communitySovereigntyRequests.id)
        ),
      this.db
        .select(requestCols)
        .from(communitySovereigntyRequests)
        .where(
          and(
            eq(communitySovereigntyRequests.communityId, communityId),
            inArray(communitySovereigntyRequests.state, [
              'cancelled',
              'completed',
            ])
          )
        )
        .orderBy(
          desc(communitySovereigntyRequests.requestedAt),
          desc(communitySovereigntyRequests.id)
        )
        .limit(SOVEREIGNTY_RECENT_REQUESTS_LIMIT),
      this.db
        .select({
          communityId: communityArchiveCustody.communityId,
          custodianType: communityArchiveCustody.custodianType,
          custodianUserId: communityArchiveCustody.custodianUserId,
          status: communityArchiveCustody.status,
          retentionUntil: communityArchiveCustody.retentionUntil,
          destroyedAt: communityArchiveCustody.destroyedAt,
          destructionAttestationRef:
            communityArchiveCustody.destructionAttestationRef,
        })
        .from(communityArchiveCustody)
        .where(eq(communityArchiveCustody.communityId, communityId))
        .limit(1),
    ]);

    return {
      communityId,
      status: communityStatusFromPhysical(isTrue(commRow.isActive)),
      steward,
      pendingRequests: (
        pendingRows as Array<
          Parameters<CommunitySovereigntyRepository['toRequestRecord']>[0]
        >
      ).map((row) => this.toRequestRecord(row)),
      recentRequests: (
        recentRows as Array<
          Parameters<CommunitySovereigntyRepository['toRequestRecord']>[0]
        >
      ).map((row) => this.toRequestRecord(row)),
      archiveCustody: custodyRows[0]
        ? this.toArchiveCustodyRecord(
            custodyRows[0] as Parameters<
              CommunitySovereigntyRepository['toArchiveCustodyRecord']
            >[0]
          )
        : null,
    };
  }

  /**
   * Resolve a community by explicit locator (`communityId` or `communitySlug`)
   * ONLY when `userId` holds its recorded steward designation. Used for
   * null-community `super_admin` steward requests (SPEC-V2 §7).
   */
  async findStewardDesignation(
    userId: number,
    locator: { communityId?: number; communitySlug?: string }
  ): Promise<StewardCommunityTarget | null> {
    const { communities, communityStewards } = this.tables;
    if (
      locator.communityId === undefined &&
      locator.communitySlug === undefined
    ) {
      return null;
    }
    const locatorCondition =
      locator.communityId !== undefined
        ? eq(communities.id, locator.communityId)
        : eq(communities.slug, locator.communitySlug!);

    const rows = await this.db
      .select({
        communityId: communities.id,
        slug: communities.slug,
        isActive: communities.isActive,
        deprovisionedAt: communities.deprovisionedAt,
      })
      .from(communityStewards)
      .innerJoin(communities, eq(communities.id, communityStewards.communityId))
      .where(
        and(
          eq(communityStewards.userId, userId),
          locatorCondition,
          isNull(communities.deprovisionedAt)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      communityId: Number(row.communityId),
      slug: String(row.slug),
      status: communityStatusFromPhysical(isTrue(row.isActive)),
    };
  }

  /**
   * Designate, replace, or remove a community's steward atomically with step-up
   * verification, automatic cancellation of prior steward pending notice
   * requests, and a content-free audit entry.
   */
  async setStewardAtomically(input: {
    communityId: number;
    actorId: number;
    stewardUserId: number | null;
    now: Date;
    stepUp: SovereigntyStepUp;
    auditMeta: SovereigntyAuditMeta;
  }): Promise<SetStewardOutcome> {
    const { communityId, actorId, stewardUserId, now, stepUp, auditMeta } =
      input;
    const nowMs = now.getTime();
    const action =
      stewardUserId === null
        ? SOVEREIGNTY_AUDIT_ACTIONS.STEWARD_REMOVED
        : SOVEREIGNTY_AUDIT_ACTIONS.STEWARD_DESIGNATED;
    const validatedAudit = validateContentFreeAuditEntry({
      communityId,
      actorId,
      action,
      resourceType: 'community_sovereignty',
      resourceIds: [stewardUserId === null ? communityId : stewardUserId],
      outcome: 'success',
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
    });

    const db = this.db;
    const {
      communities,
      users,
      sessions,
      communityStewards,
      communitySovereigntyRequests,
    } = this.tables;

    if (typeof db.batch === 'function') {
      const communityLiveSql = sql`exists (
        select 1 from communities c
        where c.id = ${communityId}
          and c.deprovisioned_at is null
          and not exists (
            select 1 from community_sovereignty_requests csr
            where csr.community_id = c.id
              and csr.kind = 'erasure'
              and csr.state in ('requested', 'executing', 'completed')
          )
      )`;

      const actorGateSql =
        stepUp.mode === 'password'
          ? sql`exists (
              select 1 from users a
              where a.id = ${actorId}
                and a.community_id = ${communityId}
                and a.role = 'admin'
                and a.is_active = 1
                and a.password_hash = ${stepUp.passwordHash}
                and a.password_verifier = ${stepUp.expectedVerifier}
            )`
          : sql`exists (
              select 1 from sessions s
              inner join users a on a.id = s.user_id
              where s.token_hash = ${stepUp.sessionTokenHash}
                and s.user_id = ${actorId}
                and s.revoked_at is null
                and s.expires_at > ${nowMs}
                and (s.idle_expires_at is null or s.idle_expires_at > ${nowMs})
                and (s.absolute_expires_at is null or s.absolute_expires_at > ${nowMs})
                and s.admin_code_step_up_expires_at is not null
                and s.admin_code_step_up_expires_at > ${nowMs}
                and a.community_id = ${communityId}
                and a.role = 'admin'
                and a.is_active = 1
            )`;

      const targetGateSql =
        stewardUserId === null
          ? sql`1 = 1`
          : sql`exists (
              select 1 from users t
              where t.id = ${stewardUserId}
                and t.is_active = 1
                and (
                  (t.community_id = ${communityId} and t.role in ('viewer', 'member', 'editor', 'admin'))
                  or (t.community_id is null and t.role = 'super_admin')
                )
            )`;

      const fullGateSql = sql`${communityLiveSql} and ${actorGateSql} and ${targetGateSql}`;

      const cancelNoticeStmt = db
        .update(communitySovereigntyRequests)
        .set({
          state: 'cancelled',
          cancelledAt: nowMs,
          cancelledBy: actorId,
          updatedAt: nowMs,
        })
        .where(
          and(
            eq(communitySovereigntyRequests.communityId, communityId),
            eq(communitySovereigntyRequests.state, 'notice'),
            eq(communitySovereigntyRequests.initiatedByRole, 'steward'),
            or(
              isNull(communitySovereigntyRequests.noticeEndsAt),
              gt(communitySovereigntyRequests.noticeEndsAt, nowMs)
            ),
            stewardUserId === null
              ? sql`1 = 1`
              : sql`exists (
                  select 1 from community_stewards cs
                  where cs.community_id = ${communityId}
                    and cs.user_id <> ${stewardUserId}
                )`,
            fullGateSql
          )
        )
        .returning({ id: communitySovereigntyRequests.id });

      const clearStewardBeforeUpsertStmt = db
        .delete(communityStewards)
        .where(
          and(eq(communityStewards.communityId, communityId), fullGateSql)
        );

      const stewardInsertStmt =
        stewardUserId === null
          ? null
          : db
              .insert(communityStewards)
              .select(
                sql`select ${communityId}, ${stewardUserId}, ${actorId}, ${nowMs}, ${nowMs} where ${fullGateSql}`
              )
              .returning({ communityId: communityStewards.communityId });

      const auditStmt = this.d1AuditInsert(
        db,
        validatedAudit,
        nowMs,
        fullGateSql
      );

      const stepUpStmt =
        stepUp.mode === 'admin_issued_session'
          ? db
              .update(sessions)
              .set({ adminCodeStepUpExpiresAt: null })
              .where(
                and(
                  eq(sessions.tokenHash, stepUp.sessionTokenHash),
                  eq(sessions.userId, actorId),
                  isNull(sessions.revokedAt),
                  gt(sessions.expiresAt, nowMs),
                  or(
                    isNull(sessions.idleExpiresAt),
                    gt(sessions.idleExpiresAt, nowMs)
                  ),
                  or(
                    isNull(sessions.absoluteExpiresAt),
                    gt(sessions.absoluteExpiresAt, nowMs)
                  ),
                  isNotNull(sessions.adminCodeStepUpExpiresAt),
                  gt(sessions.adminCodeStepUpExpiresAt, nowMs),
                  communityLiveSql,
                  targetGateSql,
                  sql`exists (select 1 from users a where a.id = ${actorId} and a.community_id = ${communityId} and a.role = 'admin' and a.is_active = 1)`
                )
              )
              .returning({ id: sessions.id })
          : stepUp.sessionTokenHash !== undefined
            ? db
                .update(sessions)
                .set({ adminCodeStepUpExpiresAt: null })
                .where(
                  and(
                    eq(sessions.tokenHash, stepUp.sessionTokenHash),
                    eq(sessions.userId, actorId),
                    fullGateSql
                  )
                )
            : null;

      // Also probe community-live + actor gate explicitly inside the same batch
      // when stewardUserId === null (because DELETE returns 0 rows even on
      // success when there was no prior steward).
      const gateProbeStmt = db
        .select({
          ok: sql<number>`1`,
        })
        .from(communities)
        .where(and(eq(communities.id, communityId), fullGateSql))
        .limit(1);

      const statements: unknown[] = [
        cancelNoticeStmt,
        clearStewardBeforeUpsertStmt,
      ];
      if (stewardInsertStmt !== null) {
        statements.push(stewardInsertStmt);
      }
      statements.push(auditStmt);
      const probeIdx = statements.length;
      statements.push(gateProbeStmt);
      const stepUpIdx = stepUpStmt !== null ? statements.length : -1;
      if (stepUpStmt !== null) {
        statements.push(stepUpStmt);
      }

      const results = (await db.batch(statements)) as Array<unknown[]>;
      const probeRows = results[probeIdx] ?? [];
      const gateSucceeded =
        probeRows.length > 0 &&
        (stepUp.mode !== 'admin_issued_session' ||
          (stepUpIdx >= 0 && (results[stepUpIdx] ?? []).length > 0));

      if (gateSucceeded) {
        const cancelledRequestIds = (
          (results[0] ?? []) as Array<{ id: string }>
        ).map((row) => String(row.id));
        if (stewardUserId === null) {
          return {
            outcome: 'updated',
            steward: null,
            cancelledRequestIds,
          };
        }
        const state = await this.getSovereigntyState(communityId);
        return {
          outcome: 'updated',
          steward: state?.steward ?? null,
          cancelledRequestIds,
        };
      }

      // Diagnostic read after a rejected gate (nothing mutated).
      const [commRows, erasureRows, actorRows] = await db.batch([
        db
          .select({
            id: communities.id,
            deprovisionedAt: communities.deprovisionedAt,
          })
          .from(communities)
          .where(eq(communities.id, communityId))
          .limit(1),
        db
          .select({ id: communitySovereigntyRequests.id })
          .from(communitySovereigntyRequests)
          .where(
            and(
              eq(communitySovereigntyRequests.communityId, communityId),
              eq(communitySovereigntyRequests.kind, 'erasure'),
              inArray(communitySovereigntyRequests.state, [
                'requested',
                'executing',
                'completed',
              ])
            )
          )
          .limit(1),
        db
          .select({
            id: users.id,
            communityId: users.communityId,
            role: users.role,
            isActive: users.isActive,
            passwordHash: users.passwordHash,
            passwordVerifier: users.passwordVerifier,
          })
          .from(users)
          .where(eq(users.id, actorId))
          .limit(1),
      ]);

      const comm = commRows[0] as
        | { id: number; deprovisionedAt: number | null }
        | undefined;
      if (!comm || comm.deprovisionedAt !== null) {
        return { outcome: 'not_found' };
      }
      if ((erasureRows as unknown[]).length > 0) {
        return { outcome: 'erasure_in_progress' };
      }
      const actorRow = actorRows[0] as
        | {
            id: number;
            communityId: number | null;
            role: string;
            isActive: unknown;
            passwordHash: string;
            passwordVerifier: string | null;
          }
        | undefined;
      if (
        !actorRow ||
        !isTrue(actorRow.isActive) ||
        actorRow.role !== 'admin' ||
        Number(actorRow.communityId) !== communityId
      ) {
        return { outcome: 'authority_lost' };
      }
      if (
        stepUp.mode === 'password' &&
        (actorRow.passwordHash !== stepUp.passwordHash ||
          actorRow.passwordVerifier !== stepUp.expectedVerifier)
      ) {
        return { outcome: 'step_up_failed' };
      }
      if (stepUp.mode === 'admin_issued_session') {
        const sessionRows = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.tokenHash, stepUp.sessionTokenHash),
              eq(sessions.userId, actorId),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, nowMs),
              or(
                isNull(sessions.idleExpiresAt),
                gt(sessions.idleExpiresAt, nowMs)
              ),
              or(
                isNull(sessions.absoluteExpiresAt),
                gt(sessions.absoluteExpiresAt, nowMs)
              ),
              isNotNull(sessions.adminCodeStepUpExpiresAt),
              gt(sessions.adminCodeStepUpExpiresAt, nowMs)
            )
          )
          .limit(1);
        if (sessionRows.length === 0) {
          return { outcome: 'step_up_failed' };
        }
      }
      return { outcome: 'target_not_found' };
    }

    if (this.dialect === 'postgresql') {
      return db.transaction(
        async (tx: Executor): Promise<SetStewardOutcome> => {
          // Canonical lock order: communities (FOR UPDATE) -> advisory lock ->
          // users (FOR UPDATE in ASC id order) -> sessions -> community_stewards
          // -> community_sovereignty_requests -> audit_entries.
          const [commRow] = await tx
            .select({
              id: communities.id,
              deprovisionedAt: communities.deprovisionedAt,
            })
            .from(communities)
            .where(eq(communities.id, communityId))
            .for('update')
            .limit(1);
          if (!commRow || commRow.deprovisionedAt !== null) {
            return { outcome: 'not_found' };
          }

          await tx.execute(
            sql`select pg_advisory_xact_lock(${SOVEREIGNTY_PG_ADVISORY_LOCK_NS}, ${communityId})`
          );

          const [erasureRow] = await tx
            .select({ id: communitySovereigntyRequests.id })
            .from(communitySovereigntyRequests)
            .where(
              and(
                eq(communitySovereigntyRequests.communityId, communityId),
                eq(communitySovereigntyRequests.kind, 'erasure'),
                inArray(communitySovereigntyRequests.state, [
                  'requested',
                  'executing',
                  'completed',
                ])
              )
            )
            .limit(1);
          if (erasureRow) {
            return { outcome: 'erasure_in_progress' };
          }

          const userIdsToLock =
            stewardUserId !== null && stewardUserId !== actorId
              ? [actorId, stewardUserId].sort((a, b) => a - b)
              : [actorId];
          const lockedUsers = (await tx
            .select({
              id: users.id,
              communityId: users.communityId,
              role: users.role,
              isActive: users.isActive,
              passwordHash: users.passwordHash,
              passwordVerifier: users.passwordVerifier,
            })
            .from(users)
            .where(inArray(users.id, userIdsToLock))
            .orderBy(users.id)
            .for('update')) as Array<{
            id: number;
            communityId: number | null;
            role: string;
            isActive: unknown;
            passwordHash: string;
            passwordVerifier: string | null;
          }>;

          const actorRow = lockedUsers.find((u) => Number(u.id) === actorId);
          if (
            !actorRow ||
            !isTrue(actorRow.isActive) ||
            actorRow.role !== 'admin' ||
            Number(actorRow.communityId) !== communityId
          ) {
            return { outcome: 'authority_lost' };
          }

          if (stepUp.mode === 'password') {
            if (
              actorRow.passwordHash !== stepUp.passwordHash ||
              actorRow.passwordVerifier !== stepUp.expectedVerifier
            ) {
              return { outcome: 'step_up_failed' };
            }
          } else {
            const [validStepUpSession] = await tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                and(
                  eq(sessions.tokenHash, stepUp.sessionTokenHash),
                  eq(sessions.userId, actorId),
                  isNull(sessions.revokedAt),
                  gt(sessions.expiresAt, nowMs),
                  or(
                    isNull(sessions.idleExpiresAt),
                    gt(sessions.idleExpiresAt, nowMs)
                  ),
                  or(
                    isNull(sessions.absoluteExpiresAt),
                    gt(sessions.absoluteExpiresAt, nowMs)
                  ),
                  isNotNull(sessions.adminCodeStepUpExpiresAt),
                  gt(sessions.adminCodeStepUpExpiresAt, nowMs)
                )
              )
              .for('update')
              .limit(1);
            if (!validStepUpSession) {
              return { outcome: 'step_up_failed' };
            }
          }

          let targetRow: (typeof lockedUsers)[number] | undefined;
          if (stewardUserId !== null) {
            targetRow = lockedUsers.find((u) => Number(u.id) === stewardUserId);
            const targetRole = targetRow ? parseV2Role(targetRow.role) : null;
            const targetCommId = targetRow
              ? toOptionalNumber(targetRow.communityId)
              : null;
            const validTarget =
              targetRow !== undefined &&
              isTrue(targetRow.isActive) &&
              targetRole !== null &&
              ((targetCommId === communityId && targetRole !== 'super_admin') ||
                (targetCommId === null && targetRole === 'super_admin'));
            if (!validTarget) {
              return { outcome: 'target_not_found' };
            }
          }

          if (stepUp.mode === 'admin_issued_session') {
            const consumed = await tx
              .update(sessions)
              .set({ adminCodeStepUpExpiresAt: null })
              .where(
                and(
                  eq(sessions.tokenHash, stepUp.sessionTokenHash),
                  eq(sessions.userId, actorId),
                  isNull(sessions.revokedAt),
                  gt(sessions.expiresAt, nowMs),
                  or(
                    isNull(sessions.idleExpiresAt),
                    gt(sessions.idleExpiresAt, nowMs)
                  ),
                  or(
                    isNull(sessions.absoluteExpiresAt),
                    gt(sessions.absoluteExpiresAt, nowMs)
                  ),
                  isNotNull(sessions.adminCodeStepUpExpiresAt),
                  gt(sessions.adminCodeStepUpExpiresAt, nowMs)
                )
              )
              .returning({ id: sessions.id });
            if (consumed.length === 0) {
              return { outcome: 'step_up_failed' };
            }
          } else if (stepUp.sessionTokenHash !== undefined) {
            await tx
              .update(sessions)
              .set({ adminCodeStepUpExpiresAt: null })
              .where(
                and(
                  eq(sessions.tokenHash, stepUp.sessionTokenHash),
                  eq(sessions.userId, actorId)
                )
              );
          }

          const [existingSteward] = await tx
            .select({ userId: communityStewards.userId })
            .from(communityStewards)
            .where(eq(communityStewards.communityId, communityId))
            .for('update')
            .limit(1);

          let cancelledRequestIds: string[] = [];
          const shouldCancelPending =
            existingSteward !== undefined &&
            (stewardUserId === null ||
              Number(existingSteward.userId) !== stewardUserId);

          if (shouldCancelPending) {
            const cancelled = await tx
              .update(communitySovereigntyRequests)
              .set({
                state: 'cancelled',
                cancelledAt: nowMs,
                cancelledBy: actorId,
                updatedAt: nowMs,
              })
              .where(
                and(
                  eq(communitySovereigntyRequests.communityId, communityId),
                  eq(communitySovereigntyRequests.state, 'notice'),
                  eq(communitySovereigntyRequests.initiatedByRole, 'steward'),
                  or(
                    isNull(communitySovereigntyRequests.noticeEndsAt),
                    gt(communitySovereigntyRequests.noticeEndsAt, nowMs)
                  )
                )
              )
              .returning({ id: communitySovereigntyRequests.id });
            cancelledRequestIds = (cancelled as Array<{ id: string }>).map(
              (row) => String(row.id)
            );
          }

          let nextSteward: StewardRecord | null = null;
          if (stewardUserId === null) {
            if (existingSteward) {
              await tx
                .delete(communityStewards)
                .where(eq(communityStewards.communityId, communityId));
            }
          } else {
            await tx
              .insert(communityStewards)
              .values({
                communityId,
                userId: stewardUserId,
                designatedBy: actorId,
                designatedAt: nowMs,
                updatedAt: nowMs,
              })
              .onConflictDoUpdate({
                target: communityStewards.communityId,
                set: {
                  userId: stewardUserId,
                  designatedBy: actorId,
                  designatedAt: nowMs,
                  updatedAt: nowMs,
                },
              });
            const targetRole = parseV2Role(targetRow!.role)!;
            nextSteward = {
              userId: stewardUserId,
              role: targetRole,
              status: 'active',
              sameCommunity: toOptionalNumber(targetRow!.communityId) !== null,
              designatedBy: actorId,
              designatedAt: now,
            };
          }

          await buildAuditEntryInsert(tx, validatedAudit, now);
          return {
            outcome: 'updated',
            steward: nextSteward,
            cancelledRequestIds,
          };
        }
      );
    }

    // Synchronous better-sqlite3 transaction
    return db.transaction((tx: Executor): SetStewardOutcome => {
      const commRow = tx
        .select({
          id: communities.id,
          deprovisionedAt: communities.deprovisionedAt,
        })
        .from(communities)
        .where(eq(communities.id, communityId))
        .limit(1)
        .all()[0];
      if (!commRow || commRow.deprovisionedAt !== null) {
        return { outcome: 'not_found' };
      }

      const erasureRow = tx
        .select({ id: communitySovereigntyRequests.id })
        .from(communitySovereigntyRequests)
        .where(
          and(
            eq(communitySovereigntyRequests.communityId, communityId),
            eq(communitySovereigntyRequests.kind, 'erasure'),
            inArray(communitySovereigntyRequests.state, [
              'requested',
              'executing',
              'completed',
            ])
          )
        )
        .limit(1)
        .all()[0];
      if (erasureRow) {
        return { outcome: 'erasure_in_progress' };
      }

      const actorRow = tx
        .select({
          id: users.id,
          communityId: users.communityId,
          role: users.role,
          isActive: users.isActive,
          passwordHash: users.passwordHash,
          passwordVerifier: users.passwordVerifier,
        })
        .from(users)
        .where(eq(users.id, actorId))
        .limit(1)
        .all()[0];
      if (
        !actorRow ||
        !isTrue(actorRow.isActive) ||
        actorRow.role !== 'admin' ||
        Number(actorRow.communityId) !== communityId
      ) {
        return { outcome: 'authority_lost' };
      }

      if (stepUp.mode === 'password') {
        if (
          actorRow.passwordHash !== stepUp.passwordHash ||
          actorRow.passwordVerifier !== stepUp.expectedVerifier
        ) {
          return { outcome: 'step_up_failed' };
        }
      } else {
        const validSession = tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.tokenHash, stepUp.sessionTokenHash),
              eq(sessions.userId, actorId),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, nowMs),
              or(
                isNull(sessions.idleExpiresAt),
                gt(sessions.idleExpiresAt, nowMs)
              ),
              or(
                isNull(sessions.absoluteExpiresAt),
                gt(sessions.absoluteExpiresAt, nowMs)
              ),
              isNotNull(sessions.adminCodeStepUpExpiresAt),
              gt(sessions.adminCodeStepUpExpiresAt, nowMs)
            )
          )
          .limit(1)
          .all()[0];
        if (!validSession) {
          return { outcome: 'step_up_failed' };
        }
      }

      let targetRow:
        | {
            id: number;
            communityId: number | null;
            role: string;
            isActive: unknown;
          }
        | undefined;
      if (stewardUserId !== null) {
        targetRow = tx
          .select({
            id: users.id,
            communityId: users.communityId,
            role: users.role,
            isActive: users.isActive,
          })
          .from(users)
          .where(eq(users.id, stewardUserId))
          .limit(1)
          .all()[0];
        const targetRole = targetRow ? parseV2Role(targetRow.role) : null;
        const targetCommId = targetRow
          ? toOptionalNumber(targetRow.communityId)
          : null;
        const validTarget =
          targetRow !== undefined &&
          isTrue(targetRow.isActive) &&
          targetRole !== null &&
          ((targetCommId === communityId && targetRole !== 'super_admin') ||
            (targetCommId === null && targetRole === 'super_admin'));
        if (!validTarget) {
          return { outcome: 'target_not_found' };
        }
      }

      if (stepUp.mode === 'admin_issued_session') {
        const consumed = tx
          .update(sessions)
          .set({ adminCodeStepUpExpiresAt: null })
          .where(
            and(
              eq(sessions.tokenHash, stepUp.sessionTokenHash),
              eq(sessions.userId, actorId),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, nowMs),
              or(
                isNull(sessions.idleExpiresAt),
                gt(sessions.idleExpiresAt, nowMs)
              ),
              or(
                isNull(sessions.absoluteExpiresAt),
                gt(sessions.absoluteExpiresAt, nowMs)
              ),
              isNotNull(sessions.adminCodeStepUpExpiresAt),
              gt(sessions.adminCodeStepUpExpiresAt, nowMs)
            )
          )
          .returning({ id: sessions.id })
          .all();
        if (consumed.length === 0) {
          return { outcome: 'step_up_failed' };
        }
      } else if (stepUp.sessionTokenHash !== undefined) {
        tx.update(sessions)
          .set({ adminCodeStepUpExpiresAt: null })
          .where(
            and(
              eq(sessions.tokenHash, stepUp.sessionTokenHash),
              eq(sessions.userId, actorId)
            )
          )
          .run();
      }

      const existingSteward = tx
        .select({ userId: communityStewards.userId })
        .from(communityStewards)
        .where(eq(communityStewards.communityId, communityId))
        .limit(1)
        .all()[0];

      let cancelledRequestIds: string[] = [];
      const shouldCancelPending =
        existingSteward !== undefined &&
        (stewardUserId === null ||
          Number(existingSteward.userId) !== stewardUserId);

      if (shouldCancelPending) {
        const cancelled = tx
          .update(communitySovereigntyRequests)
          .set({
            state: 'cancelled',
            cancelledAt: nowMs,
            cancelledBy: actorId,
            updatedAt: nowMs,
          })
          .where(
            and(
              eq(communitySovereigntyRequests.communityId, communityId),
              eq(communitySovereigntyRequests.state, 'notice'),
              eq(communitySovereigntyRequests.initiatedByRole, 'steward'),
              or(
                isNull(communitySovereigntyRequests.noticeEndsAt),
                gt(communitySovereigntyRequests.noticeEndsAt, nowMs)
              )
            )
          )
          .returning({ id: communitySovereigntyRequests.id })
          .all();
        cancelledRequestIds = (cancelled as Array<{ id: string }>).map((row) =>
          String(row.id)
        );
      }

      let nextSteward: StewardRecord | null = null;
      if (stewardUserId === null) {
        if (existingSteward) {
          tx.delete(communityStewards)
            .where(eq(communityStewards.communityId, communityId))
            .run();
        }
      } else {
        tx.insert(communityStewards)
          .values({
            communityId,
            userId: stewardUserId,
            designatedBy: actorId,
            designatedAt: nowMs,
            updatedAt: nowMs,
          })
          .onConflictDoUpdate({
            target: communityStewards.communityId,
            set: {
              userId: stewardUserId,
              designatedBy: actorId,
              designatedAt: nowMs,
              updatedAt: nowMs,
            },
          })
          .run();
        const targetRole = parseV2Role(targetRow!.role)!;
        nextSteward = {
          userId: stewardUserId,
          role: targetRole,
          status: 'active',
          sameCommunity: toOptionalNumber(targetRow!.communityId) !== null,
          designatedBy: actorId,
          designatedAt: now,
        };
      }

      buildAuditEntryInsert(tx, validatedAudit, now).run();
      return {
        outcome: 'updated',
        steward: nextSteward,
        cancelledRequestIds,
      };
    });
  }
  async hasAdminIssuedStepUp(
    actorId: number,
    tokenHash: string,
    nowMs: number
  ): Promise<boolean> {
    const { sessions } = this.tables;
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, actorId),
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, nowMs),
          gt(sessions.adminCodeStepUpExpiresAt, nowMs),
          or(isNull(sessions.idleExpiresAt), gt(sessions.idleExpiresAt, nowMs)),
          or(
            isNull(sessions.absoluteExpiresAt),
            gt(sessions.absoluteExpiresAt, nowMs)
          )
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Execute one bounded atomic unit on each supported backend. */
  private async sovereigntyUnit(
    communityId: number,
    actorId: number | null,
    build: (db: Executor) => Executor[]
  ): Promise<unknown[][]> {
    if (typeof this.db.batch === 'function') {
      return this.db.batch(build(this.db));
    }
    if (this.dialect === 'postgresql') {
      return this.db.transaction(async (tx: Executor) => {
        // Lifecycle writes share the same community-first order as user/admin writes.
        await tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(eq(this.tables.communities.id, communityId))
          .for('update');
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SOVEREIGNTY_PG_ADVISORY_LOCK_NS}, ${communityId})`
        );
        if (actorId !== null) {
          await tx
            .select({ id: this.tables.users.id })
            .from(this.tables.users)
            .where(eq(this.tables.users.id, actorId))
            .for('update');
        }
        if (actorId === null)
          await tx
            .select({ id: this.tables.users.id })
            .from(this.tables.users)
            .where(eq(this.tables.users.communityId, communityId))
            .orderBy(this.tables.users.id)
            .for('update');
        // A disable trigger deletes all community sessions. Lock them in id order
        // before touching requests, including the step-up session itself.
        await tx
          .select({ id: this.tables.sessions.id })
          .from(this.tables.sessions)
          .where(
            inArray(
              this.tables.sessions.userId,
              tx
                .select({ id: this.tables.users.id })
                .from(this.tables.users)
                .where(eq(this.tables.users.communityId, communityId))
            )
          )
          .orderBy(this.tables.sessions.id)
          .for('update');
        const results = [];
        for (const stmt of build(tx)) results.push(await stmt);
        return results;
      });
    }
    return this.db.transaction((tx: Executor) =>
      build(tx).map((stmt) => stmt.all())
    );
  }

  private sovereigntyAuthority(
    communityId: number,
    actorId: number,
    role: SovereigntyInitiatorRole,
    stepUp: SovereigntyStepUp,
    nowMs: number
  ) {
    const active = this.dialect === 'postgresql' ? sql`true` : sql`1`;
    const authority =
      role === 'admin'
        ? sql`a.community_id = ${communityId} and a.role = 'admin'`
        : sql`exists (select 1 from community_stewards cs
          where cs.community_id = ${communityId} and cs.user_id = a.id)
          and ((a.community_id = ${communityId} and a.role in ('viewer','member','editor','admin'))
            or (a.community_id is null and a.role = 'super_admin'))`;
    const verifier =
      stepUp.mode === 'password'
        ? sql`a.password_hash = ${stepUp.passwordHash} and a.password_verifier = ${stepUp.expectedVerifier}`
        : role !== 'admin'
          ? sql`false`
          : sql`exists (
          select 1 from sessions s where s.user_id = a.id
          and s.token_hash = ${stepUp.sessionTokenHash} and s.revoked_at is null
          and s.expires_at > ${nowMs}
          and (s.idle_expires_at is null or s.idle_expires_at > ${nowMs})
          and (s.absolute_expires_at is null or s.absolute_expires_at > ${nowMs})
          and s.admin_code_step_up_expires_at > ${nowMs})`;
    return sql`exists (select 1 from users a where a.id = ${actorId}
      and a.is_active = ${active} and ${authority} and ${verifier})
      and exists (select 1 from communities c where c.id = ${communityId}
        and c.deprovisioned_at is null)
      and not exists (select 1 from community_sovereignty_requests e
        where e.community_id = ${communityId} and e.kind = 'erasure'
        and e.state in ('requested','executing','completed'))`;
  }

  private conditionalAudit(
    db: Executor,
    communityId: number,
    actorId: number | null,
    action: string,
    resourceId: string,
    now: Date,
    meta: SovereigntyAuditMeta,
    gate: ReturnType<typeof sql>
  ) {
    const { auditEntries } = this.tables;
    const created =
      this.dialect === 'postgresql' ? now.toISOString() : now.getTime();
    // Explicit columns avoid serial-id/default differences between PostgreSQL and D1.
    return db
      .insert(auditEntries)
      .select(
        sql`select
      ${this.dialect === 'postgresql' ? sql`nextval(pg_get_serial_sequence('audit_entries','id'))` : sql`null`},
      ${communityId}, ${actorId}, ${action}, ${'community_sovereignty'},
      ${JSON.stringify([resourceId])}, ${'success'}, ${meta.ipAddress}, ${meta.userAgent}, ${created}
      where ${gate}`
      )
      .returning({ id: auditEntries.id });
  }

  async requestWithdrawal(input: {
    communityId: number;
    actorId: number;
    role: SovereigntyInitiatorRole;
    requestId: string;
    stepUp: SovereigntyStepUp;
    now: Date;
    auditMeta: SovereigntyAuditMeta;
    noticeEndsAt: number | null;
    kind?: SovereigntyRequestKind;
  }): Promise<SovereigntyRequestRecord | null> {
    const { communityId, actorId, role, requestId, stepUp, now, auditMeta } =
      input;
    const kind = input.kind ?? 'withdrawal';
    const erasure = kind === 'erasure';
    const ms = now.getTime();
    const {
      communitySovereigntyRequests: requests,
      sessions,
      communities,
      claimTokens,
    } = this.tables;
    const gate = this.sovereigntyAuthority(
      communityId,
      actorId,
      role,
      stepUp,
      ms
    );
    const marker = sql`exists (select 1 from community_sovereignty_requests r where r.id = ${requestId})`;
    const results = await this.sovereigntyUnit(communityId, actorId, (db) => {
      const statements: Executor[] = [];
      // An administrator's withdrawal supersedes a still-pending steward notice
      // in the same unit: the notice is parked as `cancelled` by the acting
      // administrator, so a notice can never outlive an immediate withdrawal
      // (SPEC-V2 §7 Withdrawal/Steward process).
      if (role === 'admin') {
        statements.push(
          this.conditionalAudit(
            db,
            communityId,
            actorId,
            SOVEREIGNTY_AUDIT_ACTIONS.REQUEST_CANCELLED,
            requestId,
            now,
            auditMeta,
            sql`${gate} and exists (select 1 from community_sovereignty_requests s
            where s.community_id = ${communityId} and s.kind = ${kind}
              and s.state = 'notice')`
          )
        );
        statements.push(
          db
            .update(requests)
            .set({
              state: 'cancelled',
              cancelledAt: ms,
              cancelledBy: actorId,
              updatedAt: ms,
            })
            .where(
              and(
                eq(requests.communityId, communityId),
                eq(requests.kind, kind),
                eq(requests.state, 'notice'),
                gate
              )
            )
            .returning()
        );
      }
      statements.push(
        db
          .insert(requests)
          .select(
            sql`select
        ${requestId}, ${communityId}, ${kind}, ${role === 'admin' ? (erasure ? 'requested' : 'completed') : 'notice'},
        ${actorId}, ${role}, ${ms}, ${input.noticeEndsAt}, ${role === 'admin' ? ms : null},
        ${null}, ${null}, ${role === 'admin' && !erasure ? ms : null}, ${ms}
        where ${gate} and not exists (select 1 from community_sovereignty_requests p
          where p.community_id = ${communityId} and p.kind = ${kind} and p.state in ('notice','requested','executing'))`
          )
          .returning(),
        this.conditionalAudit(
          db,
          communityId,
          actorId,
          role === 'admin'
            ? erasure
              ? SOVEREIGNTY_AUDIT_ACTIONS.ERASURE_REQUESTED
              : SOVEREIGNTY_AUDIT_ACTIONS.WITHDRAWAL_COMPLETED
            : erasure
              ? SOVEREIGNTY_AUDIT_ACTIONS.ERASURE_NOTICE_STARTED
              : SOVEREIGNTY_AUDIT_ACTIONS.WITHDRAWAL_NOTICE_STARTED,
          requestId,
          now,
          auditMeta,
          marker
        )
      );
      if (stepUp.sessionTokenHash !== undefined)
        statements.push(
          db
            .update(sessions)
            .set({ adminCodeStepUpExpiresAt: null })
            .where(
              and(
                eq(sessions.tokenHash, stepUp.sessionTokenHash),
                eq(sessions.userId, actorId),
                marker
              )
            )
            .returning()
        );
      if (role === 'admin') {
        statements.push(
          db
            .update(communities)
            .set({ isActive: false, updatedAt: now })
            .where(and(eq(communities.id, communityId), marker))
            .returning(),
          db
            .update(claimTokens)
            .set({ supersededAt: ms })
            .where(
              and(
                eq(claimTokens.communityId, communityId),
                isNull(claimTokens.consumedAt),
                isNull(claimTokens.supersededAt),
                marker
              )
            )
            .returning()
        );
      }
      return statements;
    });
    const row = results[role === 'admin' ? 2 : 0]?.[0];
    return row
      ? this.toRequestRecord(
          row as Parameters<
            CommunitySovereigntyRepository['toRequestRecord']
          >[0]
        )
      : null;
  }

  async cancelNotice(input: {
    communityId: number;
    actorId: number;
    requestId?: string;
    stepUp: SovereigntyStepUp;
    now: Date;
    auditMeta: SovereigntyAuditMeta;
  }): Promise<SovereigntyRequestRecord[]> {
    const { communityId, actorId, requestId, stepUp, now, auditMeta } = input;
    const ms = now.getTime();
    const { communitySovereigntyRequests: requests, sessions } = this.tables;
    const gate = this.sovereigntyAuthority(
      communityId,
      actorId,
      'admin',
      stepUp,
      ms
    );
    const changed = sql`exists (select 1 from community_sovereignty_requests r
      where r.community_id = ${communityId} and r.state = 'requested'
        and r.cancelled_by = ${actorId} and r.updated_at = ${ms}
        and ${requestId ? sql`r.id = ${requestId}` : sql`true`})`;
    const results = await this.sovereigntyUnit(communityId, actorId, (db) => {
      const statements = [
        db
          .update(requests)
          .set({
            // Temporary claim is invisible outside this atomic unit.
            state: 'requested',
            cancelledBy: actorId,
            updatedAt: ms,
          })
          .where(
            and(
              eq(requests.communityId, communityId),
              eq(requests.state, 'notice'),
              eq(requests.initiatedByRole, 'steward'),
              gt(requests.noticeEndsAt, ms),
              requestId ? eq(requests.id, requestId) : undefined,
              gate
            )
          )
          .returning(),
        this.conditionalAudit(
          db,
          communityId,
          actorId,
          SOVEREIGNTY_AUDIT_ACTIONS.REQUEST_CANCELLED,
          requestId ?? String(communityId),
          now,
          auditMeta,
          changed
        ),
      ];
      if (stepUp.sessionTokenHash !== undefined)
        statements.push(
          db
            .update(sessions)
            .set({ adminCodeStepUpExpiresAt: null })
            .where(
              and(
                eq(sessions.tokenHash, stepUp.sessionTokenHash),
                eq(sessions.userId, actorId),
                changed
              )
            )
            .returning()
        );
      statements.push(
        db
          .update(requests)
          .set({
            state: 'cancelled',
            cancelledAt: ms,
            updatedAt: ms,
          })
          .where(
            and(
              eq(requests.communityId, communityId),
              eq(requests.state, 'requested'),
              eq(requests.cancelledBy, actorId),
              eq(requests.updatedAt, ms),
              requestId ? eq(requests.id, requestId) : undefined
            )
          )
          .returning()
      );
      return statements;
    });
    return (results[results.length - 1] ?? []).map((row) =>
      this.toRequestRecord(
        row as Parameters<CommunitySovereigntyRepository['toRequestRecord']>[0]
      )
    );
  }

  /** Persisted notices survive restarts. Called before HTTP reads and by maintenance. */
  async applyDueWithdrawals(now: Date, limit = 5): Promise<boolean> {
    const {
      communitySovereigntyRequests: requests,
      communities,
      claimTokens,
    } = this.tables;
    const ms = now.getTime();
    const due = await this.db
      .select({ id: requests.id, communityId: requests.communityId })
      .from(requests)
      .where(
        and(
          eq(requests.kind, 'withdrawal'),
          eq(requests.state, 'notice'),
          sql`${requests.noticeEndsAt} <= ${ms}`
        )
      )
      .orderBy(requests.noticeEndsAt, requests.id)
      .limit(limit);
    for (const row of due) {
      await this.sovereigntyUnit(Number(row.communityId), null, (db) => {
        const marker = sql`exists (select 1 from community_sovereignty_requests r
          where r.id = ${row.id} and r.state = 'executing')`;
        // Claim inside the atomic unit; a concurrent sweep cannot repeat effects.
        const complete = db
          .update(requests)
          .set({
            state: 'executing',
            effectiveAt: sql`${requests.noticeEndsAt}`,
            updatedAt: ms,
          })
          .where(
            and(
              eq(requests.id, row.id),
              eq(requests.state, 'notice'),
              sql`${requests.noticeEndsAt} <= ${ms}`
            )
          )
          .returning();
        return [
          complete,
          this.conditionalAudit(
            db,
            Number(row.communityId),
            null,
            SOVEREIGNTY_AUDIT_ACTIONS.WITHDRAWAL_COMPLETED,
            String(row.id),
            now,
            { ipAddress: null, userAgent: null },
            marker
          ),
          db
            .update(communities)
            .set({ isActive: false, updatedAt: now })
            .where(and(eq(communities.id, row.communityId), marker))
            .returning(),
          db
            .update(claimTokens)
            .set({ supersededAt: ms })
            .where(
              and(
                eq(claimTokens.communityId, row.communityId),
                isNull(claimTokens.consumedAt),
                isNull(claimTokens.supersededAt),
                marker
              )
            )
            .returning(),
          db
            .update(requests)
            .set({ state: 'completed', completedAt: ms, updatedAt: ms })
            .where(
              and(eq(requests.id, row.id), eq(requests.state, 'executing'))
            )
            .returning(),
        ];
      });
    }
    return due.length < limit;
  }
  async erasurePending(communityId: number): Promise<boolean> {
    const r = this.tables.communitySovereigntyRequests;
    const rows = await this.db
      .select({ id: r.id })
      .from(r)
      .where(
        and(
          eq(r.communityId, communityId),
          eq(r.kind, 'erasure'),
          inArray(r.state, ['requested', 'executing'])
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  async erasureRestoreBlocked(now: Date): Promise<boolean> {
    const r = this.tables.communitySovereigntyRequests;
    const rows = await this.db
      .select({ id: r.id })
      .from(r)
      .where(
        and(
          eq(r.kind, 'erasure'),
          or(
            inArray(r.state, ['requested', 'executing']),
            and(
              eq(r.state, 'notice'),
              sql`${r.noticeEndsAt} <= ${now.getTime()}`
            )
          )
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  async erasureWork(
    limit = 5,
    now = new Date()
  ): Promise<SovereigntyRequestRecord[]> {
    const r = this.tables.communitySovereigntyRequests;
    const pending = and(
      eq(r.kind, 'erasure'),
      inArray(r.state, ['requested', 'executing'])
    );
    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(r)
      .where(pending);
    // Rotate discovery too: repeatedly reading only the oldest five would
    // hide every later community from the out-of-band scheduler indefinitely.
    const offset = total
      ? (Math.floor(now.getTime() / 60000) * limit) % total
      : 0;
    const rows = await this.db
      .select()
      .from(r)
      .where(pending)
      .orderBy(r.requestedAt, r.id)
      .limit(limit)
      .offset(offset);
    return rows.map(
      (row: Parameters<CommunitySovereigntyRepository['toRequestRecord']>[0]) =>
        this.toRequestRecord(row)
    );
  }

  async activateDueErasures(now: Date): Promise<boolean> {
    const r = this.tables.communitySovereigntyRequests;
    const rows = await this.db
      .select({ id: r.id, communityId: r.communityId })
      .from(r)
      .where(
        and(
          eq(r.kind, 'erasure'),
          eq(r.state, 'notice'),
          sql`${r.noticeEndsAt} <= ${now.getTime()}`
        )
      )
      .orderBy(r.noticeEndsAt, r.id)
      .limit(5);
    for (const row of rows)
      await this.sovereigntyUnit(Number(row.communityId), null, (db) => {
        const marker = sql`exists (select 1 from community_sovereignty_requests where id=${row.id} and state='requested')`;
        return [
          db
            .update(r)
            .set({
              state: 'requested',
              effectiveAt: sql`${r.noticeEndsAt}`,
              updatedAt: now.getTime(),
            })
            .where(
              and(
                eq(r.id, row.id),
                eq(r.state, 'notice'),
                sql`${r.noticeEndsAt} <= ${now.getTime()}`
              )
            )
            .returning(),
          this.conditionalAudit(
            db,
            Number(row.communityId),
            null,
            SOVEREIGNTY_AUDIT_ACTIONS.ERASURE_REQUESTED,
            String(row.id),
            now,
            { ipAddress: null, userAgent: null },
            marker
          ),
          db
            .update(this.tables.communities)
            .set({ isActive: false, updatedAt: now })
            .where(and(eq(this.tables.communities.id, row.communityId), marker))
            .returning(),
        ];
      });
    // The partial due-notice index makes the backlog check bounded. Reads
    // fail closed even when more than one activation batch is overdue.
    const remaining = await this.db
      .select({ id: r.id })
      .from(r)
      .where(
        and(
          eq(r.kind, 'erasure'),
          eq(r.state, 'notice'),
          sql`${r.noticeEndsAt} <= ${now.getTime()}`
        )
      )
      .limit(1);
    return remaining.length === 0;
  }

  async erasureUploads(communityId: number) {
    const j = this.tables.exportJobs;
    return this.db
      .select({ id: j.id, key: j.zipStorageKey, uploadId: j.zipUploadId })
      .from(j)
      .where(and(eq(j.communityId, communityId), isNotNull(j.zipUploadId)))
      .limit(10) as Promise<
      Array<{ id: string; key: string | null; uploadId: string | null }>
    >;
  }

  async clearErasureUpload(id: string, uploadId: string): Promise<void> {
    const j = this.tables.exportJobs;
    await this.db
      .update(j)
      .set({ zipUploadId: null })
      .where(and(eq(j.id, id), eq(j.zipUploadId, uploadId)));
  }

  async eraseRows(communityId: number, now: Date): Promise<void> {
    const t = this.tables;
    await this.sovereigntyUnit(communityId, null, (db) => [
      // Delete only this community's audit history. Cross-community/system
      // history survives; only its reference to an erased account is detached.
      db
        .delete(t.auditEntries)
        .where(eq(t.auditEntries.communityId, communityId))
        .returning({ id: t.auditEntries.id }),
      db
        .update(t.auditEntries)
        .set({ actorId: null })
        .where(
          inArray(
            t.auditEntries.actorId,
            db
              .select({ id: t.users.id })
              .from(t.users)
              .where(eq(t.users.communityId, communityId))
          )
        )
        .returning({ id: t.auditEntries.id }),
      db
        .update(t.files)
        .set({ uploadedBy: null })
        .where(
          inArray(
            t.files.uploadedBy,
            db
              .select({ id: t.users.id })
              .from(t.users)
              .where(eq(t.users.communityId, communityId))
          )
        )
        .returning({ id: t.files.id }),
      ...[
        t.attachments,
        t.externalMediaLinks,
        t.storyPlaces,
        t.storySpeakers,
        t.importManifests,
        t.exportTokens,
        t.exportJobs,
        t.communityMapConfigs,
        t.stories,
        t.speakers,
        t.places,
        t.files,
        t.themes,
        t.claimTokens,
        t.authThrottle,
        t.loginCodes,
      ].map((table) =>
        db
          .delete(table)
          .where(eq(table.communityId, communityId))
          .returning({ communityId: table.communityId })
      ),
      db
        .delete(t.users)
        .where(eq(t.users.communityId, communityId))
        .returning({ id: t.users.id }),
      db
        .delete(t.communities)
        .where(eq(t.communities.id, communityId))
        .returning({ id: t.communities.id }),
      buildAuditEntryInsert(
        db,
        {
          communityId: null,
          actorId: null,
          action: SOVEREIGNTY_AUDIT_ACTIONS.ERASURE_COMPLETED,
          resourceType: 'system',
          resourceIds: [communityId],
          outcome: 'success',
        },
        now
      ).returning(),
    ]);
  }
}
