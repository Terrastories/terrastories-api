import { sql } from 'drizzle-orm';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint,
  index as pgIndex,
  uuid,
  check as pgCheck,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  text,
  integer,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { usersPg, usersSqlite } from './users.js';
import { filesPg, filesSqlite } from './files.js';
import { communitiesPg, communitiesSqlite } from './communities.js';

// Expiry is Unix milliseconds on both backends. Only a digest of the opaque
// browser token is persisted; no authorization state is cached in the cookie.
export const sessionsPg = pgTable(
  'sessions',
  {
    id: pgText('id').primaryKey(),
    tokenHash: pgText('token_hash').notNull().unique(),
    userId: pgInteger('user_id')
      .notNull()
      .references(() => usersPg.id, { onDelete: 'cascade' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (table) => [pgIndex('sessions_user_idx').on(table.userId)]
);

export const sessionsSqlite = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => usersSqlite.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sessions_user_idx').on(table.userId)]
);

// One typed owning-resource relation for the thin slice. A File row or a
// legacy stored URL alone is never sufficient authority to read its bytes.
export const communityMediaPg = pgTable(
  'community_media',
  {
    fileId: uuid('file_id')
      .primaryKey()
      .references(() => filesPg.id, { onDelete: 'cascade' }),
    communityId: pgInteger('community_id')
      .notNull()
      .references(() => communitiesPg.id, { onDelete: 'cascade' }),
    kind: pgText('kind').notNull(),
  },
  (table) => [
    pgCheck('community_media_kind_check', sql`${table.kind} = 'branding'`),
  ]
);

export const communityMediaSqlite = sqliteTable(
  'community_media',
  {
    fileId: text('file_id')
      .primaryKey()
      .notNull()
      .references(() => filesSqlite.id, { onDelete: 'cascade' }),
    communityId: integer('community_id')
      .notNull()
      .references(() => communitiesSqlite.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
  },
  (table) => [
    check('community_media_kind_check', sql`${table.kind} = 'branding'`),
  ]
);
