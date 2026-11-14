import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  sessionLifetime,
  sessionRenewalInterval,
} from '../shared/session-policy.js';
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
  passwordHash: string;
  role: string;
  communityId: number;
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
      passwordHash: users.passwordHash,
      role: users.role,
      communityId: users.communityId,
    };
  }

  async candidates(
    email: string,
    communityId?: number
  ): Promise<FoundationUser[]> {
    const { users, communities } = this.tables;
    return this.database
      .select(this.projection())
      .from(users)
      .innerJoin(communities, eq(users.communityId, communities.id))
      .where(
        and(
          eq(users.email, email),
          eq(users.isActive, true),
          eq(communities.isActive, true),
          communityId === undefined
            ? undefined
            : eq(users.communityId, communityId)
        )
      )
      .limit(2);
  }

  async createSession(
    tokenHash: string,
    user: FoundationUser,
    expiresAt: Date,
    previousHash?: string
  ): Promise<boolean> {
    const sessions = this.sessions;
    const { users, communities } = this.tables;
    // A presented session belonging to a different user is never rotated
    // onto the new login: it is revoked, and the authenticating user always
    // gets a row of their own (#188 — shared-browser login).
    if (previousHash) {
      await this.database
        .delete(sessions)
        .where(
          and(
            eq(sessions.tokenHash, previousHash),
            ne(sessions.userId, user.id)
          )
        );
    }
    let verified = this.database
      .select({
        id: sql`coalesce((select ${sessions.id} from ${sessions} where ${sessions.tokenHash} = ${previousHash ?? ''} and ${sessions.userId} = ${user.id}), ${tokenHash})`,
        tokenHash: sql`${tokenHash}`,
        userId: users.id,
        expiresAt: sql`${expiresAt.getTime()}`,
      })
      .from(users)
      .innerJoin(communities, eq(users.communityId, communities.id))
      .where(
        and(
          eq(users.id, user.id),
          eq(users.passwordHash, user.passwordHash),
          eq(users.role, sql`${user.role}`),
          eq(users.communityId, user.communityId),
          eq(users.isActive, true),
          eq(communities.isActive, true)
        )
      );
    // PostgreSQL locks current authority through the write; a concurrent reset
    // either changes this selection or waits and then revokes the new session.
    // SQLite/D1 serialize this single write statement without interactive locks.
    if (dialectOf(this.database) === 'postgresql')
      verified = verified.for('share');
    // Stable row IDs ensure concurrent rotations always write a fresh digest.
    const rows = await this.database
      .insert(sessions)
      .select(verified)
      .onConflictDoUpdate({
        target: sessions.id,
        set: { tokenHash, userId: user.id, expiresAt: expiresAt.getTime() },
      })
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  /** Re-read current user/community state; mutation triggers permanently revoke sessions. */
  async session(
    tokenHash: string,
    now: Date,
    renew = true
  ): Promise<FoundationUser | null> {
    const { users, communities } = this.tables;
    const sessions = this.sessions;
    const rows: (FoundationUser & { expiresAt: number })[] = await this.database
      .select({ ...this.projection(), expiresAt: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .innerJoin(communities, eq(users.communityId, communities.id))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now.getTime()),
          eq(users.isActive, true),
          eq(communities.isActive, true)
        )
      )
      .limit(1);
    const user = rows[0];
    if (
      user &&
      renew &&
      now.getTime() >= user.expiresAt - sessionLifetime + sessionRenewalInterval
    ) {
      const touched = await this.database
        .update(sessions)
        .set({ expiresAt: now.getTime() + sessionLifetime })
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            eq(sessions.expiresAt, user.expiresAt),
            gt(sessions.expiresAt, now.getTime())
          )
        )
        .returning({ id: sessions.id });
      // A lost renewal race must re-read authority, never resurrect a revoked row.
      if (!touched.length) return this.session(tokenHash, now, false);
    }
    return user ?? null;
  }

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
    communityId: number
  ): Promise<{
    storageKey: string;
    mimeType: string;
  } | null> {
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
          eq(communities.isActive, true),
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
