/**
 * Themes Repository Tests
 *
 * Tests the themes repository with comprehensive CRUD operations,
 * community scoping, geographic validation, and cultural protocols
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testDb, type TestDatabase } from '../helpers/database.js';
import {
  themesSqlite as themes,
  type CreateTheme,
  type UpdateTheme,
} from '../../src/db/schema/themes.js';
import { communitiesSqlite as communities } from '../../src/db/schema/communities.js';
import { ThemesRepository } from '../../src/repositories/themes.repository.js';
import { eq } from 'drizzle-orm';

describe('ThemesRepository', () => {
  let db: TestDatabase;
  let themesRepo: ThemesRepository;
  let testCommunityId: number;
  let otherCommunityId: number;

  beforeEach(async () => {
    db = await testDb.setup();
    themesRepo = new ThemesRepository(db);

    // Clear and seed test data fresh each time
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    testCommunityId = fixtures.communities[1].id; // Skip system community (index 0)
    otherCommunityId = fixtures.communities[2].id;
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  describe('CRUD Operations', () => {
    describe('create()', () => {
      it('should create theme with all fields', async () => {
        const themeData: CreateTheme = {
          name: 'Test Theme',
          description: 'A comprehensive test theme',
          mapboxStyleUrl: 'mapbox://styles/mapbox/streets-v11',
          mapboxAccessToken: 'pk.test.token',
          centerLat: 45.0,
          centerLong: -123.0,
          swBoundaryLat: 44.0,
          swBoundaryLong: -124.0,
          neBoundaryLat: 46.0,
          neBoundaryLong: -122.0,
          active: true,
          communityId: testCommunityId,
        };

        const result = await themesRepo.create(themeData);

        expect(result).toBeDefined();
        expect(result.id).toBeGreaterThan(0);
        expect(result.name).toBe('Test Theme');
        expect(result.description).toBe('A comprehensive test theme');
        expect(result.mapboxStyleUrl).toBe(
          'mapbox://styles/mapbox/streets-v11'
        );
        expect(result.mapboxAccessToken).toBe('pk.test.token');
        expect(Number(result.centerLat)).toBe(45.0);
        expect(Number(result.centerLong)).toBe(-123.0);
        expect(Number(result.swBoundaryLat)).toBe(44.0);
        expect(Number(result.swBoundaryLong)).toBe(-124.0);
        expect(Number(result.neBoundaryLat)).toBe(46.0);
        expect(Number(result.neBoundaryLong)).toBe(-122.0);
        expect(result.active).toBe(true);
        expect(result.communityId).toBe(testCommunityId);
        expect(result.createdAt).toBeInstanceOf(Date);
        expect(result.updatedAt).toBeInstanceOf(Date);
      });

      it('should create theme with minimal required fields', async () => {
        const themeData: CreateTheme = {
          name: 'Minimal Theme',
          communityId: testCommunityId,
        };

        const result = await themesRepo.create(themeData);

        expect(result).toBeDefined();
        expect(result.name).toBe('Minimal Theme');
        expect(result.description).toBeNull();
        expect(result.active).toBe(false); // default value
        expect(result.communityId).toBe(testCommunityId);
      });

      it('should throw error for invalid community ID', async () => {
        const themeData: CreateTheme = {
          name: 'Invalid Community Theme',
          communityId: 999999, // non-existent
        };

        await expect(themesRepo.create(themeData)).rejects.toThrow();
      });
    });

    describe('findById()', () => {
      it('should find theme by ID', async () => {
        const themeData: CreateTheme = {
          name: 'Findable Theme',
          description: 'A theme to be found',
          active: true,
          communityId: testCommunityId,
        };

        const created = await themesRepo.create(themeData);
        const found = await themesRepo.findById(created.id);

        expect(found).toBeDefined();
        expect(found!.id).toBe(created.id);
        expect(found!.name).toBe('Findable Theme');
        expect(found!.description).toBe('A theme to be found');
        expect(found!.active).toBe(true);
      });

      it('should return null for non-existent theme', async () => {
        const found = await themesRepo.findById(999999);
        expect(found).toBeNull();
      });
    });

    describe('findByCommunityId()', () => {
      it('should find all themes for a community', async () => {
        const themes1: CreateTheme[] = [
          {
            name: 'Community Theme 1',
            active: true,
            communityId: testCommunityId,
          },
          {
            name: 'Community Theme 2',
            active: false,
            communityId: testCommunityId,
          },
        ];

        const themes2: CreateTheme[] = [
          { name: 'Other Theme', active: true, communityId: otherCommunityId },
        ];

        await themesRepo.create(themes1[0]);
        await themesRepo.create(themes1[1]);
        await themesRepo.create(themes2[0]);

        const communityThemes =
          await themesRepo.findByCommunityId(testCommunityId);

        expect(communityThemes).toHaveLength(2);
        expect(communityThemes.map((t) => t.name).sort()).toEqual([
          'Community Theme 1',
          'Community Theme 2',
        ]);
        expect(
          communityThemes.every((t) => t.communityId === testCommunityId)
        ).toBe(true);
      });

      it('should return empty array for community with no themes', async () => {
        const themes = await themesRepo.findByCommunityId(testCommunityId);
        expect(themes).toEqual([]);
      });
    });

    describe('findActiveThemes()', () => {
      it('should find all active themes for a community', async () => {
        const themeData: CreateTheme[] = [
          {
            name: 'Active Theme 1',
            active: true,
            communityId: testCommunityId,
          },
          {
            name: 'Active Theme 2',
            active: true,
            communityId: testCommunityId,
          },
          {
            name: 'Inactive Theme',
            active: false,
            communityId: testCommunityId,
          },
        ];

        await themesRepo.create(themeData[0]);
        await themesRepo.create(themeData[1]);
        await themesRepo.create(themeData[2]);

        const activeThemes = await themesRepo.findActiveThemes(testCommunityId);

        expect(activeThemes).toHaveLength(2);
        expect(activeThemes.every((t) => t.active === true)).toBe(true);
        expect(
          activeThemes.every((t) => t.communityId === testCommunityId)
        ).toBe(true);
        expect(activeThemes.map((t) => t.name).sort()).toEqual([
          'Active Theme 1',
          'Active Theme 2',
        ]);
      });

      it('should return empty array if no active themes', async () => {
        await themesRepo.create({
          name: 'Inactive Theme',
          active: false,
          communityId: testCommunityId,
        });

        const activeThemes = await themesRepo.findActiveThemes(testCommunityId);
        expect(activeThemes).toEqual([]);
      });
    });

    describe('update()', () => {
      it('should update theme successfully', async () => {
        const created = await themesRepo.create({
          name: 'Original Theme',
          description: 'Original description',
          active: false,
          communityId: testCommunityId,
        });

        const updateData: UpdateTheme = {
          name: 'Updated Theme',
          description: 'Updated description',
          active: true,
          centerLat: 47.6062,
          centerLong: -122.3321,
        };

        // Add small delay to ensure different timestamp
        await new Promise((resolve) => setTimeout(resolve, 50));
        const updated = await themesRepo.update(created.id, updateData);

        expect(updated).toBeDefined();
        expect(updated!.id).toBe(created.id);
        expect(updated!.name).toBe('Updated Theme');
        expect(updated!.description).toBe('Updated description');
        expect(updated!.active).toBe(true);
        expect(Number(updated!.centerLat)).toBe(47.6062);
        expect(Number(updated!.centerLong)).toBe(-122.3321);
        expect(updated!.communityId).toBe(testCommunityId); // unchanged
        expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(
          created.updatedAt.getTime()
        );
      });

      it('should return null for non-existent theme', async () => {
        const result = await themesRepo.update(999999, { name: 'Updated' });
        expect(result).toBeNull();
      });

      it('should update partial fields only', async () => {
        const created = await themesRepo.create({
          name: 'Partial Update Theme',
          description: 'Original description',
          active: false,
          centerLat: 45.0,
          communityId: testCommunityId,
        });

        const updated = await themesRepo.update(created.id, {
          name: 'New Name Only',
        });

        expect(updated!.name).toBe('New Name Only');
        expect(updated!.description).toBe('Original description'); // unchanged
        expect(updated!.active).toBe(false); // unchanged
        expect(Number(updated!.centerLat)).toBe(45.0); // unchanged
      });
    });

    describe('delete()', () => {
      it('should delete theme successfully', async () => {
        const created = await themesRepo.create({
          name: 'Deletable Theme',
          communityId: testCommunityId,
        });

        const deleted = await themesRepo.delete(created.id);
        expect(deleted).toBe(true);

        // Verify theme is deleted
        const found = await themesRepo.findById(created.id);
        expect(found).toBeNull();
      });

      it('should return false for non-existent theme', async () => {
        const result = await themesRepo.delete(999999);
        expect(result).toBe(false);
      });
    });
  });

  describe('Community Data Isolation', () => {
    it('should isolate themes by community', async () => {
      // Create themes in different communities
      const theme1 = await themesRepo.create({
        name: 'Community 1 Theme',
        communityId: testCommunityId,
      });
      const theme2 = await themesRepo.create({
        name: 'Community 2 Theme',
        communityId: otherCommunityId,
      });

      // Verify community 1 can only see its own themes
      const community1Themes =
        await themesRepo.findByCommunityId(testCommunityId);
      expect(community1Themes).toHaveLength(1);
      expect(community1Themes[0].name).toBe('Community 1 Theme');

      // Verify community 2 can only see its own themes
      const community2Themes =
        await themesRepo.findByCommunityId(otherCommunityId);
      expect(community2Themes).toHaveLength(1);
      expect(community2Themes[0].name).toBe('Community 2 Theme');

      // Verify cross-community access is prevented
      const theme1FromCommunity2 = await themesRepo.findByIdAndCommunity(
        theme1.id,
        otherCommunityId
      );
      expect(theme1FromCommunity2).toBeNull();

      const theme2FromCommunity1 = await themesRepo.findByIdAndCommunity(
        theme2.id,
        testCommunityId
      );
      expect(theme2FromCommunity1).toBeNull();
    });

    it('should enforce community scoping in updates', async () => {
      const theme = await themesRepo.create({
        name: 'Community Scoped Theme',
        communityId: testCommunityId,
      });

      // Try to update from wrong community context - should not find theme
      const result = await themesRepo.updateByCommunity(
        theme.id,
        otherCommunityId,
        { name: 'Hacked Update' }
      );

      expect(result).toBeNull();

      // Verify theme unchanged
      const unchanged = await themesRepo.findById(theme.id);
      expect(unchanged!.name).toBe('Community Scoped Theme');
    });

    it('should enforce community scoping in deletes', async () => {
      const theme = await themesRepo.create({
        name: 'Community Scoped Delete',
        communityId: testCommunityId,
      });

      // Try to delete from wrong community context
      const deleteResult = await themesRepo.deleteByCommunity(
        theme.id,
        otherCommunityId
      );

      expect(deleteResult).toBe(false);

      // Verify theme still exists
      const stillExists = await themesRepo.findById(theme.id);
      expect(stillExists).toBeDefined();
      expect(stillExists!.name).toBe('Community Scoped Delete');
    });
  });

  describe('Geographic Validation', () => {
    it('should validate geographic boundaries', async () => {
      const validTheme: CreateTheme = {
        name: 'Valid Geography Theme',
        centerLat: 45.0,
        centerLong: -123.0,
        swBoundaryLat: 44.0,
        swBoundaryLong: -124.0,
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
        communityId: testCommunityId,
      };

      const result = await themesRepo.create(validTheme);
      expect(result).toBeDefined();

      const validation = await themesRepo.validateGeographicBounds(result.id);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('should detect invalid geographic boundaries', async () => {
      // Create theme with invalid bounds (SW > NE)
      const invalidTheme = await themesRepo.create({
        name: 'Invalid Geography Theme',
        centerLat: 45.0,
        centerLong: -123.0,
        swBoundaryLat: 47.0, // > NE boundary
        swBoundaryLong: -121.0, // > NE boundary
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
        communityId: testCommunityId,
      });

      const validation = await themesRepo.validateGeographicBounds(
        invalidTheme.id
      );
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain(
        'Southwest boundary latitude must be less than northeast boundary latitude'
      );
      expect(validation.errors).toContain(
        'Southwest boundary longitude must be less than northeast boundary longitude'
      );
    });

    it('should validate coordinate ranges', async () => {
      // Test with coordinates out of valid range
      const invalidCoordinates = await themesRepo.create({
        name: 'Invalid Coordinates Theme',
        centerLat: 95.0, // > 90
        centerLong: 185.0, // > 180
        communityId: testCommunityId,
      });

      const validation = await themesRepo.validateGeographicBounds(
        invalidCoordinates.id
      );
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain(
        'Center latitude must be between -90 and 90 degrees'
      );
      expect(validation.errors).toContain(
        'Center longitude must be between -180 and 180 degrees'
      );
    });
  });

  describe('Performance & Indexing', () => {
    it('should efficiently query by community ID', async () => {
      // Create multiple themes
      const themes: CreateTheme[] = Array.from({ length: 20 }, (_, i) => ({
        name: `Performance Theme ${i}`,
        active: i % 2 === 0, // Mix of active/inactive
        communityId: testCommunityId,
      }));

      // Batch create themes
      for (const themeData of themes) {
        await themesRepo.create(themeData);
      }

      // Query should be fast with proper indexing
      const start = Date.now();
      const results = await themesRepo.findByCommunityId(testCommunityId);
      const duration = Date.now() - start;

      expect(results).toHaveLength(20);
      expect(duration).toBeLessThan(50); // Should be very fast with index
    });

    it('should efficiently query active themes', async () => {
      // Create mix of active/inactive themes
      const activeThemes = Array.from({ length: 10 }, (_, i) => ({
        name: `Active Theme ${i}`,
        active: true,
        communityId: testCommunityId,
      }));
      const inactiveThemes = Array.from({ length: 10 }, (_, i) => ({
        name: `Inactive Theme ${i}`,
        active: false,
        communityId: testCommunityId,
      }));

      for (const theme of [...activeThemes, ...inactiveThemes]) {
        await themesRepo.create(theme);
      }

      const start = Date.now();
      const results = await themesRepo.findActiveThemes(testCommunityId);
      const duration = Date.now() - start;

      expect(results).toHaveLength(10);
      expect(results.every((t) => t.active)).toBe(true);
      expect(duration).toBeLessThan(30); // Compound index should be very fast
    });

    it('should support pagination for large result sets', async () => {
      // Create 50 themes
      const themes: CreateTheme[] = Array.from({ length: 50 }, (_, i) => ({
        name: `Paginated Theme ${i.toString().padStart(2, '0')}`,
        communityId: testCommunityId,
      }));

      for (const theme of themes) {
        await themesRepo.create(theme);
      }

      // Test pagination
      const page1 = await themesRepo.findByCommunityIdPaginated(
        testCommunityId,
        { page: 1, limit: 20 }
      );
      expect(page1.themes).toHaveLength(20);
      expect(page1.total).toBe(50);
      expect(page1.page).toBe(1);
      expect(page1.totalPages).toBe(3);

      const page2 = await themesRepo.findByCommunityIdPaginated(
        testCommunityId,
        { page: 2, limit: 20 }
      );
      expect(page2.themes).toHaveLength(20);
      expect(page2.page).toBe(2);

      const page3 = await themesRepo.findByCommunityIdPaginated(
        testCommunityId,
        { page: 3, limit: 20 }
      );
      expect(page3.themes).toHaveLength(10);
      expect(page3.page).toBe(3);

      // Verify no theme duplication between pages
      const allIds = [
        ...page1.themes.map((t) => t.id),
        ...page2.themes.map((t) => t.id),
        ...page3.themes.map((t) => t.id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(50); // No duplicates
    });
  });

  describe('Search and Filtering', () => {
    beforeEach(async () => {
      // Create test themes with various properties
      const testThemes: CreateTheme[] = [
        {
          name: 'Urban Streets Theme',
          description: 'Theme for urban mapping with street details',
          active: true,
          communityId: testCommunityId,
        },
        {
          name: 'Satellite Nature Theme',
          description: 'Satellite imagery for nature visualization',
          active: true,
          communityId: testCommunityId,
        },
        {
          name: 'Historical Map Theme',
          description: 'Historical context mapping',
          active: false,
          communityId: testCommunityId,
        },
        {
          name: 'Terrain Elevation Theme',
          description: 'Topographic and elevation data',
          active: true,
          communityId: testCommunityId,
        },
      ];

      for (const theme of testThemes) {
        await themesRepo.create(theme);
      }
    });

    it('should search themes by name', async () => {
      const results = await themesRepo.searchByName(testCommunityId, 'theme');
      expect(results).toHaveLength(4); // All contain 'theme'

      const streetResults = await themesRepo.searchByName(
        testCommunityId,
        'street'
      );
      expect(streetResults).toHaveLength(1);
      expect(streetResults[0].name).toBe('Urban Streets Theme');
    });

    it('should search themes by description', async () => {
      const mappingResults = await themesRepo.searchByDescription(
        testCommunityId,
        'mapping'
      );
      expect(mappingResults).toHaveLength(2); // Urban and Historical themes

      const natureResults = await themesRepo.searchByDescription(
        testCommunityId,
        'nature'
      );
      expect(natureResults).toHaveLength(1);
      expect(natureResults[0].name).toBe('Satellite Nature Theme');
    });

    it('should filter themes by active status', async () => {
      const activeResults = await themesRepo.findActiveThemes(testCommunityId);
      expect(activeResults).toHaveLength(3);

      const allResults = await themesRepo.findByCommunityId(testCommunityId);
      const inactiveCount = allResults.filter((t) => !t.active).length;
      expect(inactiveCount).toBe(1);
    });

    it('should support combined search and filtering', async () => {
      const results = await themesRepo.searchActiveThemes(
        testCommunityId,
        'theme'
      );
      expect(results).toHaveLength(3); // Only active themes containing 'theme'
      expect(results.every((t) => t.active)).toBe(true);
    });
  });
});
