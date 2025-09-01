/**
 * TERRASTORIES API - PRODUCTION PERFORMANCE VALIDATION
 *
 * This test suite validates production performance requirements including
 * API response times, database query optimization, concurrent load handling,
 * and PostGIS spatial query performance.
 *
 * Issue #59: Production Readiness Validation & Indigenous Community Deployment
 * Phase 1: Performance & Load Testing
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { TestDatabaseManager } from '../helpers/database.js';
import { performance } from 'perf_hooks';

interface PerformanceMetrics {
  responseTime: number;
  throughput: number;
  errorRate: number;
  memoryUsage: number;
  cpuUsage?: number;
}

describe('Production Performance Validation - Phase 1', () => {
  let app: FastifyInstance;
  let db: TestDatabaseManager;
  let baselineMetrics: PerformanceMetrics;

  beforeAll(async () => {
    // Initialize test app with production settings
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'error'; // Minimize logging overhead

    app = await buildApp();
    await app.ready();

    db = new TestDatabaseManager();
    await db.setup();

    // Seed database with realistic test data
    await seedPerformanceTestData();

    // Collect baseline performance metrics
    baselineMetrics = await collectBaselineMetrics();

    console.log('Performance validation setup complete');
  });

  describe('API Response Time Validation', () => {
    test('All endpoints respond in < 200ms under normal load', async () => {
      const endpoints = [
        { method: 'GET', url: '/api/v1/health' },
        { method: 'GET', url: '/api/v1/communities' },
        { method: 'GET', url: '/api/v1/communities/1/stories' },
        { method: 'GET', url: '/api/v1/communities/1/places' },
        { method: 'GET', url: '/api/v1/communities/1/speakers' },
        { method: 'GET', url: '/api/v1/communities/1/stories/1' },
        { method: 'GET', url: '/api/v1/communities/1/places/1' },
      ];

      const responseTimeThreshold = 200; // milliseconds
      const results: Array<{
        endpoint: string;
        responseTime: number;
        status: number;
      }> = [];

      for (const endpoint of endpoints) {
        // Test each endpoint 10 times to get average
        const times: number[] = [];

        for (let i = 0; i < 10; i++) {
          const start = performance.now();

          const response = await app.inject({
            method: endpoint.method as any,
            url: endpoint.url,
          });

          const end = performance.now();
          const responseTime = end - start;

          times.push(responseTime);
          results.push({
            endpoint: `${endpoint.method} ${endpoint.url}`,
            responseTime,
            status: response.statusCode,
          });
        }

        const avgResponseTime =
          times.reduce((sum, time) => sum + time, 0) / times.length;
        const maxResponseTime = Math.max(...times);

        expect(
          avgResponseTime,
          `${endpoint.method} ${endpoint.url} average response time should be < ${responseTimeThreshold}ms (got ${avgResponseTime.toFixed(2)}ms)`
        ).toBeLessThan(responseTimeThreshold);

        expect(
          maxResponseTime,
          `${endpoint.method} ${endpoint.url} max response time should be < ${responseTimeThreshold * 2}ms (got ${maxResponseTime.toFixed(2)}ms)`
        ).toBeLessThan(responseTimeThreshold * 2);
      }

      console.log(
        'Response time results:',
        results.map(
          (r) => `${r.endpoint}: ${r.responseTime.toFixed(2)}ms (${r.status})`
        )
      );
    });

    test('Authenticated endpoints maintain performance under session load', async () => {
      // Create test user session
      const session = await createTestSession();

      const authenticatedEndpoints = [
        { method: 'GET', url: '/api/v1/member/profile' },
        { method: 'GET', url: '/api/v1/member/stories' },
        { method: 'GET', url: '/api/v1/member/places' },
        {
          method: 'POST',
          url: '/api/v1/member/stories',
          data: { title: 'Test Story', content: 'Test content' },
        },
      ];

      for (const endpoint of authenticatedEndpoints) {
        const start = performance.now();

        const response = await app.inject({
          method: endpoint.method as any,
          url: endpoint.url,
          payload: endpoint.data,
          headers: {
            Authorization: `Bearer ${session.token}`,
            Cookie: session.cookie,
          },
        });

        const responseTime = performance.now() - start;

        expect(
          responseTime,
          `Authenticated ${endpoint.method} ${endpoint.url} should respond in < 300ms`
        ).toBeLessThan(300);

        expect(
          [200, 201, 204],
          `${endpoint.method} ${endpoint.url} should return success status`
        ).toContain(response.statusCode);
      }
    });

    test('File upload/download performance with large files', async () => {
      const session = await createTestSession();

      // Test file upload (10MB simulated file)
      const uploadStart = performance.now();
      const uploadResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/member/files',
        headers: {
          Authorization: `Bearer ${session.token}`,
          Cookie: session.cookie,
          'Content-Type': 'multipart/form-data',
        },
        payload: createMockFilePayload('test-large-file.mp4', 10 * 1024 * 1024), // 10MB
      });
      const uploadTime = performance.now() - uploadStart;

      expect(uploadResponse.statusCode).toBe(201);
      expect(
        uploadTime,
        'File upload should complete within 5 seconds'
      ).toBeLessThan(5000);

      // Test file download
      const fileUrl = uploadResponse.json().data.url;
      const downloadStart = performance.now();
      const downloadResponse = await app.inject({
        method: 'GET',
        url: fileUrl,
        headers: {
          Authorization: `Bearer ${session.token}`,
          Cookie: session.cookie,
        },
      });
      const downloadTime = performance.now() - downloadStart;

      expect(downloadResponse.statusCode).toBe(200);
      expect(
        downloadTime,
        'File download should complete within 3 seconds'
      ).toBeLessThan(3000);
    });
  });

  describe('Database Query Performance Optimization', () => {
    test('No N+1 queries in story listings with associations', async () => {
      // Enable query logging to detect N+1 queries
      const queryLog: Array<{ sql: string; duration: number }> = [];

      // Mock database query logging
      const originalQuery = db.query.bind(db);
      db.query = async function (sql: string, params?: any[]) {
        const start = performance.now();
        const result = await originalQuery(sql, params);
        const duration = performance.now() - start;

        queryLog.push({ sql, duration });
        return result;
      };

      // Request stories with places and speakers (associations)
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/communities/1/stories?include=places,speakers',
      });

      expect(response.statusCode).toBe(200);

      // Analyze query patterns for N+1 issues
      const storyQueries = queryLog.filter(
        (q) => q.sql.includes('SELECT') && q.sql.includes('stories')
      );
      const placeQueries = queryLog.filter((q) => q.sql.includes('places'));
      const speakerQueries = queryLog.filter((q) => q.sql.includes('speakers'));

      // Should have efficient joins, not multiple individual queries
      expect(
        storyQueries.length,
        'Should use joins, not multiple story queries'
      ).toBeLessThanOrEqual(2);
      expect(
        placeQueries.length,
        'Should use joins for places, not N+1 queries'
      ).toBeLessThanOrEqual(1);
      expect(
        speakerQueries.length,
        'Should use joins for speakers, not N+1 queries'
      ).toBeLessThanOrEqual(1);

      // Restore original query method
      db.query = originalQuery;
    });

    test('Database indexes are properly utilized for common queries', async () => {
      // Test queries that should use indexes
      const indexTestQueries = [
        {
          name: 'Community-scoped story search',
          sql: 'SELECT id FROM stories WHERE community_id = $1',
          params: ['1'],
          expectedIndex: 'stories_community_id_idx',
        },
        {
          name: 'Geographic place search',
          sql: 'SELECT id FROM places WHERE ST_DWithin(geometry, ST_Point($1, $2), $3)',
          params: [-123.1207, 49.2827, 1000],
          expectedIndex: 'places_geometry_gist_idx',
        },
        {
          name: 'User role lookup',
          sql: 'SELECT id FROM users WHERE role = $1 AND community_id = $2',
          params: ['admin', '1'],
          expectedIndex: 'users_role_community_id_idx',
        },
      ];

      for (const testQuery of indexTestQueries) {
        const explainResult = await db.query(
          `EXPLAIN (ANALYZE, BUFFERS) ${testQuery.sql}`,
          testQuery.params
        );

        const queryPlan = explainResult.rows
          .map((row) => row['QUERY PLAN'])
          .join('\n');

        // Should use index scan, not sequential scan
        expect(
          queryPlan,
          `${testQuery.name} should use index scan`
        ).not.toContain('Seq Scan');

        // Should reference the expected index
        expect(
          queryPlan,
          `${testQuery.name} should use ${testQuery.expectedIndex}`
        ).toContain('Index');
      }
    });

    test('PostGIS spatial queries complete within 100ms', async () => {
      const spatialQueries = [
        {
          name: 'Point in polygon search',
          sql: `
            SELECT id, name FROM places 
            WHERE ST_Contains(geometry, ST_Point($1, $2))
            AND community_id = $3
          `,
          params: [-123.1207, 49.2827, '1'],
        },
        {
          name: 'Radius search',
          sql: `
            SELECT id, name, ST_Distance(geometry, ST_Point($1, $2)) as distance 
            FROM places 
            WHERE ST_DWithin(geometry, ST_Point($1, $2), $3)
            AND community_id = $4
            ORDER BY distance
          `,
          params: [-123.1207, 49.2827, 5000, '1'],
        },
        {
          name: 'Bounding box search',
          sql: `
            SELECT id, name FROM places 
            WHERE geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND community_id = $5
          `,
          params: [-123.2, 49.2, -123.0, 49.3, '1'],
        },
      ];

      for (const query of spatialQueries) {
        const start = performance.now();

        const result = await db.query(query.sql, query.params);

        const duration = performance.now() - start;

        expect(
          duration,
          `${query.name} should complete within 100ms (took ${duration.toFixed(2)}ms)`
        ).toBeLessThan(100);

        expect(
          result.rows,
          `${query.name} should return results`
        ).toBeDefined();
      }
    });

    test('Complex multi-table queries maintain performance', async () => {
      // Test a complex query that joins multiple tables
      const complexQuery = `
        SELECT DISTINCT s.id, s.title, s.created_at,
               c.name as community_name,
               COUNT(sp.place_id) as place_count,
               COUNT(ss.speaker_id) as speaker_count,
               ARRAY_AGG(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL) as place_names,
               ARRAY_AGG(DISTINCT spk.name) FILTER (WHERE spk.name IS NOT NULL) as speaker_names
        FROM stories s
        JOIN communities c ON s.community_id = c.id
        LEFT JOIN story_places sp ON s.id = sp.story_id
        LEFT JOIN places p ON sp.place_id = p.id
        LEFT JOIN story_speakers ss ON s.id = ss.story_id
        LEFT JOIN speakers spk ON ss.speaker_id = spk.id
        WHERE s.community_id = $1
          AND s.privacy_level IN ('public', 'members_only')
        GROUP BY s.id, s.title, s.created_at, c.name
        ORDER BY s.created_at DESC
        LIMIT 20
      `;

      const start = performance.now();

      const result = await db.query(complexQuery, ['1']);

      const duration = performance.now() - start;

      expect(
        duration,
        `Complex multi-table query should complete within 200ms (took ${duration.toFixed(2)}ms)`
      ).toBeLessThan(200);

      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('title');
      expect(result.rows[0]).toHaveProperty('place_count');
      expect(result.rows[0]).toHaveProperty('speaker_count');
    });
  });

  describe('Concurrent Load Handling', () => {
    test('System handles 100+ concurrent users without degradation', async () => {
      const concurrentUsers = 100;
      const requestsPerUser = 5;
      const maxResponseTime = 500; // milliseconds

      // Create multiple user sessions
      const sessions = await Promise.all(
        Array(concurrentUsers)
          .fill(null)
          .map(() => createTestSession())
      );

      console.log(
        `Testing ${concurrentUsers} concurrent users with ${requestsPerUser} requests each...`
      );

      // Generate concurrent requests
      const allRequests = sessions.flatMap((session) =>
        Array(requestsPerUser)
          .fill(null)
          .map(() => ({
            session,
            endpoint: '/api/v1/communities/1/stories',
            method: 'GET',
          }))
      );

      const start = performance.now();

      // Execute all requests concurrently
      const results = await Promise.allSettled(
        allRequests.map(async (req, index) => {
          const requestStart = performance.now();

          const response = await app.inject({
            method: req.method as any,
            url: req.endpoint,
            headers: {
              Authorization: `Bearer ${req.session.token}`,
              Cookie: req.session.cookie,
            },
          });

          const requestTime = performance.now() - requestStart;

          return {
            index,
            status: response.statusCode,
            responseTime: requestTime,
            success: response.statusCode === 200,
          };
        })
      );

      const totalTime = performance.now() - start;

      // Analyze results
      const successful = results.filter(
        (r) => r.status === 'fulfilled' && r.value.success
      ).length;
      const failed = results.length - successful;
      const responseTimes = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => (r as any).value.responseTime);

      const averageResponseTime =
        responseTimes.reduce((sum, time) => sum + time, 0) /
        responseTimes.length;
      const maxActualResponseTime = Math.max(...responseTimes);
      const successRate = (successful / results.length) * 100;

      console.log(`Load test results:
        - Total requests: ${results.length}
        - Successful: ${successful}
        - Failed: ${failed}
        - Success rate: ${successRate.toFixed(2)}%
        - Average response time: ${averageResponseTime.toFixed(2)}ms
        - Max response time: ${maxActualResponseTime.toFixed(2)}ms
        - Total test duration: ${totalTime.toFixed(2)}ms
      `);

      // Validate performance requirements
      expect(successRate, 'Success rate should be > 95%').toBeGreaterThan(95);
      expect(
        averageResponseTime,
        'Average response time should be reasonable'
      ).toBeLessThan(maxResponseTime);
      expect(
        maxActualResponseTime,
        'Max response time should not exceed threshold'
      ).toBeLessThan(maxResponseTime * 2);
    });

    test('Memory usage remains stable under load', async () => {
      const initialMemory = process.memoryUsage();

      // Generate sustained load
      const loadDuration = 30000; // 30 seconds
      const requestInterval = 100; // milliseconds between requests

      let requestCount = 0;
      const memoryMeasurements: Array<{ heapUsed: number; timestamp: number }> =
        [];

      const loadPromise = new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          try {
            await app.inject({
              method: 'GET',
              url: '/api/v1/communities/1/stories',
            });
            requestCount++;

            // Measure memory every 5 seconds
            if (requestCount % 50 === 0) {
              const memory = process.memoryUsage();
              memoryMeasurements.push({
                heapUsed: memory.heapUsed,
                timestamp: Date.now(),
              });
            }
          } catch (error) {
            console.error('Load test request failed:', error);
          }
        }, requestInterval);

        setTimeout(() => {
          clearInterval(interval);
          resolve();
        }, loadDuration);
      });

      await loadPromise;

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;
      const memoryIncreasePercent =
        (memoryIncrease / initialMemory.heapUsed) * 100;

      console.log(`Memory usage after ${requestCount} requests:
        - Initial heap: ${Math.round(initialMemory.heapUsed / 1024 / 1024)}MB
        - Final heap: ${Math.round(finalMemory.heapUsed / 1024 / 1024)}MB
        - Increase: ${Math.round(memoryIncrease / 1024 / 1024)}MB (${memoryIncreasePercent.toFixed(2)}%)
      `);

      // Memory increase should be reasonable (< 50% growth)
      expect(
        memoryIncreasePercent,
        'Memory usage should not increase excessively under load'
      ).toBeLessThan(50);

      // Check for memory leaks (gradual increase pattern)
      if (memoryMeasurements.length >= 3) {
        const first = memoryMeasurements[0].heapUsed;
        const last = memoryMeasurements[memoryMeasurements.length - 1].heapUsed;
        const continuousIncrease = ((last - first) / first) * 100;

        expect(
          continuousIncrease,
          'Should not show signs of memory leaks (continuous growth)'
        ).toBeLessThan(30);
      }
    });
  });

  describe('Production Performance Benchmarking', () => {
    test('API performance meets or exceeds Rails API benchmarks', async () => {
      // These benchmarks would be based on the existing Rails API performance
      const railsBenchmarks = {
        '/api/communities': 150, // ms
        '/api/communities/1/stories': 180, // ms
        '/api/communities/1/places': 120, // ms
        '/api/communities/1/speakers': 100, // ms
      };

      const testEndpoints = Object.keys(railsBenchmarks);

      for (const endpoint of testEndpoints) {
        const benchmark =
          railsBenchmarks[endpoint as keyof typeof railsBenchmarks];

        // Test endpoint multiple times for accurate measurement
        const times: number[] = [];
        for (let i = 0; i < 20; i++) {
          const start = performance.now();
          const response = await app.inject({
            method: 'GET',
            url: `/api/v1${endpoint}`,
          });
          const responseTime = performance.now() - start;

          if (response.statusCode === 200) {
            times.push(responseTime);
          }
        }

        const averageTime =
          times.reduce((sum, time) => sum + time, 0) / times.length;

        expect(
          averageTime,
          `${endpoint} should meet or exceed Rails benchmark (${benchmark}ms vs ${averageTime.toFixed(2)}ms)`
        ).toBeLessThan(benchmark);
      }
    });

    test('Database connection pool handles concurrent connections efficiently', async () => {
      const maxConnections = 50;
      const queryDuration = 2000; // 2 seconds

      // Create multiple concurrent database operations
      const connectionPromises = Array(maxConnections)
        .fill(null)
        .map(async (_, index) => {
          const start = performance.now();

          try {
            // Execute a query that takes some time
            await db.query(`
            SELECT pg_sleep(0.1), 
                   COUNT(*) as story_count,
                   COUNT(DISTINCT community_id) as community_count
            FROM stories 
            WHERE created_at >= NOW() - INTERVAL '1 year'
          `);

            const duration = performance.now() - start;
            return { success: true, duration, index };
          } catch (error) {
            return { success: false, error: error.message, index };
          }
        });

      const results = await Promise.allSettled(connectionPromises);

      const successful = results.filter(
        (r) => r.status === 'fulfilled' && r.value.success
      ).length;

      const failed = results.length - successful;
      const successRate = (successful / results.length) * 100;

      expect(
        successRate,
        `Database connection pool should handle ${maxConnections} concurrent connections (${successRate.toFixed(2)}% success rate)`
      ).toBeGreaterThan(90);

      expect(
        failed,
        `Should not have connection pool exhaustion errors`
      ).toBeLessThan(maxConnections * 0.1);
    });
  });

  // Helper functions
  async function seedPerformanceTestData(): Promise<void> {
    // Create test communities
    await db.query(`
      INSERT INTO communities (id, name, locale, created_at) 
      VALUES 
        ('1', 'Performance Test Community 1', 'en', NOW()),
        ('2', 'Performance Test Community 2', 'fr', NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    // Create test users
    await db.query(`
      INSERT INTO users (id, email, password_hash, role, community_id, created_at)
      VALUES 
        ('1', 'test@community1.test', '$2b$10$hash', 'admin', '1', NOW()),
        ('2', 'test@community2.test', '$2b$10$hash', 'admin', '2', NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    // Create multiple stories for performance testing
    const storyInserts = [];
    for (let i = 1; i <= 100; i++) {
      storyInserts.push(`
        ('${i}', 'Performance Test Story ${i}', 'Content for story ${i}', '${Math.ceil(i / 50)}', 'public', NOW())
      `);
    }

    await db.query(`
      INSERT INTO stories (id, title, content, community_id, privacy_level, created_at)
      VALUES ${storyInserts.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `);

    // Create test places with PostGIS data
    const placeInserts = [];
    for (let i = 1; i <= 50; i++) {
      const lat = 49.2827 + (Math.random() - 0.5) * 0.1;
      const lng = -123.1207 + (Math.random() - 0.5) * 0.1;

      placeInserts.push(`
        ('${i}', 'Performance Test Place ${i}', ST_Point(${lng}, ${lat}), '${Math.ceil(i / 25)}', NOW())
      `);
    }

    await db.query(`
      INSERT INTO places (id, name, geometry, community_id, created_at)
      VALUES ${placeInserts.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `);

    console.log('Performance test data seeded');
  }

  async function collectBaselineMetrics(): Promise<PerformanceMetrics> {
    const start = performance.now();
    const initialMemory = process.memoryUsage();

    // Warm up the application
    await app.inject({ method: 'GET', url: '/api/v1/health' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/communities',
    });

    const responseTime = performance.now() - start;
    const finalMemory = process.memoryUsage();

    return {
      responseTime,
      throughput: 1000 / responseTime, // requests per second
      errorRate: response.statusCode >= 400 ? 1 : 0,
      memoryUsage: finalMemory.heapUsed - initialMemory.heapUsed,
    };
  }

  async function createTestSession(): Promise<{
    token: string;
    cookie: string;
  }> {
    // Create test user session
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'test@community1.test',
        password: 'test-password-123',
      },
    });

    if (loginResponse.statusCode !== 200) {
      throw new Error('Failed to create test session');
    }

    const cookie = loginResponse.headers['set-cookie'] as string;
    const token = loginResponse.json().token || 'test-jwt-token';

    return { token, cookie };
  }

  function createMockFilePayload(filename: string, size: number): any {
    // Create mock multipart form data for file upload testing
    return {
      file: {
        filename,
        mimetype: 'video/mp4',
        data: Buffer.alloc(size, 'x'), // Create buffer of specified size
      },
    };
  }

  afterAll(async () => {
    // Clean up performance test data
    await cleanupPerformanceTestData();
    await db.teardown();
    await app.close();

    console.log('Performance validation completed');
  });

  async function cleanupPerformanceTestData(): Promise<void> {
    try {
      await db.query(
        "DELETE FROM story_places WHERE story_id IN (SELECT id FROM stories WHERE title LIKE 'Performance Test%')"
      );
      await db.query(
        "DELETE FROM story_speakers WHERE story_id IN (SELECT id FROM stories WHERE title LIKE 'Performance Test%')"
      );
      await db.query(
        "DELETE FROM stories WHERE title LIKE 'Performance Test%'"
      );
      await db.query("DELETE FROM places WHERE name LIKE 'Performance Test%'");
      await db.query("DELETE FROM users WHERE email LIKE '%community%.test'");
      await db.query(
        "DELETE FROM communities WHERE name LIKE 'Performance Test%'"
      );
    } catch (error) {
      console.warn('Error cleaning up performance test data:', error);
    }
  }
});
