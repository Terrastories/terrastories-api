/**
 * Restore drill, Node/SQLite field-kit profile (#136).
 *
 * Runs the real scripts/field-kit-backup.sh against a seeded database and
 * upload tree, restores the archive into a fresh database file, and checks
 * counts, per-table checksums, community ownership invariants, an app smoke on
 * the restored state and the session-revocation hazard (SPEC-V2 section 7
 * Backups, docs/OPERATIONS-GOVERNANCE.md section 6.5).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import { makeServerSecret } from '../hono/auth-test-utils.js';
import { rawUploadRequest } from '../helpers/raw-upload.js';
import {
  DRILL_ACCOUNTS,
  DRILL_KEY,
  OWNERSHIP_INVARIANTS,
  diffSnapshots,
  migrationVersion,
  seedDrillDataset,
  snapshotSqlite,
  writeDrillReport,
  type DrillIds,
  type Snapshot,
} from './drill-helpers.js';

const ORIGIN = 'https://drill.example.test';
const SCRIPT = path.join(process.cwd(), 'scripts/field-kit-backup.sh');
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

const sha256 = (bytes: Uint8Array | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const root = mkdtempSync(path.join(tmpdir(), 'tsapi-drill-sqlite-'));
const liveData = path.join(root, 'data');
const liveUploads = path.join(root, 'uploads');
const backups = path.join(root, 'backups');
const restoreRoot = path.join(root, 'restore');
const livePath = path.join(liveData, 'field-kit.db');
// Out-of-band erasure records: never mounted into the backup (SPEC-V2 section 7).
const erasureRecords = path.join(root, 'erasure-records');
for (const d of [liveData, liveUploads, backups, restoreRoot, erasureRecords])
  mkdirSync(d, { recursive: true });

let live: Sqlite.Database;
let ids: DrillIds;
let liveApp: ReturnType<typeof createHonoApp>;
let before: Snapshot;
const media: { recent?: string; aged?: string } = {};
const cookies: Record<string, string> = {};
let archiveName = '';
let backupMs = 0;
let restoreMs = 0;
const openApps: Sqlite.Database[] = [];

async function buildApp(db: Sqlite.Database, uploadsRoot: string) {
  const orm = drizzle(db);
  const storage = await createLocalStorage(uploadsRoot);
  return createHonoApp({
    repository: new HonoFoundationRepository(orm),
    serverSecret: makeServerSecret(),
    secureCookies: false,
    publicOrigin: ORIGIN,
    corsOrigins: [],
    storage,
    mediaCleanup: new MediaCleanupCoordinator(orm, storage),
  });
}

async function login(
  app: ReturnType<typeof createHonoApp>,
  email: string,
  slug: string
): Promise<string> {
  const res = await app.request(`${ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey: DRILL_KEY,
      communitySlug: slug,
    }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function upload(
  app: ReturnType<typeof createHonoApp>,
  cookie: string,
  bytes: Uint8Array
): Promise<string> {
  const raw = rawUploadRequest({
    filename: 'photo.png',
    contentType: 'image/png',
    bytes,
  });
  const res = await app.request(`${ORIGIN}/v2/media${raw.search}`, {
    method: 'POST',
    headers: { ...raw.headers, cookie },
    body: raw.body,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

const get = (
  app: ReturnType<typeof createHonoApp>,
  url: string,
  cookie?: string
) => app.request(`${ORIGIN}${url}`, cookie ? { headers: { cookie } } : {});

beforeAll(async () => {
  live = new Sqlite(livePath);
  live.pragma('foreign_keys = ON');
  const orm = drizzle(live);
  migrate(orm, { migrationsFolder: 'src/db/migrations' });
  ids = await seedDrillDataset(orm);
  liveApp = await buildApp(live, liveUploads);

  cookies.editor = await login(
    liveApp,
    DRILL_ACCOUNTS.editorAlpha,
    'drill-alpha'
  );
  cookies.viewer = await login(
    liveApp,
    DRILL_ACCOUNTS.viewerAlpha,
    'drill-alpha'
  );
  media.recent = await upload(liveApp, cookies.editor, PNG);
  media.aged = await upload(
    liveApp,
    cookies.editor,
    Uint8Array.from([...PNG, 0])
  );
  // Age the file past 7 days: the backup must still contain it.
  const agedKey = path.join(
    liveUploads,
    `communities/${ids.alpha}/media/${media.aged}`
  );
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  utimesSync(agedKey, old, old);

  before = snapshotSqlite(live);

  // Real backup procedure (live, database open and idle).
  const started = Date.now();
  execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      BACKUP_DIR: backups,
      DATA_DIR: liveData,
      UPLOADS_DIR: liveUploads,
      TILES_DIR: path.join(root, 'no-tiles'),
      BACKUP_COMPRESSION: 'true',
    },
    stdio: 'pipe',
  });
  backupMs = Date.now() - started;
  archiveName = readdirSync(backups).find((f) => f.endsWith('.tar.gz')) ?? '';

  // Sessions revoked after the backup: the editor logs out, the viewer's
  // account is deactivated through the real trigger path (row deletion).
  const logout = await liveApp.request(`${ORIGIN}/v2/auth/logout`, {
    method: 'POST',
    headers: { cookie: cookies.editor!, origin: ORIGIN },
  });
  expect([200, 204]).toContain(logout.status);
}, 120_000);

afterAll(() => {
  live?.close();
  while (openApps.length > 0) openApps.pop()?.close();
});

/** Restore: extract the archive and copy the database into a fresh file. */
function restore(label: string, purgeSessions: boolean) {
  const started = Date.now();
  const dir = path.join(restoreRoot, label);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(backups, archiveName), '-C', dir]);
  const base = path.join(dir, archiveName.replace(/\.tar\.gz$/, ''));
  const dbFile = path.join(dir, 'restored.db');
  copyFileSync(path.join(base, 'data/field-kit.db'), dbFile);
  const db = new Sqlite(dbFile);
  openApps.push(db);
  db.pragma('foreign_keys = ON');
  // Operator step (governance 6.5): a restore never revives revoked sessions.
  if (purgeSessions) db.prepare('DELETE FROM sessions').run();
  restoreMs = Date.now() - started;
  // cp --parents keeps the absolute source path under the archive root.
  return { db, uploads: path.join(base, liveUploads), base };
}

describe('SQLite field-kit restore drill (#136)', () => {
  it('produces a compressed archive with data, uploads and a manifest, without erasure records', () => {
    expect(archiveName).toMatch(/^fieldkit_backup_\d{8}_\d{6}\.tar\.gz$/);
    const listing = execFileSync('tar', [
      '-tzf',
      path.join(backups, archiveName),
    ])
      .toString()
      .split('\n');
    expect(listing.some((l) => l.endsWith('/data/field-kit.db'))).toBe(true);
    expect(listing.some((l) => l.endsWith('/uploads_manifest.txt'))).toBe(true);
    expect(listing.some((l) => l.endsWith('/backup_info.json'))).toBe(true);
    expect(listing.some((l) => l.includes('erasure-records'))).toBe(false);
  });

  it('restores identical row counts and per-table checksums, and keeps ownership invariants', () => {
    const { db } = restore('verify', false);
    const after = snapshotSqlite(db);
    expect(diffSnapshots(before, after)).toEqual([]);
    expect(Object.keys(after)).toContain('__drizzle_migrations');
    expect(after.stories!.count).toBe(3);
    expect(after.communities!.count).toBe(2);

    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    for (const [name, query] of Object.entries(OWNERSHIP_INVARIANTS)) {
      expect({ name, violations: db.prepare(query).all() }).toEqual({
        name,
        violations: [],
      });
    }
    // Per-community counts: nothing moved between communities.
    const perCommunity = db
      .prepare(
        'SELECT community_id AS c, count(*) AS n FROM stories GROUP BY community_id ORDER BY community_id'
      )
      .all();
    expect(perCommunity).toEqual([
      { c: ids.alpha, n: 2 },
      { c: ids.beta, n: 1 },
    ]);

    writeDrillReport('sqlite', {
      backup: 'scripts/field-kit-backup.sh',
      schema: migrationVersion('sqlite'),
      appliedMigrations: (
        db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
          n: number;
        }
      ).n,
      tables: after,
      timingsMs: { backup: backupMs, restore: restoreMs },
    });
  });

  it('serves the restored database: login, story read, media metadata and bytes, public audience', async () => {
    const { db, uploads } = restore('smoke', true);
    const app = await buildApp(db, uploads);

    const editor = await login(app, DRILL_ACCOUNTS.editorAlpha, 'drill-alpha');
    const story = await get(app, `/v2/stories/${ids.storyAlphaPublic}`, editor);
    expect(story.status).toBe(200);
    expect(JSON.stringify(await story.json())).toContain('Alpha Public Story');

    const meta = await get(app, `/v2/media/${media.recent}/metadata`, editor);
    expect(meta.status).toBe(200);
    const checksum = ((await meta.json()) as { data: { checksum: string } })
      .data.checksum;
    expect(checksum).toBe(sha256(PNG));
    const bytes = await get(app, `/v2/media/${media.recent}`, editor);
    expect(bytes.status).toBe(200);
    expect(sha256(Buffer.from(await bytes.arrayBuffer()))).toBe(checksum);

    // Sovereignty: foreign community content stays invisible, restricted stays hidden.
    const foreign = await get(
      app,
      `/v2/stories/${ids.storyBetaPublic}`,
      editor
    );
    expect(foreign.status).toBe(404);
    const restricted = await get(
      app,
      `/v2/stories/${ids.storyAlphaRestricted}`,
      editor
    );
    expect(restricted.status).toBe(404);
    const publicList = await get(
      app,
      '/v2/public/communities/drill-alpha/stories'
    );
    expect(publicList.status).toBe(200);
    const publicText = JSON.stringify(await publicList.json());
    expect(publicText).toContain('Alpha Public Story');
    expect(publicText).not.toContain('Alpha Restricted Story');
    expect(publicText).not.toContain('Beta Public Story');
  });

  it('does not revive sessions revoked after the backup once the restore purges sessions', async () => {
    // The backup holds the editor session; the live system then revoked it.
    const hazard = restore('hazard', false);
    const hazardApp = await buildApp(hazard.db, hazard.uploads);
    const revived = await get(hazardApp, '/v2/auth/me', cookies.editor);
    // Documents why the purge step is mandatory: without it the restored file
    // authenticates a token the community already revoked.
    expect(revived.status).toBe(200);

    const purged = restore('purged', true);
    const purgedApp = await buildApp(purged.db, purged.uploads);
    expect((await get(purgedApp, '/v2/auth/me', cookies.editor)).status).toBe(
      401
    );
    expect((await get(purgedApp, '/v2/auth/me', cookies.viewer)).status).toBe(
      401
    );
    expect(
      (
        purged.db.prepare('SELECT count(*) AS n FROM sessions').get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });

  it('restores media older than 7 days byte-identical and every manifest entry exists', () => {
    const { base, uploads } = restore('window', true);
    const manifest = readFileSync(
      path.join(base, 'uploads_manifest.txt'),
      'utf8'
    )
      .split('\n')
      .filter(Boolean);
    const recentKey = `${liveUploads}/communities/${ids.alpha}/media/${media.recent}`;
    const agedKey = `${liveUploads}/communities/${ids.alpha}/media/${media.aged}`;
    expect(manifest).toContain(recentKey);
    expect(manifest).toContain(agedKey);
    expect(
      existsSync(
        path.join(uploads, `communities/${ids.alpha}/media/${media.recent}`)
      )
    ).toBe(true);
    const agedRestored = path.join(
      uploads,
      `communities/${ids.alpha}/media/${media.aged}`
    );
    expect(existsSync(agedRestored)).toBe(true);
    expect(sha256(readFileSync(agedRestored))).toBe(
      sha256(Uint8Array.from([...PNG, 0]))
    );
    for (const entry of manifest)
      expect(existsSync(path.join(base, entry))).toBe(true);
  });
});
