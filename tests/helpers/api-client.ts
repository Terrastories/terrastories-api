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
   * Make authenticated request using real session cookies
   */
  async authenticatedRequest(
    method: string,
    url: string,
    data?: any,
    sessionId?: string
  ): Promise<LightMyRequestResponse> {
    const session = sessionId || (await this.getTestSessionId());

    const options: InjectOptions = {
      method: method.toUpperCase(),
      url,
      headers: {
        'Content-Type': 'application/json',
        cookie: `sessionId=${session}`,
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
   * Get test session ID by performing actual login using pre-existing test users
   */
  async getTestSessionId(
    _userId = 1,
    communityId = 1,
    role = 'admin'
  ): Promise<string> {
    // Use predefined test users created by createTestData()
    const testUserCredentials = {
      admin: { email: 'admin@test.com', password: 'testPassword123' },
      admin2: { email: 'admin2@test.com', password: 'testPassword123' },
      editor: { email: 'editor@test.com', password: 'testPassword123' },
      elder: { email: 'elder@test.com', password: 'testPassword123' },
      viewer: { email: 'viewer@test.com', password: 'testPassword123' },
      super_admin: {
        email: 'superadmin@test.com',
        password: 'testPassword123',
      },
    };

    const credentials =
      testUserCredentials[role as keyof typeof testUserCredentials];
    if (!credentials) {
      throw new Error(`Unknown role: ${role}`);
    }

    // Login with existing test user
    console.log(
      `DEBUG: Attempting login for ${credentials.email} with community ID ${communityId}`
    );

    const loginResponse = await this.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: credentials.email,
        password: credentials.password,
        communityId: communityId,
      },
    });

    console.log(
      `DEBUG: Login response for ${credentials.email}: ${loginResponse.statusCode} - ${loginResponse.body}`
    );

    if (loginResponse.statusCode !== 200) {
      throw new Error(`Failed to login test user: ${loginResponse.body}`);
    }

    // Extract session ID from Set-Cookie header
    const setCookieHeader = loginResponse.headers['set-cookie'];
    let sessionId = '';

    if (Array.isArray(setCookieHeader)) {
      const sessionCookie = setCookieHeader.find((cookie) =>
        cookie.includes('sessionId=')
      );
      sessionId = sessionCookie
        ? sessionCookie.split('sessionId=')[1].split(';')[0]
        : '';
    } else if (setCookieHeader) {
      sessionId = setCookieHeader.includes('sessionId=')
        ? setCookieHeader.split('sessionId=')[1].split(';')[0]
        : '';
    }

    if (!sessionId) {
      throw new Error('Failed to extract session ID from login response');
    }

    return sessionId;
  }

  /**
   * Create session tokens for different user roles
   * Note: Community IDs are determined by the test fixtures in the actual test setup
   */
  async getTokens() {
    return {
      admin: await this.getTestSessionId(1, 1, 'admin'), // Community ID 1 for compatibility
      editor: await this.getTestSessionId(2, 1, 'editor'),
      viewer: await this.getTestSessionId(3, 1, 'viewer'),
      superAdmin: await this.getTestSessionId(999, 1, 'super_admin'), // Super admin in system community
      anotherCommunity: await this.getTestSessionId(4, 2, 'admin'), // Admin in demo community
    };
  }

  /**
   * Backward compatibility method for getTestToken
   */
  async getTestToken(
    userId = 1,
    communityId = 1,
    role = 'admin'
  ): Promise<string> {
    return await this.getTestSessionId(userId, communityId, role);
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
      // @ts-expect-error - Fastify v5 types don't yet properly export routerOptions interface
      routerOptions: {
        ignoreTrailingSlash: true,
        caseSensitive: false,
      },
    });

    // Add essential plugins for JSON handling (mirror main app)
    await app.register((await import('@fastify/cors')).default);

    // Add Swagger support for schema validation
    const swagger = (await import('@fastify/swagger')).default;
    const { swaggerSchemas } = await import(
      '../../src/shared/schemas/index.js'
    );

    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Terrastories API Test',
          version: '1.0.0',
        },
        components: {
          schemas: swaggerSchemas as any,
        },
      },
    });

    // Cookie support (required for sessions)
    await app.register((await import('@fastify/cookie')).default);

    // Session management - essential for authentication
    const { getConfig } = await import('../../src/shared/config/index.js');
    const config = getConfig();

    await app.register((await import('@fastify/session')).default, {
      secret: config.auth.session.secret,
      cookie: {
        secure: config.auth.session.secure,
        httpOnly: config.auth.session.httpOnly,
        maxAge: config.auth.session.maxAge,
        sameSite: config.auth.session.sameSite,
        path: '/',
      },
      saveUninitialized: false,
    });

    // Register all routes with test database
    const { registerRoutes } = await import('../../src/routes/index.js');
    await app.register(registerRoutes, {
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
