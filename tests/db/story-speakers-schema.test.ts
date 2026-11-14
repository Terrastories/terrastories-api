import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '../../src/db/index.js';
import {
  migrateInMemorySqlite,
  sqliteColumn,
  sqliteForeignKeyGroups,
} from '../helpers/tenant-fk-probe.js';
import {
  getStorySpeakersTable,
  storySpeakersPg,
  storySpeakersSqlite,
  storySpeakersRelations,
  storySpeakersSqliteRelations,
  insertStorySpeakerSchema,
  selectStorySpeakerSchema,
  createStorySpeakerSchema,
  type StorySpeaker,
  type NewStorySpeaker,
  type CreateStorySpeaker,
} from '../../src/db/schema/story_speakers.js';

describe('Story Speakers Schema', () => {
  let db: any;

  beforeAll(async () => {
    db = await getDb();
  });

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Multi-Database Support', () => {
    it('should export PostgreSQL table definition', () => {
      expect(storySpeakersPg).toBeDefined();
      expect(typeof storySpeakersPg).toBe('object');
    });

    it('should export SQLite table definition', () => {
      expect(storySpeakersSqlite).toBeDefined();
      expect(typeof storySpeakersSqlite).toBe('object');
    });

    it('should have getStorySpeakersTable function for runtime selection', async () => {
      expect(getStorySpeakersTable).toBeDefined();
      expect(typeof getStorySpeakersTable).toBe('function');

      const table = await getStorySpeakersTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');
    });
  });

  describe('Schema Structure', () => {
    it('should have correct table structure', () => {
      expect(storySpeakersPg).toBeDefined();
      expect(storySpeakersSqlite).toBeDefined();
    });

    it('should have required columns', () => {
      // Just check that the tables have the expected structure
      expect(storySpeakersPg).toHaveProperty('id');
      expect(storySpeakersPg).toHaveProperty('communityId');
      expect(storySpeakersPg).toHaveProperty('storyId');
      expect(storySpeakersPg).toHaveProperty('speakerId');
      expect(storySpeakersPg).toHaveProperty('createdAt');
      expect(storySpeakersPg).toHaveProperty('updatedAt');
    });

    it('should support both PostgreSQL and SQLite', () => {
      expect(typeof storySpeakersPg).toBe('object');
      expect(typeof storySpeakersSqlite).toBe('object');
    });
  });

  describe('Relations', () => {
    it('should export story speakers relations', () => {
      expect(storySpeakersRelations).toBeDefined();
      expect(typeof storySpeakersRelations).toBe('object');
    });

    it('should export SQLite relations', () => {
      expect(storySpeakersSqliteRelations).toBeDefined();
      expect(typeof storySpeakersSqliteRelations).toBe('object');
    });
  });

  describe('Zod Validation Schemas', () => {
    const validStorySpeaker = {
      id: 1,
      communityId: 2,
      storyId: 5,
      speakerId: 2,
      storyRole: 'Primary storyteller',
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const validCreateStorySpeaker = {
      communityId: 2,
      storyId: 5,
      speakerId: 2,
      storyRole: 'Primary storyteller',
      sortOrder: 0,
    };

    it('should validate valid insert story speaker data', () => {
      const result = insertStorySpeakerSchema.safeParse(validStorySpeaker);
      expect(result.success).toBe(true);
    });

    it('should validate valid select story speaker data', () => {
      const result = selectStorySpeakerSchema.safeParse(validStorySpeaker);
      expect(result.success).toBe(true);
    });

    it('should validate valid create story speaker data', () => {
      const result = createStorySpeakerSchema.safeParse(
        validCreateStorySpeaker
      );
      expect(result.success).toBe(true);
    });

    it('should reject invalid story ID', () => {
      const invalid = { ...validCreateStorySpeaker, storyId: 'invalid' };
      const result = createStorySpeakerSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject invalid speaker ID', () => {
      const invalid = { ...validCreateStorySpeaker, speakerId: 'invalid' };
      const result = createStorySpeakerSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject missing story ID', () => {
      const invalid = { speakerId: 2 };
      const result = createStorySpeakerSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject missing speaker ID', () => {
      const invalid = { storyId: 5 };
      const result = createStorySpeakerSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('TypeScript Types', () => {
    it('should infer correct StorySpeaker type', () => {
      const storySpeaker: StorySpeaker = {
        id: 1,
        communityId: 2,
        storyId: 5,
        speakerId: 2,
        storyRole: 'Primary storyteller',
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(storySpeaker).toBeDefined();
    });

    it('should infer correct NewStorySpeaker type', () => {
      const newStorySpeaker: NewStorySpeaker = {
        communityId: 2,
        storyId: 5,
        speakerId: 2,
        storyRole: 'Primary storyteller',
        sortOrder: 0,
      };
      expect(newStorySpeaker).toBeDefined();
    });

    it('should infer correct CreateStorySpeaker type', () => {
      const createStorySpeaker: CreateStorySpeaker = {
        communityId: 2,
        storyId: 5,
        speakerId: 2,
        storyRole: 'Primary storyteller',
        sortOrder: 0,
      };
      expect(createStorySpeaker).toBeDefined();
    });
  });

  describe('Constraints and Indexes', () => {
    it('should have table constraints defined', () => {
      expect(storySpeakersPg).toBeDefined();
      expect(storySpeakersSqlite).toBeDefined();
      // Unique constraints are defined in table creation
    });
  });

  // #186: assertions run against a database that applied the repository's
  // SQLite migrations, so they prove the applied schema, not the Drizzle
  // objects (the dual-backend gate in scripts/test-db-backend.ts covers the
  // same contract on PostgreSQL and on upgraded databases).
  describe('Composite Tenant Foreign Keys (migrated database)', () => {
    let sqlite: Awaited<ReturnType<typeof migrateInMemorySqlite>>;

    beforeAll(async () => {
      sqlite = await migrateInMemorySqlite();
    });

    afterAll(() => {
      sqlite.close();
    });

    it('should carry the NOT NULL community_id tenant column', () => {
      const column = sqliteColumn(sqlite, 'story_speakers', 'community_id');
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(1);
    });

    it('should reference stories(community_id, id) and speakers(community_id, id) on delete cascade', () => {
      const foreignKeys = sqliteForeignKeyGroups(sqlite, 'story_speakers');
      expect(foreignKeys).toContainEqual({
        table: 'stories',
        from: ['community_id', 'story_id'],
        to: ['community_id', 'id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      });
      expect(foreignKeys).toContainEqual({
        table: 'speakers',
        from: ['community_id', 'speaker_id'],
        to: ['community_id', 'id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      });
    });
  });
});
