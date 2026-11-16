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
import { and, asc, count, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { userStatusToPhysical } from '../policy/canonical-state.js';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import { sessionsPg, sessionsSqlite } from '../db/schema/sessions.js';

export interface ManagedUserRow {
  id: number;
  email: string;
  username: string | null;
  displayName: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date;
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
    email: string;
    username: string | null;
    displayName: string | null;
    role: string;
    isActive: number | boolean;
    createdAt: Date | number;
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
   * uniform 409.
   */
  async hasIdentityCollision(input: {
    communityId: number;
    emailNormalized?: string;
    usernameNormalized?: string | null;
    excludeUserId?: number;
  }): Promise<boolean> {
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
      // Community-scoped email uniqueness.
      clauses.push(
        and(
          eq(users.communityId, input.communityId),
          eq(users.emailNormalized, emailNormalized)
        )
      );
      // An email shared between a null-community account and any community
      // account (§6.2: unresolvable at login; rejected on new identities).
      clauses.push(
        and(
          isNull(users.communityId),
          eq(users.emailNormalized, emailNormalized)
        )
      );
      // An email matching another account's username (any community).
      clauses.push(eq(users.usernameNormalized, emailNormalized));
    }
    if (clauses.length === 0) return false;
    const rows = await this.database
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
  }): Promise<{ id: number }> {
    const { users } = this.tables;
    const [row] = await this.database
      .insert(users)
      .values({
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
      })
      .returning({ id: users.id });
    return { id: Number(row.id) };
  }

  async updateCommunityUser(input: {
    id: number;
    communityId: number;
    displayName?: string | null;
    username?: string | null;
    usernameNormalized?: string | null;
    email?: string;
    emailNormalized?: string;
    role?: 'viewer' | 'member' | 'editor' | 'admin';
    isActive?: boolean;
    updatedAt: Date;
  }): Promise<boolean> {
    const { users } = this.tables;
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
    const rows = await this.database
      .update(users)
      .set(patch)
      .where(
        and(eq(users.id, input.id), eq(users.communityId, input.communityId))
      )
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /** Active `admin` accounts of the community (role-change guard input). */
  async countActiveAdmins(communityId: number): Promise<number> {
    const { users } = this.tables;
    const rows = await this.database
      .select({ total: count() })
      .from(users)
      .where(
        and(
          eq(users.communityId, communityId),
          eq(users.role, 'admin'),
          eq(users.isActive, true)
        )
      );
    return Number(rows[0]?.total ?? 0);
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
  async resetVerifierAndRevokeSessions(input: {
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
  }): Promise<boolean> {
    const db = this.database;
    const { users, communities } = this.tables;
    const sessions = (
      dialectOf(db) === 'postgresql' ? sessionsPg : sessionsSqlite
    ) as typeof sessionsSqlite;
    const { id, communityId, passwordHash, passwordVerifier } = input.target;

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

    if (typeof db.batch === 'function') {
      const [updated] = await db.batch([
        verifierUpdate(db),
        revokeAllSessions(db),
      ]);
      return updated.length > 0;
    }
    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: Executor) => {
        await acquireCommunityFirst(tx);
        const updated = await verifierUpdate(tx);
        if (updated.length > 0) await revokeAllSessions(tx);
        return updated.length > 0;
      });
    }
    return db.transaction((tx: Executor) => {
      acquireCommunityFirst(tx);
      const updated = verifierUpdate(tx).all();
      if (updated.length > 0) revokeAllSessions(tx).run();
      return updated.length > 0;
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

  /** Insert a LoginCode row (only the SHA-256 digest is stored). */
  async insertLoginCode(input: {
    communityId: number | null;
    userId: number;
    purpose: 'admin_issued' | 'recovery';
    codeHash: string;
    createdBy: number | null;
    createdAt: number;
    expiresAt: number | null;
  }): Promise<{ id: number }> {
    const { loginCodes } = this.tables;
    const [row] = await this.database
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
    return { id: Number(row.id) };
  }
}
