import { and, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  communityStatusToPhysical,
  userStatusToPhysical,
} from '../policy/canonical-state.js';
import {
  V2_COMMUNITY_ROLES,
  parseV2Role,
  type V2CommunityRole,
} from '../shared/authorization/sovereignty-policy.js';
import {
  SESSION_LAST_SEEN_WRITE_INTERVAL_MS,
  sessionIdleWindowMs,
  sessionLifetimesFor,
  type SessionKind,
} from '../shared/auth-policy.js';
import { sessionRenewalInterval } from '../shared/session-policy.js';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import {
  sessionsPg,
  sessionsSqlite,
  communityMediaPg,
  communityMediaSqlite,
} from '../db/schema/sessions.js';

export interface FoundationUser {
  id: number;
  email: string;
  username: string | null;
  displayName: string | null;
  passwordHash: string;
  role: V2CommunityRole;
  communityId: number | null;
}

interface RawFoundationUser {
  id: number;
  email: string;
  username: string | null;
  displayName: string | null;
  passwordHash: string;
  role: string;
  communityId: number | null;
}

/**
 * Internal rollback signal for the coupled verifier/session write: the session
 * gate lost the race, so the transaction rolls back and the caller answers
 * `false` without an error. It never escapes the repository.
 */
class SessionGateLost extends Error {
  constructor() {
    super('session authority gate lost');
    this.name = 'SessionGateLost';
  }
}

// Drizzle's per-dialect executors (better-sqlite3, postgres.js, D1) share one
// runtime shape but expose incompatible TypeScript overloads, so the coupled
// write builders are typed through one deliberately loose pair of aliases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Statement = any;

export class HonoFoundationRepository {
  private readonly tables;
  private readonly sessions;
  private readonly communityMedia;
  // Both dialects expose the same surface with incompatible TS overloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly database: any;

  constructor(database: Database | DrizzleD1Database) {
    this.database = database;
    this.tables = tablesFor(database);
    this.sessions = (
      dialectOf(database) === 'postgresql' ? sessionsPg : sessionsSqlite
    ) as typeof sessionsSqlite;
    this.communityMedia = (
      dialectOf(database) === 'postgresql'
        ? communityMediaPg
        : communityMediaSqlite
    ) as typeof communityMediaSqlite;
  }

  /** Shared connection for the transitional Explore read adapter (#198). */
  get connection(): Database | DrizzleD1Database {
    return this.database;
  }

  private projection() {
    const { users } = this.tables;
    return {
      id: users.id,
      email: users.email,
      username: users.username,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      role: users.role,
      communityId: users.communityId,
    };
  }

  /**
   * Canonical V2 authentication and session-validity gate (SPEC-V2 §6.2, §7):
   * - Active users with a canonical V2 role (legacy `elder` rejected);
   * - A `super_admin` with `community_id IS NULL`;
   * - Active users of an active community;
   * - An own-community `admin` or designated steward of a disabled community
   *   (sovereignty surface only).
   */
  private allowedAuthConditions() {
    const { users, communities, communityStewards } = this.tables;
    return and(
      eq(users.isActive, userStatusToPhysical('active').isActive),
      inArray(users.role, [...V2_COMMUNITY_ROLES]),
      or(
        and(isNull(users.communityId), eq(users.role, 'super_admin')),
        eq(communities.isActive, communityStatusToPhysical('active')),
        and(
          eq(communities.isActive, communityStatusToPhysical('disabled')),
          or(
            eq(users.role, 'admin'),
            sql`exists (select 1 from ${communityStewards} cs where cs.community_id = ${users.communityId} and cs.user_id = ${users.id})`
          )
        )
      )
    );
  }

  /**
   * The same authority gate as {@link allowedAuthConditions}, expressed without
   * a `communities` join so it can guard a bare `UPDATE users` (the coupled
   * verifier write has no join to hang `communities.is_active` on).
   */
  private verifierAuthorityConditions() {
    const { users, communities, communityStewards } = this.tables;
    // Subqueries rather than a raw `sql` fragment: the community flag is a
    // boolean column, and a raw interpolation would bind a bare boolean that
    // SQLite rejects. A query-builder subquery maps it like any other read.
    const activeCommunities = this.database
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.isActive, communityStatusToPhysical('active')));
    const disabledCommunities = this.database
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.isActive, communityStatusToPhysical('disabled')));
    return and(
      eq(users.isActive, userStatusToPhysical('active').isActive),
      inArray(users.role, [...V2_COMMUNITY_ROLES]),
      or(
        and(isNull(users.communityId), eq(users.role, 'super_admin')),
        inArray(users.communityId, activeCommunities),
        and(
          inArray(users.communityId, disabledCommunities),
          or(
            eq(users.role, 'admin'),
            sql`exists (select 1 from ${communityStewards} cs where cs.community_id = ${users.communityId} and cs.user_id = ${users.id})`
          )
        )
      )
    );
  }

  private toFoundationUser(row: RawFoundationUser): FoundationUser | null {
    const role = parseV2Role(row.role);
    if (!role) return null;
    if (row.communityId === null && role !== 'super_admin') return null;
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      passwordHash: row.passwordHash,
      role,
      communityId: row.communityId,
    };
  }

  async candidates(
    email: string,
    communityId?: number
  ): Promise<FoundationUser[]> {
    const { users, communities } = this.tables;
    // Resolve up to 2 matching accounts on the identifier (+ community locator)
    // FIRST, before checking allowedAuthConditions(), so an active account
    // sharing an email with a disabled/inactive/elder account stays ambiguous
    // without a community locator (SPEC-V2 §6.2).
    const rows: (RawFoundationUser & { allowed: number })[] =
      await this.database
        .select({
          ...this.projection(),
          allowed: sql<number>`case when ${this.allowedAuthConditions()} then 1 else 0 end`,
        })
        .from(users)
        .leftJoin(communities, eq(users.communityId, communities.id))
        .where(
          and(
            eq(users.email, email),
            communityId === undefined
              ? undefined
              : eq(users.communityId, communityId)
          )
        )
        .limit(2);
    if (rows.length !== 1 || Number(rows[0].allowed) !== 1) return [];
    const user = this.toFoundationUser(rows[0]);
    return user ? [user] : [];
  }

  /** The parsed session write, as builders bound to an executor. */
  private sessionWritePlan(input: {
    tokenHash: string;
    user: FoundationUser;
    kind: SessionKind;
    createdAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    previousHash?: string;
    /** Explicit device-session revocation metadata (admin revoke, §6.8). */
    revokedAt?: Date;
    revokedBy?: number;
    /**
     * Time-bounded one-shot right to generate recovery codes without password
     * presentation, granted only when establishing a session from an
     * `admin_issued` LoginCode (SPEC-V2 §6.8, §6.10).
     */
    adminCodeStepUpExpiresAt?: Date | null;
    /**
     * The verifier the session row must see committed before it may consume
     * the login: the verifier the plain path verified against, or the new one
     * just written by the coupled path (§7 step 4). `undefined` disables the
     * extra condition (legacy tests only); `null` anchors to a NULL verifier.
     */
    expectedVerifier?: string | null;
  }): {
    tokenHash: string;
    userId: number;
    previousHash: string | undefined;
    verifiedInsert: (database: Executor) => Statement;
    revokePresented: (hash: string) => Statement;
  } | null {
    const { tokenHash, user } = input;
    const now = input.createdAt;
    const role = parseV2Role(user.role);
    if (!role) return null;
    if (user.communityId === null && role !== 'super_admin') return null;
    const sessions = this.sessions;
    const { users, communities } = this.tables;
    const kind = input.kind;
    const expiresAt = input.idleExpiresAt;
    const createdAt = input.createdAt.getTime();
    const lastSeenAt = input.createdAt.getTime();
    const idleExpiresAt = input.idleExpiresAt.getTime();
    const absoluteExpiresAt = input.absoluteExpiresAt.getTime();
    const revokedAt = input.revokedAt ? input.revokedAt.getTime() : null;
    const revokedBy = input.revokedAt ? (input.revokedBy ?? user.id) : null;
    const adminCodeStepUpExpiresAt = input.adminCodeStepUpExpiresAt
      ? input.adminCodeStepUpExpiresAt.getTime()
      : null;
    // Anchor the session to the verifier the request verified against — or
    // the one the coupled write just committed — so a lost verifier race
    // yields no session and, in the coupled path, rolls the account back to
    // its pre-write state (§7 step 4). password_hash never changes in V2, so
    // a password_hash-only anchor would consume logins after the verifier
    // moved; only the verifier tells the truth about whose credentials were
    // accepted.
    const expectedVerifier = input.expectedVerifier;
    const verifierCondition =
      expectedVerifier === undefined
        ? sql`1 = 1`
        : expectedVerifier === null
          ? isNull(users.passwordVerifier)
          : eq(users.passwordVerifier, expectedVerifier);
    // A presented session belonging to a different user is never rotated
    // onto the new login: it is revoked, and the authenticating user always
    // gets a row of their own (#188 — shared-browser login). The revocation
    // is coupled to the verified session write below and runs only when that
    // write establishes the login, so a login that loses the authority race
    // never destroys the other user's session.
    const sessionValues = {
      tokenHash: sql`${tokenHash}`,
      userId: sql`${user.id}`,
      expiresAt: sql`${expiresAt.getTime()}`,
      kind: sql`${kind}`,
      createdAt: sql`${createdAt}`,
      lastSeenAt: sql`${lastSeenAt}`,
      idleExpiresAt: sql`${idleExpiresAt}`,
      absoluteExpiresAt: sql`${absoluteExpiresAt}`,
      revokedAt: revokedAt === null ? sql`null` : sql`${revokedAt}`,
      revokedBy: revokedBy === null ? sql`null` : sql`${revokedBy}`,
      adminCodeStepUpExpiresAt:
        adminCodeStepUpExpiresAt === null
          ? sql`null`
          : sql`${adminCodeStepUpExpiresAt}`,
    };
    const verifiedInsert = (database: Executor) => {
      const base = database
        .select({
          // Only an unexpired same-user row is rotated in place; an expired
          // presented row is never resurrected — the login allocates a fresh
          // row instead.
          id: sql`coalesce((select ${sessions.id} from ${sessions} where ${sessions.tokenHash} = ${input.previousHash ?? ''} and ${sessions.userId} = ${user.id} and ${sessions.expiresAt} > ${now.getTime()}), ${tokenHash})`,
          ...sessionValues,
        })
        .from(users);
      const joined =
        user.communityId === null
          ? base.leftJoin(communities, eq(users.communityId, communities.id))
          : base.innerJoin(communities, eq(users.communityId, communities.id));
      let verified = joined.where(
        and(
          eq(users.id, user.id),
          eq(users.passwordHash, user.passwordHash),
          eq(users.role, role),
          user.communityId === null
            ? isNull(users.communityId)
            : eq(users.communityId, user.communityId),
          this.allowedAuthConditions(),
          verifierCondition
        )
      );
      // PostgreSQL locks current authority through the write; a concurrent
      // reset or community disable either changes this selection or waits
      // and then revokes the new session. Community-scoped logins use an
      // INNER JOIN with bare `FOR SHARE` to lock both `users` and
      // `communities`; only the null-community `super_admin` path uses
      // `LEFT JOIN` and locks `users` alone. SQLite/D1 serialize this
      // single write statement without interactive locks.
      if (dialectOf(this.database) === 'postgresql') {
        verified =
          user.communityId === null
            ? verified.for('share', { of: users })
            : verified.for('share');
      }
      // Stable row IDs ensure concurrent rotations always write a fresh digest.
      return database
        .insert(sessions)
        .select(verified)
        .onConflictDoUpdate({
          target: sessions.id,
          set: sessionValues,
        })
        .returning({ id: sessions.id });
    };
    const revokePresented = (hash: string) =>
      and(eq(sessions.tokenHash, hash), ne(sessions.userId, user.id));
    return {
      tokenHash,
      userId: user.id,
      previousHash: input.previousHash,
      verifiedInsert,
      revokePresented,
    };
  }

  /**
   * Establish a session row for a verified login (SPEC-V2 §6.8, §7
   * "Sessions").
   *
   * The caller supplies the authoritative row contents: `tokenHash` plus the
   * `kind`, `createdAt`, `idleExpiresAt` and `absoluteExpiresAt` the policy
   * computed, and — for a same-user rotation — the `previousHash` whose row is
   * rewritten in place. The authority gate is re-checked inside the write on
   * both dialects: the INSERT…SELECT only produces a row while the account is
   * still authenticable, and the PostgreSQL `FOR SHARE` lock makes a
   * concurrent reset/disable either change that selection or wait and revoke
   * the new session.
   */
  async createSession(input: {
    tokenHash: string;
    user: FoundationUser;
    kind: SessionKind;
    createdAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    previousHash?: string;
    /** Explicit device-session revocation metadata (admin revoke, §6.8). */
    revokedAt?: Date;
    revokedBy?: number;
    adminCodeStepUpExpiresAt?: Date | null;
    /** Verifier anchor for the session write (§7 step 4). */
    expectedVerifier?: string | null;
  }): Promise<boolean> {
    const plan = this.sessionWritePlan(input);
    if (!plan) return false;
    const db = this.database;
    const sessions = this.sessions;
    if (plan.previousHash === undefined) {
      const rows = await plan.verifiedInsert(db);
      return rows.length > 0;
    }
    const revokeConditional = (database: Executor) =>
      database
        .delete(sessions)
        .where(
          and(
            plan.revokePresented(plan.previousHash!),
            sql`exists (select 1 from ${sessions} where ${sessions.tokenHash} = ${plan.tokenHash} and ${sessions.userId} = ${plan.userId})`
          )
        );
    // Workers/D1 has no interactive transactions: one atomic batch couples
    // the revocation to the insert, whose committed row the delete's exists
    // guard requires — a failed gate inserts nothing, so nothing is revoked.
    if (typeof db.batch === 'function') {
      const [rows] = await db.batch([
        plan.verifiedInsert(db),
        revokeConditional(db),
      ]);
      return rows.length > 0;
    }
    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: typeof db) => {
        const rows = await plan.verifiedInsert(tx);
        if (rows.length > 0)
          await tx
            .delete(sessions)
            .where(plan.revokePresented(plan.previousHash!));
        return rows.length > 0;
      });
    }
    // better-sqlite3 (drizzle "sync" mode) exposes only synchronous
    // transactions; the insert and the coupled revocation run in one.
    return db.transaction((tx: typeof db) => {
      const rows = plan.verifiedInsert(tx).all();
      if (rows.length > 0)
        tx.delete(sessions)
          .where(plan.revokePresented(plan.previousHash!))
          .run();
      return rows.length > 0;
    });
  }

  /**
   * Couple a verifier write to the session insert in one unit — the
   * password-change path's atomicity guarantee (§7 step 4, finding 7).
   *
   * The verifier UPDATE runs *first*, so the `users_revoke_sessions` trigger
   * revokes the account's other sessions before the fresh row is inserted
   * (reversing the two would let the trigger delete the session it was meant
   * to preserve). Both statements carry the *same* authority gate — id,
   * `password_hash`, role, community and `allowedAuthConditions()` — so a lost
   * race makes them fail together: `db.batch` on D1 runs them in one atomic
   * unit, and SQLite/PostgreSQL run them in one transaction that rolls back
   * when the insert establishes no row. The verifier write and the session
   * therefore can no longer diverge, and a `Conflict` answer is truthful.
   * The account's other sessions are also revoked explicitly: when the new
   * material produces the same stored verifier the trigger does not fire,
   * and every verifier change must revoke the account's other sessions
   * (SPEC-V2 §7). The D1 batch executes the revoke without an interactive
   * transaction, so it is gated on the new verifier actually being stored —
   * a lost coupled write deletes nothing, exactly as the rolling-back
   * SQLite/PostgreSQL paths. The one hole in that gate is an identical-material
   * write (requested verifier reproduces the stored one) racing a concurrent
   * authority change: see the note on the revoke below.
   */
  async createSessionWithVerifier(input: {
    tokenHash: string;
    user: FoundationUser;
    kind: SessionKind;
    createdAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    previousHash?: string;
    verifier: {
      passwordHash: string;
      passwordVerifier: string;
      passwordAlgorithm: string;
      passwordSalt: string;
      passwordParams: string;
    };
    adminCodeStepUpExpiresAt?: Date | null;
    /** The verifier read before this write; a stale one loses the race. */
    previousVerifier?: string | null;
  }): Promise<{ established: boolean; verifierWritten: boolean }> {
    const plan = this.sessionWritePlan({
      ...input,
      // The coupled write commits its own verifier; the session row must
      // anchor to exactly that value, or the two writes would disagree.
      expectedVerifier: input.verifier.passwordVerifier,
    });
    if (!plan) return { established: false, verifierWritten: false };
    const role = parseV2Role(input.user.role);
    if (!role) return { established: false, verifierWritten: false };
    const db = this.database;
    const { users, communities } = this.tables;
    const sessions = this.sessions;
    // Community → users → sessions lock order (Greptile): the coupled write
    // revokes the user's sessions, and a concurrent community deactivation
    // locks the community row first and then revokes those same sessions in a
    // trigger. Taking the community row before the verifier write and any
    // session delete keeps both paths ordering the same way, so PG never
    // aborts one of them with a deadlock. In PostgreSQL the lock is
    // `FOR SHARE` (many coupled writers may hold it, the disable's `FOR
    // UPDATE` waits for them) and in SQLite the read runs inside the
    // single-writer transaction before the first write. A null-community
    // account (e.g. `super_admin`) has no community row to lock.
    const acquireCommunityFirst = (database: Executor): unknown => {
      if (input.user.communityId === null) return undefined;
      const lock = database
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.id, input.user.communityId));
      if (dialectOf(this.database) === 'postgresql') return lock.for('share');
      // better-sqlite3 executes synchronously; the select is issued inside
      // the transaction before the first write.
      return lock.all();
    };
    // The verifier write and the session insert share one authority anchor, so
    // either both land or neither does.
    const verifierUpdate = (database: Executor) =>
      database
        .update(users)
        .set({
          passwordHash: input.verifier.passwordHash,
          passwordVerifier: input.verifier.passwordVerifier,
          passwordAlgorithm: input.verifier.passwordAlgorithm,
          passwordSalt: input.verifier.passwordSalt,
          passwordParams: input.verifier.passwordParams,
        })
        .where(
          and(
            eq(users.id, input.user.id),
            eq(users.passwordHash, input.verifier.passwordHash),
            // A stale verifier loses the race (finding G).
            input.previousVerifier === null
              ? isNull(users.passwordVerifier)
              : input.previousVerifier === undefined
                ? sql`1 = 1`
                : eq(users.passwordVerifier, input.previousVerifier),
            eq(users.role, role),
            input.user.communityId === null
              ? isNull(users.communityId)
              : eq(users.communityId, input.user.communityId),
            this.verifierAuthorityConditions()
          )
        )
        .returning({ id: users.id });
    const revokePresentedConditional = (database: Executor) =>
      database
        .delete(sessions)
        .where(
          and(
            plan.revokePresented(plan.previousHash!),
            sql`exists (select 1 from ${sessions} where ${sessions.tokenHash} = ${plan.tokenHash} and ${sessions.userId} = ${plan.userId})`
          )
        );
    // D1 note — the gate proves "stored == requested", not "this batch
    // stored it". One hole remains: when the requested verifier reproduces
    // the already-stored one (identical salt + derivedKey) the verifier
    // update changes no row, so the batch reports established:false and no
    // session is inserted — yet a concurrent authority change (role,
    // community, password material or is_active changed in the same window)
    // leaves the stored value equal to the requested one, and this delete
    // fires on a failing coupled write. It cannot be distinguished without
    // a connection-scoped changes(), which the D1 batch gives us no handle
    // on across statements and which does not port to PostgreSQL; and the
    // alternative gate "stored == requested AND requested <> previous" was
    // rejected because it would also block the identical-material SUCCESS
    // case, where §7 still requires the other sessions to die. In practice
    // the residual costs nothing: losing the authority gate means one of
    // those columns did change, and that change revokes the sessions
    // through users_revoke_sessions / communities_revoke_sessions anyway.
    const revokeAllSessions = (database: Executor) =>
      database.delete(sessions).where(
        and(
          eq(sessions.userId, input.user.id),
          sql`exists (
            select 1 from ${users}
            where ${users.id} = ${input.user.id}
              and ${users.passwordVerifier} = ${input.verifier.passwordVerifier}
          )`
        )
      );
    // Workers/D1 has no interactive transactions: one atomic batch runs the
    // verifier write, the session revocation, the session insert and the
    // coupled revocation. SQLite serializes the batch, so the authority
    // checked statements agree.
    if (typeof db.batch === 'function') {
      const list = [
        verifierUpdate(db),
        revokeAllSessions(db),
        plan.verifiedInsert(db),
      ];
      if (plan.previousHash !== undefined)
        list.push(revokePresentedConditional(db));
      const [updated, , inserted] = await db.batch(list);
      return {
        established: inserted.length > 0,
        verifierWritten: updated.length > 0,
      };
    }
    // SQLite/PostgreSQL: one transaction, and a lost session gate rolls the
    // verifier write back so the pair stays all-or-nothing.
    // `await` is load-bearing on both dialects: the PostgreSQL transaction is
    // async, so a bare `return` propagates a `SessionGateLost` rejection past
    // the `catch` below as an unhandled error — the answer is a 500, not the
    // truthful `established: false` (§6.8, §7 step 4).
    try {
      if (dialectOf(db) === 'postgresql') {
        return await db.transaction(async (tx: Executor) => {
          // Community → users → sessions before any write (acquireCommunityFirst).
          await acquireCommunityFirst(tx);
          // Users row before the sessions locks, keeping the one global order
          // of every coupled-writer path (community → users → sessions) so this
          // password-upgrade login can never lock after a redemption that took
          // the same rows in the opposite order.
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.user.id))
            .for('update')
            .limit(1);
          // Take every session row this coupled write will delete under one
          // `FOR UPDATE` in a single deterministic (ascending id) order before
          // any write — the same union lock the redemption path takes. A
          // cross-user upgrade login (B presenting A's cookie) deletes B's
          // sessions and then A's presented row, so an overlapping redemption
          // (A presenting B's cookie) must serialize here instead of holding
          // one row while waiting for the other in reverse order (PR #252 bot
          // finding 2; SPEC-V2 §6.8).
          const lockSessions = () =>
            tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                plan.previousHash === undefined
                  ? eq(sessions.userId, input.user.id)
                  : or(
                      eq(sessions.userId, input.user.id),
                      eq(sessions.tokenHash, plan.previousHash)
                    )
              )
              .orderBy(sessions.id)
              .for('update');
          await lockSessions();
          const updated = await verifierUpdate(tx);
          if (updated.length === 0) throw new SessionGateLost();
          // Explicit revocation: a same-verifier write never fires the
          // trigger, yet §7 requires the other sessions to die.
          await revokeAllSessions(tx);
          const inserted = await plan.verifiedInsert(tx);
          if (inserted.length === 0) throw new SessionGateLost();
          if (plan.previousHash !== undefined)
            await tx
              .delete(sessions)
              .where(plan.revokePresented(plan.previousHash));
          return { established: true, verifierWritten: updated.length > 0 };
        });
      }
      return await db.transaction((tx: Executor) => {
        // Community → users → sessions before any write (acquireCommunityFirst).
        acquireCommunityFirst(tx);
        const updated = verifierUpdate(tx).all();
        if (updated.length === 0) throw new SessionGateLost();
        // Explicit revocation: a same-verifier write never fires the
        // trigger, yet §7 requires the other sessions to die.
        revokeAllSessions(tx).run();
        const inserted = plan.verifiedInsert(tx).all();
        if (inserted.length === 0) throw new SessionGateLost();
        if (plan.previousHash !== undefined)
          tx.delete(sessions)
            .where(plan.revokePresented(plan.previousHash))
            .run();
        return { established: true, verifierWritten: updated.length > 0 };
      });
    } catch (error) {
      if (error instanceof SessionGateLost)
        return { established: false, verifierWritten: false };
      throw error;
    }
  }

  /**
   * Re-read current user/community state; mutation triggers permanently revoke
   * sessions. Enforces the §6.8 expiry split (idle window, device absolute
   * window, revocation tombstone) and persists `last_seen_at` at a bounded
   * rate so a busy session does not spend one D1 row write per request.
   *
   * `sessionContext` also returns the `kind`, so the response cookie can be
   * issued with the lifetime of the session the caller actually holds.
   */
  async sessionContext(
    tokenHash: string,
    now: Date,
    renew = true
  ): Promise<{
    user: FoundationUser;
    kind: SessionKind;
    /** The row's absolute expiry, so a device cookie can carry the remainder. */
    absoluteExpiresAt: number | null;
  } | null> {
    const { users, communities } = this.tables;
    const sessions = this.sessions;
    const nowMs = now.getTime();
    const rows: (RawFoundationUser & {
      expiresAt: number;
      idleExpiresAt: number | null;
      absoluteExpiresAt: number | null;
      lastSeenAt: number | null;
      kind: string;
    })[] = await this.database
      .select({
        ...this.projection(),
        expiresAt: sessions.expiresAt,
        idleExpiresAt: sessions.idleExpiresAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
        lastSeenAt: sessions.lastSeenAt,
        kind: sessions.kind,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .leftJoin(communities, eq(users.communityId, communities.id))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          this.sessionWindowCondition(nowMs),
          this.allowedAuthConditions()
        )
      )
      .limit(1);
    const row = rows[0];
    const user = row ? this.toFoundationUser(row) : null;
    if (!user || !row) return null;
    const kind: SessionKind = row.kind === 'device' ? 'device' : 'standard';
    // Bounded last-seen write: once a minute at most, plus the slide-renewal
    // inside the final 15 minutes of the idle window.
    const idleExpiresAt = row.idleExpiresAt ?? row.expiresAt;
    const staleLastSeen =
      row.lastSeenAt === null ||
      nowMs - row.lastSeenAt >= SESSION_LAST_SEEN_WRITE_INTERVAL_MS;
    // Renewal is rate-limited to once per `sessionRenewalInterval`: the idle
    // expiry encodes the last renewal, so the threshold is the last renewal plus
    // the interval, whichever idle window the kind uses.
    const renewWindow =
      renew &&
      nowMs >=
        idleExpiresAt - sessionIdleWindowMs(kind) + sessionRenewalInterval;
    if (!staleLastSeen && !renewWindow)
      return { user, kind, absoluteExpiresAt: row.absoluteExpiresAt };
    const patch: Record<string, unknown> = { lastSeenAt: nowMs };
    if (renewWindow) {
      const next = sessionLifetimesFor(kind, nowMs);
      patch.expiresAt = next.idleExpiresAt;
      patch.idleExpiresAt = next.idleExpiresAt;
    }
    const touched = await this.database
      .update(sessions)
      .set(patch)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          eq(sessions.expiresAt, row.expiresAt),
          gt(sessions.expiresAt, nowMs),
          this.sessionWindowCondition(nowMs)
        )
      )
      .returning({ id: sessions.id });
    // A lost race — a concurrent revoke, deletion, idle- or absolute-expiry,
    // or a renewed `expiresAt` — means the previously-read user can no longer
    // authenticate. Whenever the touch was attempted and matched 0 rows
    // (with or without a renewal due), re-read under the same validity
    // conditions or answer as unauthenticated — never return stale authority.
    if (touched.length === 0) return this.sessionContext(tokenHash, now, false);
    return { user, kind, absoluteExpiresAt: row.absoluteExpiresAt };
  }

  async session(
    tokenHash: string,
    now: Date,
    renew = true
  ): Promise<FoundationUser | null> {
    const context = await this.sessionContext(tokenHash, now, renew);
    return context?.user ?? null;
  }

  /**
   * The §6.8 window predicate shared by reads and writes: not idle-expired,
   * not past the absolute device window, not revoked.
   */
  private sessionWindowCondition(nowMs: number) {
    const sessions = this.sessions;
    return and(
      or(isNull(sessions.idleExpiresAt), gt(sessions.idleExpiresAt, nowMs)),
      or(
        isNull(sessions.absoluteExpiresAt),
        gt(sessions.absoluteExpiresAt, nowMs)
      ),
      isNull(sessions.revokedAt)
    );
  }

  /** Set a user's display name (own profile edit, PATCH /v2/auth/me). */
  async updateDisplayName(
    id: number,
    displayName: string | null,
    now: Date
  ): Promise<void> {
    const { users } = this.tables;
    await this.database
      .update(users)
      .set({ displayName, updatedAt: now })
      .where(eq(users.id, id));
  }

  /** Delete this session row (logout) and clear it everywhere else. */
  async revokeSession(tokenHash: string): Promise<void> {
    await this.database
      .delete(this.sessions)
      .where(eq(this.sessions.tokenHash, tokenHash));
  }

  async revokeUserSessions(userId: number): Promise<void> {
    await this.database
      .delete(this.sessions)
      .where(eq(this.sessions.userId, userId));
  }

  /**
   * Whether the account currently holds at least one unconsumed,
   * unsuperseded `recovery` LoginCode (`GET /v2/auth/me` confirmation flag).
   */
  async hasActiveRecoveryCodes(userId: number): Promise<boolean> {
    const { loginCodes } = this.tables;
    const rows = await this.database
      .select({ id: loginCodes.id })
      .from(loginCodes)
      .where(
        and(
          eq(loginCodes.userId, userId),
          eq(loginCodes.purpose, 'recovery'),
          isNull(loginCodes.usedAt),
          isNull(loginCodes.supersededAt)
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  async brandingFile(
    fileId: string,
    communityId: number | null
  ): Promise<{
    storageKey: string;
    mimeType: string;
  } | null> {
    if (
      communityId === null ||
      !Number.isInteger(communityId) ||
      communityId <= 0
    ) {
      return null;
    }
    const { files, communities } = this.tables;
    const media = this.communityMedia;
    const rows = await this.database
      .select({
        storageKey: files.path,
        mimeType: files.mimeType,
      })
      .from(media)
      .innerJoin(files, eq(media.fileId, files.id))
      .innerJoin(communities, eq(media.communityId, communities.id))
      .where(
        and(
          eq(media.fileId, fileId),
          eq(media.communityId, communityId),
          eq(media.kind, 'branding'),
          eq(files.communityId, media.communityId),
          eq(files.isActive, true),
          eq(communities.isActive, communityStatusToPhysical('active')),
          isNull(files.culturalRestrictions)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async readiness(): Promise<void> {
    // Touch the authoritative session table so missing migrations fail readiness.
    await this.database
      .select({ value: sql<number>`1` })
      .from(this.sessions)
      .limit(1);
  }
}
