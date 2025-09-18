/**
 * Mock Utilities
 *
 * Mock utilities for external services and dependencies
 */

import { vi } from 'vitest';
import type { TestDatabase } from './database.js';
import {
  communitiesSqlite as communities,
  usersSqlite as users,
} from '../../src/db/schema/index.js';

/**
 * File system mock utilities
 */
export class FileSystemMock {
  static mockFileExists(exists: boolean = true) {
    return vi.fn().mockResolvedValue(exists);
  }

  static mockFileRead(content: string | Buffer) {
    return vi.fn().mockResolvedValue(content);
  }

  static mockFileWrite() {
    return vi.fn().mockResolvedValue(undefined);
  }

  static mockFileDelete() {
    return vi.fn().mockResolvedValue(undefined);
  }
}

/**
 * HTTP request mock utilities
 */
export class HttpMock {
  static mockSuccessResponse<T>(data: T, status = 200) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  static mockErrorResponse(status: number, message: string) {
    return vi.fn().mockRejectedValue(new Error(`HTTP ${status}: ${message}`));
  }

  static mockNetworkError() {
    return vi.fn().mockRejectedValue(new Error('Network error'));
  }
}

/**
 * Email service mock
 */
export class EmailMock {
  static createEmailService() {
    return {
      send: vi.fn().mockResolvedValue({ messageId: 'mock-message-id' }),
      verify: vi.fn().mockResolvedValue(true),
      getDeliveryStatus: vi.fn().mockResolvedValue('delivered'),
    };
  }

  static mockSendSuccess() {
    return vi.fn().mockResolvedValue({
      messageId: 'mock-message-id',
      response: '250 OK',
      accepted: ['test@example.com'],
      rejected: [],
    });
  }

  static mockSendFailure() {
    return vi.fn().mockRejectedValue(new Error('SMTP connection failed'));
  }
}

/**
 * File upload/storage mock
 */
export class StorageMock {
  static createStorageService() {
    return {
      upload: vi.fn().mockResolvedValue({
        url: 'https://mock-storage.com/file.jpg',
        key: 'mock-file-key',
        size: 1024,
        contentType: 'image/jpeg',
      }),
      download: vi.fn().mockResolvedValue(Buffer.from('mock file content')),
      delete: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      getMetadata: vi.fn().mockResolvedValue({
        size: 1024,
        contentType: 'image/jpeg',
        lastModified: Date.now(),
      }),
    };
  }

  static mockUploadSuccess(filename = 'test-file.jpg') {
    return vi.fn().mockResolvedValue({
      url: `https://mock-storage.com/${filename}`,
      key: `uploads/${filename}`,
      size: Math.floor(Math.random() * 10000),
      contentType: filename.endsWith('.jpg')
        ? 'image/jpeg'
        : 'application/octet-stream',
    });
  }

  static mockUploadFailure() {
    return vi.fn().mockRejectedValue(new Error('Storage service unavailable'));
  }
}

/**
 * Geolocation/mapping service mock
 */
export class GeoMock {
  static createGeocodingService() {
    return {
      geocode: vi.fn().mockResolvedValue([
        {
          lat: 49.2827,
          lng: -123.1207,
          address: '123 Test Street, Vancouver, BC, Canada',
          placeId: 'mock-place-id',
        },
      ]),
      reverseGeocode: vi.fn().mockResolvedValue([
        {
          address: '123 Test Street, Vancouver, BC, Canada',
          components: {
            streetNumber: '123',
            street: 'Test Street',
            city: 'Vancouver',
            province: 'BC',
            country: 'Canada',
          },
        },
      ]),
      calculateDistance: vi.fn().mockResolvedValue(1234.56), // meters
    };
  }

  static mockGeocodeSuccess(lat = 49.2827, lng = -123.1207) {
    return vi.fn().mockResolvedValue([
      {
        lat,
        lng,
        address: 'Mock Address',
        placeId: 'mock-place-id',
      },
    ]);
  }

  static mockGeocodeNotFound() {
    return vi.fn().mockResolvedValue([]);
  }
}

/**
 * External API mock
 */
export class ExternalApiMock {
  static createApiClient(_baseUrl: string) {
    return {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    };
  }

  static mockApiSuccess<T>(data: T) {
    return {
      get: vi.fn().mockResolvedValue({ data, status: 200 }),
      post: vi.fn().mockResolvedValue({ data, status: 201 }),
      put: vi.fn().mockResolvedValue({ data, status: 200 }),
      delete: vi.fn().mockResolvedValue({ status: 204 }),
      patch: vi.fn().mockResolvedValue({ data, status: 200 }),
    };
  }

  static mockApiError(status: number, message: string) {
    const error = new Error(message);
    (error as any).response = { status };

    return {
      get: vi.fn().mockRejectedValue(error),
      post: vi.fn().mockRejectedValue(error),
      put: vi.fn().mockRejectedValue(error),
      delete: vi.fn().mockRejectedValue(error),
      patch: vi.fn().mockRejectedValue(error),
    };
  }
}

/**
 * Time mock utilities
 */
export class TimeMock {
  static mockCurrentTime(timestamp: number | Date) {
    const time = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    vi.setSystemTime(time);
  }

  static resetTime() {
    vi.useRealTimers();
  }

  static mockDelay(ms: number) {
    return vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, ms))
      );
  }
}

/**
 * Random data generators for testing
 */
export class TestDataGenerator {
  static randomString(length = 10): string {
    const chars =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join('');
  }

  static randomEmail(): string {
    return `${this.randomString(8)}@example.com`;
  }

  static randomUrl(): string {
    return `https://example.com/${this.randomString(8)}`;
  }

  static randomCoordinate(min = -180, max = 180): number {
    return Math.random() * (max - min) + min;
  }

  static randomLatLng(): { lat: number; lng: number } {
    return {
      lat: this.randomCoordinate(-90, 90),
      lng: this.randomCoordinate(-180, 180),
    };
  }

  static randomDate(start?: Date, end?: Date): Date {
    const startTime = start?.getTime() || new Date(2020, 0, 1).getTime();
    const endTime = end?.getTime() || Date.now();
    return new Date(startTime + Math.random() * (endTime - startTime));
  }

  static randomPhoneNumber(): string {
    const areaCode = Math.floor(Math.random() * 800) + 200;
    const exchange = Math.floor(Math.random() * 800) + 200;
    const number = Math.floor(Math.random() * 9000) + 1000;
    return `(${areaCode}) ${exchange}-${number}`;
  }
}

/**
 * Performance testing utilities
 */
export class PerformanceMock {
  static createTimer() {
    const start = performance.now();
    return {
      elapsed: () => performance.now() - start,
      stop: () => performance.now() - start,
    };
  }

  static async measureAsync<T>(
    fn: () => Promise<T>
  ): Promise<{ result: T; duration: number }> {
    const start = performance.now();
    const result = await fn();
    const duration = performance.now() - start;
    return { result, duration };
  }

  static measureSync<T>(fn: () => T): { result: T; duration: number } {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;
    return { result, duration };
  }
}

/**
 * Memory usage tracking for tests
 */
export class MemoryMock {
  static getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss / 1024 / 1024, // MB
      heapTotal: usage.heapTotal / 1024 / 1024, // MB
      heapUsed: usage.heapUsed / 1024 / 1024, // MB
      external: usage.external / 1024 / 1024, // MB
    };
  }

  static trackMemoryUsage<T>(fn: () => T): { result: T; memoryDelta: number } {
    const before = process.memoryUsage().heapUsed;
    const result = fn();
    const after = process.memoryUsage().heapUsed;
    const memoryDelta = (after - before) / 1024 / 1024; // MB
    return { result, memoryDelta };
  }
}

/**
 * Common mock patterns
 */
export const CommonMocks = {
  /**
   * Mock console methods to capture logs in tests
   */
  mockConsole: () => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),

  /**
   * Mock process.env
   */
  mockEnv: (overrides: Record<string, string>) => {
    const original = { ...process.env };
    Object.assign(process.env, overrides);
    return () => {
      process.env = original;
    };
  },

  /**
   * Mock setTimeout and setInterval
   */
  mockTimers: () => {
    vi.useFakeTimers();
    return {
      advanceTime: (ms: number) => vi.advanceTimersByTime(ms),
      runAllTimers: () => vi.runAllTimers(),
      restore: () => vi.useRealTimers(),
    };
  },
};

/**
 * Database record creation helpers for tests
 */

export interface MockCommunityData {
  name?: string;
  description?: string;
  slug?: string;
  publicStories?: boolean;
  locale?: string;
}

export interface MockUserData {
  email?: string;
  role?: 'super_admin' | 'admin' | 'editor' | 'elder' | 'viewer';
  communityId?: number;
  firstName?: string;
  lastName?: string;
}

/**
 * Create a mock community in the test database
 */
export async function createMockCommunity(
  db: TestDatabase,
  data: MockCommunityData = {}
) {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const communityData = {
    name: data.name || 'Test Community',
    description: data.description || 'A community for testing',
    slug: data.slug || `test-community-${uniqueId}`,
    publicStories: data.publicStories ?? true,
    locale: data.locale || 'en',
    culturalSettings: null,
    isActive: true,
  };

  const [community] = await db
    .insert(communities)
    .values([communityData])
    .returning();
  return community;
}

/**
 * Create a mock user in the test database
 */
export async function createMockUser(
  db: TestDatabase,
  data: MockUserData = {}
) {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Require explicit communityId to ensure proper data isolation in tests
  if (data.communityId === undefined) {
    throw new Error(
      'createMockUser requires a valid communityId to ensure isolation'
    );
  }

  const userData = {
    email: data.email || `test-${uniqueId}@example.com`,
    passwordHash:
      '$argon2id$v=19$m=65536,t=3,p=4$tCxyO6RAN/yxOKo7TkGnXg$3kM2t3GUmirQtHwtkPp/Pwu7fvbNwYoqWNvr/HLaGCE',
    firstName: data.firstName || 'Test',
    lastName: data.lastName || 'User',
    role: data.role || 'viewer',
    communityId: data.communityId,
    isActive: true,
  };

  const [user] = await db.insert(users).values([userData]).returning();
  return user;
}
