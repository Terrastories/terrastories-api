/**
 * Community user-management data access (Slice 11a, #188; SPEC-V2 §6.2, §6.8,
 * route registry §6 "Users").
 *
 * Own-community accounts only: every query is scoped by the actor's
 * community, cross-community rows are invisible (callers answer 404). The
 * list surface never projects credential material. Identity collision checks
 * mirror the backfill contract in src/db/backfill-user-identity.ts and run
 * on the application-normalized columns — never database case-folding — so
 * they behave identically on SQLite/D1 and PostgreSQL; the unique indexes
 * remain the backstop for the check-then-insert race.
 *
 * The privileged verifier reset runs community → users → sessions lock
 * order on PostgreSQL (matching HonoFoundationRepository.createSessionWithVerifier)
 * so a concurrent role/is_active change and an assisted reset cannot deadlock.
 */
import {
  and,
  asc,
  count,
  eq,
  gt,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { userStatusToPhysical } from '../policy/canonical-state.js';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import { sessionsPg, sessionsSqlite } from '../db/schema/sessions.js';
import {
  validateContentFreeAuditEntry,
  type ContentFreeAuditEntryInput,
  type ValidatedAuditEntryRecord,
} from '../shared/utils/audit-entry.js';
import { buildAuditEntryInsert } from './audit-entry.repository.js';
import { userAuthorityConditions } from './hono-foundation.repository.js';

export interface ManagedUserRow {
  id: number;
  email: string | null;
  username: string | null;
  displayName: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date;
  /**
   * Normalized identity columns. Internal read model only — never projected
   * onto the wire (SPEC-V2 §6.2 identity checks need the stored values).
   */
  emailNormalized: string | null;
  usernameNormalized: string | null;
}

export interface DeviceSessionRow {
  id: string;
  kind: 'standard' | 'device';
  createdAt: number | null;
  lastSeenAt: number | null;
  idleExpiresAt: number | null;
  absoluteExpiresAt: number | null;
}

// Drizzle's per-dialect executors expose incompatible TS overloads; the
// coupled write builders are typed through the same loose aliases the
// foundation repository uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;

/** Unique-constraint backstop (23505 / SQLITE_CONSTRAINT_UNIQUE) across the
 * check-then-insert race. Mirrors community.repository's detector. */
export function isUniqueConstraintError(
  error: unknown,
  seen: Set<unknown> = new Set()
): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const { code, message, cause } = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  ) {
    return true;
  }
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    if (
      lower.includes('unique constraint') ||
      lower.includes('duplicate key')
    ) {
      return true;
    }
  }
  return cause ? isUniqueConstraintError(cause, seen) : false;
}

export class UserManagementRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly database: any;
  private readonly tables;

  constructor(database: Database | DrizzleD1Database) {
    this.database = database;
    this.tables = tablesFor(database);
  }

  /** Shared connection for the audit writer. */
  get connection(): Database | DrizzleD1Database {
    return this.database;
  }

  private toRow(row: {
    id: number;
    email: string | null;
    username: string | null;
    displayName: string | null;
    role: string;
    isActive: number | boolean;
    createdAt: Date | number;
    emailNormalized: string | null;
    usernameNormalized: string | null;
  }): ManagedUserRow {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      isActive: row.isActive === true || row.isActive === 1,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      emailNormalized: row.emailNormalized ?? null,
      usernameNormalized: row.usernameNormalized ?? null,
    };
  }

  private projection() {
    const { users } = this.tables;
    return {
      id: users.id,
      email: users.email,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      emailNormalized: users.emailNormalized,
      usernameNormalized: users.usernameNormalized,
    };
  }

  /** Own-community lifecycle flag, or null when the community row is gone. */
  async communityIsActive(communityId: number): Promise<boolean | null> {
    const { communities } = this.tables;
    const rows = await this.database
      .select({ isActive: communities.isActive })
      .from(communities)
      .where(eq(communities.id, communityId))
      .limit(1);
    const value = rows[0]?.isActive;
    if (value === undefined) return null;
    return value === true || value === 1;
  }

  async listCommunityUsers(
    communityId: number,
    limit: number,
    offset: number
  ): Promise<{ rows: ManagedUserRow[]; total: number }> {
    const { users } = this.tables;
    const [rows, totalRows] = await Promise.all([
      this.database
        .select(this.projection())
        .from(users)
        .where(eq(users.communityId, communityId))
        // Deterministic, stable order (id tie-break); SPEC §4/§9.
        .orderBy(asc(users.id))
        .limit(limit)
        .offset(offset),
      this.database
        .select({ total: count() })
        .from(users)
        .where(eq(users.communityId, communityId)),
    ]);
    return {
      rows: rows.map((row: never) => this.toRow(row)),
      total: Number(totalRows[0]?.total ?? 0),
    };
  }

  /** A single own-community account, or null (cross-community 404). */
  async findCommunityUser(
    communityId: number,
    id: number
  ): Promise<ManagedUserRow | null> {
    const { users } = this.tables;
    const rows = await this.database
      .select(this.projection())
      .from(users)
      .where(and(eq(users.id, id), eq(users.communityId, communityId)))
      .limit(1);
    const row = rows[0];
    return row ? this.toRow(row) : null;
  }

  /**
   * Raw row including the verifier anchors the coupled reset write re-checks.
   * Same-community only; null when absent.
   */
  async findCommunityUserForReset(
    communityId: number,
    id: number
  ): Promise<{
    id: number;
    communityId: number;
    passwordHash: string;
    passwordVerifier: string | null;
  } | null> {
    const { users } = this.tables;
    const rows = await this.database
      .select({
        id: users.id,
        communityId: users.communityId,
        passwordHash: users.passwordHash,
        passwordVerifier: users.passwordVerifier,
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.communityId, communityId)))
      .limit(1);
    const row = rows[0];
    if (!row || row.communityId === null) return null;
    return {
      id: row.id,
      communityId: row.communityId,
      passwordHash: row.passwordHash,
      passwordVerifier: row.passwordVerifier,
    };
  }

  /**
   * Whether `create`/`update` would violate any SPEC-V2 §6.2 identity rule.
   * One round trip; no rule names are leaked to the caller — any hit is a
   * uniform 409. May run against a transaction executor (PostgreSQL).
   */
  async hasIdentityCollision(
    input: {
      communityId: number | null;
      emailNormalized?: string;
      usernameNormalized?: string | null;
      excludeUserId?: number;
    },
    database: Executor = this.database
  ): Promise<boolean> {
    const { users } = this.tables;
    const { emailNormalized, usernameNormalized, excludeUserId } = input;
    if (emailNormalized === undefined && !usernameNormalized) return false;
    const clauses = [];
    if (usernameNormalized) {
      // Global username uniqueness.
      clauses.push(eq(users.usernameNormalized, usernameNormalized));
      // A username matching another account's email (any community).
      clauses.push(eq(users.emailNormalized, usernameNormalized));
    }
    if (emailNormalized !== undefined) {
      if (input.communityId === null) {
        // A null-community account's email may not be shared with any
        // account at all (§6.2).
        clauses.push(eq(users.emailNormalized, emailNormalized));
      } else {
        // Community-scoped email uniqueness.
        clauses.push(
          and(
            eq(users.communityId, input.communityId),
            eq(users.emailNormalized, emailNormalized)
          )
        );
        // An email shared between a null-community account and any
        // community account (§6.2: unresolvable at login; rejected on new
        // identities).
        clauses.push(
          and(
            isNull(users.communityId),
            eq(users.emailNormalized, emailNormalized)
          )
        );
      }
      // An email matching another account's username (any community).
      clauses.push(eq(users.usernameNormalized, emailNormalized));
    }
    if (clauses.length === 0) return false;
    const rows = await database
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          or(...clauses),
          excludeUserId === undefined ? undefined : ne(users.id, excludeUserId)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The cross-rule identity predicates as raw `x.<column>` fragments for the
   * guarded INSERT ... SELECT / UPDATE ... WHERE NOT EXISTS statements. The
   * unique indexes back the primary uniqueness rules; these fragments carry
   * the cross-kind rules (username == email, email == username, email shared
   * with a null-community account) which no index enforces.
   */
  private identityCollisionWhereSql(input: {
    communityId: number | null;
    emailNormalized?: string;
    usernameNormalized?: string | null;
    excludeUserId?: number;
  }): SQL | undefined {
    const { emailNormalized, usernameNormalized, excludeUserId } = input;
    const clauses: SQL[] = [];
    if (usernameNormalized) {
      clauses.push(sql`x.username_normalized = ${usernameNormalized}`);
      clauses.push(sql`x.email_normalized = ${usernameNormalized}`);
    }
    if (emailNormalized !== undefined) {
      if (input.communityId === null) {
        clauses.push(sql`x.email_normalized = ${emailNormalized}`);
      } else {
        clauses.push(
          sql`x.community_id = ${input.communityId} and x.email_normalized = ${emailNormalized}`
        );
        clauses.push(
          sql`x.community_id is null and x.email_normalized = ${emailNormalized}`
        );
      }
      clauses.push(sql`x.username_normalized = ${emailNormalized}`);
    }
    if (clauses.length === 0) return undefined;
    const inner = or(...clauses);
    const scoped =
      excludeUserId === undefined
        ? sql`(${inner})`
        : sql`x.id <> ${excludeUserId} and (${inner})`;
    return sql`not exists (select 1 from users x where ${scoped})`;
  }

  /**
   * Normalized identifiers involved in an identity write, de-duplicated and
   * sorted so concurrent writers take the PostgreSQL advisory locks in one
   * total order and cannot deadlock.
   */
  private advisoryLockIdentifiers(input: {
    emailNormalized?: string;
    usernameNormalized?: string | null;
  }): string[] {
    const identifiers = [
      input.emailNormalized,
      input.usernameNormalized,
    ].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    return [...new Set(identifiers)].sort();
  }

  private async takeIdentityAdvisoryLocks(
    tx: Executor,
    input: { emailNormalized?: string; usernameNormalized?: string | null }
  ): Promise<void> {
    for (const identifier of this.advisoryLockIdentifiers(input)) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('identity:' || ${identifier}))`
      );
    }
  }

  /**
   * Guarded account creation. `ok: false` means an identity rule was hit —
   * the caller answers the uniform 409, never naming the rule. The guard and
   * the insert are one atomic unit: a single `INSERT ... SELECT ... WHERE NOT
   * EXISTS` statement on SQLite/D1, or a transaction taking advisory locks on
   * every normalized identifier involved (sorted) before checking and writing
   * on PostgreSQL — never a racing check-then-insert.
   */
  async createCommunityUser(input: {
    communityId: number;
    username: string;
    usernameNormalized: string | null;
    email: string;
    emailNormalized: string;
    displayName: string | null;
    role: 'viewer' | 'member' | 'editor' | 'admin';
    passwordHash: string;
    verifier: {
      passwordVerifier: string;
      passwordAlgorithm: string;
      passwordSalt: string;
      passwordParams: string;
    } | null;
    createdAt: Date;
  }): Promise<{ ok: true; id: number } | { ok: false }> {
    const { users } = this.tables;
    const createdMs = input.createdAt.getTime();
    const values = {
      email: input.email,
      username: input.username,
      displayName: input.displayName,
      emailNormalized: input.emailNormalized,
      usernameNormalized: input.usernameNormalized,
      passwordHash: input.passwordHash,
      passwordVerifier: input.verifier?.passwordVerifier ?? null,
      passwordAlgorithm: input.verifier?.passwordAlgorithm ?? null,
      passwordSalt: input.verifier?.passwordSalt ?? null,
      passwordParams: input.verifier?.passwordParams ?? null,
      // The V1 physical columns are NOT NULL; V2 manages displayName, so
      // the legacy pair stays blank (never synthesized).
      firstName: '',
      lastName: '',
      role: input.role,
      communityId: input.communityId,
      isActive: true,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    if (dialectOf(this.database) === 'postgresql') {
      return (this.database as Executor).transaction(async (tx: Executor) => {
        // Lock order community -> identity (advisory) -> users -> sessions,
        // the same as PATCH: the users insert's FK check takes FOR KEY SHARE
        // on the community row, so taking the advisory lock first would
        // deadlock against a PATCH holding the community FOR UPDATE.
        await tx
          .select({ id: this.tables.communities.id })
          .from(this.tables.communities)
          .where(eq(this.tables.communities.id, input.communityId))
          .for('share');
        await this.takeIdentityAdvisoryLocks(tx, input);
        const collided = await this.hasIdentityCollision(
          {
            communityId: input.communityId,
            emailNormalized: input.emailNormalized,
            usernameNormalized: input.usernameNormalized,
          },
          tx
        );
        if (collided) return { ok: false };
        const [row] = await tx
          .insert(users)
          .values(values)
          .returning({ id: users.id });
        return { ok: true, id: Number(row.id) };
      });
    }

    const collision = this.identityCollisionWhereSql({
      communityId: input.communityId,
      emailNormalized: input.emailNormalized,
      usernameNormalized: input.usernameNormalized,
    });
    const insertable = sql`insert into users (
      email, username, display_name, email_normalized, username_normalized,
      password_hash, password_verifier, password_algorithm, password_salt,
      password_params, first_name, last_name, role, community_id, is_active,
      created_at, updated_at
    ) select
      ${input.email}, ${input.username}, ${input.displayName},
      ${input.emailNormalized}, ${input.usernameNormalized},
      ${input.passwordHash}, ${input.verifier?.passwordVerifier ?? null},
      ${input.verifier?.passwordAlgorithm ?? null},
      ${input.verifier?.passwordSalt ?? null},
      ${input.verifier?.passwordParams ?? null},
      ${''}, ${''},
      ${input.role}, ${input.communityId}, 1,
      ${createdMs}, ${createdMs}
    where ${collision ?? sql`1 = 1`}
    returning id`;
    const inserted = (await this.database.all(insertable)) as Array<{
      id: number | string;
    }>;
    if (inserted.length === 0) return { ok: false };
    return { ok: true, id: Number(inserted[0]!.id) };
  }

  /**
   * Result of the coupled update write. `not_found` — the target row is gone
   * or never in this community (caller answers 404). `authority_lost` — the
   * actor stopped being an active admin of the community mid-request (403).
   * `last_admin` — the change would leave the community without an active
   * administrator (409 `last_admin`). `updated` — the write landed.
   */
  async updateCommunityUser(input: {
    id: number;
    communityId: number;
    actorId: number;
    displayName?: string | null;
    username?: string | null;
    usernameNormalized?: string | null;
    email?: string;
    emailNormalized?: string | null;
    /**
     * The identity fields whose normalized values actually changed — only
     * those need the collision guard (and it must hold at write time, not
     * just at pre-check time).
     */
    collision?: {
      emailNormalized?: string;
      usernameNormalized?: string | null;
    };
    role?: 'viewer' | 'member' | 'editor' | 'admin';
    isActive?: boolean;
    updatedAt: Date;
  }): Promise<
    | 'updated'
    | 'not_found'
    | 'authority_lost'
    | 'last_admin'
    | 'identity_conflict'
  > {
    const { users, communities } = this.tables;
    const patch: Record<string, unknown> = { updatedAt: input.updatedAt };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.username !== undefined) {
      patch.username = input.username;
      patch.usernameNormalized = input.usernameNormalized ?? null;
    }
    if (input.email !== undefined) {
      patch.email = input.email;
      patch.emailNormalized = input.emailNormalized;
    }
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) {
      patch.isActive = userStatusToPhysical(
        input.isActive ? 'active' : 'disabled'
      ).isActive;
    }

    // Whether the change keeps the *target* an active administrator. When it
    // does, no admin-count guard is needed; when it does not, at least one
    // other active admin must remain (excluding the target itself).
    const keepActiveAdmin =
      (input.role === undefined || input.role === 'admin') &&
      (input.isActive === undefined || input.isActive === true);

    if (dialectOf(this.database) === 'postgresql') {
      // One transaction, lock order community -> users (sessions are not
      // touched here). FOR UPDATE on the community row serialises concurrent
      // role/status changes of the same community.
      return (this.database as Executor).transaction(async (tx: Executor) => {
        await tx
          .select({ id: communities.id })
          .from(communities)
          .where(eq(communities.id, input.communityId))
          .for('update');
        const [actorRow] = await tx
          .select({ role: users.role, isActive: users.isActive })
          .from(users)
          .where(
            and(
              eq(users.id, input.actorId),
              eq(users.communityId, input.communityId),
              eq(users.role, 'admin'),
              eq(users.isActive, true)
            )
          )
          .limit(1);
        if (!actorRow) return 'authority_lost';
        if (input.collision) {
          await this.takeIdentityAdvisoryLocks(tx, input.collision);
          const collided = await this.hasIdentityCollision(
            {
              ...input.collision,
              communityId: input.communityId,
              excludeUserId: input.id,
            },
            tx
          );
          if (collided) return 'identity_conflict';
        }
        if (!keepActiveAdmin) {
          const [countRow] = await tx
            .select({ total: count() })
            .from(users)
            .where(
              and(
                eq(users.communityId, input.communityId),
                eq(users.role, 'admin'),
                eq(users.isActive, true),
                ne(users.id, input.id)
              )
            );
          if (Number(countRow?.total ?? 0) < 1) return 'last_admin';
        }
        const updated = await tx
          .update(users)
          .set(patch)
          .where(
            and(
              eq(users.id, input.id),
              eq(users.communityId, input.communityId)
            )
          )
          .returning({ id: users.id });
        return updated.length > 0 ? 'updated' : 'not_found';
      });
    }

    // SQLite/D1: a single guarded statement — the admin-count and the
    // actor-is-a-live-admin checks are part of the WRITE, not a pre-check
    // racing the write. 0 rows → re-read to classify the refusal.
    const adminGuard = keepActiveAdmin
      ? undefined
      : sql`(select count(*) from users o where o.community_id = ${input.communityId} and o.role = 'admin' and o.is_active = 1 and o.id <> ${input.id}) >= 1`;
    const collisionGuard = input.collision
      ? this.identityCollisionWhereSql({
          ...input.collision,
          communityId: input.communityId,
          excludeUserId: input.id,
        })
      : undefined;
    const updated = await this.database
      .update(users)
      .set(patch)
      .where(
        and(
          eq(users.id, input.id),
          eq(users.communityId, input.communityId),
          sql`exists (select 1 from users a where a.id = ${input.actorId} and a.community_id = ${input.communityId} and a.role = 'admin' and a.is_active = 1)`,
          adminGuard,
          collisionGuard
        )
      )
      .returning({ id: users.id });
    const rows = updated as Array<{ id: number }>;
    if (rows.length > 0) return 'updated';

    // Classification re-read (the guard failed; explain it precisely).
    const target = await this.findCommunityUser(input.communityId, input.id);
    if (!target) return 'not_found';
    const [actorRow] = await this.database
      .select({ role: users.role, isActive: users.isActive })
      .from(users)
      .where(
        and(
          eq(users.id, input.actorId),
          eq(users.communityId, input.communityId),
          eq(users.role, 'admin'),
          eq(users.isActive, true)
        )
      )
      .limit(1);
    if (!actorRow) return 'authority_lost';
    if (input.collision) {
      const collided = await this.hasIdentityCollision({
        ...input.collision,
        communityId: input.communityId,
        excludeUserId: input.id,
      });
      if (collided) return 'identity_conflict';
    }
    if (!keepActiveAdmin) {
      const [countRow] = await this.database
        .select({ total: count() })
        .from(users)
        .where(
          and(
            eq(users.communityId, input.communityId),
            eq(users.role, 'admin'),
            eq(users.isActive, true),
            ne(users.id, input.id)
          )
        );
      if (Number(countRow?.total ?? 0) < 1) return 'last_admin';
    }
    // Every predicate passes on re-read: the row vanished between the guarded
    // write and the re-read.
    return 'not_found';
  }

  /**
   * Admin-assisted verifier reset, coupled to revoking the target's sessions
   * (SPEC-V2 §7: "an admin reset applies its verifier atomically with
   * revoking the target account's existing sessions"). Establishes no
   * session for anyone. One atomic unit: D1 batch, SQLite transaction, or a
   * PostgreSQL transaction taking the community row FOR SHARE first (lock
   * order community → users → sessions). Returns false when the authority
   * anchor lost the race (caller answers 409).
   */
  async resetVerifierAndRevokeSessions(
    input: {
      target: {
        id: number;
        communityId: number;
        passwordHash: string;
        passwordVerifier: string | null;
      };
      verifier: {
        passwordVerifier: string;
        passwordAlgorithm: string;
        passwordSalt: string;
        passwordParams: string;
      };
    },
    audit?: ContentFreeAuditEntryInput
  ): Promise<boolean> {
    const db = this.database;
    const { users, communities } = this.tables;
    const { auditEntries } = tablesFor(db);
    const sessions = (
      dialectOf(db) === 'postgresql' ? sessionsPg : sessionsSqlite
    ) as typeof sessionsSqlite;
    const { id, communityId, passwordHash, passwordVerifier } = input.target;
    // Validate once, up front, so the content-free rule cannot be bypassed by
    // the conditional insert path either.
    const validatedAudit = audit ? validateContentFreeAuditEntry(audit) : null;

    // Community → users → sessions lock order (PostgreSQL FOR SHARE; SQLite
    // serializes the transaction before the first write). A null-community
    // target cannot reach here — the caller refuses those.
    const acquireCommunityFirst = (database: Executor): unknown => {
      const lock = database
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.id, communityId));
      if (dialectOf(db) === 'postgresql') return lock.for('share');
      return lock.all();
    };

    const verifierUpdate = (database: Executor) =>
      database
        .update(users)
        .set({
          passwordVerifier: input.verifier.passwordVerifier,
          passwordAlgorithm: input.verifier.passwordAlgorithm,
          passwordSalt: input.verifier.passwordSalt,
          passwordParams: input.verifier.passwordParams,
        })
        .where(
          and(
            eq(users.id, id),
            eq(users.passwordHash, passwordHash),
            passwordVerifier === null
              ? isNull(users.passwordVerifier)
              : eq(users.passwordVerifier, passwordVerifier),
            eq(users.communityId, communityId)
          )
        )
        .returning({ id: users.id });

    // The verifier change fires users_revoke_sessions; this covers the
    // identical-material case where the trigger does not, mirroring the
    // coupled verifier write (§7).
    const revokeAllSessions = (database: Executor) =>
      database.delete(sessions).where(
        and(
          eq(sessions.userId, id),
          sql`exists (
            select 1 from ${users}
            where ${users.id} = ${id}
              and ${users.passwordVerifier} = ${input.verifier.passwordVerifier}
          )`
        )
      );

    // D1's whole-transaction unit is a batch; there is no interactive
    // transaction. The audit row is gated on the PRE-update anchor (the same
    // predicate as verifierUpdate) and runs before the update, so it lands
    // iff this request's write lands, never because another request already
    // stored identical material.
    const conditionalAuditInsert = (database: Executor) => {
      const record = validatedAudit as ValidatedAuditEntryRecord;
      return database.insert(auditEntries).select(
        sql`select
          ${null}, ${record.communityId}, ${record.actorId}, ${record.action},
          ${record.resourceType}, ${JSON.stringify(record.resourceIds)},
          ${record.outcome}, ${record.ipAddress}, ${record.userAgent},
          ${Date.now()}
        where exists (
          select 1 from users
          where id = ${id}
            and community_id = ${communityId}
            and password_hash = ${passwordHash}
            and ${
              passwordVerifier === null
                ? sql`password_verifier is null`
                : sql`password_verifier = ${passwordVerifier}`
            }
        )`
      );
    };

    if (typeof db.batch === 'function') {
      const statements: unknown[] = [];
      if (validatedAudit) statements.push(conditionalAuditInsert(db));
      statements.push(verifierUpdate(db), revokeAllSessions(db));
      const results = await db.batch(statements);
      const updated = results[validatedAudit ? 1 : 0];
      return updated.length > 0;
    }
    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: Executor) => {
        await acquireCommunityFirst(tx);
        const updated = await verifierUpdate(tx);
        if (updated.length > 0) await revokeAllSessions(tx);
        if (updated.length > 0 && validatedAudit) {
          await buildAuditEntryInsert(tx, validatedAudit);
        }
        return updated.length > 0;
      });
    }
    return db.transaction((tx: Executor) => {
      acquireCommunityFirst(tx);
      const updated = verifierUpdate(tx).all();
      if (updated.length > 0) revokeAllSessions(tx).run();
      if (updated.length > 0 && validatedAudit) {
        buildAuditEntryInsert(tx, validatedAudit).run();
      }
      return updated.length > 0;
    });
  }

  /**
   * Self-service identifier change (PATCH /v2/auth/me with username/email),
   * written under the SAME identity rules as the admin edit: the collision
   * guard holds at write time (PostgreSQL: community FOR SHARE -> sorted
   * identity advisory locks -> users, never sessions; SQLite/D1: one guarded
   * UPDATE ... WHERE NOT EXISTS). The write is anchored on the credential
   * state the step-up verified (`password_hash` + `password_verifier`), so a
   * concurrent password change or reset makes it `stale` instead of landing
   * under a credential that was just replaced. The content-free audit row is
   * in the same atomic unit (D1 batch, SQLite transaction, PostgreSQL
   * transaction) and lands iff the update does.
   *
   * Neither identifier column is in the `users_revoke_sessions` trigger's
   * column list, so no session is revoked by this write.
   */
  async updateOwnIdentity(
    input: {
      id: number;
      communityId: number | null;
      anchor: { passwordHash: string; passwordVerifier: string | null };
      displayName?: string | null;
      username?: string;
      usernameNormalized?: string | null;
      email?: string;
      emailNormalized?: string | null;
      /** Every supplied identifier, re-checked at write time. */
      collision: {
        emailNormalized?: string;
        usernameNormalized?: string | null;
      };
      updatedAt: Date;
    },
    audit: ContentFreeAuditEntryInput
  ): Promise<'updated' | 'identity_conflict' | 'stale'> {
    const db = this.database;
    const { users, communities } = this.tables;
    const { auditEntries } = tablesFor(db);
    const validatedAudit = validateContentFreeAuditEntry(audit);
    const patch: Record<string, unknown> = { updatedAt: input.updatedAt };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.username !== undefined) {
      patch.username = input.username;
      patch.usernameNormalized = input.usernameNormalized ?? null;
    }
    if (input.email !== undefined) {
      patch.email = input.email;
      patch.emailNormalized = input.emailNormalized;
    }
    const { passwordHash, passwordVerifier } = input.anchor;
    // Anchor = verified credential AND current access, decided exactly as the
    // session / password-change gate decides it (active user, V2 role, active
    // community, or the own-admin / steward sovereignty surface of a disabled
    // one; SPEC-V2 §7). An account disabled, moved or whose community is
    // disabled mid-request is refused.
    const anchorWhere = () =>
      and(
        eq(users.id, input.id),
        userAuthorityConditions(db),
        input.communityId === null
          ? isNull(users.communityId)
          : eq(users.communityId, input.communityId),
        eq(users.passwordHash, passwordHash),
        passwordVerifier === null
          ? isNull(users.passwordVerifier)
          : eq(users.passwordVerifier, passwordVerifier)
      );
    const collisionSql = this.identityCollisionWhereSql({
      ...input.collision,
      communityId: input.communityId,
      excludeUserId: input.id,
    });
    const guardedUpdate = (database: Executor) =>
      database
        .update(users)
        .set(patch)
        .where(and(anchorWhere(), collisionSql))
        .returning({ id: users.id });
    const anchorStillHolds = async (
      database: Executor = db
    ): Promise<boolean> => {
      const rows = (await database
        .select({ id: users.id })
        .from(users)
        .where(anchorWhere())
        .limit(1)) as unknown[];
      return rows.length > 0;
    };

    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: Executor) => {
        if (input.communityId !== null)
          await tx
            .select({ id: communities.id })
            .from(communities)
            .where(eq(communities.id, input.communityId))
            .for('share');
        await this.takeIdentityAdvisoryLocks(tx, input.collision);
        // A stale credential must never reach the 409 branch.
        if (!(await anchorStillHolds(tx))) return 'stale' as const;
        const collided = await this.hasIdentityCollision(
          {
            ...input.collision,
            communityId: input.communityId,
            excludeUserId: input.id,
          },
          tx
        );
        if (collided) return 'identity_conflict' as const;
        const updated = await guardedUpdate(tx);
        if (updated.length === 0) return 'stale' as const;
        await buildAuditEntryInsert(tx, validatedAudit);
        return 'updated' as const;
      });
    }

    if (typeof db.batch === 'function') {
      // D1: the audit row is gated on the same pre-update predicates as the
      // UPDATE and runs first, so it lands iff this request's write lands.
      const auditInsert = db.insert(auditEntries).select(
        sql`select
          ${null}, ${validatedAudit.communityId}, ${validatedAudit.actorId},
          ${validatedAudit.action}, ${validatedAudit.resourceType},
          ${JSON.stringify(validatedAudit.resourceIds)},
          ${validatedAudit.outcome}, ${validatedAudit.ipAddress},
          ${validatedAudit.userAgent}, ${Date.now()}
        where exists (
          select 1 from users
          where ${anchorWhere()}
        ) and ${collisionSql ?? sql`1 = 1`}`
      );
      const results = await db.batch([auditInsert, guardedUpdate(db)]);
      if ((results[1] as unknown[]).length > 0) return 'updated';
      return (await anchorStillHolds()) ? 'identity_conflict' : 'stale';
    }

    return db.transaction((tx: Executor) => {
      const updated = guardedUpdate(tx).all() as unknown[];
      if (updated.length > 0) {
        buildAuditEntryInsert(tx, validatedAudit).run();
        return 'updated' as const;
      }
      const anchored = tx
        .select({ id: users.id })
        .from(users)
        .where(anchorWhere())
        .limit(1)
        .all() as unknown[];
      return anchored.length > 0
        ? ('identity_conflict' as const)
        : ('stale' as const);
    });
  }

  private sessionWindow(nowMs: number) {
    const sessions = this.tables.sessions;
    return and(
      or(isNull(sessions.idleExpiresAt), gt(sessions.idleExpiresAt, nowMs)),
      or(
        isNull(sessions.absoluteExpiresAt),
        gt(sessions.absoluteExpiresAt, nowMs)
      ),
      // Rows whose single (legacy) expiry has passed never list or revoke,
      // even if their idle/absolute split still looks live.
      gt(sessions.expiresAt, nowMs),
      isNull(sessions.revokedAt)
    );
  }

  /** Live `device` sessions of a target account (metadata only). */
  async listDeviceSessions(
    userId: number,
    now: Date
  ): Promise<DeviceSessionRow[]> {
    const sessions = this.tables.sessions;
    const rows = await this.database
      .select({
        id: sessions.id,
        kind: sessions.kind,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        idleExpiresAt: sessions.idleExpiresAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.kind, 'device'),
          this.sessionWindow(now.getTime())
        )
      )
      .orderBy(asc(sessions.createdAt), asc(sessions.id));
    return rows.map((row: DeviceSessionRow) => ({
      id: String(row.id),
      kind: 'device',
      createdAt: row.createdAt === null ? null : Number(row.createdAt),
      lastSeenAt: row.lastSeenAt === null ? null : Number(row.lastSeenAt),
      idleExpiresAt:
        row.idleExpiresAt === null ? null : Number(row.idleExpiresAt),
      absoluteExpiresAt:
        row.absoluteExpiresAt === null ? null : Number(row.absoluteExpiresAt),
    }));
  }

  /** Tombstone a live device session (revoked_at/revoked_by); false when absent. */
  async revokeDeviceSession(input: {
    userId: number;
    sessionId: string;
    revokedBy: number;
    now: Date;
  }): Promise<boolean> {
    const sessions = this.tables.sessions;
    const rows = await this.database
      .update(sessions)
      .set({
        revokedAt: input.now.getTime(),
        revokedBy: input.revokedBy,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.userId, input.userId),
          eq(sessions.kind, 'device'),
          this.sessionWindow(input.now.getTime())
        )
      )
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  /**
   * Insert a LoginCode row (only the SHA-256 digest is stored) with its
   * content-free audit row in the same atomic unit — a D1 batch, or one
   * transaction on SQLite/PostgreSQL. A failed audit rolls back the
   * issuance: no code row is left behind.
   */
  async insertLoginCodeWithAudit(
    input: {
      communityId: number | null;
      userId: number;
      purpose: 'admin_issued' | 'recovery';
      codeHash: string;
      createdBy: number | null;
      createdAt: number;
      expiresAt: number | null;
    },
    audit: ContentFreeAuditEntryInput
  ): Promise<{ id: number }> {
    const db = this.database;
    const { loginCodes } = this.tables;
    // Fail fast on an invalid audit shape before anything else runs.
    const validatedAudit = validateContentFreeAuditEntry(audit);
    const codeInsert = (database: Executor) =>
      database
        .insert(loginCodes)
        .values({
          communityId: input.communityId,
          userId: input.userId,
          purpose: input.purpose,
          codeHash: input.codeHash,
          createdBy: input.createdBy,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          usedAt: null,
          supersededAt: null,
        })
        .returning({ id: loginCodes.id });

    if (typeof db.batch === 'function') {
      const [codeRows] = await db.batch([
        codeInsert(db),
        buildAuditEntryInsert(db, validatedAudit),
      ]);
      const rows = codeRows as Array<{ id: number | string }>;
      return { id: Number(rows[0]!.id) };
    }
    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: Executor) => {
        const [codeRow] = await codeInsert(tx);
        await buildAuditEntryInsert(tx, validatedAudit);
        return { id: Number(codeRow.id) };
      });
    }
    return db.transaction((tx: Executor) => {
      const [codeRow] = codeInsert(tx).all();
      buildAuditEntryInsert(tx, validatedAudit).run();
      return { id: Number(codeRow.id) };
    });
  }
}
