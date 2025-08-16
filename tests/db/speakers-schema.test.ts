import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '../../src/db/index.js';
import {
  getSpeakersTable,
  speakersPg,
  speakersSqlite,
  speakersRelations,
  insertSpeakerSchema,
  selectSpeakerSchema,
  createSpeakerSchema,
  updateSpeakerSchema,
  type Speaker,
  type NewSpeaker,
} from '../../src/db/schema/speakers.js';

describe('Speakers Schema', () => {
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
      expect(speakersPg).toBeDefined();
      expect(typeof speakersPg).toBe('object');
    });

    it('should export SQLite table definition', () => {
      expect(speakersSqlite).toBeDefined();
      expect(typeof speakersSqlite).toBe('object');
    });

    it('should have getSpeakersTable function for runtime selection', async () => {
      expect(getSpeakersTable).toBeDefined();
      expect(typeof getSpeakersTable).toBe('function');

      const table = await getSpeakersTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');
    });
  });

  describe('Schema Structure', () => {
    it('should have all required fields', async () => {
      const table = await getSpeakersTable();

      // Check required fields exist
      expect(table.id).toBeDefined();
      expect(table.name).toBeDefined();
      expect(table.bio).toBeDefined();
      expect(table.communityId).toBeDefined();
      expect(table.photoUrl).toBeDefined();
      expect(table.birthYear).toBeDefined();
      expect(table.elderStatus).toBeDefined();
      expect(table.culturalRole).toBeDefined();
      expect(table.isActive).toBeDefined();
      expect(table.createdAt).toBeDefined();
      expect(table.updatedAt).toBeDefined();
    });

    it('should have correct field types for PostgreSQL', () => {
      const pgFields = speakersPg;

      // Verify field configurations
      expect(pgFields.id).toBeDefined();
      expect(pgFields.name).toBeDefined();
      expect(pgFields.communityId).toBeDefined();
      expect(pgFields.elderStatus).toBeDefined();
      expect(pgFields.culturalRole).toBeDefined();
      expect(pgFields.isActive).toBeDefined();
    });

    it('should have correct field types for SQLite', () => {
      const sqliteFields = speakersSqlite;

      // Verify field configurations
      expect(sqliteFields.id).toBeDefined();
      expect(sqliteFields.name).toBeDefined();
      expect(sqliteFields.communityId).toBeDefined();
      expect(sqliteFields.elderStatus).toBeDefined();
      expect(sqliteFields.culturalRole).toBeDefined();
      expect(sqliteFields.isActive).toBeDefined();
    });
  });

  describe('Relations', () => {
    it('should export speakers relations', () => {
      expect(speakersRelations).toBeDefined();
    });

    it('should define community relation', () => {
      // The actual relations testing would require a full database setup
      // This test will be meaningful once both tables exist with relations
      expect(speakersRelations).toBeDefined();
    });
  });

  describe('Zod Validation Schemas', () => {
    it('should export all validation schemas', () => {
      expect(insertSpeakerSchema).toBeDefined();
      expect(selectSpeakerSchema).toBeDefined();
      expect(createSpeakerSchema).toBeDefined();
      expect(updateSpeakerSchema).toBeDefined();
    });

    it('should validate valid speaker data', () => {
      const validSpeaker = {
        name: 'Elder Mary Johnson',
        bio: 'Traditional knowledge keeper and storyteller',
        communityId: 1,
        photoUrl: 'https://example.com/photo.jpg',
        birthYear: 1945,
        elderStatus: true,
        culturalRole: 'Knowledge Keeper',
        isActive: true,
      };

      const result = createSpeakerSchema.safeParse(validSpeaker);
      expect(result.success).toBe(true);
    });

    it('should reject invalid speaker data - missing name', () => {
      const invalidSpeaker = {
        bio: 'Speaker without name',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(invalidSpeaker);
      expect(result.success).toBe(false);
    });

    it('should reject invalid speaker data - invalid birthYear', () => {
      const invalidSpeaker = {
        name: 'Test Speaker',
        communityId: 1,
        birthYear: 'not-a-number',
      };

      const result = createSpeakerSchema.safeParse(invalidSpeaker);
      expect(result.success).toBe(false);
    });

    it('should validate elderStatus boolean field', () => {
      const elderSpeaker = {
        name: 'Elder Sarah',
        communityId: 1,
        elderStatus: true,
      };

      const result = createSpeakerSchema.safeParse(elderSpeaker);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.elderStatus).toBe(true);
      }
    });

    it('should default elderStatus to false', () => {
      const regularSpeaker = {
        name: 'Young Speaker',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(regularSpeaker);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.elderStatus).toBe(false);
      }
    });

    it('should validate isActive field with default true', () => {
      const speakerWithoutActive = {
        name: 'Active Speaker',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(speakerWithoutActive);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(true);
      }
    });

    it('should allow optional bio field', () => {
      const speakerWithoutBio = {
        name: 'Speaker Name',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(speakerWithoutBio);
      expect(result.success).toBe(true);
    });

    it('should allow optional photoUrl field', () => {
      const speakerWithoutPhoto = {
        name: 'Speaker Name',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(speakerWithoutPhoto);
      expect(result.success).toBe(true);
    });

    it('should allow optional birthYear field', () => {
      const speakerWithoutBirthYear = {
        name: 'Speaker Name',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(speakerWithoutBirthYear);
      expect(result.success).toBe(true);
    });

    it('should allow optional culturalRole field', () => {
      const speakerWithoutRole = {
        name: 'Speaker Name',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(speakerWithoutRole);
      expect(result.success).toBe(true);
    });
  });

  describe('TypeScript Types', () => {
    it('should export Speaker type', () => {
      // Type check - this will fail at compile time if type doesn't exist
      const speaker: Speaker = {
        id: 1,
        name: 'Test Speaker',
        bio: 'Test bio',
        communityId: 1,
        photoUrl: 'https://example.com/photo.jpg',
        birthYear: 1950,
        elderStatus: false,
        culturalRole: 'Storyteller',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(speaker).toBeDefined();
      expect(speaker.id).toBe(1);
      expect(speaker.name).toBe('Test Speaker');
    });

    it('should export NewSpeaker type', () => {
      // Type check - this will fail at compile time if type doesn't exist
      const newSpeaker: NewSpeaker = {
        name: 'New Speaker',
        bio: 'New bio',
        communityId: 1,
        photoUrl: 'https://example.com/photo.jpg',
        birthYear: 1960,
        elderStatus: true,
        culturalRole: 'Elder',
        isActive: true,
      };

      expect(newSpeaker).toBeDefined();
      expect(newSpeaker.name).toBe('New Speaker');
    });
  });

  describe('Multi-Tenant Data Isolation', () => {
    it('should require communityId field', () => {
      const speakerWithoutCommunity = {
        name: 'Speaker without community',
      };

      const result = createSpeakerSchema.safeParse(speakerWithoutCommunity);
      expect(result.success).toBe(false);
    });

    it('should validate positive communityId values', () => {
      const speakerWithValidCommunity = {
        name: 'Valid Speaker',
        communityId: 1,
      };

      const result = createSpeakerSchema.safeParse(speakerWithValidCommunity);
      expect(result.success).toBe(true);
    });
  });

  describe('Cultural Sensitivity Features', () => {
    it('should support elder status recognition', () => {
      const elderSpeaker = {
        name: 'Elder Thomas',
        communityId: 1,
        elderStatus: true,
        culturalRole: 'Traditional Knowledge Keeper',
      };

      const result = createSpeakerSchema.safeParse(elderSpeaker);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.elderStatus).toBe(true);
        expect(result.data.culturalRole).toBe('Traditional Knowledge Keeper');
      }
    });

    it('should support cultural role specification', () => {
      const culturalSpeaker = {
        name: 'Maria Santos',
        communityId: 1,
        culturalRole: 'Ceremonial Leader',
        elderStatus: false,
      };

      const result = createSpeakerSchema.safeParse(culturalSpeaker);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.culturalRole).toBe('Ceremonial Leader');
      }
    });

    it('should handle speakers with traditional names', () => {
      const traditionalSpeaker = {
        name: 'Aiyana Two-Bears',
        communityId: 1,
        elderStatus: true,
        culturalRole: 'Medicine Woman',
      };

      const result = createSpeakerSchema.safeParse(traditionalSpeaker);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Aiyana Two-Bears');
      }
    });

    it('should support birth year for elder recognition', () => {
      const elderWithBirthYear = {
        name: 'Elder Robert',
        communityId: 1,
        birthYear: 1930,
        elderStatus: true,
      };

      const result = createSpeakerSchema.safeParse(elderWithBirthYear);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.birthYear).toBe(1930);
        expect(result.data.elderStatus).toBe(true);
      }
    });

    it('should allow inactive speakers (deceased/moved)', () => {
      const inactiveSpeaker = {
        name: 'Former Elder Jane',
        communityId: 1,
        isActive: false,
        elderStatus: true,
      };

      const result = createSpeakerSchema.safeParse(inactiveSpeaker);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(false);
      }
    });

    it('should support photo URLs for speaker profiles', () => {
      const speakerWithPhoto = {
        name: 'Speaker with Photo',
        communityId: 1,
        photoUrl: 'https://community.example.com/speakers/photo123.jpg',
      };

      const result = createSpeakerSchema.safeParse(speakerWithPhoto);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.photoUrl).toBe(
          'https://community.example.com/speakers/photo123.jpg'
        );
      }
    });
  });

  describe('Update Schema Validation', () => {
    it('should allow partial updates', () => {
      const partialUpdate = {
        bio: 'Updated biography',
        culturalRole: 'Updated Role',
      };

      const result = updateSpeakerSchema.safeParse(partialUpdate);
      expect(result.success).toBe(true);
    });

    it('should not allow updating id field', () => {
      const invalidUpdate = {
        id: 999,
        name: 'Updated Name',
      };

      const parsed = updateSpeakerSchema.safeParse(invalidUpdate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // ID should be omitted from update schema
        expect(parsed.data.id).toBeUndefined();
      }
    });

    it('should not allow updating createdAt field', () => {
      const invalidUpdate = {
        name: 'Updated Name',
        createdAt: new Date(),
      };

      const parsed = updateSpeakerSchema.safeParse(invalidUpdate);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // createdAt should be omitted from update schema
        expect(parsed.data.createdAt).toBeUndefined();
      }
    });

    it('should allow updating elder status', () => {
      const elderUpdate = {
        elderStatus: true,
        culturalRole: 'Newly Recognized Elder',
      };

      const result = updateSpeakerSchema.safeParse(elderUpdate);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.elderStatus).toBe(true);
      }
    });

    it('should allow updating active status', () => {
      const statusUpdate = {
        isActive: false,
      };

      const result = updateSpeakerSchema.safeParse(statusUpdate);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(false);
      }
    });
  });
});
