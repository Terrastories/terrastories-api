/**
 * Recovery-code and login-code redemption data access (Slice 11b-A, #188;
 * SPEC-V2 §6.8, §6.10, §7 "Bootstrap and account lifecycle"; route registry §1).
 *
 * Every multi-row mutation runs as one atomic unit across all three supported
 * targets:
 *  - PostgreSQL transaction with `communities (FOR SHARE) -> users (FOR UPDATE)
 *    -> sessions -> login_codes -> audit_entries` lock ordering;
 *  - SQLite synchronous transaction (`better-sqlite3`);
 *  - Workers D1 single `db.batch()` with <=100 bound parameters per statement
 *    and conditional predicates keeping step-up/code consumption atomic.
 */
import { and, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import type { VerifierWrite } from './hono-auth.repository.js';
import type { SessionKind } from '../shared/auth-policy.js';
import type { V2CommunityRole } from '../shared/authorization/sovereignty-policy.js';
import {
  validateContentFreeAuditEntry,
  type ContentFreeAuditEntryInput,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';

export interface LoginCodeRecord {
  id: number;
  communityId: number | null;
  userId: number;
  purpose: 'admin_issued' | 'recovery';
  codeHash: string;
  createdBy: number | null;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
  supersededAt: number | null;
}

export type RecoveryCodeGenerationOutcome =
  | 'generated'
  | 'step_up_failed'
  | 'authority_lost';

export type RecoveryGenerationStepUp =
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

const isTrue = (value: unknown): boolean => value === true || value === 1;

export class AuthRecoveryRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
  }

  /** Lookup a LoginCode by its SHA-256 digest (unique index). */
  async findLoginCodeByHash(codeHash: string): Promise<LoginCodeRecord | null> {
    const { loginCodes } = this.tables;
    const rows = await this.db
      .select({
        id: loginCodes.id,
        communityId: loginCodes.communityId,
        userId: loginCodes.userId,
        purpose: loginCodes.purpose,
        codeHash: loginCodes.codeHash,
        createdBy: loginCodes.createdBy,
        createdAt: loginCodes.createdAt,
        expiresAt: loginCodes.expiresAt,
        usedAt: loginCodes.usedAt,
        supersededAt: loginCodes.supersededAt,
      })
      .from(loginCodes)
      .where(eq(loginCodes.codeHash, codeHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      communityId: row.communityId === null ? null : Number(row.communityId),
      userId: Number(row.userId),
      purpose: row.purpose as 'admin_issued' | 'recovery',
      codeHash: row.codeHash,
      createdBy: row.createdBy === null ? null : Number(row.createdBy),
      createdAt: Number(row.createdAt),
      expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
      usedAt: row.usedAt === null ? null : Number(row.usedAt),
      supersededAt: row.supersededAt === null ? null : Number(row.supersededAt),
    };
  }

  /** Whether `userId` is currently designated as steward for their community (or any community for a null-community super_admin). */
  async isDesignatedSteward(userId: number): Promise<boolean> {
    const { communityStewards, users } = this.tables;
    const rows = await this.db
      .select({ communityId: communityStewards.communityId })
      .from(communityStewards)
      .innerJoin(users, eq(users.id, communityStewards.userId))
      .where(
        and(
          eq(communityStewards.userId, userId),
          eq(users.isActive, true),
          or(
            isNull(users.communityId),
            eq(users.communityId, communityStewards.communityId)
          )
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  private d1AuditInsert(
    database: Executor,
    record: ValidatedAuditEntryRecord,
    nowMs: number,
    gate: ReturnType<typeof sql>
  ) {
    const { auditEntries } = tablesFor(database);
    return database.insert(auditEntries).select(
      sql`select
        ${null}, ${record.communityId}, ${record.actorId}, ${record.action},
        ${record.resourceType}, ${JSON.stringify(record.resourceIds)},
        ${record.outcome}, ${record.ipAddress}, ${record.userAgent},
        ${nowMs}
      where ${gate}`
    );
  }

  private buildRecoveryGenerationStatements(
    tx: Executor,
    input: {
      actor: {
        id: number;
        communityId: number | null;
        role: V2CommunityRole;
      };
      codeHashes: string[];
      nowMs: number;
      stepUp: RecoveryGenerationStepUp;
    },
    validatedAudit: ValidatedAuditEntryRecord
  ) {
    const { sessions, loginCodes } = this.tables;
    const { actor, codeHashes, nowMs, stepUp } = input;

    const clearStepUp = (tokenHash: string) =>
      tx
        .update(sessions)
        .set({ adminCodeStepUpExpiresAt: null })
        .where(
          and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, actor.id))
        );

    const consumeStepUp = (tokenHash: string) =>
      tx
        .update(sessions)
        .set({ adminCodeStepUpExpiresAt: null })
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            eq(sessions.userId, actor.id),
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

    const supersedePrior = () =>
      tx
        .update(loginCodes)
        .set({ supersededAt: nowMs })
        .where(
          and(
            eq(loginCodes.userId, actor.id),
            eq(loginCodes.purpose, 'recovery'),
            isNull(loginCodes.usedAt),
            isNull(loginCodes.supersededAt)
          )
        );

    const insertCodes = () =>
      tx.insert(loginCodes).values(
        codeHashes.map((codeHash) => ({
          communityId: actor.communityId,
          userId: actor.id,
          purpose: 'recovery' as const,
          codeHash,
          createdBy: actor.id,
          createdAt: nowMs,
          expiresAt: null,
          usedAt: null,
          supersededAt: null,
        }))
      );

    const insertAudit = () => buildAuditEntryInsert(tx, validatedAudit);

    const checkUser = (
      userRow:
        | {
            isActive: unknown;
            role: string;
            communityId: number | null;
            passwordHash: string;
            passwordVerifier: string | null;
          }
        | undefined
    ): RecoveryCodeGenerationOutcome | null => {
      if (
        !userRow ||
        !isTrue(userRow.isActive) ||
        userRow.role !== actor.role ||
        userRow.communityId !== actor.communityId
      ) {
        return 'authority_lost';
      }
      if (actor.communityId === null && userRow.role !== 'super_admin') {
        return 'authority_lost';
      }
      if (
        stepUp.mode === 'password' &&
        (userRow.passwordHash !== stepUp.passwordHash ||
          userRow.passwordVerifier !== stepUp.expectedVerifier)
      ) {
        return 'authority_lost';
      }
      return null;
    };

    return {
      clearStepUp,
      consumeStepUp,
      supersedePrior,
      insertCodes,
      insertAudit,
      checkUser,
    };
  }

  /**
   * Atomically verify step-up authority, supersede prior unused recovery codes
   * for the account, insert 10 fresh recovery-code hashes, and write the
   * content-free audit row in one unit.
   */
  async generateRecoveryCodesAtomically(
    input: {
      actor: {
        id: number;
        communityId: number | null;
        role: V2CommunityRole;
      };
      codeHashes: string[];
      nowMs: number;
      stepUp: RecoveryGenerationStepUp;
    },
    audit: ContentFreeAuditEntryInput
  ): Promise<RecoveryCodeGenerationOutcome> {
    const validatedAudit = validateContentFreeAuditEntry(audit);
    const db = this.db;
    const { communities, communityStewards, users, sessions, loginCodes } =
      this.tables;
    const { actor, codeHashes, nowMs, stepUp } = input;

    if (typeof db.batch === 'function') {
      const userAuthoritySql = sql`u.is_active = 1
        and u.role = ${actor.role}
        and ${
          actor.communityId === null
            ? sql`u.community_id is null and u.role = 'super_admin'`
            : sql`u.community_id = ${actor.communityId}
                and c.id = ${actor.communityId}
                and (
                  u.role = 'admin'
                  or exists (
                    select 1 from community_stewards cs
                    where cs.community_id = u.community_id and cs.user_id = u.id
                  )
                )`
        }`;

      const gate =
        stepUp.mode === 'password'
          ? sql`exists (
              select 1 from users u
              left join communities c on c.id = u.community_id
              where u.id = ${actor.id}
                and u.password_hash = ${stepUp.passwordHash}
                and u.password_verifier = ${stepUp.expectedVerifier}
                and ${userAuthoritySql}
            )`
          : sql`exists (
              select 1 from sessions s
              inner join users u on u.id = s.user_id
              left join communities c on c.id = u.community_id
              where s.token_hash = ${stepUp.sessionTokenHash}
                and s.user_id = ${actor.id}
                and s.revoked_at is null
                and s.expires_at > ${nowMs}
                and (s.idle_expires_at is null or s.idle_expires_at > ${nowMs})
                and (s.absolute_expires_at is null or s.absolute_expires_at > ${nowMs})
                and s.admin_code_step_up_expires_at is not null
                and s.admin_code_step_up_expires_at > ${nowMs}
                and ${userAuthoritySql}
            )`;

      const statements: unknown[] = [
        db
          .update(loginCodes)
          .set({ supersededAt: nowMs })
          .where(
            and(
              eq(loginCodes.userId, actor.id),
              eq(loginCodes.purpose, 'recovery'),
              isNull(loginCodes.usedAt),
              isNull(loginCodes.supersededAt),
              gate
            )
          ),
      ];

      codeHashes.forEach((codeHash, index) => {
        const insertStmt = db.insert(loginCodes).select(
          sql`select
            ${null}, ${actor.communityId}, ${actor.id}, ${'recovery'},
            ${codeHash}, ${actor.id}, ${nowMs}, ${null}, ${null}, ${null}
          where ${gate}`
        );
        statements.push(
          index === 0 ? insertStmt.returning({ id: loginCodes.id }) : insertStmt
        );
      });

      statements.push(this.d1AuditInsert(db, validatedAudit, nowMs, gate));

      if (stepUp.mode === 'admin_issued_session') {
        statements.push(
          db
            .update(sessions)
            .set({ adminCodeStepUpExpiresAt: null })
            .where(
              and(
                eq(sessions.tokenHash, stepUp.sessionTokenHash),
                eq(sessions.userId, actor.id),
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
                sql`exists (
                  select 1 from users u
                  left join communities c on c.id = u.community_id
                  where u.id = ${actor.id} and ${userAuthoritySql}
                )`
              )
            )
            .returning({ id: sessions.id })
        );
      } else if (stepUp.sessionTokenHash !== undefined) {
        statements.push(
          db
            .update(sessions)
            .set({ adminCodeStepUpExpiresAt: null })
            .where(
              and(
                eq(sessions.tokenHash, stepUp.sessionTokenHash),
                eq(sessions.userId, actor.id),
                gate
              )
            )
        );
      }

      const results = (await db.batch(statements)) as Array<unknown[]>;
      if (stepUp.mode === 'admin_issued_session') {
        const consumed = results[results.length - 1] ?? [];
        return consumed.length > 0 ? 'generated' : 'step_up_failed';
      }
      const firstInsert = results[1] ?? [];
      return firstInsert.length > 0 ? 'generated' : 'authority_lost';
    }

    if (dialectOf(db) === 'postgresql') {
      return db.transaction(
        async (tx: Executor): Promise<RecoveryCodeGenerationOutcome> => {
          const ops = this.buildRecoveryGenerationStatements(
            tx,
            input,
            validatedAudit
          );
          if (actor.communityId !== null) {
            const [comm] = await tx
              .select({ id: communities.id, isActive: communities.isActive })
              .from(communities)
              .where(eq(communities.id, actor.communityId))
              .for('share')
              .limit(1);
            if (!comm) return 'authority_lost';
          }
          const [userRow] = await tx
            .select({
              id: users.id,
              communityId: users.communityId,
              role: users.role,
              isActive: users.isActive,
              passwordHash: users.passwordHash,
              passwordVerifier: users.passwordVerifier,
            })
            .from(users)
            .where(eq(users.id, actor.id))
            .for('update')
            .limit(1);
          const failure = ops.checkUser(userRow);
          if (failure !== null) return failure;
          if (actor.communityId !== null && actor.role !== 'admin') {
            const [stewardRow] = await tx
              .select({ userId: communityStewards.userId })
              .from(communityStewards)
              .where(
                and(
                  eq(communityStewards.communityId, actor.communityId),
                  eq(communityStewards.userId, actor.id)
                )
              )
              .for('share')
              .limit(1);
            if (!stewardRow) return 'authority_lost';
          }
          if (stepUp.mode === 'password') {
            if (stepUp.sessionTokenHash !== undefined) {
              await ops.clearStepUp(stepUp.sessionTokenHash);
            }
          } else {
            const consumed = await ops.consumeStepUp(stepUp.sessionTokenHash);
            if (consumed.length === 0) return 'step_up_failed';
          }
          await ops.supersedePrior();
          await ops.insertCodes();
          await ops.insertAudit();
          return 'generated';
        }
      );
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    return db.transaction((tx: Executor): RecoveryCodeGenerationOutcome => {
      const ops = this.buildRecoveryGenerationStatements(
        tx,
        input,
        validatedAudit
      );
      if (actor.communityId !== null) {
        const comm = tx
          .select({ id: communities.id, isActive: communities.isActive })
          .from(communities)
          .where(eq(communities.id, actor.communityId))
          .limit(1)
          .all()[0];
        if (!comm) return 'authority_lost';
      }
      const userRow = tx
        .select({
          id: users.id,
          communityId: users.communityId,
          role: users.role,
          isActive: users.isActive,
          passwordHash: users.passwordHash,
          passwordVerifier: users.passwordVerifier,
        })
        .from(users)
        .where(eq(users.id, actor.id))
        .limit(1)
        .all()[0];
      const failure = ops.checkUser(userRow);
      if (failure !== null) return failure;
      if (actor.communityId !== null && actor.role !== 'admin') {
        const stewardRow = tx
          .select({ userId: communityStewards.userId })
          .from(communityStewards)
          .where(
            and(
              eq(communityStewards.communityId, actor.communityId),
              eq(communityStewards.userId, actor.id)
            )
          )
          .limit(1)
          .all()[0];
        if (!stewardRow) return 'authority_lost';
      }
      if (stepUp.mode === 'password') {
        if (stepUp.sessionTokenHash !== undefined) {
          ops.clearStepUp(stepUp.sessionTokenHash).run();
        }
      } else {
        const consumed = ops.consumeStepUp(stepUp.sessionTokenHash).all();
        if (consumed.length === 0) return 'step_up_failed';
      }
      ops.supersedePrior().run();
      ops.insertCodes().run();
      ops.insertAudit().run();
      return 'generated';
    });
  }

  private buildRedeemStatements(
    tx: Executor,
    input: {
      code: {
        id: number;
        codeHash: string;
        userId: number;
        purpose: 'admin_issued' | 'recovery';
        expiresAt: number | null;
      };
      account: {
        id: number;
        communityId: number | null;
        role: V2CommunityRole;
        passwordHash: string;
      };
      verifier: VerifierWrite | null;
      session: {
        tokenHash: string;
        kind: SessionKind;
        createdAtMs: number;
        idleExpiresAtMs: number;
        absoluteExpiresAtMs: number;
        adminCodeStepUpExpiresAtMs: number | null;
        previousHash?: string;
      };
      nowMs: number;
    },
    validatedAudit: ValidatedAuditEntryRecord
  ) {
    const { users, sessions, loginCodes } = this.tables;
    const { code, account, verifier, session, nowMs } = input;

    const checkUser = (
      userRow:
        | {
            isActive: unknown;
            role: string;
            communityId: number | null;
            passwordHash: string;
          }
        | undefined
    ): boolean => {
      if (
        !userRow ||
        !isTrue(userRow.isActive) ||
        userRow.role !== account.role ||
        userRow.communityId !== account.communityId ||
        userRow.passwordHash !== account.passwordHash
      ) {
        return false;
      }
      if (account.communityId === null && userRow.role !== 'super_admin') {
        return false;
      }
      return true;
    };

    const consumeCode = () =>
      tx
        .update(loginCodes)
        .set({ usedAt: nowMs })
        .where(
          and(
            eq(loginCodes.id, code.id),
            eq(loginCodes.codeHash, code.codeHash),
            eq(loginCodes.userId, account.id),
            eq(loginCodes.purpose, code.purpose),
            isNull(loginCodes.usedAt),
            isNull(loginCodes.supersededAt),
            code.expiresAt === null
              ? isNull(loginCodes.expiresAt)
              : and(
                  isNotNull(loginCodes.expiresAt),
                  gt(loginCodes.expiresAt, nowMs)
                )
          )
        )
        .returning({ id: loginCodes.id });

    const updateVerifier = () =>
      verifier === null
        ? null
        : tx
            .update(users)
            .set({
              passwordVerifier: verifier.passwordVerifier,
              passwordAlgorithm: verifier.passwordAlgorithm,
              passwordSalt: verifier.passwordSalt,
              passwordParams: verifier.passwordParams,
            })
            .where(eq(users.id, account.id));

    const revokeSessions = () =>
      tx.delete(sessions).where(eq(sessions.userId, account.id));

    /**
     * Take every session row this redemption will delete under one `FOR UPDATE`
     * in a single deterministic (ascending id) order before any of them is
     * deleted. Two concurrent cross-user redemptions (A presenting B's cookie
     * while B presents A's) otherwise lock the same two rows in opposite order
     * — each its own session first — and PostgreSQL aborts one with a deadlock.
     * Ordering both sides identically makes the second transaction wait instead
     * of abort (SPEC-V2 §6.8).
     */
    const lockSessions = () =>
      tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          session.previousHash === undefined
            ? eq(sessions.userId, account.id)
            : or(
                eq(sessions.userId, account.id),
                eq(sessions.tokenHash, session.previousHash)
              )
        )
        .orderBy(sessions.id)
        .for('update');

    const insertSession = () =>
      tx.insert(sessions).values({
        id: session.tokenHash,
        tokenHash: session.tokenHash,
        userId: account.id,
        expiresAt: session.idleExpiresAtMs,
        kind: session.kind,
        createdAt: session.createdAtMs,
        lastSeenAt: session.createdAtMs,
        idleExpiresAt: session.idleExpiresAtMs,
        absoluteExpiresAt: session.absoluteExpiresAtMs,
        revokedAt: null,
        revokedBy: null,
        adminCodeStepUpExpiresAt: session.adminCodeStepUpExpiresAtMs,
      });

    const revokePresentedCrossUser = () =>
      session.previousHash === undefined
        ? null
        : tx
            .delete(sessions)
            .where(
              and(
                eq(sessions.tokenHash, session.previousHash),
                ne(sessions.userId, account.id)
              )
            );

    const insertAudit = () => buildAuditEntryInsert(tx, validatedAudit);

    return {
      checkUser,
      consumeCode,
      updateVerifier,
      lockSessions,
      revokeSessions,
      insertSession,
      revokePresentedCrossUser,
      insertAudit,
    };
  }

  /**
   * Atomically consume a single-use LoginCode (`recovery` or `admin_issued`),
   * optionally update the password verifier (mandatory for `recovery`, optional
   * for `admin_issued`) BEFORE creating the new Session so the authority-change
   * trigger revokes only prior sessions, revoke any remaining prior sessions +
   * cross-user presented cookie, issue the new Session, and write the
   * content-free audit row.
   */
  async redeemLoginCodeAtomically(
    input: {
      code: {
        id: number;
        codeHash: string;
        userId: number;
        purpose: 'admin_issued' | 'recovery';
        expiresAt: number | null;
      };
      account: {
        id: number;
        communityId: number | null;
        role: V2CommunityRole;
        passwordHash: string;
      };
      verifier: VerifierWrite | null;
      session: {
        tokenHash: string;
        kind: SessionKind;
        createdAtMs: number;
        idleExpiresAtMs: number;
        absoluteExpiresAtMs: number;
        adminCodeStepUpExpiresAtMs: number | null;
        previousHash?: string;
      };
      nowMs: number;
    },
    audit: ContentFreeAuditEntryInput
  ): Promise<boolean> {
    const validatedAudit = validateContentFreeAuditEntry(audit);
    const db = this.db;
    const { communities, communityStewards, users, sessions, loginCodes } =
      this.tables;
    const { code, account, verifier, session, nowMs } = input;

    if (typeof db.batch === 'function') {
      const codeAndAuthorityGate = sql`exists (
        select 1 from login_codes lc
        inner join users u on u.id = lc.user_id
        left join communities c on c.id = u.community_id
        where lc.id = ${code.id}
          and lc.code_hash = ${code.codeHash}
          and lc.user_id = ${account.id}
          and lc.purpose = ${code.purpose}
          and lc.used_at is null
          and lc.superseded_at is null
          and (${
            code.expiresAt === null
              ? sql`lc.expires_at is null`
              : sql`lc.expires_at is not null and lc.expires_at > ${nowMs}`
          })
          and u.is_active = 1
          and u.role = ${account.role}
          and u.password_hash = ${account.passwordHash}
          and (${
            account.communityId === null
              ? sql`u.community_id is null and u.role = 'super_admin'`
              : sql`u.community_id = ${account.communityId} and c.id = ${account.communityId} and (c.is_active = 1 or (c.is_active = 0 and (u.role = 'admin' or exists (select 1 from community_stewards cs where cs.community_id = u.community_id and cs.user_id = u.id))))`
          })
      )`;

      const verifierWrittenGate =
        verifier === null
          ? sql`1 = 1`
          : sql`exists (
              select 1 from users u
              where u.id = ${account.id}
                and u.password_verifier = ${verifier.passwordVerifier}
            )`;

      const newSessionExistsGate = sql`exists (
        select 1 from sessions s
        where s.token_hash = ${session.tokenHash}
          and s.user_id = ${account.id}
      )`;

      const statements: unknown[] = [];

      if (verifier !== null) {
        statements.push(
          db
            .update(users)
            .set({
              passwordVerifier: verifier.passwordVerifier,
              passwordAlgorithm: verifier.passwordAlgorithm,
              passwordSalt: verifier.passwordSalt,
              passwordParams: verifier.passwordParams,
            })
            .where(and(eq(users.id, account.id), codeAndAuthorityGate))
        );
      }

      statements.push(
        db
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, account.id),
              codeAndAuthorityGate,
              verifierWrittenGate
            )
          )
      );

      statements.push(
        db.insert(sessions).select(
          sql`select
            ${session.tokenHash}, ${session.tokenHash}, ${account.id},
            ${session.idleExpiresAtMs}, ${session.kind},
            ${session.createdAtMs}, ${session.createdAtMs},
            ${session.idleExpiresAtMs}, ${session.absoluteExpiresAtMs},
            ${null}, ${null}, ${session.adminCodeStepUpExpiresAtMs}
          where ${codeAndAuthorityGate} and ${verifierWrittenGate}`
        )
      );

      if (session.previousHash !== undefined) {
        statements.push(
          db
            .delete(sessions)
            .where(
              and(
                eq(sessions.tokenHash, session.previousHash),
                ne(sessions.userId, account.id),
                newSessionExistsGate
              )
            )
        );
      }

      statements.push(
        this.d1AuditInsert(db, validatedAudit, nowMs, newSessionExistsGate)
      );

      // Consume the LoginCode LAST, gated on the new session actually landing,
      // so a failing authority gate or concurrent batch leaves `used_at` NULL.
      statements.push(
        db
          .update(loginCodes)
          .set({ usedAt: nowMs })
          .where(
            and(
              eq(loginCodes.id, code.id),
              eq(loginCodes.codeHash, code.codeHash),
              eq(loginCodes.userId, account.id),
              eq(loginCodes.purpose, code.purpose),
              isNull(loginCodes.usedAt),
              isNull(loginCodes.supersededAt),
              code.expiresAt === null
                ? isNull(loginCodes.expiresAt)
                : and(
                    isNotNull(loginCodes.expiresAt),
                    gt(loginCodes.expiresAt, nowMs)
                  ),
              newSessionExistsGate
            )
          )
          .returning({ id: loginCodes.id })
      );

      const results = (await db.batch(statements)) as Array<unknown[]>;
      const consumed = results[results.length - 1] ?? [];
      return consumed.length > 0;
    }

    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: Executor): Promise<boolean> => {
        const ops = this.buildRedeemStatements(tx, input, validatedAudit);
        let disabledRequiresStewardCheck = false;
        if (account.communityId !== null) {
          const [comm] = await tx
            .select({ id: communities.id, isActive: communities.isActive })
            .from(communities)
            .where(eq(communities.id, account.communityId))
            .for('share')
            .limit(1);
          if (!comm) return false;
          if (!isTrue(comm.isActive) && account.role !== 'admin') {
            disabledRequiresStewardCheck = true;
          }
        }
        const [userRow] = await tx
          .select({
            id: users.id,
            communityId: users.communityId,
            role: users.role,
            isActive: users.isActive,
            passwordHash: users.passwordHash,
          })
          .from(users)
          .where(eq(users.id, account.id))
          .for('update')
          .limit(1);
        if (!ops.checkUser(userRow)) return false;
        // Sessions before community_stewards and login_codes, and all session
        // rows in one ascending order: a cross-user redemption pair and a
        // concurrent steward designation can then only serialize.
        await ops.lockSessions();
        if (disabledRequiresStewardCheck && account.communityId !== null) {
          const [stewardRow] = await tx
            .select({ userId: communityStewards.userId })
            .from(communityStewards)
            .where(
              and(
                eq(communityStewards.communityId, account.communityId),
                eq(communityStewards.userId, account.id)
              )
            )
            .for('share')
            .limit(1);
          if (!stewardRow) return false;
        }
        const consumed = await ops.consumeCode();
        if (consumed.length === 0) return false;
        const verStmt = ops.updateVerifier();
        if (verStmt !== null) await verStmt;
        await ops.revokeSessions();
        await ops.insertSession();
        const crossStmt = ops.revokePresentedCrossUser();
        if (crossStmt !== null) await crossStmt;
        await ops.insertAudit();
        return true;
      });
    }

    // better-sqlite3 synchronous transaction: callback MUST NOT return a Promise.
    return db.transaction((tx: Executor): boolean => {
      const ops = this.buildRedeemStatements(tx, input, validatedAudit);
      if (account.communityId !== null) {
        const comm = tx
          .select({ id: communities.id, isActive: communities.isActive })
          .from(communities)
          .where(eq(communities.id, account.communityId))
          .limit(1)
          .all()[0];
        if (!comm) return false;
        if (!isTrue(comm.isActive) && account.role !== 'admin') {
          const stewardRow = tx
            .select({ userId: communityStewards.userId })
            .from(communityStewards)
            .where(
              and(
                eq(communityStewards.communityId, account.communityId),
                eq(communityStewards.userId, account.id)
              )
            )
            .limit(1)
            .all()[0];
          if (!stewardRow) return false;
        }
      }
      const userRow = tx
        .select({
          id: users.id,
          communityId: users.communityId,
          role: users.role,
          isActive: users.isActive,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.id, account.id))
        .limit(1)
        .all()[0];
      if (!ops.checkUser(userRow)) return false;
      const consumed = ops.consumeCode().all();
      if (consumed.length === 0) return false;
      const verStmt = ops.updateVerifier();
      if (verStmt !== null) verStmt.run();
      ops.revokeSessions().run();
      ops.insertSession().run();
      const crossStmt = ops.revokePresentedCrossUser();
      if (crossStmt !== null) crossStmt.run();
      ops.insertAudit().run();
      return true;
    });
  }
}
