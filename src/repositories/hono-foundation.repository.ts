import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
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

/** Durable authority shared by the coexistence Hono slice on both DB targets. */
export class HonoFoundationRepository {
  private readonly tables;
  private readonly sessions;
  private readonly communityMedia;
  // Match the existing repositories' widened Drizzle boundary: both dialects
  // expose the same query surface while their overloaded TS signatures differ.
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

  /**
   * Transitional exact stored-email lookup. Full canonical normalized identity
   * and nullable-username support belongs to #137's domain normalization.
   * Returning two matches forces callers to reject ambiguous tenant selection.
   */
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
    let verified = this.database
      .select({
        id: sql`coalesce((select ${sessions.id} from ${sessions} where ${sessions.tokenHash} = ${previousHash ?? ''}), ${tokenHash})`,
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
    // A stable row ID allows a single-statement rotation on every dialect.
    // Concurrent rotations can never insert the old browser-token digest:
    // the inserted/updated token is always the newly generated digest.
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
  async session(tokenHash: string, now: Date): Promise<FoundationUser | null> {
    const { users, communities } = this.tables;
    const sessions = this.sessions;
    const rows: FoundationUser[] = await this.database
      .select(this.projection())
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
    return rows[0] ?? null;
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
    originalName: string;
  } | null> {
    const { files, communities } = this.tables;
    const media = this.communityMedia;
    const rows = await this.database
      .select({
        storageKey: files.path,
        mimeType: files.mimeType,
        originalName: files.originalName,
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
