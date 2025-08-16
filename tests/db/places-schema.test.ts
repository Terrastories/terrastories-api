import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  placesPg,
  placesSqlite,
  getPlacesTable,
  insertPlaceSchema,
  createPlaceSchema,
  updatePlaceSchema,
  validateCoordinates,
  spatialHelpers,
  type Place,
} from '../../src/db/schema/places.js';
import {
  setupTestDatabase as setupTestDb,
  teardownTestDatabase as cleanupTestDb,
} from '../helpers/database.js';

describe('Places Schema', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await cleanupTestDb();
  });

  describe('Schema Definition', () => {
    it('should have PostgreSQL table with correct structure', () => {
      expect(placesPg).toBeDefined();
      expect(placesPg[Symbol.for('drizzle:Name')]).toBe('places');

      // Check column definitions
      const columns = Object.keys(placesPg);
      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('communityId');
      expect(columns).toContain('latitude');
      expect(columns).toContain('longitude');
      expect(columns).toContain('createdAt');
      expect(columns).toContain('updatedAt');
    });

    it('should have SQLite table with correct structure', () => {
      expect(placesSqlite).toBeDefined();
      expect(placesSqlite[Symbol.for('drizzle:Name')]).toBe('places');

      // Check that SQLite table has required columns
      const columns = Object.keys(placesSqlite);
      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('communityId');
      expect(columns).toContain('latitude');
      expect(columns).toContain('longitude');
    });

    it('should have proper TypeScript types', () => {
      // Test type inference
      const place: Place = {
        id: 1,
        name: 'Test Place',
        description: null,
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        region: null,
        mediaUrls: [],
        culturalSignificance: null,
        isRestricted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(place.id).toBe(1);
      expect(place.name).toBe('Test Place');
      expect(place.latitude).toBe(-15.7801);
      expect(place.longitude).toBe(-47.9292);
    });
  });

  describe('Zod Validation Schemas', () => {
    describe('insertPlaceSchema', () => {
      it('should validate valid place data', () => {
        const validPlace = {
          name: 'Sacred Mountain',
          description: 'A sacred site for ceremonies',
          communityId: 1,
          latitude: -15.7801,
          longitude: -47.9292,
          region: 'Central Highlands',
          mediaUrls: ['https://example.com/image.jpg'],
          culturalSignificance: 'Sacred ceremony site',
          isRestricted: false,
        };

        const result = insertPlaceSchema.safeParse(validPlace);
        expect(result.success).toBe(true);
      });

      it('should reject invalid coordinates', () => {
        const invalidPlace = {
          name: 'Invalid Place',
          communityId: 1,
          latitude: 100, // Invalid latitude > 90
          longitude: -47.9292,
        };

        const result = insertPlaceSchema.safeParse(invalidPlace);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain('Invalid latitude');
        }
      });

      it('should reject invalid longitude', () => {
        const invalidPlace = {
          name: 'Invalid Place',
          communityId: 1,
          latitude: -15.7801,
          longitude: 200, // Invalid longitude > 180
        };

        const result = insertPlaceSchema.safeParse(invalidPlace);
        expect(result.success).toBe(false);
      });

      it('should require name and coordinates', () => {
        const incompletePlace = {
          communityId: 1,
          // Missing name, latitude, longitude
        };

        const result = insertPlaceSchema.safeParse(incompletePlace);
        expect(result.success).toBe(false);
      });

      it('should validate media URLs', () => {
        const placeWithInvalidUrl = {
          name: 'Place with Media',
          communityId: 1,
          latitude: -15.7801,
          longitude: -47.9292,
          mediaUrls: ['not-a-valid-url'],
        };

        const result = insertPlaceSchema.safeParse(placeWithInvalidUrl);
        expect(result.success).toBe(false);
      });

      it('should handle optional fields', () => {
        const minimalPlace = {
          name: 'Minimal Place',
          communityId: 1,
          latitude: -15.7801,
          longitude: -47.9292,
        };

        const result = insertPlaceSchema.safeParse(minimalPlace);
        expect(result.success).toBe(true);
      });
    });

    describe('createPlaceSchema', () => {
      it('should exclude auto-generated fields', () => {
        const placeData = {
          id: 999, // Should be excluded
          name: 'New Place',
          communityId: 1,
          latitude: -15.7801,
          longitude: -47.9292,
          createdAt: new Date(), // Should be excluded
          updatedAt: new Date(), // Should be excluded
        };

        const result = createPlaceSchema.safeParse(placeData);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.id).toBeUndefined();
          expect(result.data.createdAt).toBeUndefined();
          expect(result.data.updatedAt).toBeUndefined();
          expect(result.data.name).toBe('New Place');
        }
      });
    });

    describe('updatePlaceSchema', () => {
      it('should make all fields optional', () => {
        const partialUpdate = {
          name: 'Updated Name',
        };

        const result = updatePlaceSchema.safeParse(partialUpdate);
        expect(result.success).toBe(true);
      });

      it('should exclude restricted fields', () => {
        const updateData = {
          name: 'Updated Place',
          communityId: 999, // Should be excluded
          id: 123, // Should be excluded
          createdAt: new Date(), // Should be excluded
        };

        const result = updatePlaceSchema.safeParse(updateData);
        expect(result.success).toBe(true);

        if (result.success) {
          expect(result.data.id).toBeUndefined();
          expect(result.data.communityId).toBeUndefined();
          expect(result.data.createdAt).toBeUndefined();
          expect(result.data.name).toBe('Updated Place');
        }
      });
    });
  });

  describe('Dynamic Table Selection', () => {
    it('should return correct table based on environment', async () => {
      // Test that the function returns a table
      const table = await getPlacesTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');

      // Test that the returned table has the expected structure
      expect(table.id).toBeDefined();
      expect(table.name).toBeDefined();
      expect(table.communityId).toBeDefined();
      expect(table.latitude).toBeDefined();
      expect(table.longitude).toBeDefined();
    });
  });

  describe('Coordinate Validation', () => {
    it('should validate correct coordinates', () => {
      expect(validateCoordinates(-15.7801, -47.9292)).toBe(true);
      expect(validateCoordinates(0, 0)).toBe(true);
      expect(validateCoordinates(-90, -180)).toBe(true);
      expect(validateCoordinates(90, 180)).toBe(true);
    });

    it('should reject invalid coordinates', () => {
      expect(validateCoordinates(100, 0)).toBe(false); // Invalid latitude
      expect(validateCoordinates(0, 200)).toBe(false); // Invalid longitude
      expect(validateCoordinates(-100, 0)).toBe(false); // Invalid latitude
      expect(validateCoordinates(0, -200)).toBe(false); // Invalid longitude
    });
  });

  describe('PostGIS Spatial Helpers', () => {
    it('should generate correct PostGIS point creation SQL', () => {
      const pointSql = spatialHelpers.createPoint(-15.7801, -47.9292);
      expect(pointSql).toContain('ST_SetSRID');
      expect(pointSql).toContain('ST_MakePoint');
      expect(pointSql).toContain('-47.9292'); // longitude first
      expect(pointSql).toContain('-15.7801'); // latitude second
      expect(pointSql).toContain('4326'); // SRID
    });

    it('should generate correct radius search SQL', () => {
      const radiusSql = spatialHelpers.findWithinRadius(
        -15.7801,
        -47.9292,
        1000
      );
      expect(radiusSql).toContain('ST_DWithin');
      expect(radiusSql).toContain('longitude');
      expect(radiusSql).toContain('latitude');
      expect(radiusSql).toContain('1000'); // radius in meters
    });

    it('should generate correct bounding box search SQL', () => {
      const bounds = { north: -15.7, south: -15.8, east: -47.9, west: -48.0 };
      const boundsSql = spatialHelpers.findInBoundingBox(bounds);
      expect(boundsSql).toContain('ST_Within');
      expect(boundsSql).toContain('ST_MakeEnvelope');
      expect(boundsSql).toContain('-48'); // west (without trailing .0)
      expect(boundsSql).toContain('-15.8'); // south
    });

    it('should generate correct distance calculation SQL', () => {
      const distanceSql = spatialHelpers.calculateDistance(-15.7801, -47.9292);
      expect(distanceSql).toContain('ST_Distance');
      expect(distanceSql).toContain('longitude');
      expect(distanceSql).toContain('latitude');
      expect(distanceSql).toContain('geography');
    });
  });

  describe('Multi-Database Compatibility', () => {
    it('should have matching column names between PostgreSQL and SQLite', () => {
      const pgColumns = Object.keys(placesPg).filter(
        (key) => !key.startsWith('_')
      );
      const sqliteColumns = Object.keys(placesSqlite).filter(
        (key) => !key.startsWith('_')
      );

      // Core columns should match
      const coreColumns = [
        'id',
        'name',
        'communityId',
        'latitude',
        'longitude',
        'createdAt',
        'updatedAt',
      ];

      coreColumns.forEach((column) => {
        expect(pgColumns).toContain(column);
        expect(sqliteColumns).toContain(column);
      });
    });

    it('should handle coordinate columns consistently', () => {
      // Both should have basic coordinate columns
      expect(Object.keys(placesPg)).toContain('latitude');
      expect(Object.keys(placesPg)).toContain('longitude');
      expect(Object.keys(placesSqlite)).toContain('latitude');
      expect(Object.keys(placesSqlite)).toContain('longitude');
    });
  });

  describe('Cultural Sensitivity Features', () => {
    it('should support restricted places', () => {
      const restrictedPlace = {
        name: 'Sacred Burial Ground',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        isRestricted: true,
        culturalSignificance: 'Ancestral burial site',
      };

      const result = insertPlaceSchema.safeParse(restrictedPlace);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isRestricted).toBe(true);
        expect(result.data.culturalSignificance).toBe('Ancestral burial site');
      }
    });

    it('should support cultural significance descriptions', () => {
      const culturalPlace = {
        name: 'Ceremony Circle',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        culturalSignificance:
          'Traditional ceremony site used for seasonal celebrations',
      };

      const result = insertPlaceSchema.safeParse(culturalPlace);
      expect(result.success).toBe(true);
    });
  });

  describe('Media URL Validation', () => {
    it('should accept valid media URLs', () => {
      const placeWithMedia = {
        name: 'Media Place',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        mediaUrls: [
          'https://example.com/image.jpg',
          'https://example.com/video.mp4',
          'https://example.com/audio.mp3',
        ],
      };

      const result = insertPlaceSchema.safeParse(placeWithMedia);
      expect(result.success).toBe(true);
    });

    it('should reject invalid URLs', () => {
      const placeWithInvalidUrls = {
        name: 'Invalid Media Place',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        mediaUrls: ['not-a-url', 'also-not-a-url'],
      };

      const result = insertPlaceSchema.safeParse(placeWithInvalidUrls);
      expect(result.success).toBe(false);
    });

    it('should default to empty array for media URLs', () => {
      const placeWithoutMedia = {
        name: 'Simple Place',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
      };

      const result = insertPlaceSchema.safeParse(placeWithoutMedia);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mediaUrls).toEqual([]);
      }
    });
  });
});
