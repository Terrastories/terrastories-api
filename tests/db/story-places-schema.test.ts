import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '../../src/db/index.js';
import {
  migrateInMemorySqlite,
  sqliteColumn,
  sqliteForeignKeyGroups,
} from '../helpers/tenant-fk-probe.js';
import {
  getStoryPlacesTable,
  storyPlacesPg,
  storyPlacesSqlite,
  storyPlacesRelations,
  storyPlacesSqliteRelations,
  insertStoryPlaceSchema,
  selectStoryPlaceSchema,
  createStoryPlaceSchema,
  type StoryPlace,
  type NewStoryPlace,
  type CreateStoryPlace,
} from '../../src/db/schema/story_places.js';

describe('Story Places Schema', () => {
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
      expect(storyPlacesPg).toBeDefined();
      expect(typeof storyPlacesPg).toBe('object');
    });

    it('should export SQLite table definition', () => {
      expect(storyPlacesSqlite).toBeDefined();
      expect(typeof storyPlacesSqlite).toBe('object');
    });

    it('should have getStoryPlacesTable function for runtime selection', async () => {
      expect(getStoryPlacesTable).toBeDefined();
      expect(typeof getStoryPlacesTable).toBe('function');

      const table = await getStoryPlacesTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');
    });
  });

  describe('Schema Structure', () => {
    it('should have correct table structure', () => {
      expect(storyPlacesPg).toBeDefined();
      expect(storyPlacesSqlite).toBeDefined();
    });

    it('should have required columns', () => {
      // Just check that the tables have the expected structure
      expect(storyPlacesPg).toHaveProperty('id');
      expect(storyPlacesPg).toHaveProperty('communityId');
      expect(storyPlacesPg).toHaveProperty('storyId');
      expect(storyPlacesPg).toHaveProperty('placeId');
      expect(storyPlacesPg).toHaveProperty('createdAt');
      expect(storyPlacesPg).toHaveProperty('updatedAt');
    });

    it('should support both PostgreSQL and SQLite', () => {
      expect(typeof storyPlacesPg).toBe('object');
      expect(typeof storyPlacesSqlite).toBe('object');
    });
  });

  describe('Relations', () => {
    it('should export story places relations', () => {
      expect(storyPlacesRelations).toBeDefined();
      expect(typeof storyPlacesRelations).toBe('object');
    });

    it('should export SQLite relations', () => {
      expect(storyPlacesSqliteRelations).toBeDefined();
      expect(typeof storyPlacesSqliteRelations).toBe('object');
    });
  });

  describe('Zod Validation Schemas', () => {
    const validStoryPlace = {
      id: 1,
      communityId: 2,
      storyId: 5,
      placeId: 3,
      culturalContext: 'A sacred site for ceremony',
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const validCreateStoryPlace = {
      communityId: 2,
      storyId: 5,
      placeId: 3,
      culturalContext: 'A sacred site for ceremony',
      sortOrder: 0,
    };

    it('should validate valid insert story place data', () => {
      const result = insertStoryPlaceSchema.safeParse(validStoryPlace);
      expect(result.success).toBe(true);
    });

    it('should validate valid select story place data', () => {
      const result = selectStoryPlaceSchema.safeParse(validStoryPlace);
      expect(result.success).toBe(true);
    });

    it('should validate valid create story place data', () => {
      const result = createStoryPlaceSchema.safeParse(validCreateStoryPlace);
      expect(result.success).toBe(true);
    });

    it('should reject invalid story ID', () => {
      const invalid = { ...validCreateStoryPlace, storyId: 'invalid' };
      const result = createStoryPlaceSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject invalid place ID', () => {
      const invalid = { ...validCreateStoryPlace, placeId: 'invalid' };
      const result = createStoryPlaceSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject missing story ID', () => {
      const invalid = { placeId: 3 };
      const result = createStoryPlaceSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject missing place ID', () => {
      const invalid = { storyId: 5 };
      const result = createStoryPlaceSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('TypeScript Types', () => {
    it('should infer correct StoryPlace type', () => {
      const storyPlace: StoryPlace = {
        id: 1,
        communityId: 2,
        storyId: 5,
        placeId: 3,
        culturalContext: 'A sacred site for ceremony',
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(storyPlace).toBeDefined();
    });

    it('should infer correct NewStoryPlace type', () => {
      const newStoryPlace: NewStoryPlace = {
        communityId: 2,
        storyId: 5,
        placeId: 3,
        culturalContext: 'A sacred site for ceremony',
        sortOrder: 0,
      };
      expect(newStoryPlace).toBeDefined();
    });

    it('should infer correct CreateStoryPlace type', () => {
      const createStoryPlace: CreateStoryPlace = {
        communityId: 2,
        storyId: 5,
        placeId: 3,
        culturalContext: 'A sacred site for ceremony',
        sortOrder: 0,
      };
      expect(createStoryPlace).toBeDefined();
    });
  });

  describe('Constraints and Indexes', () => {
    it('should have table constraints defined', () => {
      expect(storyPlacesPg).toBeDefined();
      expect(storyPlacesSqlite).toBeDefined();
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
      const column = sqliteColumn(sqlite, 'story_places', 'community_id');
      expect(column).toBeDefined();
      expect(column?.notnull).toBe(1);
    });

    it('should reference stories(community_id, id) and places(community_id, id) on delete cascade', () => {
      const foreignKeys = sqliteForeignKeyGroups(sqlite, 'story_places');
      expect(foreignKeys).toContainEqual({
        table: 'stories',
        from: ['community_id', 'story_id'],
        to: ['community_id', 'id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      });
      expect(foreignKeys).toContainEqual({
        table: 'places',
        from: ['community_id', 'place_id'],
        to: ['community_id', 'id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      });
    });
  });
});
