/**
 * Themes schema tests
 *
 * Tests the themes table schema with both PostgreSQL and SQLite compatibility
 * Validates Rails compatibility and geographic coordinate validation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testDb, type TestDatabase } from '../../helpers/database.js';
import {
  themesSqlite as themes,
  createThemeSchema,
  updateThemeSchema,
  GeographicBoundsSchema,
  MapboxStyleUrlSchema,
  type Theme,
  type CreateTheme,
} from '../../../src/db/schema/themes.js';
import { communitiesSqlite as communities } from '../../../src/db/schema/communities.js';
import { eq } from 'drizzle-orm';

describe('Themes Schema', () => {
  let db: TestDatabase;
  let testCommunityId: number;

  beforeAll(async () => {
    db = await testDb.getDb();

    // Create test community
    const testCommunity = await db
      .insert(communities)
      .values({
        name: 'Test Community',
        slug: 'test-themes-community',
        description: 'Community for testing themes schema',
      })
      .returning({ id: communities.id });

    testCommunityId = testCommunity[0].id;
  });

  beforeEach(async () => {
    // Clean themes table before each test but preserve the community
    await db.delete(themes);

    // Ensure we have a fresh test community for each test
    if (testCommunityId) {
      // Check if community still exists
      const existingCommunity = await db
        .select()
        .from(communities)
        .where(eq(communities.id, testCommunityId));

      if (existingCommunity.length === 0) {
        // Recreate test community if it was deleted
        const testCommunity = await db
          .insert(communities)
          .values({
            name: 'Test Community',
            slug: `test-themes-community-${Date.now()}`,
            description: 'Community for testing themes schema',
          })
          .returning({ id: communities.id });

        testCommunityId = testCommunity[0].id;
      }
    }
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(themes);
    await db.delete(communities).where(eq(communities.id, testCommunityId));
  });

  describe('Table Structure & Rails Compatibility', () => {
    it('should create theme with all Rails-compatible fields', async () => {
      const themeData: CreateTheme = {
        name: 'Test Theme',
        description: 'A test theme for validation',
        mapboxStyleUrl: 'mapbox://styles/user/styleid',
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

      const result = await db.insert(themes).values(themeData).returning();
      expect(result).toHaveLength(1);

      const theme = result[0];
      expect(theme.name).toBe('Test Theme');
      expect(theme.description).toBe('A test theme for validation');
      expect(theme.mapboxStyleUrl).toBe('mapbox://styles/user/styleid');
      expect(theme.mapboxAccessToken).toBe('pk.test.token');
      expect(Number(theme.centerLat)).toBe(45.0);
      expect(Number(theme.centerLong)).toBe(-123.0);
      expect(Number(theme.swBoundaryLat)).toBe(44.0);
      expect(Number(theme.swBoundaryLong)).toBe(-124.0);
      expect(Number(theme.neBoundaryLat)).toBe(46.0);
      expect(Number(theme.neBoundaryLong)).toBe(-122.0);
      expect(theme.active).toBe(true);
      expect(theme.communityId).toBe(testCommunityId);
      expect(theme.createdAt).toBeInstanceOf(Date);
      expect(theme.updatedAt).toBeInstanceOf(Date);
    });

    it('should create theme with minimal required fields', async () => {
      const themeData: CreateTheme = {
        name: 'Minimal Theme',
        communityId: testCommunityId,
      };

      const result = await db.insert(themes).values(themeData).returning();
      expect(result).toHaveLength(1);

      const theme = result[0];
      expect(theme.name).toBe('Minimal Theme');
      expect(theme.description).toBeNull();
      expect(theme.active).toBe(false); // default value
      expect(theme.communityId).toBe(testCommunityId);
    });

    it('should handle decimal precision for coordinates correctly', async () => {
      const themeData: CreateTheme = {
        name: 'Precision Theme',
        centerLat: 45.123456,
        centerLong: -123.654321,
        swBoundaryLat: 44.111111,
        swBoundaryLong: -124.222222,
        neBoundaryLat: 46.333333,
        neBoundaryLong: -122.444444,
        communityId: testCommunityId,
      };

      const result = await db.insert(themes).values(themeData).returning();
      const theme = result[0];

      // Test 6 decimal places precision (as per Rails schema)
      expect(Number(theme.centerLat)).toBeCloseTo(45.123456, 6);
      expect(Number(theme.centerLong)).toBeCloseTo(-123.654321, 6);
      expect(Number(theme.swBoundaryLat)).toBeCloseTo(44.111111, 6);
      expect(Number(theme.swBoundaryLong)).toBeCloseTo(-124.222222, 6);
      expect(Number(theme.neBoundaryLat)).toBeCloseTo(46.333333, 6);
      expect(Number(theme.neBoundaryLong)).toBeCloseTo(-122.444444, 6);
    });
  });

  describe('Database Constraints & Validation', () => {
    it('should enforce non-null constraint on name', async () => {
      const invalidData = {
        communityId: testCommunityId,
        // name is missing
      };

      await expect(
        db.insert(themes).values(invalidData as any)
      ).rejects.toThrow();
    });

    it('should enforce non-null constraint on communityId', async () => {
      const invalidData = {
        name: 'Test Theme',
        // communityId is missing
      };

      await expect(
        db.insert(themes).values(invalidData as any)
      ).rejects.toThrow();
    });

    it('should enforce foreign key constraint on communityId', async () => {
      const invalidData: CreateTheme = {
        name: 'Invalid Community Theme',
        communityId: 999999, // non-existent community
      };

      await expect(db.insert(themes).values(invalidData)).rejects.toThrow();
    });

    it('should set default values correctly', async () => {
      const themeData: CreateTheme = {
        name: 'Default Test Theme',
        communityId: testCommunityId,
      };

      const result = await db.insert(themes).values(themeData).returning();
      const theme = result[0];

      expect(theme.active).toBe(false); // default false
      expect(theme.description).toBeNull();
      expect(theme.mapboxStyleUrl).toBeNull();
      expect(theme.mapboxAccessToken).toBeNull();
      expect(theme.centerLat).toBeNull();
      expect(theme.centerLong).toBeNull();
      expect(theme.swBoundaryLat).toBeNull();
      expect(theme.swBoundaryLong).toBeNull();
      expect(theme.neBoundaryLat).toBeNull();
      expect(theme.neBoundaryLong).toBeNull();
    });
  });

  describe('Geographic Validation', () => {
    it('should validate geographic bounds with GeographicBoundsSchema', () => {
      const validBounds = {
        centerLat: 45.0,
        centerLong: -123.0,
        swBoundaryLat: 44.0,
        swBoundaryLong: -124.0,
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
      };

      const result = GeographicBoundsSchema.safeParse(validBounds);
      expect(result.success).toBe(true);
    });

    it('should reject invalid latitude ranges', () => {
      const invalidBounds = {
        centerLat: 91.0, // > 90
        centerLong: -123.0,
        swBoundaryLat: 44.0,
        swBoundaryLong: -124.0,
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
      };

      const result = GeographicBoundsSchema.safeParse(invalidBounds);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('centerLat');
    });

    it('should reject invalid longitude ranges', () => {
      const invalidBounds = {
        centerLat: 45.0,
        centerLong: 181.0, // > 180
        swBoundaryLat: 44.0,
        swBoundaryLong: -124.0,
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
      };

      const result = GeographicBoundsSchema.safeParse(invalidBounds);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('centerLong');
    });

    it('should reject SW boundary > NE boundary (latitude)', () => {
      const invalidBounds = {
        centerLat: 45.0,
        centerLong: -123.0,
        swBoundaryLat: 47.0, // > NE
        swBoundaryLong: -124.0,
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
      };

      const result = GeographicBoundsSchema.safeParse(invalidBounds);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('swBoundaryLat');
    });

    it('should reject SW boundary > NE boundary (longitude)', () => {
      const invalidBounds = {
        centerLat: 45.0,
        centerLong: -123.0,
        swBoundaryLat: 44.0,
        swBoundaryLong: -121.0, // > NE
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
      };

      const result = GeographicBoundsSchema.safeParse(invalidBounds);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toContain('swBoundaryLong');
    });
  });

  describe('Mapbox Integration Validation', () => {
    it('should validate correct Mapbox style URL format', () => {
      const validUrls = [
        'mapbox://styles/mapbox/streets-v11',
        'mapbox://styles/user/custom-style',
        'mapbox://styles/organization/team-style',
      ];

      validUrls.forEach((url) => {
        const result = MapboxStyleUrlSchema.safeParse(url);
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid Mapbox style URL formats', () => {
      const invalidUrls = [
        'https://api.mapbox.com/styles/v1/mapbox/streets-v11',
        'mapbox://tiles/streets-v11',
        'styles/mapbox/streets-v11',
        'not-a-url',
      ];

      invalidUrls.forEach((url) => {
        const result = MapboxStyleUrlSchema.safeParse(url);
        expect(result.success).toBe(false);
      });
    });

    it('should allow empty string for mapbox style URL', () => {
      const result = MapboxStyleUrlSchema.safeParse('');
      expect(result.success).toBe(true);
    });
  });

  describe('Community Data Isolation', () => {
    it('should allow multiple themes per community', async () => {
      const theme1: CreateTheme = {
        name: 'Theme 1',
        communityId: testCommunityId,
      };
      const theme2: CreateTheme = {
        name: 'Theme 2',
        communityId: testCommunityId,
      };

      await db.insert(themes).values([theme1, theme2]);

      const communityThemes = await db
        .select()
        .from(themes)
        .where(eq(themes.communityId, testCommunityId));

      expect(communityThemes).toHaveLength(2);
      expect(communityThemes.map((t) => t.name)).toEqual([
        'Theme 1',
        'Theme 2',
      ]);
    });

    it('should isolate themes by community', async () => {
      // Create another test community
      const otherCommunity = await db
        .insert(communities)
        .values({
          name: 'Other Community',
          slug: 'other-themes-community',
          description: 'Other community for isolation testing',
        })
        .returning({ id: communities.id });

      const otherCommunityId = otherCommunity[0].id;

      // Create themes in both communities
      await db.insert(themes).values([
        { name: 'Theme 1', communityId: testCommunityId },
        { name: 'Theme 2', communityId: otherCommunityId },
      ]);

      // Verify isolation
      const community1Themes = await db
        .select()
        .from(themes)
        .where(eq(themes.communityId, testCommunityId));

      const community2Themes = await db
        .select()
        .from(themes)
        .where(eq(themes.communityId, otherCommunityId));

      expect(community1Themes).toHaveLength(1);
      expect(community1Themes[0].name).toBe('Theme 1');
      expect(community2Themes).toHaveLength(1);
      expect(community2Themes[0].name).toBe('Theme 2');

      // Clean up - delete themes first to avoid foreign key constraint
      await db.delete(themes).where(eq(themes.communityId, otherCommunityId));
      await db.delete(communities).where(eq(communities.id, otherCommunityId));
    });
  });

  describe('Zod Schema Validation', () => {
    it('should validate createThemeSchema with valid data', () => {
      const validData: CreateTheme = {
        name: 'Valid Theme',
        description: 'A valid theme description',
        mapboxStyleUrl: 'mapbox://styles/mapbox/streets-v11',
        mapboxAccessToken: 'pk.test.token',
        centerLat: 45.0,
        centerLong: -123.0,
        swBoundaryLat: 44.0,
        swBoundaryLong: -124.0,
        neBoundaryLat: 46.0,
        neBoundaryLong: -122.0,
        active: true,
        communityId: 1,
      };

      const result = createThemeSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject createThemeSchema with invalid data', () => {
      const invalidData = {
        name: '', // empty string
        communityId: -1, // negative number
        centerLat: 91.0, // invalid latitude
      };

      const result = createThemeSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(3); // name, communityId, centerLat
    });

    it('should validate updateThemeSchema excludes communityId', () => {
      const updateData = {
        name: 'Updated Theme',
        communityId: 999, // should not be allowed in updates
      };

      const result = updateThemeSchema.safeParse(updateData);
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('communityId');
    });

    it('should validate geographic bounds in createThemeSchema', () => {
      const invalidBoundsData: CreateTheme = {
        name: 'Invalid Bounds Theme',
        swBoundaryLat: 47.0, // > NE boundary
        neBoundaryLat: 46.0,
        swBoundaryLong: -122.0, // > NE boundary
        neBoundaryLong: -123.0,
        communityId: 1,
      };

      const result = createThemeSchema.safeParse(invalidBoundsData);
      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(2); // both lat and long boundary errors
    });
  });

  describe('Performance & Indexing', () => {
    it('should support querying by communityId efficiently', async () => {
      // Create multiple themes across different communities
      const themes1 = Array.from({ length: 10 }, (_, i) => ({
        name: `Community 1 Theme ${i}`,
        communityId: testCommunityId,
      }));

      await db.insert(themes).values(themes1);

      // Query should be fast with proper indexing
      const start = Date.now();
      const results = await db
        .select()
        .from(themes)
        .where(eq(themes.communityId, testCommunityId));
      const duration = Date.now() - start;

      expect(results).toHaveLength(10);
      expect(duration).toBeLessThan(100); // Should be very fast with proper indexing
    });

    it('should support querying active themes efficiently', async () => {
      // Create mix of active and inactive themes
      await db.insert(themes).values([
        { name: 'Active Theme 1', active: true, communityId: testCommunityId },
        { name: 'Active Theme 2', active: true, communityId: testCommunityId },
        {
          name: 'Inactive Theme 1',
          active: false,
          communityId: testCommunityId,
        },
        {
          name: 'Inactive Theme 2',
          active: false,
          communityId: testCommunityId,
        },
      ]);

      const activeThemes = await db
        .select()
        .from(themes)
        .where(eq(themes.active, true));

      expect(activeThemes).toHaveLength(2);
      expect(activeThemes.every((t) => t.active)).toBe(true);
    });

    it('should support compound queries (community + active) efficiently', async () => {
      // Create themes in different states
      await db.insert(themes).values([
        {
          name: 'Community Active',
          active: true,
          communityId: testCommunityId,
        },
        {
          name: 'Community Inactive',
          active: false,
          communityId: testCommunityId,
        },
      ]);

      const start = Date.now();
      const results = await db
        .select()
        .from(themes)
        .where(eq(themes.communityId, testCommunityId))
        .where(eq(themes.active, true));
      const duration = Date.now() - start;

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Community Active');
      expect(duration).toBeLessThan(50); // Compound index should make this very fast
    });
  });
});
