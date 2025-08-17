/**
 * API Test Client
 *
 * Utilities for testing HTTP endpoints with authentication and validation
 */

import { FastifyInstance } from 'fastify';
import { InjectOptions, LightMyRequestResponse } from 'light-my-request';

export interface ApiResponse<T = any> {
  data?: T;
  meta?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface AuthTokens {
  access: string;
  refresh?: string;
}

/**
 * API Test Client for simplified HTTP testing
 */
export class ApiTestClient {
  constructor(private app: FastifyInstance) {}

  /**
   * Make authenticated request with Bearer token
   */
  async authenticatedRequest(
    method: string,
    url: string,
    data?: any,
    token?: string
  ): Promise<LightMyRequestResponse> {
    const authToken = token || (await this.getTestToken());

    const options: InjectOptions = {
      method: method.toUpperCase(),
      url,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      options.payload = JSON.stringify(data);
    }

    if (data && method.toUpperCase() === 'GET') {
      const params = new URLSearchParams(data);
      options.url = `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
    }

    return this.app.inject(options);
  }

  /**
   * Make unauthenticated request
   */
  async request(
    method: string,
    url: string,
    data?: any
  ): Promise<LightMyRequestResponse> {
    const options: InjectOptions = {
      method: method.toUpperCase(),
      url,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      options.payload = JSON.stringify(data);
    }

    if (data && method.toUpperCase() === 'GET') {
      const params = new URLSearchParams(data);
      options.url = `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
    }

    return this.app.inject(options);
  }

  /**
   * GET request helpers
   */
  async get(
    url: string,
    params?: Record<string, any>,
    token?: string
  ): Promise<LightMyRequestResponse> {
    if (token !== undefined) {
      return this.authenticatedRequest('GET', url, params, token);
    }
    return this.request('GET', url, params);
  }

  async post(
    url: string,
    data?: any,
    token?: string
  ): Promise<LightMyRequestResponse> {
    if (token !== undefined) {
      return this.authenticatedRequest('POST', url, data, token);
    }
    return this.request('POST', url, data);
  }

  async put(
    url: string,
    data?: any,
    token?: string
  ): Promise<LightMyRequestResponse> {
    if (token !== undefined) {
      return this.authenticatedRequest('PUT', url, data, token);
    }
    return this.request('PUT', url, data);
  }

  async patch(
    url: string,
    data?: any,
    token?: string
  ): Promise<LightMyRequestResponse> {
    if (token !== undefined) {
      return this.authenticatedRequest('PATCH', url, data, token);
    }
    return this.request('PATCH', url, data);
  }

  async delete(url: string, token?: string): Promise<LightMyRequestResponse> {
    if (token !== undefined) {
      return this.authenticatedRequest('DELETE', url, undefined, token);
    }
    return this.request('DELETE', url);
  }

  /**
   * Get test authentication token
   * This is a mock implementation - replace with actual auth logic when implemented
   */
  async getTestToken(userId = 1, communityId = 1): Promise<string> {
    // Mock JWT token for testing
    // In real implementation, this would call the auth endpoint or create a valid JWT
    const mockPayload = {
      sub: userId,
      communityId,
      role: 'admin',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
    };

    // Simple base64 encoding for mock token (not secure, only for testing)
    return `mock.${Buffer.from(JSON.stringify(mockPayload)).toString('base64')}.signature`;
  }

  /**
   * Create tokens for different user roles
   */
  async getTokens() {
    return {
      admin: await this.getTestToken(1, 1),
      editor: await this.getTestToken(2, 1),
      viewer: await this.getTestToken(3, 1),
      superAdmin: await this.getTestToken(999, 0), // Super admin has no specific community
      anotherCommunity: await this.getTestToken(4, 2),
    };
  }

  /**
   * Assert successful response
   */
  assertSuccess(response: LightMyRequestResponse, expectedStatus = 200): void {
    if (response.statusCode !== expectedStatus) {
      throw new Error(
        `Expected status ${expectedStatus} but got ${response.statusCode}. Body: ${response.body}`
      );
    }
  }

  /**
   * Assert error response
   */
  assertError(response: LightMyRequestResponse, expectedStatus: number): void {
    if (response.statusCode !== expectedStatus) {
      throw new Error(
        `Expected error status ${expectedStatus} but got ${response.statusCode}. Body: ${response.body}`
      );
    }
  }

  /**
   * Parse JSON response safely
   */
  parseResponse(response: LightMyRequestResponse): ApiResponse {
    try {
      return JSON.parse(response.body);
    } catch {
      throw new Error(`Failed to parse response JSON: ${response.body}`);
    }
  }

  /**
   * Assert response data structure
   */
  assertResponseStructure(
    response: LightMyRequestResponse,
    expectedKeys: (keyof ApiResponse)[]
  ): ApiResponse {
    const parsed = this.parseResponse(response);

    for (const key of expectedKeys) {
      if (!(key in parsed)) {
        throw new Error(
          `Expected response to contain key '${String(key)}' but it was missing`
        );
      }
    }

    return parsed;
  }

  /**
   * Test pagination response
   */
  assertPaginatedResponse(
    response: LightMyRequestResponse,
    expectedStatus = 200
  ): { data: any[]; meta: { page: number; limit: number; total: number } } {
    this.assertSuccess(response, expectedStatus);
    const parsed = this.parseResponse(response);

    if (!Array.isArray(parsed.data)) {
      throw new Error('Expected data to be an array for paginated response');
    }

    if (
      !parsed.meta ||
      typeof parsed.meta.page !== 'number' ||
      typeof parsed.meta.limit !== 'number'
    ) {
      throw new Error(
        'Expected meta object with page and limit for paginated response'
      );
    }

    return parsed;
  }

  /**
   * Test data validation error response
   */
  assertValidationError(response: LightMyRequestResponse): void {
    this.assertError(response, 400);
    const parsed = this.parseResponse(response);

    if (!parsed.error || !parsed.error.code) {
      throw new Error('Expected validation error response to have error.code');
    }

    if (parsed.error.code !== 'VALIDATION_ERROR') {
      throw new Error(`Expected VALIDATION_ERROR but got ${parsed.error.code}`);
    }
  }

  /**
   * Test authorization error response
   */
  assertUnauthorized(response: LightMyRequestResponse): void {
    this.assertError(response, 401);
  }

  /**
   * Test forbidden error response
   */
  assertForbidden(response: LightMyRequestResponse): void {
    this.assertError(response, 403);
  }

  /**
   * Test not found error response
   */
  assertNotFound(response: LightMyRequestResponse): void {
    this.assertError(response, 404);
  }
}

/**
 * Create API test client for a Fastify app
 */
export function createApiClient(app: FastifyInstance): ApiTestClient {
  return new ApiTestClient(app);
}

/**
 * Create test Fastify app with routes for testing
 */
export async function createTestApp(
  testDatabase?: any
): Promise<FastifyInstance> {
  if (testDatabase) {
    // Create a custom app that uses the test database
    const Fastify = (await import('fastify')).default;
    const app = Fastify({
      logger: false, // Disable logging in tests
      disableRequestLogging: true,
    });

    // Add essential plugins for JSON handling
    await app.register((await import('@fastify/cors')).default);

    // Register auth routes with test database
    const { authRoutes } = await import('../../src/routes/auth.js');
    await app.register(authRoutes, {
      prefix: '/api/v1',
      database: testDatabase,
    });

    return app;
  } else {
    // Import buildApp dynamically to avoid circular dependencies
    const { buildApp } = await import('../../src/app.js');
    return await buildApp();
  }
}

/**
 * Mock data generators for testing
 */
export class MockDataGenerator {
  /**
   * Generate mock community data
   */
  static community(overrides: any = {}) {
    return {
      name: 'Test Community',
      description: 'A test community for API testing',
      slug: `test-community-${Date.now()}`,
      publicStories: true,
      ...overrides,
    };
  }

  /**
   * Generate mock place data
   */
  static place(communityId: number, overrides: any = {}) {
    return {
      name: 'Test Place',
      description: 'A test place for API testing',
      location: {
        type: 'Point',
        coordinates: [-123.1234, 49.2827],
      },
      community_id: communityId,
      ...overrides,
    };
  }

  /**
   * Generate mock spatial data
   */
  static spatialPoint(lat = 49.2827, lng = -123.1234) {
    return {
      type: 'Point',
      coordinates: [lng, lat], // GeoJSON uses [lng, lat] order
    };
  }

  static spatialPolygon(coords?: number[][][]) {
    const defaultCoords = [
      [
        [-123.13, 49.28],
        [-123.12, 49.28],
        [-123.12, 49.29],
        [-123.13, 49.29],
        [-123.13, 49.28],
      ],
    ];

    return {
      type: 'Polygon',
      coordinates: coords || defaultCoords,
    };
  }
}
