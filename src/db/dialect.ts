/**
 * Dialect-aware table selection and portable query helpers.
 *
 * SQLite/D1 and PostgreSQL are equal required targets (docs/SPEC-V2.md §8).
 * Repositories must pick tables from the database instance they were given,
 * never from a single-dialect schema alias, and must express shared search and
 * ordering behavior through these helpers so both backends return the same
 * rows in the same order.
 */
import { asc, desc, is, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { attachmentsPg, attachmentsSqlite } from './schema/attachments.js';
import { communitiesPg, communitiesSqlite } from './schema/communities.js';
import { filesPg, filesSqlite } from './schema/files.js';
import { placesPg, placesSqlite } from './schema/places.js';
import { speakersPg, speakersSqlite } from './schema/speakers.js';
import { storiesPg, storiesSqlite } from './schema/stories.js';
import { storyPlacesPg, storyPlacesSqlite } from './schema/story_places.js';
import {
  storySpeakersPg,
  storySpeakersSqlite,
} from './schema/story_speakers.js';
import { themesPg, themesSqlite } from './schema/themes.js';
import { usersPg, usersSqlite } from './schema/users.js';

export type Dialect = 'postgresql' | 'sqlite';

const sqliteTables = {
  attachments: attachmentsSqlite,
  communities: communitiesSqlite,
  files: filesSqlite,
  places: placesSqlite,
  speakers: speakersSqlite,
  stories: storiesSqlite,
  storyPlaces: storyPlacesSqlite,
  storySpeakers: storySpeakersSqlite,
  themes: themesSqlite,
  users: usersSqlite,
};

const postgresTables = {
  attachments: attachmentsPg,
  communities: communitiesPg,
  files: filesPg,
  places: placesPg,
  speakers: speakersPg,
  stories: storiesPg,
  storyPlaces: storyPlacesPg,
  storySpeakers: storySpeakersPg,
  themes: themesPg,
  users: usersPg,
};

/**
 * Both table sets share column names. Repositories query through a widened
 * Drizzle instance, so the SQLite shape is used as the static column surface.
 */
export type DialectTables = typeof sqliteTables;

/** Detect the dialect from the Drizzle instance itself, not from config. */
export function dialectOf(database: unknown): Dialect {
  return is(database, PgDatabase) ? 'postgresql' : 'sqlite';
}

/** The table set that matches the given Drizzle instance. */
export function tablesFor(database: unknown): DialectTables {
  return (
    dialectOf(database) === 'postgresql' ? postgresTables : sqliteTables
  ) as DialectTables;
}

/** Escape LIKE wildcards so user input is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Case-insensitive substring match with the same result on both backends.
 *
 * PostgreSQL uses ILIKE; SQLite uses LIKE on lower() of both sides. Both escape
 * wildcards with a backslash. Folding is ASCII-reliable on both; non-ASCII case
 * folding is an intentional difference (SQLite lower() folds ASCII only) until
 * V2 application-normalized columns replace database folding (SPEC-V2 §6.2/§6.3).
 */
export function containsInsensitive(
  dialect: Dialect,
  column: AnyColumn | SQL,
  term: string
): SQL {
  const pattern = `%${escapeLikePattern(term)}%`;
  return dialect === 'postgresql'
    ? sql`${column} ILIKE ${pattern} ESCAPE '\\'`
    : sql`lower(${column}) LIKE lower(${pattern}) ESCAPE '\\'`;
}

/**
 * Collation-independent text ordering: byte (code point) order on both
 * backends. PostgreSQL otherwise sorts by the server locale (glibc and musl
 * differ), while SQLite's default BINARY collation is byte order.
 */
export function textOrder(
  dialect: Dialect,
  column: AnyColumn,
  direction: 'asc' | 'desc' = 'asc'
): SQL {
  const ordered =
    dialect === 'postgresql' ? sql`${column} COLLATE "C"` : sql`${column}`;
  return direction === 'desc' ? sql`${ordered} DESC` : sql`${ordered} ASC`;
}

/** Order by a column, then by id, so equal values have a stable order. */
export function orderWithTiebreak(
  primary: SQL,
  idColumn: AnyColumn,
  direction: 'asc' | 'desc' = 'asc'
): SQL[] {
  return [primary, direction === 'desc' ? desc(idColumn) : asc(idColumn)];
}
