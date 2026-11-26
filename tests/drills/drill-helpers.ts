/**
 * Shared helpers for the backup/restore drills (#136).
 *
 * The drills run offline: SQLite files on disk, the real field-kit backup
 * script, a wrangler-d1-export-shaped SQL dump, and (only when configured)
 * pg_dump/pg_restore against the CI PostgreSQL 13 service. Each drill writes a
 * JSON report that records the schema/migration version it exercised.
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { tablesFor } from '../../src/db/dialect.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { argon2Seed, makeDerivedKey } from '../hono/auth-test-utils.js';

/** Dialect-agnostic Drizzle handle (same widening as scripts/qa/qa-database.ts). */
export type DrillDb = any;

export const DRILL_KEY = makeDerivedKey();
export const DRILL_T0 = new Date('2026-11-20T12:00:00.000Z');

export const FILE_IDS = {
  alphaStory: '77777777-7777-4777-8777-777777777701',
  betaStory: '77777777-7777-4777-8777-777777777702',
} as const;

export interface DrillIds {
  alpha: number;
  beta: number;
  adminAlpha: number;
  editorAlpha: number;
  viewerAlpha: number;
  adminBeta: number;
  storyAlphaPublic: number;
  storyAlphaRestricted: number;
  storyBetaPublic: number;
}

export const DRILL_ACCOUNTS = {
  adminAlpha: 'admin@alpha.drill.test',
  editorAlpha: 'editor@alpha.drill.test',
  viewerAlpha: 'viewer@alpha.drill.test',
  adminBeta: 'admin@beta.drill.test',
} as const;

async function insertRow(
  db: DrillDb,
  table: DrillDb,
  values: Record<string, unknown>
): Promise<number> {
  const [row] = await db
    .insert(table)
    .values(values)
    .returning({ id: table.id });
  return row.id as number;
}

/**
 * Seed a representative two-community dataset: accounts of every role, places,
 * speakers, public and restricted stories with edges, files with attachments
 * and one live session. Works on SQLite/D1 and PostgreSQL through tablesFor.
 */
export async function seedDrillDataset(db: DrillDb): Promise<DrillIds> {
  const t = tablesFor(db);
  const creds = await argon2Seed(DRILL_KEY);
  const base = { createdAt: DRILL_T0, updatedAt: DRILL_T0 };

  const alpha = await insertRow(db, t.communities, {
    name: 'Drill Alpha',
    slug: 'drill-alpha',
    locale: 'en',
    publicStories: true,
    isActive: true,
    ...base,
  });
  const beta = await insertRow(db, t.communities, {
    name: 'Drill Beta',
    slug: 'drill-beta',
    locale: 'en',
    publicStories: true,
    isActive: true,
    ...base,
  });

  const makeUser = (email: string, role: string, communityId: number) =>
    insertRow(db, t.users, {
      email,
      username: email.replace('@', '-').split('.')[0],
      ...deriveUserIdentityColumns({
        email,
        username: email.replace('@', '-').split('.')[0],
      }),
      ...creds,
      firstName: role,
      lastName: 'Drill',
      role,
      communityId,
      isActive: true,
      ...base,
    });
  const adminAlpha = await makeUser(DRILL_ACCOUNTS.adminAlpha, 'admin', alpha);
  const editorAlpha = await makeUser(
    DRILL_ACCOUNTS.editorAlpha,
    'editor',
    alpha
  );
  const viewerAlpha = await makeUser(
    DRILL_ACCOUNTS.viewerAlpha,
    'viewer',
    alpha
  );
  const adminBeta = await makeUser(DRILL_ACCOUNTS.adminBeta, 'admin', beta);

  const place = (communityId: number, name: string, lat: number, lng: number) =>
    insertRow(db, t.places, {
      communityId,
      name,
      latitude: lat,
      longitude: lng,
      isRestricted: false,
      ...base,
    });
  const placeA1 = await place(alpha, 'River Bend', 49.1, -123.1);
  const placeA2 = await place(alpha, 'Cedar Ridge', 49.2, -123.2);
  const placeB1 = await place(beta, 'Salt Flat', -41.2, 174.7);

  const speaker = (communityId: number, name: string) =>
    insertRow(db, t.speakers, { communityId, name, isActive: true, ...base });
  const speakerA1 = await speaker(alpha, 'Speaker One');
  const speakerA2 = await speaker(alpha, 'Speaker Two');
  const speakerB1 = await speaker(beta, 'Speaker Beta');

  const story = (
    communityId: number,
    title: string,
    slug: string,
    privacyLevel: string,
    isRestricted: boolean
  ) =>
    insertRow(db, t.stories, {
      communityId,
      title,
      slug,
      language: 'en',
      privacyLevel,
      isRestricted,
      ...base,
    });
  const storyAlphaPublic = await story(
    alpha,
    'Alpha Public Story',
    'alpha-public',
    'public',
    false
  );
  const storyAlphaRestricted = await story(
    alpha,
    'Alpha Restricted Story',
    'alpha-restricted',
    'restricted',
    true
  );
  const storyBetaPublic = await story(
    beta,
    'Beta Public Story',
    'beta-public',
    'public',
    false
  );

  for (const [communityId, storyId, placeId] of [
    [alpha, storyAlphaPublic, placeA1],
    [alpha, storyAlphaPublic, placeA2],
    [alpha, storyAlphaRestricted, placeA2],
    [beta, storyBetaPublic, placeB1],
  ] as const) {
    await db
      .insert(t.storyPlaces)
      .values({ communityId, storyId, placeId, sortOrder: 0, ...base });
  }
  for (const [communityId, storyId, speakerId] of [
    [alpha, storyAlphaPublic, speakerA1],
    [alpha, storyAlphaRestricted, speakerA2],
    [beta, storyBetaPublic, speakerB1],
  ] as const) {
    await db
      .insert(t.storySpeakers)
      .values({ communityId, storyId, speakerId, ...base });
  }

  const fileRow = (id: string, communityId: number, uploadedBy: number) => ({
    id,
    filename: 'story.png',
    originalName: 'story.png',
    path: `communities/${communityId}/story.png`,
    storageKey: `communities/${communityId}/story.png`,
    url: 'https://storage.invalid/story.png',
    mimeType: 'image/png',
    size: 64,
    byteSize: 64,
    communityId,
    uploadedBy,
    isActive: true,
    ...base,
  });
  await db
    .insert(t.files)
    .values([
      fileRow(FILE_IDS.alphaStory, alpha, adminAlpha),
      fileRow(FILE_IDS.betaStory, beta, adminBeta),
    ]);
  await db.insert(t.attachments).values({
    communityId: alpha,
    ownerType: 'story',
    ownerId: storyAlphaPublic,
    fileId: FILE_IDS.alphaStory,
    role: 'media',
    ordinal: 0,
    isActive: true,
    createdAt: DRILL_T0,
  });

  // A live session for a seeded account (digest only, like the real table).
  await db.insert(t.sessions).values({
    id: 'drill-session-seed',
    tokenHash: createHash('sha256').update('drill-seed-token').digest('hex'),
    userId: editorAlpha,
    expiresAt: DRILL_T0.getTime() + 12 * 3600 * 1000,
    kind: 'standard',
    createdAt: DRILL_T0.getTime(),
  });

  return {
    alpha,
    beta,
    adminAlpha,
    editorAlpha,
    viewerAlpha,
    adminBeta,
    storyAlphaPublic,
    storyAlphaRestricted,
    storyBetaPublic,
  };
}

// ---------------------------------------------------------------------------
// Row counts and checksums
// ---------------------------------------------------------------------------

export interface TableDigest {
  count: number;
  sha256: string;
}
export type Snapshot = Record<string, TableDigest>;

function normalizeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `hex:${value.toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Order-independent digest of a table's rows (count + SHA-256 of sorted rows). */
export function digestRows(rows: Array<Record<string, unknown>>): TableDigest {
  const lines = rows
    .map((row) =>
      JSON.stringify(
        Object.entries(row).map(([k, v]) => [k, normalizeValue(v)])
      )
    )
    .sort();
  return {
    count: rows.length,
    sha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

export function snapshotSqlite(sqlite: Database.Database): Snapshot {
  const names = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  const out: Snapshot = {};
  for (const { name } of names) {
    out[name] = digestRows(
      sqlite.prepare(`SELECT * FROM "${name}"`).all() as Array<
        Record<string, unknown>
      >
    );
  }
  return out;
}

/** Tables whose digest differs (or exists on one side only). */
export function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names]
    .filter((n) => a[n]?.sha256 !== b[n]?.sha256 || a[n]?.count !== b[n]?.count)
    .sort();
}

// ---------------------------------------------------------------------------
// Ownership / sovereignty invariants (plain SQL: identical on SQLite and PG)
// ---------------------------------------------------------------------------

/** Each query selects violating rows; a clean restore returns none. */
export const OWNERSHIP_INVARIANTS: Record<string, string> = {
  'users reference an existing community': `
    SELECT u.id FROM users u
    WHERE u.community_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM communities c WHERE c.id = u.community_id)`,
  'story-place edges stay inside one community': `
    SELECT sp.id FROM story_places sp
    JOIN stories s ON s.id = sp.story_id
    JOIN places p ON p.id = sp.place_id
    WHERE sp.community_id <> s.community_id OR sp.community_id <> p.community_id`,
  'story-speaker edges stay inside one community': `
    SELECT ss.id FROM story_speakers ss
    JOIN stories s ON s.id = ss.story_id
    JOIN speakers p ON p.id = ss.speaker_id
    WHERE ss.community_id <> s.community_id OR ss.community_id <> p.community_id`,
  'attachments stay inside the file community': `
    SELECT a.id FROM attachments a
    JOIN files f ON f.id = a.file_id
    WHERE a.community_id <> f.community_id`,
  'storage keys are community-scoped': `
    SELECT f.id FROM files f
    WHERE f.storage_key IS NOT NULL
      AND f.storage_key NOT LIKE 'communities/' || f.community_id || '/%'`,
  'sessions belong to existing users': `
    SELECT s.id FROM sessions s
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)`,
};

// ---------------------------------------------------------------------------
// Schema/migration version and drill reports
// ---------------------------------------------------------------------------

export interface MigrationVersion {
  dialect: 'sqlite' | 'postgresql';
  journalEntries: number;
  latestTag: string;
  latestWhen: number;
}

/** The migration journal head the drill ran against (SQLite or PostgreSQL). */
export function migrationVersion(
  dialect: 'sqlite' | 'postgresql'
): MigrationVersion {
  const folder = dialect === 'sqlite' ? 'migrations' : 'migrations/postgres';
  const journal = JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'src/db', folder, 'meta/_journal.json'),
      'utf8'
    )
  ) as { entries: Array<{ tag: string; when: number }> };
  const last = journal.entries[journal.entries.length - 1]!;
  return {
    dialect,
    journalEntries: journal.entries.length,
    latestTag: last.tag,
    latestWhen: last.when,
  };
}

/** Write the drill report (CI uploads DRILL_REPORT_DIR) and echo it. */
export function writeDrillReport(
  profile: string,
  report: Record<string, unknown>
): string {
  const dir =
    process.env.DRILL_REPORT_DIR ?? mkdtempSync(path.join(tmpdir(), 'drill-'));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `restore-drill-${profile}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { profile, recordedAt: new Date().toISOString(), ...report },
      null,
      2
    )
  );
  console.info(`[restore-drill:${profile}] report ${file}`);
  return file;
}
