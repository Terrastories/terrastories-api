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
import { usersSqlite } from '../../src/db/schema/users.js';
import { sessionsSqlite } from '../../src/db/schema/sessions.js';
import {
  communityFromPhysical,
  storyVisibilityFromPhysical,
} from '../../src/policy/canonical-state.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { captureRailsToBundle } from '../../src/migration/rails/capture.js';
import {
  ManualReviewRequiredError,
  transformRailsBundle,
  type TransformManifest,
} from '../../src/migration/v2/transform.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
  RAILS_BCRYPT_ALGORITHM,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { makeDerivedKey, makeVerifierSalt } from '../hono/auth-test-utils.js';
import {
  fixtureDir,
  loadFixtureSql,
  withIsolatedRailsDatabase,
} from './pg-test-helper.js';

const sourceUrl = process.env.RAILS_MIGRATION_TEST_DATABASE_URL;
const describeWithPostgres = sourceUrl ? describe : describe.skip;

// Obviously-fake fixture passwords documented in tests/fixtures/rails/README.md.
const FIXTURE_PASSWORDS: Record<string, string> = {
  member_rio: 'fixture-pass-member-2026',
  admin_rio: 'fixture-pass-admin-2026',
  editor_rio: 'fixture-pass-editor-2026',
};

interface Run {
  dir: string;
  manifest: TransformManifest;
}

describeWithPostgres('Rails -> V2 SQLite transform (Stage 2)', () => {
  let workDir: string;
  let bundleDir: string;
  let counter = 0;

  const nextOutput = (): string => join(workDir, 'out-' + counter++);

  const transform = async (
    options: {
      communities?: string[];
      includeSystemUsers?: boolean;
      allowManual?: boolean;
    } = {}
  ): Promise<Run> => {
    const dir = nextOutput();
    const manifest = await transformRailsBundle({
      bundleDir,
      outputDir: dir,
      ...options,
    });
    return { dir, manifest };
  };

  const open = (run: Run, file = 'v2.sqlite'): Database.Database =>
    new Database(join(run.dir, file), { readonly: true });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rails-transform-'));
    bundleDir = join(workDir, 'bundle');
    await withIsolatedRailsDatabase(sourceUrl!, async (dbUrl, pool) => {
      await loadFixtureSql(pool, '2024');
      // A description needing sanitisation, to prove changed values are recorded.
      await pool.query(
        'UPDATE stories SET ' +
          '"desc"' +
          " = '<p>kept</p><script>dropped()</script>' WHERE id = 30"
      );
      await captureRailsToBundle({
        sourceUrl: dbUrl,
        outputDir: bundleDir,
        blobRoot: join(fixtureDir, 'blobs'),
      });
    });
  }, 120_000);

  afterAll(() => undefined);

  it('fails closed on MANUAL items, listing ids and codes only, and leaves no output', async () => {
    const out = nextOutput();
    const error = await transformRailsBundle({
      bundleDir,
      outputDir: out,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManualReviewRequiredError);
    const message = (error as Error).message;
    for (const expected of [
      'communities#12 slug_missing',
      'users#201 role_super_admin_contradiction',
      'users#20 email_collision',
      'users#28 email_collision',
      'users#29 identifier_cross_kind_collision',
      'users#203 password_hash_malformed',
      'stories#33 permission_missing',
      'media_links#81 url_missing',
      'flipper_features#97 unknown_enabled_flag',
    ]) {
      expect(message).toContain(expected);
    }
    // never any contents
    expect(message).not.toContain('example.org');
    expect(message).not.toContain('$2');
    await expect(stat(out)).rejects.toThrow();
    const leftovers = (await readdir(workDir)).filter((name) =>
      name.startsWith('out-')
    );
    expect(leftovers).toEqual([]);
  });

  describe('with --allow-manual (all communities)', () => {
    let run: Run;
    beforeAll(async () => {
      run = await transform({ allowManual: true });
    });

    it('writes owner-only outputs and passes FK/integrity checks', async () => {
      const files = (await readdir(run.dir)).sort();
      expect(files).toEqual([
        'legacy-archive.sqlite',
        'manifest.json',
        'manual-review.json',
        'v2.sqlite',
        'validation-summary.txt',
      ]);
      for (const file of files) {
        expect((await stat(join(run.dir, file))).mode & 0o777).toBe(0o600);
      }
      expect((await stat(run.dir)).mode & 0o777).toBe(0o700);
      const db = open(run);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    });

    it('accounts for every source row exactly once and imports the expected counts', () => {
      for (const [table, counts] of Object.entries(run.manifest.dispositions)) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        expect(total, table).toBe(run.manifest.sourceCounts[table]);
      }
      expect(run.manifest.canonicalCounts).toEqual({
        communities: 2,
        users: 6,
        places: 4,
        speakers: 3,
        stories: 4,
        story_places: 5,
        story_speakers: 4,
        external_media_links: 1,
        community_map_configs: 1,
      });
      expect(run.manifest.dispositions.users).toMatchObject({
        imported: 6,
        not_selected: 0,
        archived: 2,
        manual: 5,
      });
      expect(run.manifest.idRemaps.users).toEqual([]);
    });

    it('maps roles, preserves ids, and keeps identity fields without synthesizing', () => {
      const db = open(run);
      const rows = db
        .prepare(
          'SELECT id, role, community_id, email, email_normalized, username, username_normalized FROM users ORDER BY id'
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows.map((r) => [r.id, r.role])).toEqual([
        [21, 'member'],
        [22, 'editor'],
        [23, 'admin'],
        [25, 'member'],
        [26, 'member'],
        [27, 'viewer'],
      ]);
      const blank = rows.find((r) => r.id === 26)!;
      expect(blank.username).toBeNull();
      expect(blank.username_normalized).toBeNull();
      expect(blank.email).toBe('blankuser@example.org');
      const nullEmail = rows.find((r) => r.id === 27)!;
      expect(nullEmail.email).toBeNull();
      expect(nullEmail.email_normalized).toBeNull();
      // cross-community duplicate email is allowed
      expect(
        rows.filter((r) => r.email_normalized === 'shared@example.org')
      ).toHaveLength(2);
      db.close();
    });

    it('excludes contradictory roles, collisions, malformed hashes and unclassified rows', () => {
      const codes = Object.fromEntries(
        run.manifest.manual.map((item) => [
          item.table + '#' + item.id,
          item.code,
        ])
      );
      expect(codes['users#201']).toBe('role_super_admin_contradiction');
      expect(codes['users#20']).toBe('email_collision');
      expect(codes['users#28']).toBe('email_collision');
      expect(codes['users#29']).toBe('identifier_cross_kind_collision');
      expect(codes['users#203']).toBe('password_hash_malformed');
      expect(codes['stories#33']).toBe('permission_missing');
      expect(codes['communities#12']).toBe('slug_missing');
      expect(codes['media_links#81']).toBe('url_missing');
      const db = open(run);
      const ids = (
        db.prepare('SELECT id FROM users').all() as Array<{ id: number }>
      ).map((r) => r.id);
      for (const excluded of [20, 28, 29, 201, 203]) {
        expect(ids).not.toContain(excluded);
      }
      db.close();
      const archive = open(run, 'legacy-archive.sqlite');
      const archived = archive
        .prepare(
          "SELECT source_id FROM archived_rows WHERE table_name = 'users' AND reason = 'email_collision' ORDER BY source_id"
        )
        .all();
      expect(archived).toEqual([{ source_id: '20' }, { source_id: '28' }]);
      archive.close();
    });

    it('wraps bcrypt verifiers exactly as the legacy login expects and keeps raw hashes out of V2', async () => {
      const db = open(run);
      const row = db
        .prepare(
          'SELECT password_verifier, password_algorithm, password_salt, password_params, password_hash FROM users WHERE id = 21'
        )
        .get() as Record<string, string | null>;
      const archive = open(run, 'legacy-archive.sqlite');
      const raw = (
        archive
          .prepare(
            "SELECT value FROM archived_fields WHERE table_name = 'users' AND source_id = '21' AND column_name = 'encrypted_password'"
          )
          .get() as { value: string }
      ).value;
      expect(raw).toMatch(/^\$2[aby]\$/);
      expect(row.password_algorithm).toBe(RAILS_BCRYPT_ALGORITHM);
      expect(row.password_verifier).toBe(
        await sha256Hex('$2b$' + raw.slice(4))
      );
      expect(row.password_salt).toBe(raw.slice(7, 29));
      expect(JSON.parse(row.password_params as string)).toEqual({
        cost: Number(raw.slice(4, 6)),
      });
      expect(row.password_hash).not.toBe(raw);
      // the blank-password account has no verifier (code-only account)
      const blank = db
        .prepare(
          'SELECT password_verifier, password_algorithm FROM users WHERE id = 26'
        )
        .get();
      expect(blank).toEqual({
        password_verifier: null,
        password_algorithm: null,
      });
      archive.close();
      db.close();

      const bytes = await readFile(join(run.dir, 'v2.sqlite'));
      expect(bytes.includes(Buffer.from(raw))).toBe(false);
    });

    it('maps story permission to visibility and keeps private communities private', () => {
      const db = open(run);
      const stories = db
        .prepare(
          'SELECT id, privacy_level, is_restricted, community_id, topic, topic_normalized FROM stories ORDER BY id'
        )
        .all() as Array<Record<string, unknown>>;
      expect(stories.map((s) => [s.id, s.privacy_level])).toEqual([
        [30, 'public'],
        [31, 'members_only'],
        [32, 'editors'],
        [34, 'public'],
      ]);
      expect(
        stories.map((s) =>
          storyVisibilityFromPhysical(s.privacy_level, s.is_restricted === 1)
        )
      ).toEqual(['public', 'community', 'editors', 'public']);
      const communities = db
        .prepare(
          'SELECT id, slug, public_stories, is_active, locale FROM communities ORDER BY id'
        )
        .all() as Array<Record<string, unknown>>;
      expect(communities.map((c) => [c.id, c.slug, c.public_stories])).toEqual([
        [10, 'rio_verde', 1],
        [11, 'sierra_alta', 0],
      ]);
      expect(
        communityFromPhysical({ publicStories: false, isActive: true })
          .visibility
      ).toBe('private');
      // blank topic stays blank; null stays null
      expect(stories.find((s) => s.id === 31)?.topic).toBe('');
      expect(stories.find((s) => s.id === 31)?.topic_normalized).toBeNull();
      expect(stories.find((s) => s.id === 32)?.topic).toBeNull();
      db.close();
    });

    it('sanitizes descriptions and archives the raw changed value', () => {
      const db = open(run);
      const story = db
        .prepare(
          'SELECT description, description_plain FROM stories WHERE id = 30'
        )
        .get() as Record<string, string>;
      expect(story.description).not.toContain('script');
      expect(story.description).toContain('kept');
      db.close();
      const archive = open(run, 'legacy-archive.sqlite');
      const raw = archive
        .prepare(
          "SELECT value FROM archived_fields WHERE table_name = 'stories' AND source_id = '30' AND column_name = 'desc'"
        )
        .get() as { value: string };
      expect(raw.value).toContain('<script>');
      archive.close();
      expect(run.manifest.fieldEvents['stories.desc:sanitized']).toBe(1);
    });

    it('keeps null coordinates null, dates at the UTC calendar day, and edge multiplicity', () => {
      const db = open(run);
      const place = db
        .prepare('SELECT latitude, longitude FROM places WHERE id = 51')
        .get();
      expect(place).toEqual({ latitude: null, longitude: null });
      const boundary = db
        .prepare('SELECT latitude, longitude FROM places WHERE id = 52')
        .get() as { latitude: number; longitude: number };
      expect(boundary.latitude).toBeCloseTo(89.999999, 6);
      const speakers = db
        .prepare(
          'SELECT id, birth_date, birth_year, birthplace_id FROM speakers ORDER BY id'
        )
        .all();
      expect(speakers).toEqual([
        {
          id: 40,
          birth_date: '1950-06-15',
          birth_year: null,
          birthplace_id: 50,
        },
        {
          id: 41,
          birth_date: '1948-12-31',
          birth_year: null,
          birthplace_id: null,
        },
        {
          id: 42,
          birth_date: '1960-01-01',
          birth_year: null,
          birthplace_id: 53,
        },
      ]);
      const edges = db
        .prepare(
          'SELECT id, story_id, place_id, sort_order, community_id FROM story_places WHERE story_id = 30 ORDER BY sort_order'
        )
        .all();
      expect(edges).toEqual([
        { id: 1, story_id: 30, place_id: 50, sort_order: 0, community_id: 10 },
        { id: 4, story_id: 30, place_id: 50, sort_order: 1, community_id: 10 },
      ]);
      const links = db
        .prepare('SELECT id, url, ordinal FROM external_media_links')
        .all();
      expect(links).toEqual([
        { id: 80, url: 'https://example.org/external-media', ordinal: 0 },
      ]);
      db.close();
    });

    it('maps themes to map configs; invalid Mapbox values stay in the archive only', async () => {
      const db = open(run);
      const config = db
        .prepare('SELECT * FROM community_map_configs')
        .get() as Record<string, unknown>;
      expect(config).toMatchObject({
        community_id: 10,
        // fixture style/token are not valid public Mapbox values: not imported
        mapbox_style_url: null,
        mapbox_access_token: null,
        expose_mapbox_credentials: 0,
        protomaps_api_key: 'legacy-protomaps-key',
        protomaps_basemap_style: '{"theme":"light"}',
        projection: 'globe',
        mapbox_3d: 1,
        three_dimensional: 1,
        static_map_file_id: null,
      });
      expect(config.zoom).toBeCloseTo(8.5, 6);
      expect(config.south_west_latitude).toBeCloseTo(-2, 6);
      db.close();
      const bytes = await readFile(join(run.dir, 'v2.sqlite'));
      expect(bytes.includes(Buffer.from('legacy-map-token'))).toBe(false);
      const archive = open(run, 'legacy-archive.sqlite');
      const archived = archive
        .prepare(
          "SELECT column_name, disposition FROM archived_fields WHERE table_name = 'themes' ORDER BY column_name"
        )
        .all();
      expect(archived).toEqual([
        { column_name: 'active', disposition: 'ARCHIVE' },
        { column_name: 'id', disposition: 'ARCHIVE' },
        {
          column_name: 'mapbox_access_token',
          disposition: 'ARCHIVE_RESTRICTED',
        },
        { column_name: 'mapbox_style_url', disposition: 'ARCHIVE' },
      ]);
      archive.close();
      const codes = run.manifest.warnings
        .filter((w) => w.table === 'themes')
        .map((w) => w.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          'mapbox_style_url_invalid',
          'mapbox_token_not_public',
        ])
      );
    });

    it('archives curriculums, flipper, metadata and unknown tables; records media as pending', () => {
      const archive = open(run, 'legacy-archive.sqlite');
      const tables = (
        archive
          .prepare(
            'SELECT DISTINCT table_name FROM archived_rows ORDER BY table_name'
          )
          .all() as Array<{ table_name: string }>
      ).map((r) => r.table_name);
      for (const expected of [
        'ar_internal_metadata',
        'community_extension_wide',
        'community_notes',
        'curriculum_stories',
        'curriculums',
        'flipper_features',
        'flipper_gates',
        'schema_migrations',
      ]) {
        expect(tables).toContain(expected);
      }
      archive.close();
      expect(run.manifest.unknownTables.sort()).toEqual([
        'community_extension_wide',
        'community_notes',
      ]);
      expect(run.manifest.curriculumUseDetected).toBe(1);
      expect(run.manifest.flipper).toEqual([
        { key: 'custom_pilot_flag', enabled: true, disposition: 'MANUAL' },
        { key: 'public_communities', enabled: true, disposition: 'IMPROVE' },
        { key: 'split_settings', enabled: true, disposition: 'IMPROVE' },
      ]);
      const { blobs, attachments } = run.manifest.pendingMedia;
      expect(blobs.length).toBeGreaterThan(0);
      expect(blobs.every((b) => b.status === 'pending_media_slice')).toBe(true);
      expect(attachments.length).toBeGreaterThan(0);
      expect(run.manifest.canonicalCounts).not.toHaveProperty('files');
    });

    it('records TRANSFORM_DEFAULT events with warnings for defaulted display text', () => {
      // fixture story 32 has a NULL language and community 12 a NULL locale
      expect(
        run.manifest.fieldEvents['stories.language:TRANSFORM_DEFAULT']
      ).toBe(1);
      expect(
        run.manifest.warnings.some(
          (w) => w.code === 'language_defaulted' && w.id === '32'
        )
      ).toBe(true);
    });

    it('writes a counts-only validation summary', async () => {
      const summary = await readFile(
        join(run.dir, 'validation-summary.txt'),
        'utf8'
      );
      expect(summary).toContain('CANONICAL');
      for (const forbidden of [
        'example.org',
        '$2a$',
        '$2b$',
        'legacy-map-token',
        'Rio Verde',
      ]) {
        expect(summary).not.toContain(forbidden);
      }
    });

    it('serves public content through the real Hono app: private community stays hidden', async () => {
      const copy = join(workDir, 'serve-public.sqlite');
      await cp(join(run.dir, 'v2.sqlite'), copy);
      const sqlite = new Database(copy);
      sqlite.pragma('foreign_keys = ON');
      const app = createHonoApp({
        repository: new HonoFoundationRepository(drizzle(sqlite)),
        secureCookies: false,
        serverSecret: makeDerivedKey(),
        storage: { read: async () => null },
      });
      const open1 = await app.fetch(
        new Request('http://localhost/v2/public/communities/rio_verde/stories')
      );
      expect(open1.status).toBe(200);
      const body = (await open1.json()) as {
        data: { stories: Array<{ id: number }> };
      };
      // only permission 0 (public) stories of the public community
      expect(body.data.stories.map((s) => s.id)).toEqual([30]);
      const priv = await app.fetch(
        new Request(
          'http://localhost/v2/public/communities/sierra_alta/stories'
        )
      );
      expect(priv.status).toBe(404);
      sqlite.close();
    });

    it('lets a migrated wrapped-bcrypt user log in, upgrades the verifier, and rejects a wrong password', async () => {
      const copy = join(workDir, 'serve-login.sqlite');
      await cp(join(run.dir, 'v2.sqlite'), copy);
      const sqlite = new Database(copy);
      sqlite.pragma('foreign_keys = ON');
      const db = drizzle(sqlite);
      const app = createHonoApp({
        repository: new HonoFoundationRepository(db),
        secureCookies: false,
        serverSecret: makeDerivedKey(),
        trustProxy: true,
        storage: { read: async () => null },
      });
      const post = (body: unknown, ip: string) =>
        app.request('http://test/v2/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': ip,
          },
          body: JSON.stringify(body),
        });

      for (const [index, username] of [
        'member_rio',
        'admin_rio',
        'editor_rio',
      ].entries()) {
        const row = db
          .select()
          .from(usersSqlite)
          .where(eq(usersSqlite.username, username))
          .get();
        expect(row?.passwordAlgorithm).toBe(RAILS_BCRYPT_ALGORITHM);
        // the client recomputes bcrypt with the stored salt and cost
        const cost = String(JSON.parse(row!.passwordParams!).cost).padStart(
          2,
          '0'
        );
        const derivedKey = await hash(
          FIXTURE_PASSWORDS[username]!,
          '$2b$' + cost + '$' + row!.passwordSalt
        );
        // wrong password first: uniform 401
        const wrong = await post(
          {
            identifier: username,
            derivedKey: await hash(
              'not-the-password',
              '$2b$' + cost + '$' + row!.passwordSalt
            ),
          },
          '10.0.0.' + (index + 1)
        );
        expect(wrong.status).toBe(401);

        const upgradedKey = makeDerivedKey();
        const login = await post(
          {
            identifier: username,
            derivedKey,
            upgrade: {
              algorithm: ARGON2ID_ALGORITHM,
              salt: makeVerifierSalt(),
              params: { ...ARGON2ID_PARAMS },
              derivedKey: upgradedKey,
            },
          },
          '10.0.1.' + (index + 1)
        );
        expect(login.status, username).toBe(200);
        const after = db
          .select()
          .from(usersSqlite)
          .where(eq(usersSqlite.username, username))
          .get();
        expect(after?.passwordAlgorithm).toBe(ARGON2ID_ALGORITHM);
        expect(after?.passwordVerifier).toBe(await sha256Hex(upgradedKey));
        expect(db.select().from(sessionsSqlite).all().length).toBeGreaterThan(
          index
        );
      }
      sqlite.close();
    }, 60_000);
  });

  it('imports only selected communities and marks everything else not_selected', async () => {
    const run = await transform({
      communities: ['rio_verde'],
      allowManual: true,
    });
    const db = open(run);
    const communityIds = (
      db.prepare('SELECT id FROM communities').all() as Array<{ id: number }>
    ).map((r) => r.id);
    expect(communityIds).toEqual([10]);
    expect(
      (
        db.prepare('SELECT DISTINCT community_id FROM stories').all() as Array<{
          community_id: number;
        }>
      ).map((r) => r.community_id)
    ).toEqual([10]);
    expect(
      db
        .prepare('SELECT count(*) AS n FROM users WHERE community_id = 11')
        .get()
    ).toEqual({ n: 0 });
    db.close();
    expect(run.manifest.dispositions.communities).toMatchObject({
      imported: 1,
      not_selected: 2,
    });
    expect(run.manifest.dispositions.stories.not_selected).toBe(1);
    expect(run.manifest.selection).toMatchObject({
      mode: 'community_allowlist',
      selectors: ['rio_verde'],
    });
    // blobs of other communities are never silently dropped from the record
    const statuses = new Set(
      run.manifest.pendingMedia.attachments.map((a) => a.status)
    );
    expect(statuses.has('not_selected')).toBe(true);
    // selection by numeric id works and an unknown selector fails closed
    const byId = await transform({ communities: ['11'], allowManual: true });
    const idDb = open(byId);
    expect(
      (
        idDb.prepare('SELECT id FROM communities').all() as Array<{
          id: number;
        }>
      ).map((r) => r.id)
    ).toEqual([11]);
    idDb.close();
    await expect(
      transformRailsBundle({
        bundleDir,
        outputDir: nextOutput(),
        communities: ['nope'],
        allowManual: true,
      })
    ).rejects.toThrow(/matched no source community/);
  });

  it('raises sqlite_sequence to the max source id so new rows never reuse legacy ids', async () => {
    const run = await transform({
      communities: ['rio_verde'],
      allowManual: true,
    });
    const db = new Database(join(run.dir, 'v2.sqlite'));
    const seq = db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'communities'")
      .get() as { seq: number };
    // community 11 is not imported but its id stays reserved
    expect(seq.seq).toBeGreaterThanOrEqual(11);
    const inserted = db
      .prepare(
        "INSERT INTO communities (name, slug, locale, is_active, created_at, updated_at) VALUES ('n', 'brand-new', 'en', 1, 1, 1)"
      )
      .run();
    expect(Number(inserted.lastInsertRowid)).toBeGreaterThan(11);
    db.close();
  });

  it('imports null-community super_admins only with --include-system-users', async () => {
    const without = await transform({
      communities: ['rio_verde'],
      allowManual: true,
    });
    const withDb = open(without);
    expect(
      withDb
        .prepare('SELECT count(*) AS n FROM users WHERE role = ?')
        .get('super_admin')
    ).toEqual({ n: 0 });
    withDb.close();
    expect(
      without.manifest.dispositions.users.not_selected
    ).toBeGreaterThanOrEqual(2);

    const withSystem = await transform({
      communities: ['rio_verde'],
      includeSystemUsers: true,
      allowManual: true,
    });
    const db = open(withSystem);
    expect(
      db
        .prepare('SELECT id, community_id FROM users WHERE role = ?')
        .all('super_admin')
    ).toEqual([{ id: 24, community_id: null }]);
    db.close();
    // the contradictory null-community user is MANUAL, never imported
    expect(
      withSystem.manifest.manual.find(
        (m) => m.table === 'users' && m.id === '202'
      )?.code
    ).toBe('role_super_admin_contradiction');
  });

  it('is deterministic: same bundle gives a byte-identical manifest and identical rows', async () => {
    const [a, b] = [
      await transform({ allowManual: true }),
      await transform({ allowManual: true }),
    ];
    expect(await readFile(join(a.dir, 'manifest.json'), 'utf8')).toBe(
      await readFile(join(b.dir, 'manifest.json'), 'utf8')
    );
    const dump = (run: Run, file: string, tables: string[]): unknown[] => {
      const db = open(run, file);
      const out = tables.map((t) =>
        db.prepare('SELECT * FROM ' + t + ' ORDER BY 1, 2, 3').all()
      );
      db.close();
      return out;
    };
    expect(
      dump(a, 'v2.sqlite', [
        'communities',
        'users',
        'stories',
        'places',
        'speakers',
        'story_places',
        'story_speakers',
      ])
    ).toEqual(
      dump(b, 'v2.sqlite', [
        'communities',
        'users',
        'stories',
        'places',
        'speakers',
        'story_places',
        'story_speakers',
      ])
    );
    expect(
      dump(a, 'legacy-archive.sqlite', ['archived_rows', 'archived_fields'])
    ).toEqual(
      dump(b, 'legacy-archive.sqlite', ['archived_rows', 'archived_fields'])
    );
  });

  it('refuses to overwrite an existing output path', async () => {
    const out = nextOutput();
    await transformRailsBundle({
      bundleDir,
      outputDir: out,
      allowManual: true,
    });
    await expect(
      transformRailsBundle({ bundleDir, outputDir: out, allowManual: true })
    ).rejects.toThrow(/overwrite/);
  });

  it('fails closed on a tampered archive or blob and leaves no output', async () => {
    const tampered = join(workDir, 'bundle-tampered-archive');
    await cp(bundleDir, tampered, { recursive: true });
    const archivePath = join(tampered, 'legacy.sqlite');
    const bytes = await readFile(archivePath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
    await writeFile(archivePath, bytes);
    const out = nextOutput();
    await expect(
      transformRailsBundle({
        bundleDir: tampered,
        outputDir: out,
        allowManual: true,
      })
    ).rejects.toThrow(/archive/i);
    await expect(stat(out)).rejects.toThrow();

    const blobTampered = join(workDir, 'bundle-tampered-blob');
    await cp(bundleDir, blobTampered, { recursive: true });
    await writeFile(join(blobTampered, 'blobs', 'storymedia01'), 'changed');
    const out2 = nextOutput();
    await expect(
      transformRailsBundle({
        bundleDir: blobTampered,
        outputDir: out2,
        allowManual: true,
      })
    ).rejects.toThrow(/blob/i);
    await expect(stat(out2)).rejects.toThrow();
    const leftovers = (await readdir(workDir)).filter(
      (n) => n.startsWith('out-') && n.includes('.tmp-')
    );
    expect(leftovers).toEqual([]);
  });
});
