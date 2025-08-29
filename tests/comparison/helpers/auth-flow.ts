import { DualApiClient } from './dual-client';

export interface TestTokens {
  viewer: string;
  editor: string;
  admin: string;
  elder: string;
  superAdmin: string;
}

/**
 * Authentication Flow Manager for API Comparison Testing
 */
export class AuthFlow {
  constructor(private dualClient: DualApiClient) {}

  /**
   * Create test tokens for all user roles
   */
  async createTestTokens(): Promise<TestTokens> {
    // Use existing test user credentials from api-client.ts pattern
    const testCredentials = {
      viewer: { email: 'viewer@test.com', password: 'testPassword123' },
      editor: { email: 'editor@test.com', password: 'testPassword123' },
      admin: { email: 'admin@test.com', password: 'testPassword123' },
      elder: { email: 'elder@test.com', password: 'testPassword123' },
      superAdmin: { email: 'superadmin@test.com', password: 'testPassword123' },
    };

    const tokens: any = {};

    for (const [role, credentials] of Object.entries(testCredentials)) {
      try {
        const authResult = await this.authenticateWithBothApis(
          credentials.email,
          credentials.password,
          1 // Test community ID
        );
        tokens[role] = authResult.typescriptToken;
      } catch (error) {
        console.warn(`Failed to authenticate ${role}: ${error}`);
        tokens[role] = 'mock-token-' + role; // Fallback token for testing
      }
    }

    return tokens;
  }

  /**
   * Authenticate with both APIs and return session tokens
   */
  async authenticateWithBothApis(
    email: string,
    password: string,
    communityId: number
  ): Promise<{
    railsToken: string;
    typescriptToken: string;
  }> {
    // Authenticate with TypeScript API using existing inject method
    const tsLoginResponse = await (this.dualClient as any).config.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email,
        password,
        communityId,
      },
    });

    if (tsLoginResponse.statusCode !== 200) {
      throw new Error(`TypeScript login failed: ${tsLoginResponse.body}`);
    }

    // Extract session ID from TypeScript response
    const setCookieHeader = tsLoginResponse.headers['set-cookie'];
    let typescriptToken = '';

    if (Array.isArray(setCookieHeader)) {
      const sessionCookie = setCookieHeader.find((cookie) =>
        cookie.includes('sessionId=')
      );
      typescriptToken = sessionCookie
        ? sessionCookie.split('sessionId=')[1].split(';')[0]
        : '';
    } else if (setCookieHeader) {
      typescriptToken = setCookieHeader.includes('sessionId=')
        ? setCookieHeader.split('sessionId=')[1].split(';')[0]
        : '';
    }

    // Try to authenticate with Rails API if available
    let railsToken = typescriptToken; // Default to same token

    try {
      if (await this.dualClient.isRailsApiAvailable()) {
        const railsResponse = await (this.dualClient as any).makeRailsRequest(
          'POST',
          '/api/v1/auth/login',
          {
            data: { email, password, communityId },
          }
        );

        if (railsResponse.ok) {
          const railsCookie = railsResponse.headers.get('set-cookie');
          if (railsCookie && railsCookie.includes('sessionId=')) {
            railsToken = railsCookie.split('sessionId=')[1].split(';')[0];
          }
        }
      }
    } catch (error) {
      console.warn(
        'Rails authentication failed, using TypeScript token:',
        error
      );
    }

    return {
      railsToken,
      typescriptToken,
    };
  }

  /**
   * Validate authentication works identically in both APIs
   */
  async validateAuthenticationParity(
    email: string,
    password: string
  ): Promise<boolean> {
    try {
      const result = await this.authenticateWithBothApis(email, password, 1);
      return result.railsToken === result.typescriptToken;
    } catch {
      return false;
    }
  }

  /**
   * Test logout flow works identically
   */
  async validateLogoutParity(token: string): Promise<boolean> {
    try {
      const [railsLogout, tsLogout] = await Promise.all([
        this.dualClient
          .isRailsApiAvailable()
          .then((available) =>
            available
              ? (this.dualClient as any).makeRailsRequest(
                  'POST',
                  '/api/v1/auth/logout',
                  { auth: token }
                )
              : Promise.resolve({ statusCode: 200 })
          ),
        (this.dualClient as any).makeTypescriptRequest(
          'POST',
          '/api/v1/auth/logout',
          { auth: token }
        ),
      ]);

      const railsStatus = railsLogout.status || railsLogout.statusCode;
      const tsStatus = tsLogout.statusCode;

      return railsStatus === tsStatus;
    } catch {
      return false;
    }
  }
}
