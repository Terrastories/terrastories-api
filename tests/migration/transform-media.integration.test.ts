/**
 * Stage-2 media (S3): ActiveStorage blobs -> V2 files + attachments, tenant
 * fan-out, archive of orphan/derived payloads, checksum fail-closed, and the
 * real Hono app serving the migrated output (Node SQLite + local storage).
 * Synthetic fixtures only (tests/fixtures/rails).
 */
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hash } from 'bcrypt';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHonoApp } from '../../src/hono-app.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';
import {
  transformRailsBundle,
  type TransformManifest,
} from '../../src/migration/v2/transform.js';
import { deterministicFileId } from '../../src/migration/v2/media.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../src/shared/auth-policy.js';
import { makeDerivedKey, makeVerifierSalt } from '../hono/auth-test-utils.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const md5b64 = (bytes: Buffer | string): string =>
  createHash('md5').update(bytes).digest('base64');

// Extra synthetic blobs layered on top of the shared fixture.
const EXTRA_BLOBS = [
  {
    id: 120,
    key: 'extrastory69a',
    name: 'first-story-media.svg',
    body: '<svg>first</svg>',
  },
  {
    id: 121,
    key: 'extrasysphoto',
    name: 'system-photo.svg',
    body: '<svg>system admin photo</svg>',
  },
  {
    id: 122,
    key: 'extranoattach',
    name: 'unattached-media.svg',
    body: '<svg>media row without attachment</svg>',
  },
  // Not accepted by the runtime upload allowlist / role rule: archived.
  {
    id: 123,
    key: 'extrasvgblob',
    name: 'speaker-vector.svg',
    body: '<svg>vector photo</svg>',
    type: 'image/svg+xml',
  },
  {
    id: 124,
    key: 'extraaudiopic',
    name: 'speaker-audio.ogg',
    body: 'OggS fake audio as a photo',
    type: 'audio/ogg',
  },
] as const;

interface Run {
  dir: string;
  manifest: TransformManifest;
}

describeWithPostgres('Rails -> V2 media stage (S3)', () => {
  let workDir: string;
  let bundleDir: string;
  let full: Run;
  let counter = 0;

  const nextOutput = (): string => join(workDir, 'out-' + counter++);
  const transform = async (
    options: Parameters<typeof transformRailsBundle>[0] extends infer O
      ? Partial<O>
      : never = {}
  ): Promise<Run> => {
    const dir = nextOutput();
    const manifest = await transformRailsBundle({
      bundleDir,
      outputDir: dir,
      ...options,
    });
    return { dir, manifest };
  };
  const open = (run: Run): Database.Database =>
    new Database(join(run.dir, 'v2.sqlite'), { readonly: true });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rails-media-'));
    bundleDir = join(workDir, 'bundle');
    const blobRoot = join(workDir, 'blob-root');
    await cp(join(fixtureDir, 'blobs'), blobRoot, { recursive: true });
    for (const blob of EXTRA_BLOBS) {
      await writeFile(join(blobRoot, blob.key), blob.body);
    }
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      for (const blob of EXTRA_BLOBS) {
        await pool.query(
          'INSERT INTO active_storage_blobs(id, key, filename, content_type, metadata, byte_size, checksum, created_at, service_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            blob.id,
            blob.key,
            blob.name,
            'type' in blob ? blob.type : 'image/png',
            '{"identified":true}',
            Buffer.byteLength(blob.body),
            md5b64(blob.body),
            '2020-11-01 00:00:00',
            'local',
          ]
        );
      }
      await pool.query(
        "INSERT INTO media(id, story_id, created_at, updated_at) VALUES (69, 30, '2020-05-31 00:00:00', '2024-05-31 00:00:00'), (74, 30, '2020-06-05 00:00:00', '2024-06-05 00:00:00')"
      );
      await pool.query(
        'INSERT INTO active_storage_attachments(id, name, record_type, record_id, blob_id, created_at) VALUES ' +
          // lower media id but higher attachment id: ordering follows the media id
          "(140, 'media', 'Media', 69, 120, '2020-11-02 00:00:00')," +
          // null-community super_admin profile photo
          "(141, 'photo', 'User', 24, 121, '2020-11-02 00:00:00')," +
          // same blob, same community, second relation: one shared file
          "(142, 'photo', 'Place', 51, 107, '2020-11-02 00:00:00')," +
          // runtime would reject: svg is not allowlisted; audio on a photo role
          "(143, 'photo', 'Speaker', 41, 123, '2020-11-02 00:00:00')," +
          "(144, 'photo', 'Speaker', 42, 124, '2020-11-02 00:00:00')"
      );
      await captureRailsToBundle({
        sourceUrl: dbUrl,
        outputDir: bundleDir,
        blobRoot,
      });
    });
    full = await transform({ allowManual: true, includeSystemUsers: true });
  }, 120_000);

  afterAll(() => undefined);

  const rows = (run: Run, sql: string): Array<Record<string, unknown>> => {
    const db = open(run);
    try {
      return db.prepare(sql).all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  };

  it('archives attachments the runtime upload rules would reject, with a warning', () => {
    const ids = rows(full, 'SELECT id FROM attachments WHERE id IN (143, 144)');
    expect(ids).toEqual([]);
    const archive = new Database(join(full.dir, 'legacy-archive.sqlite'), {
      readonly: true,
    });
    try {
      expect(
        archive
          .prepare(
            "SELECT source_id, reason FROM archived_rows WHERE table_name = 'active_storage_attachments' AND source_id IN ('143','144') ORDER BY source_id"
          )
          .all()
      ).toEqual([
        { source_id: '143', reason: 'media_type_not_allowed' },
        { source_id: '144', reason: 'media_type_not_allowed' },
      ]);
    } finally {
      archive.close();
    }
    const warnings = full.manifest.warnings as Array<{
      code: string;
      id: string | null;
    }>;
    const flagged = warnings
      .filter((w) => w.code === 'attachment_media_type_not_allowed_archived')
      .map((w) => w.id)
      .sort();
    expect(flagged).toEqual(['143', '144']);
    const ledger = full.manifest.media.blobs.filter((b) =>
      ['123', '124'].includes(b.blobId)
    );
    expect(ledger.map((b) => [b.disposition, b.archiveReason])).toEqual([
      ['archive', 'no_accepted_attachment'],
      ['archive', 'no_accepted_attachment'],
    ]);
    expect(
      rows(
        full,
        "SELECT COUNT(*) AS n FROM files WHERE mime_type = 'image/svg+xml'"
      )
    ).toEqual([{ n: 0 }]);
  });

  it('maps every Rails attachment role to a V2 owner type, owner id, role and ordinal', () => {
    const attachments = rows(
      full,
      'SELECT id, community_id, owner_type, owner_id, role, ordinal FROM attachments ORDER BY id'
    );
    const byId = Object.fromEntries(
      attachments.map((a) => [a.id as number, a])
    );
    expect(byId[101]).toMatchObject({
      owner_type: 'story',
      owner_id: 30,
      role: 'story_media',
      community_id: 10,
    });
    expect(byId[102]).toMatchObject({
      owner_type: 'place',
      owner_id: 50,
      role: 'place_photo',
    });
    expect(byId[103]).toMatchObject({
      owner_type: 'place',
      owner_id: 50,
      role: 'place_name_audio',
    });
    expect(byId[104]).toMatchObject({
      owner_type: 'speaker',
      owner_id: 40,
      role: 'speaker_photo',
    });
    expect(byId[105]).toMatchObject({
      owner_type: 'user',
      owner_id: 22,
      role: 'user_photo',
      community_id: 10,
    });
    expect(byId[106]).toMatchObject({
      owner_type: 'community',
      owner_id: 10,
      role: 'community_display_image',
    });
    expect(byId[107]).toMatchObject({
      owner_type: 'community',
      owner_id: 10,
      role: 'community_background_image',
    });
    expect(byId[111]).toMatchObject({
      owner_type: 'map_config',
      owner_id: 10,
      role: 'static_map',
      community_id: 10,
    });
    expect(byId[115]).toMatchObject({
      owner_type: 'community',
      owner_id: 11,
      role: 'community_display_image',
      community_id: 11,
    });
    // derived attachments (variant image, preview image) are not canonical
    expect(byId[114]).toBeUndefined();
    expect(byId[116]).toBeUndefined();
    // null-community super_admin photo exception
    expect(byId[141]).toMatchObject({
      owner_type: 'user',
      owner_id: 24,
      role: 'user_photo',
      community_id: null,
    });
    expect(full.manifest.canonicalCounts.attachments).toBe(attachments.length);
  });

  it('orders the sponsor trio and story media deterministically', () => {
    const sponsors = rows(
      full,
      "SELECT id, ordinal FROM attachments WHERE role = 'sponsor_logo' ORDER BY ordinal"
    );
    expect(sponsors).toEqual([
      { id: 108, ordinal: 0 },
      { id: 109, ordinal: 1 },
      { id: 110, ordinal: 2 },
    ]);
    // media 69 (attachment 140) sorts before media 70 (attachment 101)
    const story = rows(
      full,
      "SELECT id, ordinal FROM attachments WHERE role = 'story_media' AND owner_id = 30 ORDER BY ordinal"
    );
    expect(story).toEqual([
      { id: 140, ordinal: 0 },
      { id: 101, ordinal: 1 },
    ]);
  });

  it('creates files that match the runtime media conventions', async () => {
    const files = rows(full, 'SELECT * FROM files ORDER BY id');
    expect(files.length).toBe(full.manifest.canonicalCounts.files);
    for (const file of files) {
      const id = file.id as string;
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(file.filename).toBe(id);
      expect(file.url).toBe('/v2/media/' + id);
      expect(file.path).toBe(file.storage_key);
      expect(file.uploaded_by).toBeNull();
      expect(file.is_active).toBe(1);
      expect(file.cultural_restrictions).toBeNull();
      expect(file.byte_size).toBe(file.size);
      const key = file.storage_key as string;
      expect(key).toBe(
        file.community_id === null
          ? 'users/24/media/' + id
          : 'communities/' + String(file.community_id) + '/media/' + id
      );
      const bytes = await readFile(join(full.dir, 'v2-media', key));
      expect(sha256(bytes)).toBe(file.checksum);
      expect(bytes.length).toBe(file.byte_size);
      expect((await stat(join(full.dir, 'v2-media', key))).mode & 0o777).toBe(
        0o600
      );
    }
    const story = files.find((f) => f.original_name === 'story-media.svg')!;
    expect(story).toMatchObject({
      mime_type: 'image/png',
      community_id: 10,
      metadata: '{"identified":true}',
    });
    expect(story.byte_size).toBe(73);
    const photo = rows(
      full,
      'SELECT f.community_id, f.storage_key FROM files f JOIN attachments a ON a.file_id = f.id WHERE a.id = 141'
    );
    expect(photo).toEqual([
      {
        community_id: null,
        storage_key: expect.stringMatching(/^users\/24\/media\//),
      },
    ]);
  });

  it('fans a blob shared across communities into one file per community, never shared', () => {
    const shared = full.manifest.media.blobs.find(
      (b) => b.sourceKey === 'sharedblob01'
    )!;
    expect(shared.disposition).toBe('canonical');
    expect(shared.destinations.map((d) => d.communityId).sort()).toEqual([
      10, 11,
    ]);
    const [a, b] = shared.destinations;
    expect(a!.fileId).not.toBe(b!.fileId);
    expect(a!.storageKey).not.toBe(b!.storageKey);
    expect(a!.fileId).toBe(deterministicFileId('111', '10'));
    const files = rows(
      full,
      "SELECT id, community_id, checksum FROM files WHERE original_name = 'shared-river.svg' ORDER BY community_id"
    );
    expect(files.length).toBe(2);
    expect(new Set(files.map((f) => f.id)).size).toBe(2);
    expect(new Set(files.map((f) => f.checksum)).size).toBe(1);
    // each attachment points at the file of its own community
    const rel = rows(
      full,
      'SELECT a.community_id AS ac, f.community_id AS fc FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.id IN (112, 113)'
    );
    for (const r of rel) expect(r.ac).toBe(r.fc);
  });

  it('shares one file between two relations of the same community', () => {
    // blob 107 is a sponsor logo (attachment 108) and, in this fixture, also a
    // place photo (attachment 142) inside the same community: one file, two relations
    const pair = rows(
      full,
      'SELECT file_id FROM attachments WHERE id IN (108, 142)'
    );
    expect(pair.length).toBe(2);
    expect(pair[0]!.file_id).toBe(pair[1]!.file_id);
  });

  it('archives orphan, variant and preview payloads with their bytes and records dispositions', async () => {
    const byKey = Object.fromEntries(
      full.manifest.media.blobs.map((b) => [b.sourceKey, b])
    );
    expect(byKey.orphanblob01).toMatchObject({
      disposition: 'archive',
      archiveReason: 'orphan',
    });
    expect(byKey.variantblob1).toMatchObject({
      disposition: 'archive',
      archiveReason: 'derived_variant',
    });
    expect(byKey.previewimg01).toMatchObject({
      disposition: 'archive',
      archiveReason: 'derived_preview',
    });
    expect(byKey.extranoattach).toMatchObject({
      disposition: 'archive',
      archiveReason: 'orphan',
    });
    for (const key of ['orphanblob01', 'variantblob1', 'previewimg01']) {
      const entry = byKey[key]!;
      const bytes = await readFile(join(full.dir, entry.archiveObject!));
      expect(sha256(bytes)).toBe(entry.sha256);
      expect(
        (await stat(join(full.dir, entry.archiveObject!))).mode & 0o777
      ).toBe(0o600);
    }
    // archived objects are never in the runtime media tree
    const keys = await readdir(join(full.dir, 'archive-media'));
    expect(keys.sort()).toEqual(
      [
        'extraaudiopic',
        'extranoattach',
        'extrasvgblob',
        'orphanblob01',
        'previewimg01',
        'variantblob1',
      ].sort()
    );
    const archive = new Database(join(full.dir, 'legacy-archive.sqlite'), {
      readonly: true,
    });
    const reasons = archive
      .prepare(
        "SELECT table_name, source_id, reason FROM archived_rows WHERE table_name IN ('active_storage_blobs','active_storage_attachments','active_storage_variant_records','media') ORDER BY table_name, CAST(source_id AS INTEGER)"
      )
      .all();
    expect(reasons).toEqual(
      expect.arrayContaining([
        {
          table_name: 'active_storage_attachments',
          source_id: '114',
          reason: 'derived_variant',
        },
        {
          table_name: 'active_storage_attachments',
          source_id: '116',
          reason: 'derived_preview',
        },
        {
          table_name: 'active_storage_variant_records',
          source_id: '120',
          reason: 'variant_regenerated',
        },
        {
          table_name: 'active_storage_blobs',
          source_id: '112',
          reason: 'orphan',
        },
        {
          table_name: 'media',
          source_id: '74',
          reason: 'media_without_attachment',
        },
      ])
    );
    archive.close();
    expect(full.manifest.warnings).toEqual(
      expect.arrayContaining([
        { code: 'media_without_attachment_archived', table: 'media', id: '74' },
        {
          code: 'orphan_blob_archived',
          table: 'active_storage_blobs',
          id: '112',
        },
      ])
    );
  });

  it('accounts for every source blob exactly once with checksum-verified destinations', () => {
    const ledger = full.manifest.media.blobs;
    const sources = full.manifest.pendingMedia.blobs;
    expect(ledger.length).toBe(sources.length);
    expect(new Set(ledger.map((b) => b.blobId)).size).toBe(ledger.length);
    const db = open(full);
    for (const entry of ledger) {
      if (entry.disposition === 'canonical') {
        expect(entry.destinations.length).toBeGreaterThan(0);
        expect(entry.archiveObject).toBeUndefined();
        for (const dest of entry.destinations) {
          const row = db
            .prepare('SELECT checksum, size FROM files WHERE id = ?')
            .get(dest.fileId) as { checksum: string; size: number };
          expect(row.checksum).toBe(entry.sha256);
          expect(String(row.size)).toBe(entry.byteSize);
        }
      } else {
        expect(entry.destinations).toEqual([]);
        expect(entry.archiveObject).toBeDefined();
      }
    }
    db.close();
    expect(
      full.manifest.media.counts.blobs.canonical +
        full.manifest.media.counts.blobs.archive
    ).toBe(ledger.length);
    for (const table of [
      'media',
      'active_storage_blobs',
      'active_storage_attachments',
      'active_storage_variant_records',
    ]) {
      const counts = full.manifest.dispositions[table]!;
      expect(counts.pending_media_slice).toBe(0);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(
        full.manifest.sourceCounts[table]
      );
    }
  });

  it('is deterministic: the same bundle yields an identical manifest and file ids', async () => {
    const again = await transform({
      allowManual: true,
      includeSystemUsers: true,
    });
    expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(full.manifest));
  });

  it('raises the attachments sequence above every source attachment id', () => {
    const db = open(full);
    const seq = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'attachments'")
      .get() as { seq: number };
    expect(seq.seq).toBeGreaterThanOrEqual(142);
    db.close();
  });

  it('writes only selected communities with --community and keeps others not_selected', async () => {
    const scoped = await transform({
      communities: ['rio_verde'],
      allowManual: true,
    });
    const communities = rows(
      scoped,
      'SELECT DISTINCT community_id AS c FROM files'
    );
    expect(communities).toEqual([{ c: 10 }]);
    const notSelected = scoped.manifest.media.blobs.filter(
      (b) => b.disposition === 'not_selected'
    );
    expect(notSelected.length).toBeGreaterThan(0);
    for (const entry of notSelected) {
      expect(entry.destinations).toEqual([]);
    }
    expect((await readdir(join(scoped.dir, 'v2-media'))).sort()).toEqual([
      'communities',
    ]);
    expect(await readdir(join(scoped.dir, 'v2-media', 'communities'))).toEqual([
      '10',
    ]);
  });

  describe('fail closed', () => {
    it('aborts atomically when a written copy does not match its checksum', async () => {
      const out = nextOutput();
      let count = 0;
      await expect(
        transformRailsBundle({
          bundleDir,
          outputDir: out,
          allowManual: true,
          includeSystemUsers: true,
          afterMediaWrite: async (path) => {
            count += 1;
            if (count === 3) await writeFile(path, 'tampered after write');
          },
        })
      ).rejects.toThrow(/Media write verification failed/);
      await expect(stat(out)).rejects.toThrow();
      const leftovers = (await readdir(workDir)).filter((name) =>
        name.startsWith(out.split('/').pop()!)
      );
      expect(leftovers).toEqual([]);
    });

    it('refuses a bundle whose blob payload was altered after capture', async () => {
      const tampered = join(workDir, 'bundle-tampered');
      await cp(bundleDir, tampered, { recursive: true });
      await writeFile(join(tampered, 'blobs', 'storymedia01'), 'altered');
      const out = nextOutput();
      await expect(
        transformRailsBundle({
          bundleDir: tampered,
          outputDir: out,
          allowManual: true,
        })
      ).rejects.toThrow(/blob/i);
      await expect(stat(out)).rejects.toThrow();
    });
  });

  describe('real Hono app on the migrated output (Node SQLite + local storage)', () => {
    let dbFile: string;
    let sqlite: Database.Database;
    let app: ReturnType<typeof createHonoApp>;
    const ids: Record<string, string> = {};

    const fileFor = (attachmentId: number): string =>
      (
        sqlite
          .prepare('SELECT file_id FROM attachments WHERE id = ?')
          .get(attachmentId) as { file_id: string }
      ).file_id;

    beforeAll(async () => {
      const runtime = await mkdtemp(join(workDir, 'runtime-'));
      dbFile = join(runtime, 'v2.sqlite');
      await cp(join(full.dir, 'v2.sqlite'), dbFile);
      await cp(join(full.dir, 'v2-media'), join(runtime, 'media'), {
        recursive: true,
      });
      sqlite = new Database(dbFile);
      sqlite.pragma('foreign_keys = ON');
      app = createHonoApp({
        repository: new HonoFoundationRepository(drizzle(sqlite)),
        secureCookies: false,
        serverSecret: makeDerivedKey(),
        trustProxy: true,
        storage: await createLocalStorage(join(runtime, 'media')),
      });
      ids.publicStory = fileFor(101);
      ids.display = fileFor(106);
      ids.sponsor = fileFor(108);
      ids.sierraStory = fileFor(113);
      ids.rioPlacePhotoShared = fileFor(112);
    });

    afterAll(() => {
      sqlite.close();
    });

    const login = async (
      username: string,
      password: string,
      ip: string
    ): Promise<string> => {
      const row = drizzle(sqlite)
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.username, username))
        .get()!;
      const cost = String(JSON.parse(row.passwordParams!).cost).padStart(
        2,
        '0'
      );
      const derivedKey = await hash(
        password,
        '$2b$' + cost + '$' + row.passwordSalt
      );
      const response = await app.request('http://test/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({
          identifier: username,
          derivedKey,
          upgrade: {
            algorithm: ARGON2ID_ALGORITHM,
            salt: makeVerifierSalt(),
            params: { ...ARGON2ID_PARAMS },
            derivedKey: makeDerivedKey(),
          },
        }),
      });
      expect(response.status).toBe(200);
      return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; ');
    };

    const expectedBytes = async (fileId: string): Promise<Buffer> => {
      const key = (
        sqlite
          .prepare('SELECT storage_key FROM files WHERE id = ?')
          .get(fileId) as {
          storage_key: string;
        }
      ).storage_key;
      return readFile(join(full.dir, 'v2-media', key));
    };

    it('serves public-story media to an anonymous visitor, and nothing outside the public audience', async () => {
      const ok = await app.request(
        'http://test/v2/public/communities/rio_verde/media/' + ids.publicStory
      );
      expect(ok.status).toBe(200);
      expect(
        Buffer.from(await ok.arrayBuffer()).equals(
          await expectedBytes(ids.publicStory!)
        )
      ).toBe(true);
      // private community: its public story's media is not discoverable
      const sierra = await app.request(
        'http://test/v2/public/communities/sierra_alta/media/' + ids.sierraStory
      );
      expect(sierra.status).toBe(404);
      // a file of another community is not reachable through this community slug
      const cross = await app.request(
        'http://test/v2/public/communities/rio_verde/media/' + ids.sierraStory
      );
      expect(cross.status).toBe(404);
      // the authenticated route needs a session
      const anonymous = await app.request(
        'http://test/v2/media/' + ids.publicStory
      );
      expect([401, 403, 404]).toContain(anonymous.status);
    });

    it('lets a community member read community media but not another community', async () => {
      const cookie = await login(
        'member_rio',
        'fixture-pass-member-2026',
        '10.9.0.1'
      );
      for (const id of [ids.publicStory, ids.display, ids.sponsor]) {
        const response = await app.request('http://test/v2/media/' + id, {
          headers: { cookie },
        });
        expect(response.status, id).toBe(200);
        expect(
          Buffer.from(await response.arrayBuffer()).equals(
            await expectedBytes(id!)
          )
        ).toBe(true);
      }
      const foreign = await app.request(
        'http://test/v2/media/' + ids.sierraStory,
        {
          headers: { cookie },
        }
      );
      expect(foreign.status).toBe(404);
    });

    it('lists story media in migrated order', async () => {
      const response = await app.request(
        'http://test/v2/public/communities/rio_verde/stories/30'
      );
      expect(response.status).toBe(200);
      const body = JSON.stringify(await response.json());
      const first = body.indexOf(fileFor(140));
      const second = body.indexOf(fileFor(101));
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
    });
  });
});
