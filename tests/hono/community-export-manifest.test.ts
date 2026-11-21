import { afterEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { tablesFor } from '../../src/db/dialect.js';
import {
  communityMediaSqlite,
  sessionsSqlite,
  authThrottleSqlite,
} from '../../src/db/schema/sessions.js';
import { CommunityExportRepository } from '../../src/repositories/community-export.repository.js';
import { buildCommunityExportManifest } from '../../src/services/community-export-manifest.js';
import {
  COMMUNITY_EXPORT_FORMAT_VERSION,
  COMMUNITY_EXPORT_SCHEMA_VERSION,
  EXPORT_AUDIT_ACTIONS,
  exportArchivePathForFile,
} from '../../src/shared/export-policy.js';
import { writeAuditEntry } from '../../src/repositories/audit-entry.repository.js';
import { argon2Seed, makeDerivedKey } from './auth-test-utils.js';

describe('Slice 13a deterministic community export manifest builder', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  async function seedRichCommunity(options: { communityIsActive: boolean }) {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const tables = tablesFor(db);
    const t0 = new Date('2026-11-21T08:00:00.000Z');
    const t1 = new Date('2026-11-21T09:00:00.000Z');

    // Target community (active or disabled) + a second foreign community.
    db.insert(tables.communities)
      .values([
        {
          id: 1,
          name: 'Target Nation',
          description: '<p>Target desc</p>',
          descriptionPlain: 'Target desc',
          slug: 'target-nation',
          publicStories: false,
          locale: 'en',
          country: 'BR',
          isActive: options.communityIsActive,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 2,
          name: 'Foreign Nation',
          description: '<p>Foreign desc</p>',
          descriptionPlain: 'Foreign desc',
          slug: 'foreign-nation',
          publicStories: true,
          locale: 'en',
          country: 'BR',
          isActive: true,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    const adminCreds = await argon2Seed(makeDerivedKey());
    const foreignCreds = await argon2Seed(makeDerivedKey());
    const superAdminCreds = await argon2Seed(makeDerivedKey());

    db.insert(tables.users)
      .values([
        {
          id: 10,
          email: 'admin@target.test',
          emailNormalized: 'admin@target.test',
          username: 'target_admin',
          usernameNormalized: 'target_admin',
          displayName: 'Target Admin',
          firstName: 'Target',
          lastName: 'Admin',
          ...adminCreds,
          role: 'admin',
          communityId: 1,
          isActive: true,
          resetPasswordToken: 'secret-reset-token-123',
          currentSignInIp: '198.51.100.1',
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 20,
          email: 'foreign@other.test',
          emailNormalized: 'foreign@other.test',
          username: 'foreign_admin',
          usernameNormalized: 'foreign_admin',
          displayName: 'Foreign Admin',
          firstName: 'Foreign',
          lastName: 'Admin',
          ...foreignCreds,
          role: 'admin',
          communityId: 2,
          isActive: true,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 30,
          email: 'super@system.test',
          emailNormalized: 'super@system.test',
          username: 'sys_super',
          usernameNormalized: 'sys_super',
          displayName: 'System Super',
          firstName: 'System',
          lastName: 'Super',
          ...superAdminCreds,
          role: 'super_admin',
          communityId: null,
          isActive: true,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    // Sessions & throttles must never appear in exported manifest.
    db.insert(sessionsSqlite)
      .values({
        id: 'sess-target',
        tokenHash: 'e'.repeat(64),
        userId: 10,
        expiresAt: t0.getTime() + 3600_000,
        kind: 'standard',
      })
      .run();
    db.insert(authThrottleSqlite)
      .values({
        key: 'account:10',
        kind: 'account',
        communityId: 1,
        failures: 3,
        windowStartedAt: t0.getTime(),
      })
      .run();

    // Places (including #162 restricted place)
    db.insert(tables.places)
      .values([
        {
          id: 101,
          name: 'Open Creek',
          communityId: 1,
          latitude: -3.1,
          longitude: -60.02,
          isRestricted: false,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 102,
          name: 'Restricted Sacred Site',
          communityId: 1,
          latitude: null,
          longitude: null,
          isRestricted: true,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 201,
          name: 'Foreign Place',
          communityId: 2,
          latitude: 1,
          longitude: 1,
          isRestricted: false,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    db.insert(tables.speakers)
      .values([
        {
          id: 301,
          name: 'Speaker One',
          communityId: 1,
          birthDate: '1950-05-01',
          birthplaceId: 102,
          affiliation: 'River Guild',
          isActive: true,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 302,
          name: 'Foreign Speaker',
          communityId: 2,
          isActive: true,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    // Stories: public, restricted (#162), unknown privacy (#162), and foreign
    db.insert(tables.stories)
      .values([
        {
          id: 401,
          title: 'Public Story',
          description: '<p>Hello</p>',
          descriptionPlain: 'Hello',
          slug: 'public-story',
          communityId: 1,
          createdBy: 10,
          isRestricted: false,
          privacyLevel: 'public',
          topic: 'Water',
          topicNormalized: 'water',
          language: 'en',
          interviewLocationId: 101,
          interviewerId: 301,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 402,
          title: 'Restricted Story 162',
          description: '<p>Hidden #162</p>',
          descriptionPlain: 'Hidden #162',
          slug: 'restricted-story-162',
          communityId: 1,
          createdBy: 10,
          isRestricted: true,
          privacyLevel: 'public',
          language: 'en',
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 403,
          title: 'Unknown Privacy Story 162',
          slug: 'unknown-privacy-162',
          communityId: 1,
          createdBy: 10,
          isRestricted: false,
          privacyLevel: 'legacy_custom',
          language: 'en',
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 404,
          title: 'Foreign Story',
          slug: 'foreign-story',
          communityId: 2,
          createdBy: 20,
          isRestricted: false,
          privacyLevel: 'public',
          language: 'en',
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    // Multiplicity preserved on story_places & story_speakers
    db.insert(tables.storyPlaces)
      .values([
        {
          id: 501,
          communityId: 1,
          storyId: 401,
          placeId: 101,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 502,
          communityId: 1,
          storyId: 401,
          placeId: 101,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 503,
          communityId: 2,
          storyId: 404,
          placeId: 201,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    db.insert(tables.storySpeakers)
      .values([
        {
          id: 601,
          communityId: 1,
          storyId: 402,
          speakerId: 301,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: 602,
          communityId: 2,
          storyId: 404,
          speakerId: 302,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    const attachedFileId = '11111111-1111-4111-8111-111111111111';
    const stagingFileId = '22222222-2222-4222-8222-222222222222';
    const staticMapFileId = '33333333-3333-4333-8333-333333333333';
    const foreignFileId = '44444444-4444-4444-8444-444444444444';
    const superAdminPhotoId = '55555555-5555-4555-8555-555555555555';

    db.insert(tables.files)
      .values([
        {
          id: attachedFileId,
          filename: 'story.png',
          originalName: 'story.png',
          path: `communities/1/${attachedFileId}.png`,
          storageKey: `communities/1/${attachedFileId}.png`,
          url: `/v2/media/${attachedFileId}`,
          mimeType: 'image/png',
          size: 8,
          byteSize: 8,
          checksum: 'a'.repeat(64),
          communityId: 1,
          uploadedBy: 10,
          culturalRestrictions: JSON.stringify({ accessLevel: 'family' }),
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: stagingFileId,
          filename: 'staging.png',
          originalName: 'staging.png',
          path: `communities/1/${stagingFileId}.png`,
          storageKey: `communities/1/${stagingFileId}.png`,
          url: `/v2/media/${stagingFileId}`,
          mimeType: 'image/png',
          size: 4,
          byteSize: 4,
          checksum: 'b'.repeat(64),
          communityId: 1,
          uploadedBy: 10,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: staticMapFileId,
          filename: 'map.png',
          originalName: 'map.png',
          path: `communities/1/${staticMapFileId}.png`,
          storageKey: `communities/1/${staticMapFileId}.png`,
          url: `/v2/media/${staticMapFileId}`,
          mimeType: 'image/png',
          size: 6,
          byteSize: 6,
          checksum: 'c'.repeat(64),
          communityId: 1,
          uploadedBy: 10,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: foreignFileId,
          filename: 'foreign.png',
          originalName: 'foreign.png',
          path: `communities/2/${foreignFileId}.png`,
          storageKey: `communities/2/${foreignFileId}.png`,
          url: `/v2/media/${foreignFileId}`,
          mimeType: 'image/png',
          size: 5,
          byteSize: 5,
          checksum: 'd'.repeat(64),
          communityId: 2,
          uploadedBy: 20,
          createdAt: t0,
          updatedAt: t1,
        },
        {
          id: superAdminPhotoId,
          filename: 'super.png',
          originalName: 'super.png',
          path: `users/30/${superAdminPhotoId}.png`,
          storageKey: `users/30/${superAdminPhotoId}.png`,
          url: `/v2/media/${superAdminPhotoId}`,
          mimeType: 'image/png',
          size: 7,
          byteSize: 7,
          checksum: 'e'.repeat(64),
          communityId: null,
          uploadedBy: 30,
          createdAt: t0,
          updatedAt: t1,
        },
      ])
      .run();

    db.insert(tables.communityMapConfigs)
      .values({
        communityId: 1,
        basemapStyle: 'terrain',
        centerLatitude: -3.1,
        centerLongitude: -60.02,
        staticMapFileId,
        createdAt: t0,
        updatedAt: t1,
      })
      .run();

    db.insert(tables.attachments)
      .values([
        {
          id: 701,
          communityId: 1,
          fileId: attachedFileId,
          ownerType: 'story',
          ownerId: 402,
          role: 'story_media',
          ordinal: 0,
          createdAt: t0,
        },
        {
          id: 702,
          communityId: null,
          fileId: superAdminPhotoId,
          ownerType: 'user',
          ownerId: 30,
          role: 'user_photo',
          ordinal: 0,
          createdAt: t0,
        },
      ])
      .run();

    db.insert(tables.externalMediaLinks)
      .values([
        {
          id: 801,
          communityId: 1,
          storyId: 401,
          url: 'https://media.example.test/watch/1',
          ordinal: 0,
          createdAt: t0,
        },
        {
          id: 802,
          communityId: 2,
          storyId: 404,
          url: 'https://media.example.test/foreign',
          ordinal: 0,
          createdAt: t0,
        },
      ])
      .run();

    db.insert(communityMediaSqlite)
      .values({
        fileId: staticMapFileId,
        communityId: 1,
        kind: 'branding',
      })
      .run();

    // Seed community audit entries (including auth with IP/UA which must be
    // stripped in export, plus claim_token audit) and system/foreign/export audits.
    await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 10,
        action: 'auth.login',
        resourceType: 'session',
        resourceIds: [],
        outcome: 'success',
        ipAddress: '203.0.113.42',
        userAgent: 'Mozilla/5.0 SecretUA',
      },
      t0
    );
    await writeAuditEntry(
      db,
      {
        communityId: 1,
        actorId: 10,
        action: 'claim_token.consume',
        resourceType: 'claim_token',
        resourceIds: [99],
        outcome: 'success',
        ipAddress: null,
        userAgent: null,
      },
      t1
    );
    await writeAuditEntry(
      db,
      {
        communityId: 2,
        actorId: 20,
        action: 'community.visibility.public',
        resourceType: 'community',
        resourceIds: [2],
        outcome: 'success',
      },
      t0
    );
    await writeAuditEntry(
      db,
      {
        communityId: null,
        actorId: 30,
        action: 'system.lifecycle',
        resourceType: 'system',
        resourceIds: [1],
        outcome: 'success',
      },
      t0
    );

    const verifiedFiles = [
      {
        id: attachedFileId,
        storageKey: `communities/1/${attachedFileId}.png`,
        archivePath: exportArchivePathForFile(attachedFileId),
        byteSize: 8,
        checksum: 'a'.repeat(64),
      },
      {
        id: stagingFileId,
        storageKey: `communities/1/${stagingFileId}.png`,
        archivePath: exportArchivePathForFile(stagingFileId),
        byteSize: 4,
        checksum: 'b'.repeat(64),
      },
      {
        id: staticMapFileId,
        storageKey: `communities/1/${staticMapFileId}.png`,
        archivePath: exportArchivePathForFile(staticMapFileId),
        byteSize: 6,
        checksum: 'c'.repeat(64),
      },
    ];

    return {
      db,
      repo: new CommunityExportRepository(db),
      verifiedFiles,
      mediaArchive: {
        checksum: 'f'.repeat(64),
        byteSize: 256,
        fileCount: 3,
      },
      ids: {
        attachedFileId,
        stagingFileId,
        staticMapFileId,
        foreignFileId,
        superAdminPhotoId,
      },
      t1,
    };
  }

  it('exports active community including #162 rows, unattached staging files, multiplicity, and excludes credentials/foreign/null-community data', async () => {
    const { repo, verifiedFiles, mediaArchive, ids } = await seedRichCommunity({
      communityIsActive: true,
    });
    const snapshot = await repo.readCommunityExportSnapshot(1);
    expect(snapshot).not.toBeNull();
    const built = buildCommunityExportManifest(
      snapshot!,
      verifiedFiles,
      mediaArchive
    );

    expect(built.manifest.exportFormatVersion).toBe(
      COMMUNITY_EXPORT_FORMAT_VERSION
    );
    expect(built.manifest.schemaVersion).toBe(COMMUNITY_EXPORT_SCHEMA_VERSION);
    expect(built.manifest.community.status).toBe('active');
    expect(built.manifest.community.visibility).toBe('private');
    expect(built.manifest.mapConfig?.staticMapFileId).toBe(ids.staticMapFileId);
    expect(built.manifest.users).toHaveLength(1);
    expect(built.manifest.users[0]!.id).toBe(10);
    expect(built.manifest.places.map((p) => p.id)).toEqual([101, 102]);
    expect(built.manifest.places[1]!.isRestricted).toBe(true);
    expect(built.manifest.stories.map((s) => s.id)).toEqual([401, 402, 403]);
    expect(built.manifest.stories[1]!.visibility).toBe('hidden');
    expect(built.manifest.stories[1]!.isRestricted).toBe(true);
    expect(built.manifest.stories[1]!.privacyLevel).toBe('public');
    expect(built.manifest.stories[2]!.visibility).toBe('hidden');
    expect(built.manifest.stories[2]!.privacyLevel).toBe('legacy_custom');
    expect(built.manifest.storyPlaces).toHaveLength(2);
    expect(built.manifest.files.map((f) => f.id)).toEqual([
      ids.attachedFileId,
      ids.stagingFileId,
      ids.staticMapFileId,
    ]);
    expect(built.manifest.attachments.map((a) => a.id)).toEqual([701]);
    expect(built.manifest.externalMediaLinks.map((l) => l.id)).toEqual([801]);
    expect(built.manifest.auditEntries.map((e) => e.action)).toEqual([
      'auth.login',
      'claim_token.consume',
    ]);

    // Ensure zero credential material, IP/UA, foreign records, or super_admin records leak
    expect(built.jsonText).not.toContain('passwordHash');
    expect(built.jsonText).not.toContain('passwordVerifier');
    expect(built.jsonText).not.toContain('passwordSalt');
    expect(built.jsonText).not.toContain('secret-reset-token-123');
    expect(built.jsonText).not.toContain('198.51.100.1');
    expect(built.jsonText).not.toContain('203.0.113.42');
    expect(built.jsonText).not.toContain('SecretUA');
    expect(built.jsonText).not.toContain(ids.foreignFileId);
    expect(built.jsonText).not.toContain(ids.superAdminPhotoId);
    expect(built.jsonText).not.toContain('foreign@other.test');
    expect(built.jsonText).not.toContain('super@system.test');
  });

  it('produces byte-identical re-exports even after export-lifecycle audit entries are written, and supports disabled communities', async () => {
    const { db, repo, verifiedFiles, mediaArchive, t1 } =
      await seedRichCommunity({
        communityIsActive: false,
      });

    const snap1 = await repo.readCommunityExportSnapshot(1);
    expect(snap1).not.toBeNull();
    const first = buildCommunityExportManifest(
      snap1!,
      verifiedFiles,
      mediaArchive
    );
    expect(first.manifest.community.status).toBe('disabled');
    expect(first.manifest.stories).toHaveLength(3);

    // Emit export lifecycle audit entries as real requests would.
    for (const action of Object.values(EXPORT_AUDIT_ACTIONS)) {
      await writeAuditEntry(
        db,
        {
          communityId: 1,
          actorId: 10,
          action,
          resourceType: 'community_export',
          resourceIds: ['job-abc'],
          outcome: 'success',
        },
        new Date(t1.getTime() + 60_000)
      );
    }

    const snap2 = await repo.readCommunityExportSnapshot(1);
    const second = buildCommunityExportManifest(
      snap2!,
      verifiedFiles,
      mediaArchive
    );

    expect(second.checksum).toBe(first.checksum);
    expect(second.byteSize).toBe(first.byteSize);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(
      true
    );
  });
});
