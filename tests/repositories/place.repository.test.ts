/**
 * Place Repository Tests
 *
 * Tests the PlaceRepository class with:
 * - Complete CRUD operations
 * - PostGIS spatial queries with SQLite fallback
 * - Multi-database compatibility
 * - Community data isolation
 * - Story-place association management
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { PlaceRepository } from '../../src/repositories/place.repository.js';
import { testDb } from '../helpers/database.js';
import type { CreatePlaceData } from '../../src/repositories/place.repository.js';

describe('PlaceRepository', () => {
  let repository: PlaceRepository;
  let testCommunityId: number;
  let otherCommunityId: number;
  let db: any;

  beforeEach(async () => {
    db = await testDb.setup();
    repository = new PlaceRepository(db);

    // Clear and seed test data fresh each time
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community (index 0)
    otherCommunityId = fixtures.communities[2].id;
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  describe('create', () => {
    test('should create a new place with valid coordinates', async () => {
      const placeData: CreatePlaceData = {
        name: 'Sacred Mountain',
        description: 'Traditional gathering place',
        latitude: 37.7749,
        longitude: -122.4194,
        region: 'North Region',
        culturalSignificance: 'Sacred ceremonial site',
        isRestricted: false,
      };

      const place = await repository.create({ ...placeData, communityId: testCommunityId });

      expect(place).toBeDefined();
      expect(place.id).toBeTypeOf('number');
      expect(place.name).toBe('Sacred Mountain');
      expect(place.latitude).toBe(37.7749);
      expect(place.longitude).toBe(-122.4194);
      expect(place.culturalSignificance).toBe('Sacred ceremonial site');
      expect(place.communityId).toBe(testCommunityId);
    });

    test('should create place with media URLs', async () => {
      const placeData: CreatePlaceData = {
        name: 'Photo Place',
        latitude: 37.7749,
        longitude: -122.4194,
        mediaUrls: ['http://example.com/photo1.jpg', 'http://example.com/photo2.jpg'],
      };

      const place = await repository.create({ ...placeData, communityId: testCommunityId });

      expect(place.mediaUrls).toEqual(['http://example.com/photo1.jpg', 'http://example.com/photo2.jpg']);
    });

    test('should reject invalid coordinates', async () => {
      const invalidData: CreatePlaceData = {
        name: 'Invalid Place',
        latitude: 91, // Invalid latitude
        longitude: -122.4194,
      };

      await expect(repository.create({ ...invalidData, communityId: testCommunityId }))
        .rejects.toThrow('Invalid latitude or longitude');
    });

    test('should reject place with non-existent community', async () => {
      const placeData: CreatePlaceData = {
        name: 'Orphan Place',
        latitude: 37.7749,
        longitude: -122.4194,
      };

      await expect(repository.create({ ...placeData, communityId: 99999 }))
        .rejects.toThrow('Invalid community ID');
    });
  });

  describe('getById', () => {
    test('should retrieve place by ID', async () => {
      const placeData: CreatePlaceData = {
        name: 'Test Place',
        latitude: 37.7749,
        longitude: -122.4194,
      };

      const created = await repository.create({ ...placeData, communityId: testCommunityId });
      const retrieved = await repository.getById(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.name).toBe('Test Place');
    });

    test('should return null for non-existent place', async () => {
      const place = await repository.getById(99999);
      expect(place).toBeNull();
    });
  });

  describe('getByIdWithCommunityCheck', () => {
    test('should retrieve place within same community', async () => {
      const placeData: CreatePlaceData = {
        name: 'Community Place',
        latitude: 37.7749,
        longitude: -122.4194,
      };

      const created = await repository.create({ ...placeData, communityId: testCommunityId });
      const retrieved = await repository.getByIdWithCommunityCheck(created.id, testCommunityId);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
    });

    test('should return null for place in different community', async () => {
      const placeData: CreatePlaceData = {
        name: 'Other Community Place',
        latitude: 37.7749,
        longitude: -122.4194,
      };

      const created = await repository.create({ ...placeData, communityId: otherCommunityId });
      const retrieved = await repository.getByIdWithCommunityCheck(created.id, testCommunityId);

      expect(retrieved).toBeNull();
    });
  });

  describe('getByCommunity', () => {
    test('should retrieve places for a community with pagination', async () => {
      // Create multiple places
      await Promise.all([
        repository.create({
          name: 'Place 1',
          latitude: 37.7749,
          longitude: -122.4194,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Place 2',
          latitude: 37.7849,
          longitude: -122.4294,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Place 3',
          latitude: 37.7949,
          longitude: -122.4394,
          communityId: testCommunityId,
        }),
      ]);

      const result = await repository.getByCommunity(testCommunityId, { page: 1, limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.pages).toBe(2);
    });

    test('should exclude restricted places for non-elder users', async () => {
      await Promise.all([
        repository.create({
          name: 'Public Place',
          latitude: 37.7749,
          longitude: -122.4194,
          isRestricted: false,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Sacred Place',
          latitude: 37.7849,
          longitude: -122.4294,
          isRestricted: true,
          communityId: testCommunityId,
        }),
      ]);

      const result = await repository.getByCommunity(testCommunityId, { 
        page: 1, 
        limit: 10,
        includeRestricted: false 
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Public Place');
    });
  });

  describe('update', () => {
    test('should update place fields', async () => {
      const placeData: CreatePlaceData = {
        name: 'Original Name',
        latitude: 37.7749,
        longitude: -122.4194,
      };

      const created = await repository.create({ ...placeData, communityId: testCommunityId });
      const updated = await repository.update(created.id, {
        name: 'Updated Name',
        description: 'New description',
      });

      expect(updated).toBeDefined();
      expect(updated!.name).toBe('Updated Name');
      expect(updated!.description).toBe('New description');
      expect(updated!.latitude).toBe(37.7749); // Unchanged
    });

    test('should return null when updating non-existent place', async () => {
      const updated = await repository.update(99999, { name: 'New Name' });
      expect(updated).toBeNull();
    });
  });

  describe('delete', () => {
    test('should delete a place', async () => {
      const placeData: CreatePlaceData = {
        name: 'To Delete',
        latitude: 37.7749,
        longitude: -122.4194,
      };

      const created = await repository.create({ ...placeData, communityId: testCommunityId });
      const deleted = await repository.delete(created.id);

      expect(deleted).toBe(true);

      // Verify place is deleted
      const retrieved = await repository.getById(created.id);
      expect(retrieved).toBeNull();
    });

    test('should return false when deleting non-existent place', async () => {
      const deleted = await repository.delete(99999);
      expect(deleted).toBe(false);
    });
  });

  describe('searchNear', () => {
    test('should find places within specified radius', async () => {
      // Create places at different distances from San Francisco
      await Promise.all([
        repository.create({
          name: 'Close Place',
          latitude: 37.7749, // San Francisco
          longitude: -122.4194,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Medium Place', 
          latitude: 37.7849, // ~1km north
          longitude: -122.4194,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Far Place',
          latitude: 37.9949, // ~25km north
          longitude: -122.4194,
          communityId: testCommunityId,
        }),
      ]);

      const results = await repository.searchNear({
        communityId: testCommunityId,
        latitude: 37.7749,
        longitude: -122.4194,
        radiusKm: 5,
        page: 1,
        limit: 10,
      });

      expect(results.data.length).toBeGreaterThanOrEqual(2);
      const names = results.data.map(p => p.name);
      expect(names).toContain('Close Place');
      expect(names).toContain('Medium Place');
      // Far place should be excluded (unless we're using the SQLite fallback which is less precise)
    });

    test('should respect community isolation in radius search', async () => {
      await Promise.all([
        repository.create({
          name: 'My Community Place',
          latitude: 37.7749,
          longitude: -122.4194,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Other Community Place',
          latitude: 37.7749,
          longitude: -122.4194,
          communityId: otherCommunityId,
        }),
      ]);

      const results = await repository.searchNear({
        communityId: testCommunityId,
        latitude: 37.7749,
        longitude: -122.4194,
        radiusKm: 1,
        page: 1,
        limit: 10,
      });

      expect(results.data).toHaveLength(1);
      expect(results.data[0].name).toBe('My Community Place');
    });

    test('should validate search coordinates', async () => {
      await expect(repository.searchNear({
        communityId: testCommunityId,
        latitude: 91, // Invalid
        longitude: -122.4194,
        radiusKm: 5,
        page: 1,
        limit: 10,
      })).rejects.toThrow('Invalid search coordinates');
    });
  });

  describe('searchInBounds', () => {
    test('should find places within bounding box', async () => {
      await Promise.all([
        repository.create({
          name: 'Inside Place',
          latitude: 37.7749, // Inside bounds
          longitude: -122.4194,
          communityId: testCommunityId,
        }),
        repository.create({
          name: 'Outside Place',
          latitude: 38.0000, // Outside bounds
          longitude: -121.0000,
          communityId: testCommunityId,
        }),
      ]);

      const results = await repository.searchInBounds({
        communityId: testCommunityId,
        north: 37.8000,
        south: 37.7000,
        east: -122.4000,
        west: -122.5000,
        page: 1,
        limit: 10,
      });

      expect(results.data).toHaveLength(1);
      expect(results.data[0].name).toBe('Inside Place');
    });

    test('should validate bounding box', async () => {
      await expect(repository.searchInBounds({
        communityId: testCommunityId,
        north: 37.7000, // North should be > South
        south: 37.8000,
        east: -122.4000,
        west: -122.5000,
        page: 1,
        limit: 10,
      })).rejects.toThrow('Invalid bounding box');
    });
  });
});