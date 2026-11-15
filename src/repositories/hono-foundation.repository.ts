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
   * - An own-community `admin` of a disabled community (sovereignty surface only).
   */
  private allowedAuthConditions() {
    const { users, communities } = this.tables;
    return and(
      eq(users.isActive, userStatusToPhysical('active').isActive),
      inArray(users.role, [...V2_COMMUNITY_ROLES]),
      or(
        and(isNull(users.communityId), eq(users.role, 'super_admin')),
        eq(communities.isActive, communityStatusToPhysical('active')),
        and(
          eq(communities.isActive, communityStatusToPhysical('disabled')),
          eq(users.role, 'admin')
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
  }): Promise<boolean> {
    const { tokenHash, user } = input;
    const now = input.createdAt;
    const role = parseV2Role(user.role);
    if (!role) return false;
    if (user.communityId === null && role !== 'super_admin') return false;
    const sessions = this.sessions;
    const { users, communities } = this.tables;
    const db = this.database;
    const kind = input.kind;
    const expiresAt = input.idleExpiresAt;
    const createdAt = input.createdAt.getTime();
    const lastSeenAt = input.createdAt.getTime();
    const idleExpiresAt = input.idleExpiresAt.getTime();
    const absoluteExpiresAt = input.absoluteExpiresAt.getTime();
    const revokedAt = input.revokedAt ? input.revokedAt.getTime() : null;
    const revokedBy = input.revokedAt ? (input.revokedBy ?? user.id) : null;
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
    };
    const verifiedInsert = (database: typeof db) => {
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
          this.allowedAuthConditions()
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
    const previousHash = input.previousHash;
    if (previousHash === undefined) {
      const rows = await verifiedInsert(db);
      return rows.length > 0;
    }
    // Workers/D1 has no interactive transactions: one atomic batch couples
    // the revocation to the insert, whose committed row the delete's exists
    // guard requires — a failed gate inserts nothing, so nothing is revoked.
    if (typeof db.batch === 'function') {
      const [rows] = await db.batch([
        verifiedInsert(db),
        db
          .delete(sessions)
          .where(
            and(
              revokePresented(previousHash),
              sql`exists (select 1 from ${sessions} where ${sessions.tokenHash} = ${tokenHash} and ${sessions.userId} = ${user.id})`
            )
          ),
      ]);
      return rows.length > 0;
    }
    if (dialectOf(db) === 'postgresql') {
      return db.transaction(async (tx: typeof db) => {
        const rows = await verifiedInsert(tx);
        if (rows.length > 0)
          await tx.delete(sessions).where(revokePresented(previousHash));
        return rows.length > 0;
      });
    }
    // better-sqlite3 (drizzle "sync" mode) exposes only synchronous
    // transactions; the insert and the coupled revocation run in one.
    return db.transaction((tx: typeof db) => {
      const rows = verifiedInsert(tx).all();
      if (rows.length > 0)
        tx.delete(sessions).where(revokePresented(previousHash)).run();
      return rows.length > 0;
    });
  }

  /**
   * Re-read current user/community state; mutation triggers permanently revoke
   * sessions. Enforces the §6.8 expiry split (idle window, device absolute
   * window, revocation tombstone) and persists `last_seen_at` at a bounded
   * rate so a busy session does not spend one D1 row write per request.
   */
  async session(
    tokenHash: string,
    now: Date,
    renew = true
  ): Promise<FoundationUser | null> {
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
    if (!user || !row) return user;
    // Bounded last-seen write: once a minute at most, plus the slide-renewal
    // inside the final 15 minutes of the idle window.
    const idleExpiresAt = row.idleExpiresAt ?? row.expiresAt;
    const kind = row.kind === 'device' ? 'device' : 'standard';
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
    if (!staleLastSeen && !renewWindow) return user;
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
    // A lost renewal race must re-read authority, never resurrect a revoked row.
    if (!touched.length && renewWindow)
      return this.session(tokenHash, now, false);
    return user;
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
