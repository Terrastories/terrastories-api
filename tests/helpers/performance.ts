/**
 * Performance Testing Utilities
 *
 * Utilities for performance testing and benchmarking database operations
 */

import { TestDatabaseManager } from './database.js';
import { communities, places } from '../../src/db/schema/index.js';
import { sql } from 'drizzle-orm';

export interface PerformanceMetrics {
  duration: number; // milliseconds
  memoryUsage: {
    before: NodeJS.MemoryUsage;
    after: NodeJS.MemoryUsage;
    delta: number; // MB
  };
  databaseStats?: {
    before: any;
    after: any;
  };
}

export interface BenchmarkResult extends PerformanceMetrics {
  name: string;
  iterations: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  successfulRuns: number;
  failedRuns: number;
}

/**
 * Performance testing utilities for database operations
 */
export class PerformanceTester {
  private db: TestDatabaseManager;

  constructor(db: TestDatabaseManager) {
    this.db = db;
  }

  /**
   * Measure single operation performance
   */
  async measureOperation<T>(
    name: string,
    operation: () => Promise<T>
  ): Promise<{ result: T; metrics: PerformanceMetrics }> {
    // Collect initial state
    const memoryBefore = process.memoryUsage();
    const dbStatsBefore = await this.db.getStats();
    const startTime = performance.now();

    try {
      // Execute operation
      const result = await operation();

      // Collect final state
      const endTime = performance.now();
      const memoryAfter = process.memoryUsage();
      const dbStatsAfter = await this.db.getStats();

      const metrics: PerformanceMetrics = {
        duration: endTime - startTime,
        memoryUsage: {
          before: memoryBefore,
          after: memoryAfter,
          delta: (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024, // MB
        },
        databaseStats: {
          before: dbStatsBefore,
          after: dbStatsAfter,
        },
      };

      return { result, metrics };
    } catch (error) {
      const endTime = performance.now();
      const memoryAfter = process.memoryUsage();
      const dbStatsAfter = await this.db.getStats();

      const metrics: PerformanceMetrics = {
        duration: endTime - startTime,
        memoryUsage: {
          before: memoryBefore,
          after: memoryAfter,
          delta: (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024,
        },
        databaseStats: {
          before: dbStatsBefore,
          after: dbStatsAfter,
        },
      };

      throw new Error(
        `Operation '${name}' failed: ${error}. Metrics: ${JSON.stringify(metrics)}`
      );
    }
  }

  /**
   * Benchmark operation with multiple iterations
   */
  async benchmark<T>(
    name: string,
    operation: () => Promise<T>,
    iterations = 100
  ): Promise<BenchmarkResult> {
    const durations: number[] = [];
    let successfulRuns = 0;
    let failedRuns = 0;

    const memoryBefore = process.memoryUsage();
    const dbStatsBefore = await this.db.getStats();
    const overallStart = performance.now();

    for (let i = 0; i < iterations; i++) {
      try {
        const { metrics } = await this.measureOperation(
          `${name}_iteration_${i}`,
          operation
        );
        durations.push(metrics.duration);
        successfulRuns++;
      } catch (error) {
        failedRuns++;
        console.warn(`Benchmark iteration ${i} failed:`, error);
      }

      // Reset database state between iterations if needed
      if (i < iterations - 1) {
        await this.db.clearData();
      }
    }

    const overallEnd = performance.now();
    const memoryAfter = process.memoryUsage();
    const dbStatsAfter = await this.db.getStats();

    return {
      name,
      iterations,
      duration: overallEnd - overallStart,
      averageDuration:
        durations.reduce((sum, d) => sum + d, 0) / durations.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      successfulRuns,
      failedRuns,
      memoryUsage: {
        before: memoryBefore,
        after: memoryAfter,
        delta: (memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024,
      },
      databaseStats: {
        before: dbStatsBefore,
        after: dbStatsAfter,
      },
    };
  }

  /**
   * Test database insert performance
   */
  async benchmarkInserts(recordCount = 100): Promise<BenchmarkResult> {
    return this.benchmark(
      `insert_${recordCount}_communities`,
      async () => {
        const database = await this.db.getDb();
        const testData = Array.from({ length: recordCount }, (_, i) => ({
          name: `Performance Test Community ${i}`,
          description: `Generated for performance testing iteration ${i}`,
          slug: `perf-test-${i}-${Date.now()}`,
          publicStories: i % 2 === 0,
        }));

        return database.insert(communities).values(testData);
      },
      10 // Run 10 times to get stable metrics
    );
  }

  /**
   * Test database query performance
   */
  async benchmarkQueries(recordCount = 1000): Promise<BenchmarkResult> {
    // First, seed the database with test data
    const database = await this.db.getDb();
    const seedData = Array.from({ length: recordCount }, (_, i) => ({
      name: `Query Test Community ${i}`,
      description: `Generated for query performance testing ${i}`,
      slug: `query-test-${i}`,
      publicStories: true,
    }));

    await database.insert(communities).values(seedData);

    return this.benchmark(
      `query_${recordCount}_records`,
      async () => {
        return database.select().from(communities).limit(100);
      },
      50 // Run 50 queries
    );
  }

  /**
   * Test spatial query performance
   */
  async benchmarkSpatialQueries(recordCount = 500): Promise<BenchmarkResult> {
    // Seed with spatial data
    const database = await this.db.getDb();

    // First create a community
    const [community] = await database
      .insert(communities)
      .values({
        name: 'Spatial Test Community',
        slug: 'spatial-test',
        publicStories: true,
      })
      .returning();

    // Create places with spatial data
    const spatialData = Array.from({ length: recordCount }, (_, i) => ({
      name: `Spatial Place ${i}`,
      description: `Place with spatial data ${i}`,
      location: JSON.stringify({
        type: 'Point',
        coordinates: [
          -123.1234 + (Math.random() - 0.5) * 0.1, // Random lng around Vancouver
          49.2827 + (Math.random() - 0.5) * 0.1, // Random lat around Vancouver
        ],
      }),
      community_id: community.id,
    }));

    await database.insert(places).values(spatialData);

    return this.benchmark(
      `spatial_query_${recordCount}_places`,
      async () => {
        // Query places with spatial filter (mock spatial query for now)
        return database
          .select()
          .from(places)
          .where(
            sql`json_extract(location, '$.coordinates[0]') BETWEEN -123.2 AND -123.1`
          )
          .limit(50);
      },
      25 // Run 25 spatial queries
    );
  }

  /**
   * Test complex join performance
   */
  async benchmarkJoins(
    communityCount = 10,
    placesPerCommunity = 50
  ): Promise<BenchmarkResult> {
    const database = await this.db.getDb();

    // Seed with related data
    for (let i = 0; i < communityCount; i++) {
      const [community] = await database
        .insert(communities)
        .values({
          name: `Join Test Community ${i}`,
          slug: `join-test-${i}`,
          publicStories: true,
        })
        .returning();

      const placesData = Array.from({ length: placesPerCommunity }, (_, j) => ({
        name: `Place ${j} in Community ${i}`,
        description: `Test place for join performance`,
        location: JSON.stringify({
          type: 'Point',
          coordinates: [-123 + i * 0.1, 49 + j * 0.01],
        }),
        community_id: community.id,
      }));

      await database.insert(places).values(placesData);
    }

    return this.benchmark(
      `join_${communityCount}_communities_${placesPerCommunity}_places`,
      async () => {
        return database
          .select()
          .from(communities)
          .leftJoin(places, sql`${communities.id} = ${places.community_id}`)
          .limit(100);
      },
      20 // Run 20 join queries
    );
  }

  /**
   * Comprehensive performance test suite
   */
  async runPerformanceTestSuite(): Promise<{
    results: BenchmarkResult[];
    summary: {
      totalDuration: number;
      averageMemoryUsage: number;
      slowestOperation: string;
      fastestOperation: string;
    };
  }> {
    const results: BenchmarkResult[] = [];
    const overallStart = performance.now();

    console.log('🚀 Starting comprehensive performance test suite...');

    // Test insert performance
    console.log('📝 Testing insert performance...');
    results.push(await this.benchmarkInserts(100));

    // Test query performance
    console.log('🔍 Testing query performance...');
    results.push(await this.benchmarkQueries(1000));

    // Test spatial query performance
    console.log('🗺️ Testing spatial query performance...');
    results.push(await this.benchmarkSpatialQueries(500));

    // Test join performance
    console.log('🔗 Testing join performance...');
    results.push(await this.benchmarkJoins(10, 50));

    const overallEnd = performance.now();

    // Calculate summary
    const totalDuration = overallEnd - overallStart;
    const averageMemoryUsage =
      results.reduce((sum, r) => sum + r.memoryUsage.delta, 0) / results.length;

    const slowestResult = results.reduce((slowest, current) =>
      current.averageDuration > slowest.averageDuration ? current : slowest
    );

    const fastestResult = results.reduce((fastest, current) =>
      current.averageDuration < fastest.averageDuration ? current : fastest
    );

    const summary = {
      totalDuration,
      averageMemoryUsage,
      slowestOperation: slowestResult.name,
      fastestOperation: fastestResult.name,
    };

    console.log('✅ Performance test suite completed');
    console.log('📊 Summary:', summary);

    return { results, summary };
  }
}

/**
 * Assert performance within acceptable limits
 */
export class PerformanceAssertions {
  /**
   * Assert operation completes within time limit
   */
  static assertDuration(
    metrics: PerformanceMetrics,
    maxDurationMs: number
  ): void {
    if (metrics.duration > maxDurationMs) {
      throw new Error(
        `Operation took ${metrics.duration}ms, exceeding limit of ${maxDurationMs}ms`
      );
    }
  }

  /**
   * Assert memory usage is within acceptable range
   */
  static assertMemoryUsage(
    metrics: PerformanceMetrics,
    maxMemoryMB: number
  ): void {
    if (metrics.memoryUsage.delta > maxMemoryMB) {
      throw new Error(
        `Memory usage increased by ${metrics.memoryUsage.delta}MB, exceeding limit of ${maxMemoryMB}MB`
      );
    }
  }

  /**
   * Assert benchmark results meet performance criteria
   */
  static assertBenchmark(
    result: BenchmarkResult,
    criteria: {
      maxAverageDuration?: number;
      maxMemoryUsage?: number;
      minSuccessRate?: number;
    }
  ): void {
    if (
      criteria.maxAverageDuration &&
      result.averageDuration > criteria.maxAverageDuration
    ) {
      throw new Error(
        `Average duration ${result.averageDuration}ms exceeds limit of ${criteria.maxAverageDuration}ms`
      );
    }

    if (
      criteria.maxMemoryUsage &&
      result.memoryUsage.delta > criteria.maxMemoryUsage
    ) {
      throw new Error(
        `Memory usage ${result.memoryUsage.delta}MB exceeds limit of ${criteria.maxMemoryUsage}MB`
      );
    }

    if (criteria.minSuccessRate) {
      const successRate = result.successfulRuns / result.iterations;
      if (successRate < criteria.minSuccessRate) {
        throw new Error(
          `Success rate ${(successRate * 100).toFixed(2)}% is below minimum of ${(criteria.minSuccessRate * 100).toFixed(2)}%`
        );
      }
    }
  }
}

/**
 * Performance test utilities for common scenarios
 */
export const PerformanceTestUtils = {
  /**
   * Create performance tester for current test database
   */
  createTester: (db: TestDatabaseManager) => new PerformanceTester(db),

  /**
   * Quick performance check for an operation
   */
  quickCheck: async <T>(
    operation: () => Promise<T>,
    maxDurationMs = 1000
  ): Promise<T> => {
    const start = performance.now();
    const result = await operation();
    const duration = performance.now() - start;

    if (duration > maxDurationMs) {
      throw new Error(
        `Operation took ${duration}ms, exceeding quick check limit of ${maxDurationMs}ms`
      );
    }

    return result;
  },

  /**
   * Performance constants for testing
   */
  PERFORMANCE_LIMITS: {
    FAST_QUERY: 50, // ms
    NORMAL_QUERY: 200, // ms
    SLOW_QUERY: 1000, // ms
    BULK_INSERT: 500, // ms per 100 records
    SPATIAL_QUERY: 300, // ms
    JOIN_QUERY: 400, // ms
    MEMORY_LIMIT: 10, // MB per operation
  },
};
