import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Database } from '../db/index.js';
import { storiesPg, storiesSqlite } from '../db/schema/stories.js';
import { getConfig } from '../shared/config/index.js';

/**
 * Minimal dual-backend ownership lookup used by authorization middleware.
 *
 * The existing StoryRepository is still SQLite-typed in V1. Keeping this
 * query isolated prevents the transport guard from inheriting that limitation
 * while #135 owns the broader repository/backend convergence work.
 */
export class StoryOwnershipRepository {
  constructor(private readonly db: Database) {}

  async existsInCommunity(id: number, communityId: number): Promise<boolean> {
    const config = getConfig();
    const isPostgres =
      config.database.url.startsWith('postgresql://') ||
      config.database.url.startsWith('postgres://');

    if (isPostgres) {
      const postgresDb = this.db as PostgresJsDatabase<Record<string, unknown>>;
      const [story] = await postgresDb
        .select({ id: storiesPg.id })
        .from(storiesPg)
        .where(
          and(eq(storiesPg.id, id), eq(storiesPg.communityId, communityId))
        )
        .limit(1);
      return Boolean(story);
    }

    const sqliteDb = this.db as BetterSQLite3Database<Record<string, unknown>>;
    const [story] = await sqliteDb
      .select({ id: storiesSqlite.id })
      .from(storiesSqlite)
      .where(
        and(
          eq(storiesSqlite.id, id),
          eq(storiesSqlite.communityId, communityId)
        )
      )
      .limit(1);
    return Boolean(story);
  }
}
