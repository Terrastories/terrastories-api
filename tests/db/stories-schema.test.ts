import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '../../src/db/index.js';
import {
  getStoriesTable,
  storiesPg,
  storiesSqlite,
  storiesRelations,
  insertStorySchema,
  selectStorySchema,
  createStorySchema,
  updateStorySchema,
  type Story,
  type NewStory,
} from '../../src/db/schema/stories.js';

describe('Stories Schema', () => {
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
      expect(storiesPg).toBeDefined();
      expect(typeof storiesPg).toBe('object');
    });

    it('should export SQLite table definition', () => {
      expect(storiesSqlite).toBeDefined();
      expect(typeof storiesSqlite).toBe('object');
    });

    it('should have getStoriesTable function for runtime selection', async () => {
      expect(getStoriesTable).toBeDefined();
      expect(typeof getStoriesTable).toBe('function');

      const table = await getStoriesTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');
    });
  });

  describe('Schema Structure', () => {
    it('should have all required fields', async () => {
      const table = await getStoriesTable();

      // Check required fields exist
      expect(table.id).toBeDefined();
      expect(table.title).toBeDefined();
      expect(table.description).toBeDefined();
      expect(table.communityId).toBeDefined();
      expect(table.createdBy).toBeDefined();
      expect(table.isRestricted).toBeDefined();
      expect(table.mediaUrls).toBeDefined();
      expect(table.language).toBeDefined();
      expect(table.tags).toBeDefined();
      expect(table.createdAt).toBeDefined();
      expect(table.updatedAt).toBeDefined();
    });

    it('should have correct field types for PostgreSQL', () => {
      const pgFields = storiesPg;

      // Verify field configurations
      expect(pgFields.id).toBeDefined();
      expect(pgFields.title).toBeDefined();
      expect(pgFields.communityId).toBeDefined();
      expect(pgFields.createdBy).toBeDefined();
      expect(pgFields.isRestricted).toBeDefined();
      expect(pgFields.mediaUrls).toBeDefined();
      expect(pgFields.language).toBeDefined();
      expect(pgFields.tags).toBeDefined();
    });

    it('should have correct field types for SQLite', () => {
      const sqliteFields = storiesSqlite;

      // Verify field configurations
      expect(sqliteFields.id).toBeDefined();
      expect(sqliteFields.title).toBeDefined();
      expect(sqliteFields.communityId).toBeDefined();
      expect(sqliteFields.createdBy).toBeDefined();
      expect(sqliteFields.isRestricted).toBeDefined();
      expect(sqliteFields.mediaUrls).toBeDefined();
      expect(sqliteFields.language).toBeDefined();
      expect(sqliteFields.tags).toBeDefined();
    });
  });

  describe('Relations', () => {
    it('should export stories relations', () => {
      expect(storiesRelations).toBeDefined();
    });

    it('should define community relation', () => {
      // The actual relations testing would require a full database setup
      // This test will be meaningful once both tables exist with relations
      expect(storiesRelations).toBeDefined();
    });

    it('should define author relation', () => {
      // The actual relations testing would require a full database setup
      // This test will be meaningful once both tables exist with relations
      expect(storiesRelations).toBeDefined();
    });
  });

  describe('Zod Validation Schemas', () => {
    it('should export all validation schemas', () => {
      expect(insertStorySchema).toBeDefined();
      expect(selectStorySchema).toBeDefined();
      expect(createStorySchema).toBeDefined();
      expect(updateStorySchema).toBeDefined();
    });

    it('should validate valid story data', () => {
      const validStory = {
        title: 'Traditional Hunting Story',
        description: 'A story about traditional hunting practices',
        communityId: 1,
        createdBy: 1,
        isRestricted: false,
        mediaUrls: ['https://example.com/photo1.jpg'],
        language: 'en',
        tags: ['hunting', 'tradition'],
      };

      const result = createStorySchema.safeParse(validStory);
      expect(result.success).toBe(true);
    });

    it('should reject invalid story data - missing title', () => {
      const invalidStory = {
        description: 'A story without title',
        communityId: 1,
        createdBy: 1,
      };

      const result = createStorySchema.safeParse(invalidStory);
      expect(result.success).toBe(false);
    });

    it('should reject invalid story data - invalid mediaUrls', () => {
      const invalidStory = {
        title: 'Story with invalid media',
        communityId: 1,
        createdBy: 1,
        mediaUrls: 'not-an-array',
      };

      const result = createStorySchema.safeParse(invalidStory);
      expect(result.success).toBe(false);
    });

    it('should validate isRestricted boolean field', () => {
      const storyWithRestriction = {
        title: 'Sacred Story',
        communityId: 1,
        createdBy: 1,
        isRestricted: true,
      };

      const result = createStorySchema.safeParse(storyWithRestriction);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isRestricted).toBe(true);
      }
    });

    it('should validate language field with default', () => {
      const storyWithoutLanguage = {
        title: 'Story without language',
        communityId: 1,
        createdBy: 1,
      };

      const result = createStorySchema.safeParse(storyWithoutLanguage);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.language).toBe('en');
      }
    });

    it('should validate tags array field', () => {
      const storyWithTags = {
        title: 'Tagged Story',
        communityId: 1,
        createdBy: 1,
        tags: ['culture', 'history', 'ceremony'],
      };

      const result = createStorySchema.safeParse(storyWithTags);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.data.tags)).toBe(true);
        expect(result.data.tags).toHaveLength(3);
      }
    });
  });

  describe('TypeScript Types', () => {
    it('should export Story type', () => {
      // Type check - this will fail at compile time if type doesn't exist
      const story: Story = {
        id: 1,
        title: 'Test Story',
        description: 'Test description',
        communityId: 1,
        createdBy: 1,
        isRestricted: false,
        mediaUrls: [],
        language: 'en',
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(story).toBeDefined();
      expect(story.id).toBe(1);
      expect(story.title).toBe('Test Story');
    });

    it('should export NewStory type', () => {
      // Type check - this will fail at compile time if type doesn't exist
      const newStory: NewStory = {
        title: 'New Story',
        description: 'New description',
        communityId: 1,
        createdBy: 1,
        isRestricted: false,
        mediaUrls: [],
        language: 'en',
        tags: [],
      };

      expect(newStory).toBeDefined();
      expect(newStory.title).toBe('New Story');
    });
  });

  describe('Multi-Tenant Data Isolation', () => {
    it('should require communityId field', () => {
      const storyWithoutCommunity = {
        title: 'Story without community',
        createdBy: 1,
      };

      const result = createStorySchema.safeParse(storyWithoutCommunity);
      expect(result.success).toBe(false);
    });

    it('should require createdBy field for author tracking', () => {
      const storyWithoutAuthor = {
        title: 'Story without author',
        communityId: 1,
      };

      const result = createStorySchema.safeParse(storyWithoutAuthor);
      expect(result.success).toBe(false);
    });
  });

  describe('Cultural Sensitivity Features', () => {
    it('should support restricted content flag', () => {
      const restrictedStory = {
        title: 'Sacred Ceremony Story',
        description: 'Culturally sensitive content',
        communityId: 1,
        createdBy: 1,
        isRestricted: true,
      };

      const result = createStorySchema.safeParse(restrictedStory);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isRestricted).toBe(true);
      }
    });

    it('should default isRestricted to false', () => {
      const publicStory = {
        title: 'Public Story',
        communityId: 1,
        createdBy: 1,
      };

      const result = createStorySchema.safeParse(publicStory);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isRestricted).toBe(false);
      }
    });

    it('should support multiple media URLs for rich content', () => {
      const mediaRichStory = {
        title: 'Media Rich Story',
        communityId: 1,
        createdBy: 1,
        mediaUrls: [
          'https://example.com/photo1.jpg',
          'https://example.com/audio1.mp3',
          'https://example.com/video1.mp4',
        ],
      };

      const result = createStorySchema.safeParse(mediaRichStory);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mediaUrls).toHaveLength(3);
      }
    });

    it('should support cultural tagging system', () => {
      const culturallyTaggedStory = {
        title: 'Traditional Knowledge Story',
        communityId: 1,
        createdBy: 1,
        tags: ['traditional-knowledge', 'elders', 'ceremony', 'seasonal'],
      };

      const result = createStorySchema.safeParse(culturallyTaggedStory);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toContain('traditional-knowledge');
        expect(result.data.tags).toContain('elders');
      }
    });
  });

  describe('Update Schema Validation', () => {
    it('should allow partial updates', () => {
      const partialUpdate = {
        title: 'Updated Title',
        description: 'Updated description',
      };

      const result = updateStorySchema.safeParse(partialUpdate);
      expect(result.success).toBe(true);
    });

    it('should not allow updating id field', () => {
      const invalidUpdate = {
        id: 999,
        title: 'Updated Title',
      };

      const parsed = updateStorySchema.safeParse(invalidUpdate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // ID should be omitted from update schema
        expect(parsed.data.id).toBeUndefined();
      }
    });

    it('should not allow updating createdAt field', () => {
      const invalidUpdate = {
        title: 'Updated Title',
        createdAt: new Date(),
      };

      const parsed = updateStorySchema.safeParse(invalidUpdate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // createdAt should be omitted from update schema
        expect(parsed.data.createdAt).toBeUndefined();
      }
    });
  });
});
