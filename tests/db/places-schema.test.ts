import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  placesPg,
  placesSqlite,
  getPlacesTable,
  insertPlaceSchema,
  createPlaceSchema,
  updatePlaceSchema,
  validateCoordinates,
  SpatialUtils,
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

      const columns = Object.keys(placesPg);
      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('communityId');
      expect(columns).toContain('latitude');
      expect(columns).toContain('longitude');
      expect(columns).toContain('region');
      expect(columns).toContain('mediaUrls');
      expect(columns).toContain('culturalSignificance');
      expect(columns).toContain('isRestricted');
      expect(columns).toContain('createdAt');
      expect(columns).toContain('updatedAt');
    });

    it('should have SQLite table with correct structure', () => {
      expect(placesSqlite).toBeDefined();
      expect(placesSqlite[Symbol.for('drizzle:Name')]).toBe('places');

      const columns = Object.keys(placesSqlite);
      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('communityId');
      expect(columns).toContain('latitude');
      expect(columns).toContain('longitude');
      expect(columns).toContain('region');
      expect(columns).toContain('mediaUrls');
      expect(columns).toContain('culturalSignificance');
      expect(columns).toContain('isRestricted');
    });

    it('should have proper TypeScript types', () => {
      const place: Place = {
        id: 1,
        name: 'Test Place',
        description: null,
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        region: 'Cerrado',
        mediaUrls: [],
        photoUrl: null,
        culturalSignificance: 'Sacred site for ceremonies',
        isRestricted: false,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        updatedAt: new Date('2023-01-01T00:00:00Z'),
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
          region: 'Cerrado',
          mediaUrls: ['https://example.com/image.jpg'],
          culturalSignificance: 'Sacred site for ceremonies',
          isRestricted: false,
        };

        const result = insertPlaceSchema.safeParse(validPlace);
        expect(result.success).toBe(true);
      });

      it('should reject invalid coordinates', () => {
        const invalidPlace = {
          name: 'Invalid Place',
          communityId: 1,
          latitude: 50,
          longitude: 200,
        };

        const result = insertPlaceSchema.safeParse(invalidPlace);
        expect(result.success).toBe(false);
      });

      it('should reject invalid latitude', () => {
        const invalidPlace = {
          name: 'Invalid Place',
          communityId: 1,
          latitude: 200,
          longitude: 50,
        };

        const result = insertPlaceSchema.safeParse(invalidPlace);
        expect(result.success).toBe(false);
      });

      it('should require name and communityId', () => {
        const incompletePlace = {
          latitude: -15.7801,
          longitude: -47.9292,
        };

        const result = insertPlaceSchema.safeParse(incompletePlace);
        expect(result.success).toBe(false);
      });

      it('should validate place with coordinate data', () => {
        const placeWithCoordinates = {
          name: 'Place with Coordinates',
          communityId: 1,
          latitude: -15.7801,
          longitude: -47.9292,
        };

        const result = insertPlaceSchema.safeParse(placeWithCoordinates);
        expect(result.success).toBe(true);
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
          id: 999,
          name: 'New Place',
          communityId: 1,
          latitude: -15.7801,
          longitude: -47.9292,
          createdAt: new Date(),
          updatedAt: new Date(),
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
        const partialUpdate = { name: 'Updated Name' };
        const result = updatePlaceSchema.safeParse(partialUpdate);
        expect(result.success).toBe(true);
      });

      it('should exclude restricted fields', () => {
        const updateData = {
          name: 'Updated Place',
          communityId: 999,
          id: 123,
          createdAt: new Date(),
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
      const table = await getPlacesTable();
      expect(table).toBeDefined();
      expect(typeof table).toBe('object');
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
      expect(validateCoordinates(100, 0)).toBe(false);
      expect(validateCoordinates(0, 200)).toBe(false);
      expect(validateCoordinates(-100, 0)).toBe(false);
      expect(validateCoordinates(0, -200)).toBe(false);
    });
  });

  describe('Portable Spatial Helpers', () => {
    it('should create a backend-neutral GeoJSON point', () => {
      expect(JSON.parse(SpatialUtils.createPoint(-15.7801, -47.9292))).toEqual({
        type: 'Point',
        coordinates: [-47.9292, -15.7801],
      });
    });

    it('should calculate application-level Haversine distance', () => {
      const distanceMeters = SpatialUtils.calculateDistance(
        -15.7801,
        -47.9292,
        -15.781,
        -47.9292
      );
      expect(distanceMeters).toBeGreaterThan(90);
      expect(distanceMeters).toBeLessThan(110);
    });

    it('should evaluate bounding boxes in application code', () => {
      const bounds = { north: -15.7, south: -15.8, east: -47.9, west: -48.0 };
      expect(SpatialUtils.isPointInBounds(-15.7801, -47.9292, bounds)).toBe(
        true
      );
      expect(SpatialUtils.isPointInBounds(-16, -47.9292, bounds)).toBe(false);
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

      const coreColumns = [
        'id',
        'name',
        'communityId',
        'latitude',
        'longitude',
        'region',
        'mediaUrls',
        'photoUrl',
        'culturalSignificance',
        'isRestricted',
        'createdAt',
        'updatedAt',
      ];

      coreColumns.forEach((column) => {
        expect(pgColumns).toContain(column);
        expect(sqliteColumns).toContain(column);
      });
    });

    it('should handle coordinate columns consistently', () => {
      expect(placesPg.latitude).toBeDefined();
      expect(placesPg.longitude).toBeDefined();
      expect(placesSqlite.latitude).toBeDefined();
      expect(placesSqlite.longitude).toBeDefined();
    });
  });

  describe('Cultural Sensitivity Features', () => {
    it('should support places with cultural data', () => {
      const culturalPlace = {
        name: 'Sacred Grove',
        description: 'Traditional ceremonial site',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        culturalSignificance: 'Used for traditional ceremonies',
        isRestricted: true,
      };

      const result = insertPlaceSchema.safeParse(culturalPlace);
      expect(result.success).toBe(true);
    });

    it('should support cultural significance descriptions', () => {
      const placeWithCulturalInfo = {
        name: 'Ancient Meeting Ground',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        culturalSignificance: 'Traditional meeting place for elders',
        isRestricted: false,
      };

      const result = insertPlaceSchema.safeParse(placeWithCulturalInfo);
      expect(result.success).toBe(true);
    });
  });

  describe('Media URL Validation', () => {
    it('should accept valid place data', () => {
      const placeWithMedia = {
        name: 'Photo Place',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        mediaUrls: [
          'https://example.com/photo1.jpg',
          'https://example.com/photo2.png',
        ],
      };

      const result = insertPlaceSchema.safeParse(placeWithMedia);
      expect(result.success).toBe(true);
    });

    it('should reject invalid data', () => {
      const invalidPlace = {
        name: '',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
      };

      const result = insertPlaceSchema.safeParse(invalidPlace);
      expect(result.success).toBe(false);
    });

    it('should handle minimal place data', () => {
      const minimalPlace = {
        name: 'Simple Place',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
      };

      const result = insertPlaceSchema.safeParse(minimalPlace);
      expect(result.success).toBe(true);
    });
  });
});
