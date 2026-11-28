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
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import { createHonoApp } from '../../src/hono-app.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { MediaCleanupCoordinator } from '../../src/services/media-cleanup.service.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../src/shared/auth-policy.js';
import {
  makeDerivedKey,
  makeServerSecret,
  makeVerifierSalt,
} from '../hono/auth-test-utils.js';
import {
  applyPostRestoreSqlite,
  replayAccountChanges,
} from '../../scripts/ops/post-restore.js';
import { rawUploadRequest } from '../helpers/raw-upload.js';
import {
  DRILL_ACCOUNTS,
  DRILL_KEY,
  DRILL_VIEWER_CODE,
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
const HELPER = path.join(process.cwd(), 'scripts/ops/sqlite-backup.mjs');
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
const liveTiles = path.join(root, 'tiles');
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
let auditMarker = 0;
const newAdminKey = makeDerivedKey();
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
  slug: string,
  key: string = DRILL_KEY
): Promise<string> {
  const res = await app.request(`${ORIGIN}/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: email,
      derivedKey: key,
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
  // Bytes for the seeded files rows (the backup verifies every referenced key).
  for (const communityId of [ids.alpha, ids.beta]) {
    mkdirSync(path.join(liveUploads, `communities/${communityId}`), {
      recursive: true,
    });
    writeFileSync(
      path.join(liveUploads, `communities/${communityId}/story.png`),
      PNG
    );
  }
  mkdirSync(path.join(liveTiles, 'z0'), { recursive: true });
  writeFileSync(path.join(liveTiles, 'z0/0.pbf'), 'tile-bytes');
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

  // Authority/credential fixtures present at backup time (#136, 6.5).
  const nowMs = Date.now();
  live
    .prepare(
      'INSERT INTO community_stewards (community_id, user_id, designated_by, designated_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(ids.alpha, ids.viewerAlpha, ids.adminAlpha, nowMs, nowMs);
  live
    .prepare(
      'UPDATE users SET reset_password_token = ?, reset_password_sent_at = ?, remember_created_at = ? WHERE id = ?'
    )
    .run('reset-token-sentinel', nowMs, nowMs, ids.viewerAlpha);
  live
    .prepare(
      "INSERT INTO export_jobs (id, community_id, requested_by, status, created_at, expires_at) VALUES ('job-1', ?, ?, 'ready', ?, ?)"
    )
    .run(ids.alpha, ids.adminAlpha, nowMs, nowMs + 3600_000);
  live
    .prepare(
      "INSERT INTO export_tokens (job_id, community_id, requested_by, artifact, token_hash, created_at, expires_at) VALUES ('job-1', ?, ?, 'manifest', 'export-token-hash', ?, ?)"
    )
    .run(ids.alpha, ids.adminAlpha, nowMs, nowMs + 3600_000);
  live
    .prepare(
      "INSERT INTO community_sovereignty_requests (id, community_id, kind, state, initiated_by, initiated_by_role, requested_at, notice_ends_at, updated_at) VALUES ('req-1', ?, 'withdrawal', 'notice', ?, 'admin', ?, ?, ?)"
    )
    .run(ids.alpha, ids.adminAlpha, nowMs, nowMs + 86_400_000, nowMs);
  live
    .prepare(
      "INSERT INTO community_archive_custody (community_id, custodian_type, custodian_user_id, status, retention_until, created_at, updated_at) VALUES (?, 'steward', ?, 'held', ?, ?, ?)"
    )
    .run(ids.alpha, ids.viewerAlpha, nowMs + 86_400_000, nowMs, nowMs);
  live
    .prepare(
      "INSERT INTO installation_bootstrap (id, setup_id, community_id, admin_user_id, completed_at) VALUES (1, 'setup-1', ?, ?, ?)"
    )
    .run(ids.alpha, ids.adminAlpha, nowMs);

  before = snapshotSqlite(live);

  // Real backup procedure (live, database open and idle).
  const started = Date.now();
  // Run under sh (dash here, BusyBox ash in the container), not bash.
  auditMarker = (
    live
      .prepare('SELECT coalesce(max(id), 0) AS m FROM audit_entries')
      .get() as {
      m: number;
    }
  ).m;
  execFileSync('sh', [SCRIPT], {
    env: {
      ...process.env,
      SQLITE_BACKUP_HELPER: HELPER,
      BACKUP_DIR: backups,
      DATA_DIR: liveData,
      UPLOADS_DIR: liveUploads,
      TILES_DIR: liveTiles,
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
  // Live revocation is real before any restore is judged.
  expect((await get(liveApp, '/v2/auth/me', cookies.editor)).status).toBe(401);

  // Credentials consumed or changed after the backup: the viewer redeems its
  // login code, a claim token is consumed, and an administrator disables the
  // viewer (audited as user.update).
  const redeem = await liveApp.request(`${ORIGIN}/v2/auth/recovery/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: DRILL_VIEWER_CODE,
      identifier: DRILL_ACCOUNTS.viewerAlpha,
      communitySlug: 'drill-alpha',
    }),
  });
  expect(redeem.status).toBe(200);
  live
    .prepare(
      'UPDATE claim_tokens SET consumed_at = ? WHERE consumed_at IS NULL'
    )
    .run(Date.now());
  const adminCookie = await login(
    liveApp,
    DRILL_ACCOUNTS.adminAlpha,
    'drill-alpha'
  );
  // The admin also changes their own password (auth.password.change).
  const passwordChange = await liveApp.request(`${ORIGIN}/v2/auth/password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: adminCookie,
      origin: ORIGIN,
    },
    body: JSON.stringify({
      currentDerivedKey: DRILL_KEY,
      algorithm: ARGON2ID_ALGORITHM,
      salt: makeVerifierSalt(),
      params: { ...ARGON2ID_PARAMS },
      derivedKey: newAdminKey,
    }),
  });
  expect(passwordChange.status).toBe(200);
  // The change revokes the other sessions and issues a fresh one.
  const freshAdminCookie = (
    passwordChange.headers.get('set-cookie') ?? ''
  ).split(';')[0]!;
  const disable = await liveApp.request(
    `${ORIGIN}/v2/users/${ids.viewerAlpha}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: freshAdminCookie,
        origin: ORIGIN,
      },
      body: JSON.stringify({ status: 'disabled' }),
    }
  );
  expect(disable.status).toBe(200);
  expect(
    (
      await liveApp.request(`${ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: DRILL_ACCOUNTS.viewerAlpha,
          derivedKey: DRILL_KEY,
          communitySlug: 'drill-alpha',
        }),
      })
    ).status
  ).toBe(401);
  // Authority changes after the backup (not audited here on purpose).
  const later = Date.now();
  live.prepare('DELETE FROM community_stewards').run(); // steward removed
  live
    .prepare(
      "UPDATE community_sovereignty_requests SET state = 'cancelled', cancelled_at = ?, cancelled_by = ?, updated_at = ?"
    )
    .run(later, ids.adminAlpha, later);
  live
    .prepare(
      "UPDATE community_archive_custody SET status = 'destroyed', destroyed_at = ?, updated_at = ?"
    )
    .run(later, later);
  live.prepare('UPDATE installation_bootstrap SET admin_user_id = NULL').run();
  live
    .prepare(
      "INSERT INTO auth_throttle (key, kind, community_id, failures, window_started_at, blocked_until) VALUES ('drill-throttle', 'ip', NULL, 9, ?, ?)"
    )
    .run(later, later + 3600_000);
}, 120_000);

afterAll(() => {
  live?.close();
  while (openApps.length > 0) openApps.pop()?.close();
});

/** Restore: extract the archive and copy the database into a fresh file. */
function restore(label: string, postRestore: boolean) {
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
  // Operator step (governance 6.5): a restore never revives revoked credentials.
  if (postRestore) applyPostRestoreSqlite(db);
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

  it('does not revive sessions, consumed login codes or claim tokens revoked after the backup once post-restore runs', async () => {
    // The backup holds the editor session, an unconsumed viewer login code and
    // an unconsumed claim token; the live system then revoked/consumed them.
    const hazard = restore('hazard', false);
    const hazardApp = await buildApp(hazard.db, hazard.uploads);
    const revived = await get(hazardApp, '/v2/auth/me', cookies.editor);
    // Documents why the post-restore step is mandatory: without it the restored
    // file authenticates a token the community already revoked.
    expect(revived.status).toBe(200);
    const redeemBody = JSON.stringify({
      code: DRILL_VIEWER_CODE,
      identifier: DRILL_ACCOUNTS.viewerAlpha,
      communitySlug: 'drill-alpha',
    });
    const redeemRequest = (app: ReturnType<typeof createHonoApp>) =>
      app.request(`${ORIGIN}/v2/auth/recovery/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: redeemBody,
      });
    expect((await redeemRequest(hazardApp)).status).toBe(200);

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
    expect((await redeemRequest(purgedApp)).status).toBe(401);
    const claim = purged.db
      .prepare('SELECT consumed_at, superseded_at FROM claim_tokens')
      .get() as { consumed_at: number | null; superseded_at: number | null };
    expect(claim.superseded_at).not.toBeNull();
  });

  it('reverts account changes to backup time and replays them from the frozen database audit log', async () => {
    // Serving a restored copy writes audit rows, so the "reverted" state is shown
    // on a separate copy; the copy that is replayed has served no traffic.
    const demo = restore('replay-demo', true);
    const demoApp = await buildApp(demo.db, demo.uploads);
    const { db, uploads } = restore('replay', true);
    const app = await buildApp(db, uploads);
    const loginOn = (
      target: ReturnType<typeof createHonoApp>,
      email: string,
      key: string
    ) =>
      target.request(`${ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: email,
          derivedKey: key,
          communitySlug: 'drill-alpha',
        }),
      });
    const loginAs = (email: string, key: string) => loginOn(app, email, key);
    // Reverted: the viewer was disabled and the admin changed their own
    // password after the backup, but the restored rows predate both.
    expect(
      (await loginOn(demoApp, DRILL_ACCOUNTS.viewerAlpha, DRILL_KEY)).status
    ).toBe(200);
    expect(
      (await loginOn(demoApp, DRILL_ACCOUNTS.adminAlpha, DRILL_KEY)).status
    ).toBe(200);
    expect(
      (await loginOn(demoApp, DRILL_ACCOUNTS.adminAlpha, newAdminKey)).status
    ).toBe(401);

    // Runbook step: replay account changes from the frozen pre-restore database.
    const { replayed, missing } = replayAccountChanges(live, db, auditMarker);
    expect(replayed).toEqual(
      expect.arrayContaining([ids.viewerAlpha, ids.adminAlpha])
    );
    expect(missing).toEqual([]);
    expect((await loginAs(DRILL_ACCOUNTS.viewerAlpha, DRILL_KEY)).status).toBe(
      401
    );
    // The self password change (audited under resource_type 'auth') is replayed.
    expect((await loginAs(DRILL_ACCOUNTS.adminAlpha, DRILL_KEY)).status).toBe(
      401
    );
    expect((await loginAs(DRILL_ACCOUNTS.adminAlpha, newAdminKey)).status).toBe(
      200
    );
  });

  it('replays a username/email swap between two users without a unique conflict', () => {
    const { db } = restore('swap', true);
    const cols = 'username, username_normalized, email, email_normalized';
    const row = (id: number) =>
      live.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(id) as Record<
        string,
        string
      >;
    const a = row(ids.editorAlpha);
    const b = row(ids.viewerAlpha);
    // Live: the two users exchange identifiers after the backup (via a temp value).
    const set = live.prepare(
      `UPDATE users SET username = @username, username_normalized = @username_normalized, email = @email, email_normalized = @email_normalized WHERE id = @id`
    );
    live.transaction(() => {
      set.run({
        id: ids.editorAlpha,
        username: 'tmp-x',
        username_normalized: 'tmp-x',
        email: 'tmp-x@t.test',
        email_normalized: 'tmp-x@t.test',
      });
      set.run({ id: ids.viewerAlpha, ...a });
      set.run({ id: ids.editorAlpha, ...b });
    })();
    live
      .prepare(
        "INSERT INTO audit_entries (actor_id, action, resource_type, resource_ids, outcome, created_at) VALUES (?, 'user.update', 'user', ?, 'success', ?)"
      )
      .run(
        ids.adminAlpha,
        JSON.stringify([ids.editorAlpha, ids.viewerAlpha]),
        Date.now()
      );
    // An unrelated restored account holds the exact old temporary value of a
    // replayed user (the previous scheme used 'replay-tmp-<id>').
    db.prepare(
      'UPDATE users SET username = ?, username_normalized = ?, email_normalized = ? WHERE id = ?'
    ).run(
      `replay-tmp-${ids.editorAlpha}`,
      `replay-tmp-${ids.editorAlpha}`,
      `replay-tmp-${ids.editorAlpha}@replay.invalid`,
      ids.adminBeta
    );
    // Mirror it in the frozen DB: the account is unchanged between the two, so
    // the row comparison leaves it alone.
    const origBeta = live
      .prepare(
        'SELECT username, username_normalized, email_normalized FROM users WHERE id = ?'
      )
      .get(ids.adminBeta) as Record<string, string>;
    live
      .prepare(
        'UPDATE users SET username = ?, username_normalized = ?, email_normalized = ? WHERE id = ?'
      )
      .run(
        `replay-tmp-${ids.editorAlpha}`,
        `replay-tmp-${ids.editorAlpha}`,
        `replay-tmp-${ids.editorAlpha}@replay.invalid`,
        ids.adminBeta
      );
    const adminBetaBefore = db
      .prepare('SELECT username FROM users WHERE id = ?')
      .get(ids.adminBeta);
    const { replayed } = replayAccountChanges(live, db, auditMarker);
    expect(replayed).toEqual(
      expect.arrayContaining([ids.editorAlpha, ids.viewerAlpha])
    );
    const restoredEditor = db
      .prepare(`SELECT ${cols} FROM users WHERE id = ?`)
      .get(ids.editorAlpha);
    expect(restoredEditor).toEqual(b);
    expect(
      db.prepare('SELECT username FROM users WHERE id = ?').get(ids.adminBeta)
    ).toEqual(adminBetaBefore);
    live
      .prepare(
        'UPDATE users SET username = ?, username_normalized = ?, email_normalized = ? WHERE id = ?'
      )
      .run(
        origBeta.username,
        origBeta.username_normalized,
        origBeta.email_normalized,
        ids.adminBeta
      );
  });

  it('regenerates a temporary identifier that collides with a stored row', () => {
    const { db } = restore('collide', true);
    const cols = 'username, username_normalized, email, email_normalized';
    const frozenViewer = live
      .prepare(`SELECT ${cols} FROM users WHERE id = ?`)
      .get(ids.viewerAlpha);
    live
      .prepare(
        "INSERT INTO audit_entries (actor_id, action, resource_type, resource_ids, outcome, created_at) VALUES (?, 'user.update', 'user', ?, 'success', ?)"
      )
      .run(ids.adminAlpha, JSON.stringify([ids.viewerAlpha]), Date.now());
    // A stored row (same in the frozen DB, so it is not replayed) already
    // equals the first candidate the generator yields.
    const origName = (
      live
        .prepare('SELECT username FROM users WHERE id = ?')
        .get(ids.adminBeta) as { username: string }
    ).username;
    for (const target of [db, live])
      target
        .prepare('UPDATE users SET username = ? WHERE id = ?')
        .run(`replay tmp FORCED ${ids.viewerAlpha}`, ids.adminBeta);
    const tokens = ['FORCED', 'SECOND'];
    const { replayed } = replayAccountChanges(live, db, auditMarker, {
      tempSource: () => tokens.shift() ?? 'EXHAUSTED',
    });
    expect(replayed).toContain(ids.viewerAlpha);
    expect(tokens).toEqual([]); // the first candidate was rejected, the second used
    expect(
      db.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(ids.viewerAlpha)
    ).toEqual(frozenViewer);
    expect(
      (
        db
          .prepare('SELECT username FROM users WHERE id = ?')
          .get(ids.adminBeta) as {
          username: string;
        }
      ).username
    ).toBe(`replay tmp FORCED ${ids.viewerAlpha}`);
    live
      .prepare('UPDATE users SET username = ? WHERE id = ?')
      .run(origName, ids.adminBeta);
  });

  it('reports users created after the backup that have no restored row', () => {
    const { db } = restore('missing', true);
    live
      .prepare(
        "INSERT INTO audit_entries (actor_id, action, resource_type, resource_ids, outcome, created_at) VALUES (?, 'user.create', 'user', ?, 'success', ?)"
      )
      .run(ids.adminAlpha, JSON.stringify([999]), Date.now());
    live
      .prepare(
        "INSERT INTO users (id, email, first_name, last_name, role, community_id, is_active, password_hash, created_at, updated_at) VALUES (999, 'late@alpha.drill.test', 'L', 'U', 'viewer', ?, 1, 'x', 1, 1)"
      )
      .run(ids.alpha);
    const { missing } = replayAccountChanges(live, db, auditMarker);
    expect(missing).toEqual([999]);
  });

  it('writes the archive owner-only and reports hold no secrets', () => {
    expect(statSync(path.join(backups, archiveName)).mode & 0o777).toBe(0o600);
    const report = writeDrillReport('sqlite-secret-check', {
      schema: migrationVersion('sqlite'),
    });
    const text = readFileSync(report, 'utf8');
    for (const secret of [DRILL_KEY, DRILL_VIEWER_CODE])
      expect(text).not.toContain(secret);
  });

  it('backs up the tiles directory', () => {
    const { base } = restore('tiles', true);
    expect(readFileSync(path.join(base, 'tiles/z0/0.pbf'), 'utf8')).toBe(
      'tile-bytes'
    );
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

  it('replays account changes whose audit write failed (selected by row comparison)', async () => {
    const adminLogin = await login(
      liveApp,
      DRILL_ACCOUNTS.adminAlpha,
      'drill-alpha',
      newAdminKey
    );
    // The audit sink is down: writes fail, and both services swallow it.
    live.exec(
      "CREATE TRIGGER drill_audit_down BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit down'); END"
    );
    const key2 = makeDerivedKey();
    let fresh = '';
    try {
      const change = await liveApp.request(`${ORIGIN}/v2/auth/password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: adminLogin,
          origin: ORIGIN,
        },
        body: JSON.stringify({
          currentDerivedKey: newAdminKey,
          algorithm: ARGON2ID_ALGORITHM,
          salt: makeVerifierSalt(),
          params: { ...ARGON2ID_PARAMS },
          derivedKey: key2,
        }),
      });
      expect(change.status).toBe(200);
      fresh = (change.headers.get('set-cookie') ?? '').split(';')[0]!;
      const revoke = await liveApp.request(
        `${ORIGIN}/v2/users/${ids.editorAlpha}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            cookie: fresh,
            origin: ORIGIN,
          },
          body: JSON.stringify({ role: 'viewer' }),
        }
      );
      expect(revoke.status).toBe(200);
    } finally {
      live.exec('DROP TRIGGER drill_audit_down');
    }
    const auditMax = (
      live
        .prepare('SELECT coalesce(max(id), 0) AS m FROM audit_entries')
        .get() as { m: number }
    ).m;

    const { db, uploads } = restore('unaudited', true);
    const app = await buildApp(db, uploads);
    const loginAdmin = (key: string) =>
      app.request(`${ORIGIN}/v2/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: DRILL_ACCOUNTS.adminAlpha,
          derivedKey: key,
          communitySlug: 'drill-alpha',
        }),
      });
    // (The restored state is older: the backup-time password would still work;
    // not exercised here because serving writes audit rows before the replay.)
    // Nothing is audited after auditMax, yet the replay restores the newer state.
    const { replayed } = replayAccountChanges(live, db, auditMax);
    expect(replayed).toEqual(
      expect.arrayContaining([ids.adminAlpha, ids.editorAlpha])
    );
    expect((await loginAdmin(DRILL_KEY)).status).toBe(401);
    expect((await loginAdmin(newAdminKey)).status).toBe(401);
    expect((await loginAdmin(key2)).status).toBe(200);
    expect(
      db.prepare('SELECT role FROM users WHERE id = ?').get(ids.editorAlpha)
    ).toEqual({ role: 'viewer' });
  });

  it('releases identifiers held by accounts deleted after the backup, in the same transaction', () => {
    const { db } = restore('deleted', true);
    // Restored copy of an account that the live system deleted after the backup.
    db.prepare(
      "INSERT INTO users (id, email, username, username_normalized, email_normalized, first_name, last_name, role, community_id, is_active, password_hash, created_at, updated_at) VALUES (900, 'dead@alpha.drill.test', 'dead-name', 'dead-name', 'dead@alpha.drill.test', 'D', 'D', 'viewer', ?, 1, 'x', 1, 1)"
    ).run(ids.alpha);
    // A surviving account took the deleted account's username in the live DB.
    const orig = live
      .prepare('SELECT username, username_normalized FROM users WHERE id = ?')
      .get(ids.viewerAlpha) as Record<string, string>;
    live
      .prepare(
        "UPDATE users SET username = 'dead-name', username_normalized = 'dead-name' WHERE id = ?"
      )
      .run(ids.viewerAlpha);
    try {
      const { replayed, removed } = replayAccountChanges(live, db, auditMarker);
      expect(removed).toContain(900);
      expect(replayed).toContain(ids.viewerAlpha);
      expect(
        db
          .prepare('SELECT username FROM users WHERE id = ?')
          .get(ids.viewerAlpha)
      ).toEqual({ username: 'dead-name' });
      const dead = db
        .prepare('SELECT username, is_active FROM users WHERE id = 900')
        .get() as { username: string; is_active: number };
      expect(dead.is_active).toBe(0);
      expect(dead.username).toMatch(/^restore-removed /);
    } finally {
      live
        .prepare(
          'UPDATE users SET username = ?, username_normalized = ? WHERE id = ?'
        )
        .run(orig.username, orig.username_normalized, ids.viewerAlpha);
    }
  });

  it('refuses a replay when an id names a different account, changing nothing', () => {
    const { db } = restore('reused-id', true);
    db.prepare(
      'UPDATE users SET created_at = created_at - 12345 WHERE id = ?'
    ).run(ids.viewerAlpha);
    const before = snapshotSqlite(db);
    expect(() => replayAccountChanges(live, db, auditMarker)).toThrow(
      new RegExp(`user ids ${ids.viewerAlpha}\\b.*no account rows were changed`)
    );
    expect(diffSnapshots(before, snapshotSqlite(db))).toEqual([]);
  });

  it('refuses a frozen database of an unrelated lineage even when (id, created_at, community_id) collide', async () => {
    const { db } = restore('lineage', true);
    // A different lineage seeded identically: same ids, created_at and
    // community ids, but none of the audit history of the restored backup.
    const other = new Sqlite(':memory:');
    openApps.push(other);
    other.pragma('foreign_keys = ON');
    migrate(drizzle(other), { migrationsFolder: 'src/db/migrations' });
    await seedDrillDataset(drizzle(other));
    const before = snapshotSqlite(db);
    expect(() => replayAccountChanges(other, db, 0)).toThrow(
      /unrelated lineage.*No account rows were changed/
    );
    expect(diffSnapshots(before, snapshotSqlite(db))).toEqual([]);
    // The documented, dangerous override skips only the lineage check.
    expect(
      replayAccountChanges(other, db, 0, { allowUnrelatedLineage: true })
        .lineage
    ).toBe('skipped');
  });

  it('refuses when a restored community differs in the frozen database', () => {
    const { db } = restore('lineage-community', true);
    db.prepare('UPDATE communities SET slug = ? WHERE id = ?').run(
      'renamed',
      ids.alpha
    );
    const before = snapshotSqlite(db);
    expect(() => replayAccountChanges(live, db, auditMarker)).toThrow(
      new RegExp(`community ${ids.alpha} .*differs`)
    );
    expect(diffSnapshots(before, snapshotSqlite(db))).toEqual([]);
  });

  it('accepts a true ancestor and reports the lineage as verified', () => {
    const { db } = restore('lineage-ok', true);
    expect(replayAccountChanges(live, db, auditMarker).lineage).toBe(
      'verified'
    );
  });

  it('refuses an audit-empty restored backup even when the user tuples collide', async () => {
    const { db } = restore('lineage-empty', true);
    db.prepare('DELETE FROM audit_entries').run();
    const other = new Sqlite(':memory:');
    openApps.push(other);
    other.pragma('foreign_keys = ON');
    migrate(drizzle(other), { migrationsFolder: 'src/db/migrations' });
    await seedDrillDataset(drizzle(other));
    const before = snapshotSqlite(db);
    expect(() => replayAccountChanges(other, db, 0)).toThrow(
      /no audit entries.*No account rows were changed/
    );
    expect(diffSnapshots(before, snapshotSqlite(db))).toEqual([]);
  });

  it('still verifies a genuine ancestor after the scheduled ip/user-agent scrub', () => {
    const { db } = restore('lineage-scrub', true);
    const saved = live
      .prepare('SELECT id, ip_address, user_agent FROM audit_entries')
      .all() as Array<{
      id: number;
      ip_address: string | null;
      user_agent: string | null;
    }>;
    live
      .prepare('UPDATE audit_entries SET ip_address = NULL, user_agent = NULL')
      .run();
    try {
      expect(replayAccountChanges(live, db, auditMarker).lineage).toBe(
        'verified'
      );
    } finally {
      const put = live.prepare(
        'UPDATE audit_entries SET ip_address = ?, user_agent = ? WHERE id = ?'
      );
      for (const r of saved) put.run(r.ip_address, r.user_agent, r.id);
    }
  });

  it('a steward removed after the backup cannot request withdrawal/erasure after the replay', async () => {
    const { db } = restore('steward', true);
    const repo = new CommunitySovereigntyRepository(drizzle(db));
    // Restored backup: the steward designation is still there (revival hazard).
    expect(
      await repo.findStewardDesignation(ids.viewerAlpha, {
        communityId: ids.alpha,
      })
    ).not.toBeNull();
    const result = replayAccountChanges(live, db, auditMarker);
    expect(result.reconciled.community_stewards).toEqual({
      copied: 0,
      skipped: 0,
    });
    expect(
      await repo.findStewardDesignation(ids.viewerAlpha, {
        communityId: ids.alpha,
      })
    ).toBeNull();
  });

  it('reconciles sovereignty requests, archive custody, bootstrap and throttle from the frozen database', () => {
    const { db } = restore('authority', true);
    const result = replayAccountChanges(live, db, auditMarker);
    expect(
      db.prepare('SELECT state FROM community_sovereignty_requests').get()
    ).toEqual({ state: 'cancelled' });
    expect(result.reconciled.community_sovereignty_requests).toEqual({
      copied: 1,
      skipped: 0,
    });
    expect(
      db.prepare('SELECT status FROM community_archive_custody').get()
    ).toEqual({
      status: 'destroyed',
    });
    expect(
      db.prepare('SELECT admin_user_id FROM installation_bootstrap').get()
    ).toEqual({
      admin_user_id: null,
    });
    expect(
      db
        .prepare('SELECT blocked_until FROM auth_throttle WHERE key = ?')
        .get('drill-throttle')
    ).not.toBeUndefined();
  });

  it('reconciles community enable flags from the frozen database', () => {
    const { db } = restore('community-flags', true);
    live
      .prepare('UPDATE communities SET is_active = 0 WHERE id = ?')
      .run(ids.beta);
    try {
      const result = replayAccountChanges(live, db, auditMarker);
      expect(result.communitiesUpdated).toEqual([ids.beta]);
      expect(
        db
          .prepare('SELECT is_active FROM communities WHERE id = ?')
          .get(ids.beta)
      ).toEqual({ is_active: 0 });
    } finally {
      live
        .prepare('UPDATE communities SET is_active = 1 WHERE id = ?')
        .run(ids.beta);
    }
  });

  it('purges password-reset/remember tokens and export tokens on restore', () => {
    const { db } = restore('credentials-purge', false);
    expect(
      db
        .prepare('SELECT reset_password_token AS t FROM users WHERE id = ?')
        .get(ids.viewerAlpha)
    ).toEqual({ t: 'reset-token-sentinel' });
    expect(db.prepare('SELECT count(*) AS n FROM export_tokens').get()).toEqual(
      { n: 1 }
    );
    const purge = applyPostRestoreSqlite(db);
    expect(purge.resetTokensCleared).toBeGreaterThan(0);
    expect(purge.exportTokensDeleted).toBe(1);
    expect(
      db
        .prepare(
          'SELECT reset_password_token AS t, remember_created_at AS r FROM users WHERE id = ?'
        )
        .get(ids.viewerAlpha)
    ).toEqual({ t: null, r: null });
  });

  it('skips authority rows of a community created after the backup instead of failing the replay', () => {
    const { db } = restore('late-community', true);
    const now = Date.now();
    const lateId = Number(
      live
        .prepare(
          "INSERT INTO communities (name, slug, locale, public_stories, is_active, created_at, updated_at) VALUES ('Late', 'late-community', 'en', 0, 1, ?, ?)"
        )
        .run(now, now).lastInsertRowid
    );
    live
      .prepare(
        'INSERT INTO community_stewards (community_id, user_id, designated_by, designated_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(lateId, ids.viewerAlpha, ids.adminAlpha, now, now);
    live
      .prepare(
        "INSERT INTO community_sovereignty_requests (id, community_id, kind, state, initiated_by, initiated_by_role, requested_at, notice_ends_at, updated_at) VALUES ('req-late', ?, 'withdrawal', 'notice', ?, 'admin', ?, ?, ?)"
      )
      .run(lateId, ids.adminAlpha, now, now + 86_400_000, now);
    live
      .prepare(
        "INSERT INTO community_archive_custody (community_id, custodian_type, custodian_user_id, status, retention_until, created_at, updated_at) VALUES (?, 'steward', ?, 'held', ?, ?, ?)"
      )
      .run(lateId, ids.viewerAlpha, now + 86_400_000, now, now);
    live
      .prepare(
        "INSERT INTO auth_throttle (key, kind, community_id, failures, window_started_at) VALUES ('late-throttle', 'account', ?, 1, ?)"
      )
      .run(lateId, now);
    try {
      const result = replayAccountChanges(live, db, auditMarker);
      expect(result.reconciled.community_stewards).toEqual({
        copied: 0,
        skipped: 1,
      });
      expect(result.reconciled.community_sovereignty_requests).toEqual({
        copied: 1,
        skipped: 1,
      });
      expect(result.reconciled.community_archive_custody).toEqual({
        copied: 1,
        skipped: 1,
      });
      expect(result.reconciled.auth_throttle.skipped).toBe(1);
      // The replay still applied the account changes (the viewer is disabled again).
      expect(
        db
          .prepare('SELECT is_active FROM users WHERE id = ?')
          .get(ids.viewerAlpha)
      ).toEqual({ is_active: 0 });
    } finally {
      live
        .prepare('DELETE FROM community_stewards WHERE community_id = ?')
        .run(lateId);
      live
        .prepare(
          'DELETE FROM community_sovereignty_requests WHERE community_id = ?'
        )
        .run(lateId);
      live
        .prepare('DELETE FROM community_archive_custody WHERE community_id = ?')
        .run(lateId);
      live
        .prepare('DELETE FROM auth_throttle WHERE community_id = ?')
        .run(lateId);
      live.prepare('DELETE FROM communities WHERE id = ?').run(lateId);
    }
  });
});
