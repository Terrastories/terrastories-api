import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_OWNER_TYPES,
  ATTACHMENT_ROLES,
  attachmentsSqlite,
  communityMapConfigsSqlite,
  communityMediaSqlite,
  externalMediaLinksSqlite,
  filesSqlite,
  insertAttachmentSchema,
  insertFileSchema,
  storiesSqlite,
} from '../../src/db/schema/index.js';

const SQLITE_MIGRATIONS_DIR = path.join(process.cwd(), 'src/db/migrations');

function getOrderedSqliteMigrationFiles(): string[] {
  return readdirSync(SQLITE_MIGRATIONS_DIR)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .sort();
}

function splitMigrationStatements(sqlContent: string): string[] {
  return sqlContent
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter((stmt) => stmt.length > 0);
}

function runSqliteMigrations(
  sqlite: Database.Database,
  options: { upToPrefixInclusive?: string; onlyFile?: string } = {}
): void {
  const files = getOrderedSqliteMigrationFiles();
  for (const file of files) {
    if (options.onlyFile && file !== options.onlyFile) {
      continue;
    }
    if (
      options.upToPrefixInclusive &&
      file.slice(0, 4) > options.upToPrefixInclusive
    ) {
      break;
    }
    const sqlContent = readFileSync(
      path.join(SQLITE_MIGRATIONS_DIR, file),
      'utf8'
    );
    for (const stmt of splitMigrationStatements(sqlContent)) {
      sqlite.exec(stmt);
    }
  }
}

function seedCoreFixtures(
  sqlite: Database.Database,
  now = 1_795_003_200_000
): void {
  sqlite
    .prepare(
      `INSERT INTO communities (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(1, 'Community One', 'community-one', now, now);
  sqlite
    .prepare(
      `INSERT INTO communities (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(2, 'Community Two', 'community-two', now, now);

  sqlite
    .prepare(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role, community_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      1,
      'super@example.org',
      'hash',
      'Super',
      'Admin',
      'super_admin',
      null,
      now,
      now
    );
  sqlite
    .prepare(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role, community_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      2,
      'editor1@example.org',
      'hash',
      'Editor',
      'One',
      'editor',
      1,
      now,
      now
    );

  sqlite
    .prepare(
      `INSERT INTO stories (id, title, slug, community_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(10, 'Story One', 'story-one', 1, 2, now, now);
}

describe('Slice 2: Canonical File, Attachment, ExternalMediaLink, and CommunityMapConfig', () => {
  describe('Zod coexistence and schema contracts', () => {
    it('keeps frozen V1 insertFileSchema requiring non-null communityId and uploadedBy', () => {
      const validV1 = insertFileSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        filename: 'photo.jpg',
        originalName: 'photo.jpg',
        path: 'uploads/1/photo.jpg',
        url: 'https://example.org/api/v1/files/11111111-1111-4111-8111-111111111111',
        mimeType: 'image/jpeg',
        size: 1024,
        communityId: 1,
        uploadedBy: 2,
      });
      expect(validV1.success).toBe(true);

      const nullCommunity = insertFileSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        filename: 'photo.jpg',
        originalName: 'photo.jpg',
        path: 'uploads/super/photo.jpg',
        url: 'https://example.org/api/v1/files/11111111-1111-4111-8111-111111111111',
        mimeType: 'image/jpeg',
        size: 1024,
        communityId: null,
        uploadedBy: 1,
      });
      expect(nullCommunity.success).toBe(false);

      const nullUploader = insertFileSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        filename: 'photo.jpg',
        originalName: 'photo.jpg',
        path: 'uploads/1/photo.jpg',
        url: 'https://example.org/api/v1/files/11111111-1111-4111-8111-111111111111',
        mimeType: 'image/jpeg',
        size: 1024,
        communityId: 1,
        uploadedBy: null,
      });
      expect(nullUploader.success).toBe(false);
    });

    it('keeps frozen V1 insertAttachmentSchema requiring legacy attachable fields', () => {
      const validV1 = insertAttachmentSchema.safeParse({
        attachableId: 10,
        attachableType: 'Story',
        url: 'https://example.com/a.jpg',
        filename: 'a.jpg',
      });
      expect(validV1.success).toBe(true);

      const v2WithoutV1Fields = insertAttachmentSchema.safeParse({
        communityId: 1,
        fileId: '11111111-1111-4111-8111-111111111111',
        ownerType: 'story',
        ownerId: 10,
        role: 'story_media',
      });
      expect(v2WithoutV1Fields.success).toBe(false);
    });

    it('exports canonical attachment enums', () => {
      expect(ATTACHMENT_OWNER_TYPES).toEqual([
        'story',
        'place',
        'speaker',
        'user',
        'community',
        'map_config',
      ]);
      expect(ATTACHMENT_ROLES).toEqual([
        'story_media',
        'place_photo',
        'place_name_audio',
        'speaker_photo',
        'user_photo',
        'community_display_image',
        'community_background_image',
        'sponsor_logo',
        'static_map',
      ]);
    });
  });

  describe('SQLite DB constraints (0010 migrated schema)', () => {
    it('enforces cross-tenant attachment FK, null-community super_admin fileId cascade, and V1/V2 attachment coexistence', async () => {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      runSqliteMigrations(sqlite);
      seedCoreFixtures(sqlite);

      const db = drizzle(sqlite);
      const now = new Date(1_795_003_200_000);
      const community1FileId = '11111111-1111-4111-8111-111111111111';
      const superAdminFileId = '22222222-2222-4222-8222-222222222222';

      await db.insert(filesSqlite).values([
        {
          id: community1FileId,
          filename: 'c1.jpg',
          originalName: 'c1.jpg',
          path: 'communities/1/c1.jpg',
          storageKey: 'communities/1/c1.jpg',
          url: '/v2/media/' + community1FileId,
          mimeType: 'image/jpeg',
          size: 512,
          byteSize: 512,
          checksum: 'sha256:abc',
          communityId: 1,
          uploadedBy: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: superAdminFileId,
          filename: 'super.jpg',
          originalName: 'super.jpg',
          path: 'users/1/super.jpg',
          storageKey: 'users/1/super.jpg',
          url: '/v2/media/' + superAdminFileId,
          mimeType: 'image/jpeg',
          size: 256,
          byteSize: 256,
          checksum: 'sha256:def',
          communityId: null,
          uploadedBy: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // Cross-tenant attachment referencing Community 1's file from Community 2 MUST FAIL
      await expect(
        db.insert(attachmentsSqlite).values({
          communityId: 2,
          fileId: community1FileId,
          ownerType: 'story',
          ownerId: 10,
          role: 'story_media',
          ordinal: 0,
          createdAt: now,
        })
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);

      // Same-community attachment succeeds
      await db.insert(attachmentsSqlite).values({
        communityId: 1,
        fileId: community1FileId,
        ownerType: 'story',
        ownerId: 10,
        role: 'story_media',
        ordinal: 0,
        createdAt: now,
      });

      // Null-community super_admin attachment with nonexistent fileId MUST FAIL via single-col FK
      await expect(
        db.insert(attachmentsSqlite).values({
          communityId: null,
          fileId: '99999999-9999-4999-8999-999999999999',
          ownerType: 'user',
          ownerId: 1,
          role: 'user_photo',
          ordinal: 0,
          createdAt: now,
        })
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);

      // Null-community super_admin user_photo attachment succeeds
      await db.insert(attachmentsSqlite).values({
        communityId: null,
        fileId: superAdminFileId,
        ownerType: 'user',
        ownerId: 1,
        role: 'user_photo',
        ordinal: 0,
        createdAt: now,
      });

      // V1 legacy attachment insert (without canonical columns) coexists cleanly
      await db.insert(attachmentsSqlite).values({
        attachableId: 10,
        attachableType: 'Story',
        url: 'https://legacy.example.org/file.jpg',
        filename: 'file.jpg',
        contentType: 'image/jpeg',
        fileSize: 900,
        createdAt: now,
      });

      // Deleting null-community super_admin file MUST CASCADE and delete its attachment
      await db.delete(filesSqlite).where(eq(filesSqlite.id, superAdminFileId));

      const remaining = await db.select().from(attachmentsSqlite);
      expect(remaining.map((r) => r.fileId)).toEqual([community1FileId, null]);

      sqlite.close();
    });

    it('enforces community_map_configs 1:1 PK, composite static_map_file_id FK, and external_media_links composite FK/cascade', async () => {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      runSqliteMigrations(sqlite);
      seedCoreFixtures(sqlite);

      const db = drizzle(sqlite);
      const now = new Date(1_795_003_200_000);
      const community1MapFileId = '33333333-3333-4333-8333-333333333333';
      const community2MapFileId = '44444444-4444-4444-8444-444444444444';

      await db.insert(filesSqlite).values([
        {
          id: community1MapFileId,
          filename: 'map1.png',
          originalName: 'map1.png',
          path: 'communities/1/map1.png',
          storageKey: 'communities/1/map1.png',
          url: '/v2/media/' + community1MapFileId,
          mimeType: 'image/png',
          size: 2048,
          byteSize: 2048,
          communityId: 1,
          uploadedBy: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: community2MapFileId,
          filename: 'map2.png',
          originalName: 'map2.png',
          path: 'communities/2/map2.png',
          storageKey: 'communities/2/map2.png',
          url: '/v2/media/' + community2MapFileId,
          mimeType: 'image/png',
          size: 2048,
          byteSize: 2048,
          communityId: 2,
          uploadedBy: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // Cross-tenant staticMapFileId rejected by composite FK
      await expect(
        db.insert(communityMapConfigsSqlite).values({
          communityId: 1,
          staticMapFileId: community2MapFileId,
          centerLatitude: -3.4653,
          centerLongitude: -62.2159,
          createdAt: now,
          updatedAt: now,
        })
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);

      // Valid 1:1 map config with same-community static map file + provider-neutral fields
      await db.insert(communityMapConfigsSqlite).values({
        communityId: 1,
        basemapStyle: 'outdoors',
        centerLatitude: -3.4653,
        centerLongitude: -62.2159,
        southWestLatitude: -4.0,
        southWestLongitude: -63.0,
        northEastLatitude: -2.9,
        northEastLongitude: -61.5,
        zoom: 9.5,
        pitch: 15.0,
        bearing: 0.0,
        threeDimensional: false,
        projection: 'mercator',
        staticMapFileId: community1MapFileId,
        createdAt: now,
        updatedAt: now,
      });

      // Duplicate community_id rejected (1:1 primary key)
      await expect(
        db.insert(communityMapConfigsSqlite).values({
          communityId: 1,
          basemapStyle: 'satellite',
          createdAt: now,
          updatedAt: now,
        })
      ).rejects.toThrow(/UNIQUE constraint failed/);

      // Nullable fields preserved on minimal config for community 2
      await db.insert(communityMapConfigsSqlite).values({
        communityId: 2,
        createdAt: now,
        updatedAt: now,
      });
      const [c2Config] = await db
        .select()
        .from(communityMapConfigsSqlite)
        .where(eq(communityMapConfigsSqlite.communityId, 2));
      expect(c2Config.centerLatitude).toBeNull();
      expect(c2Config.staticMapFileId).toBeNull();

      // ExternalMediaLink: cross-community (communityId: 2, storyId: 10) MUST FAIL
      await expect(
        db.insert(externalMediaLinksSqlite).values({
          communityId: 2,
          storyId: 10,
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          ordinal: 0,
          createdAt: now,
        })
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);

      // Valid external media links + story deletion cascade
      await db.insert(externalMediaLinksSqlite).values([
        {
          communityId: 1,
          storyId: 10,
          url: 'https://vimeo.com/123456',
          ordinal: 0,
          createdAt: now,
        },
        {
          communityId: 1,
          storyId: 10,
          url: 'https://www.youtube.com/watch?v=abc123',
          ordinal: 1,
          createdAt: now,
        },
      ]);

      await db.delete(storiesSqlite).where(eq(storiesSqlite.id, 10));
      expect(await db.select().from(externalMediaLinksSqlite)).toHaveLength(0);

      sqlite.close();
    });
  });

  describe('Upgrade backfill and sqlite_sequence preservation', () => {
    it('backfills files and community_media -> attachments while keeping community_media intact and preserving sqlite_sequence even after deleting the max id row', () => {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      runSqliteMigrations(sqlite, { upToPrefixInclusive: '0009' });
      seedCoreFixtures(sqlite);

      const fileA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const fileB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const tA = 1_795_000_001_000;
      const tB = 1_795_000_002_000;

      // Seed files in pre-0010 state
      sqlite
        .prepare(
          `INSERT INTO files (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fileB,
          'b.png',
          'b.png',
          'uploads/1/b.png',
          '/v2/media/' + fileB,
          'image/png',
          222,
          1,
          2,
          tB,
          tB
        );
      sqlite
        .prepare(
          `INSERT INTO files (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fileA,
          'a.png',
          'a.png',
          'uploads/1/a.png',
          '/v2/media/' + fileA,
          'image/png',
          111,
          1,
          2,
          tA,
          tA
        );

      // Seed community_media branding rows
      sqlite
        .prepare(
          `INSERT INTO community_media (file_id, community_id, kind) VALUES (?, ?, 'branding')`
        )
        .run(fileB, 1);
      sqlite
        .prepare(
          `INSERT INTO community_media (file_id, community_id, kind) VALUES (?, ?, 'branding')`
        )
        .run(fileA, 1);

      // Seed 3 V1 attachments and delete id=3 so max(id)=2 while sqlite_sequence.seq=3
      for (let i = 1; i <= 3; i++) {
        sqlite
          .prepare(
            `INSERT INTO attachments (attachable_id, attachable_type, url, filename, content_type, file_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            10,
            'Story',
            `https://example.org/${i}.jpg`,
            `${i}.jpg`,
            'image/jpeg',
            100,
            tA
          );
      }
      sqlite.prepare(`DELETE FROM attachments WHERE id = 3`).run();

      // Apply 0010
      runSqliteMigrations(sqlite, {
        onlyFile: '0010_canonical_media_and_map_configs.sql',
      });

      const db = drizzle(sqlite);

      // 1. files storage_key & byte_size backfilled
      const fileRows = db.select().from(filesSqlite).all();
      for (const f of fileRows) {
        expect(f.storageKey).toBe(f.path);
        expect(f.byteSize).toBe(f.size);
        expect(f.checksum).toBeNull();
      }

      // 2. community_media rows preserved for /v2/media and /explore/media coexistence
      expect(db.select().from(communityMediaSqlite).all()).toHaveLength(2);

      // 3. attachments has V1 ids 1 & 2, plus backfilled community_media starting at id=4 (> seq=3)
      const attRows = sqlite
        .prepare(
          `SELECT id, community_id, file_id, owner_type, owner_id, role, ordinal, url, created_at
           FROM attachments ORDER BY id`
        )
        .all() as Array<{
        id: number;
        community_id: number | null;
        file_id: string | null;
        owner_type: string | null;
        owner_id: number | null;
        role: string | null;
        ordinal: number | null;
        url: string | null;
        created_at: number;
      }>;

      expect(attRows.map((r) => r.id)).toEqual([1, 2, 4, 5]);
      expect(attRows[2]).toMatchObject({
        id: 4,
        community_id: 1,
        file_id: fileA,
        owner_type: 'community',
        owner_id: 1,
        role: 'community_display_image',
        ordinal: 0,
        url: null,
        created_at: tA,
      });
      expect(attRows[3]).toMatchObject({
        id: 5,
        community_id: 1,
        file_id: fileB,
        owner_type: 'community',
        owner_id: 1,
        role: 'community_display_image',
        ordinal: 1,
        url: null,
        created_at: tB,
      });

      // sqlite_sequence has exactly one row per name, seq=5 for attachments, and no *_old residue
      const seqRows = sqlite
        .prepare(
          `SELECT name, seq FROM sqlite_sequence WHERE name = 'attachments'`
        )
        .all() as Array<{ name: string; seq: number }>;
      expect(seqRows).toEqual([{ name: 'attachments', seq: 5 }]);

      const duplicateSeqRows = sqlite
        .prepare(
          `SELECT name, count(*) AS cnt FROM sqlite_sequence GROUP BY name HAVING count(*) > 1`
        )
        .all();
      expect(duplicateSeqRows).toEqual([]);

      const oldSeqRows = sqlite
        .prepare(`SELECT name FROM sqlite_sequence WHERE name LIKE '%_old'`)
        .all();
      expect(oldSeqRows).toEqual([]);

      sqlite.close();
    });

    it('preserves sqlite_sequence even when all pre-0010 attachments rows were deleted prior to 0010', () => {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      runSqliteMigrations(sqlite, { upToPrefixInclusive: '0009' });
      seedCoreFixtures(sqlite);

      const fileA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const now = 1_795_000_005_000;

      for (let i = 1; i <= 5; i++) {
        sqlite
          .prepare(
            `INSERT INTO attachments (attachable_id, attachable_type, url, filename, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(10, 'Story', `https://example.org/${i}.jpg`, `${i}.jpg`, now);
      }
      sqlite.prepare(`DELETE FROM attachments`).run();

      sqlite
        .prepare(
          `INSERT INTO files (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          fileA,
          'c.png',
          'c.png',
          'uploads/1/c.png',
          '/v2/media/' + fileA,
          'image/png',
          50,
          1,
          2,
          now,
          now
        );
      sqlite
        .prepare(
          `INSERT INTO community_media (file_id, community_id, kind) VALUES (?, ?, 'branding')`
        )
        .run(fileA, 1);

      runSqliteMigrations(sqlite, {
        onlyFile: '0010_canonical_media_and_map_configs.sql',
      });

      const attRows = sqlite
        .prepare(`SELECT id, file_id FROM attachments ORDER BY id`)
        .all() as Array<{ id: number; file_id: string }>;
      expect(attRows).toEqual([{ id: 6, file_id: fileA }]);

      const seqRows = sqlite
        .prepare(
          `SELECT name, seq FROM sqlite_sequence WHERE name = 'attachments'`
        )
        .all() as Array<{ name: string; seq: number }>;
      expect(seqRows).toEqual([{ name: 'attachments', seq: 6 }]);

      expect(
        sqlite
          .prepare(
            `SELECT name, count(*) AS cnt FROM sqlite_sequence GROUP BY name HAVING count(*) > 1`
          )
          .all()
      ).toEqual([]);
      expect(
        sqlite
          .prepare(`SELECT name FROM sqlite_sequence WHERE name LIKE '%_old'`)
          .all()
      ).toEqual([]);

      sqlite.close();
    });

    it('applies 0010 cleanly in Miniflare D1 and preserves sqlite_sequence', async () => {
      const mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: ['DB'],
      });

      try {
        const d1 = await mf.getD1Database('DB');

        const execFileOnD1 = async (file: string) => {
          const sqlContent = readFileSync(
            path.join(SQLITE_MIGRATIONS_DIR, file),
            'utf8'
          );
          for (const stmt of splitMigrationStatements(sqlContent)) {
            await d1.prepare(stmt).run();
          }
        };

        for (const file of getOrderedSqliteMigrationFiles()) {
          if (file.slice(0, 4) > '0009') break;
          await execFileOnD1(file);
        }

        const now = 1_795_003_200_000;
        const fileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        await d1
          .prepare(
            `INSERT INTO communities (id, name, slug, created_at, updated_at) VALUES (1, 'D1 Comm', 'd1-comm', ?, ?)`
          )
          .bind(now, now)
          .run();
        await d1
          .prepare(
            `INSERT INTO users (id, email, password_hash, first_name, last_name, role, community_id, created_at, updated_at)
             VALUES (1, 'd1@example.org', 'hash', 'D1', 'User', 'editor', 1, ?, ?)`
          )
          .bind(now, now)
          .run();
        await d1
          .prepare(
            `INSERT INTO files (id, filename, original_name, path, url, mime_type, size, community_id, uploaded_by, created_at, updated_at)
             VALUES (?, 'd1.png', 'd1.png', 'uploads/1/d1.png', '/v2/media/' || ?, 'image/png', 77, 1, 1, ?, ?)`
          )
          .bind(fileId, fileId, now, now)
          .run();
        await d1
          .prepare(
            `INSERT INTO community_media (file_id, community_id, kind) VALUES (?, 1, 'branding')`
          )
          .bind(fileId)
          .run();
        await d1
          .prepare(
            `INSERT INTO attachments (attachable_id, attachable_type, url, filename, created_at) VALUES (1, 'Story', 'https://a.org/1', '1.jpg', ?)`
          )
          .bind(now)
          .run();
        await d1
          .prepare(
            `INSERT INTO attachments (attachable_id, attachable_type, url, filename, created_at) VALUES (1, 'Story', 'https://a.org/2', '2.jpg', ?)`
          )
          .bind(now)
          .run();
        await d1.prepare(`DELETE FROM attachments WHERE id = 2`).run();

        await execFileOnD1('0010_canonical_media_and_map_configs.sql');

        const result = await d1
          .prepare(`SELECT id, file_id, role FROM attachments ORDER BY id`)
          .all<{ id: number; file_id: string | null; role: string | null }>();

        expect(result.results).toEqual([
          { id: 1, file_id: null, role: null },
          { id: 3, file_id: fileId, role: 'community_display_image' },
        ]);

        const seqRows = await d1
          .prepare(
            `SELECT name, seq FROM sqlite_sequence WHERE name = 'attachments'`
          )
          .all<{ name: string; seq: number }>();
        expect(seqRows.results).toEqual([{ name: 'attachments', seq: 3 }]);

        const dupSeqRows = await d1
          .prepare(
            `SELECT name, count(*) AS cnt FROM sqlite_sequence GROUP BY name HAVING count(*) > 1`
          )
          .all();
        expect(dupSeqRows.results).toEqual([]);

        const oldSeqRows = await d1
          .prepare(`SELECT name FROM sqlite_sequence WHERE name LIKE '%_old'`)
          .all();
        expect(oldSeqRows.results).toEqual([]);
      } finally {
        await mf.dispose();
      }
    });
  });
});
