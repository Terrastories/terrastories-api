import { RequestOptions } from './dual-client';

/**
 * Rails API Response Mocker for development when Rails API unavailable
 */
export class RailsMocker {
  /**
   * Get mock Rails response for development testing
   */
  getMockResponse(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): any {
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);

    // Return appropriate mock response based on endpoint
    switch (normalizedEndpoint) {
      case '/api/communities':
        return this.mockCommunitiesResponse(method, options);

      case '/api/communities/:id':
        return this.mockCommunityResponse(method, options);

      case '/api/communities/:community_id/stories':
        return this.mockCommunityStoriesResponse(method, options);

      case '/api/communities/:community_id/stories/:id':
        return this.mockStoryResponse(method, options);

      case '/api/communities/:community_id/places/:id':
        return this.mockPlaceResponse(method, options);

      // Member endpoints
      case '/api/v1/member/stories':
        return this.mockMemberStoriesResponse(method, options);

      case '/api/v1/member/stories/:id':
        return this.mockMemberStoryResponse(method, options);

      case '/api/v1/member/places':
        return this.mockMemberPlacesResponse(method, options);

      case '/api/v1/member/places/:id':
        return this.mockMemberPlaceResponse(method, options);

      case '/api/v1/member/speakers':
        return this.mockMemberSpeakersResponse(method, options);

      case '/api/v1/member/speakers/:id':
        return this.mockMemberSpeakerResponse(method, options);

      // Super admin endpoints
      case '/api/v1/super_admin/communities':
        return this.mockSuperAdminCommunitiesResponse(method, options);

      case '/api/v1/super_admin/communities/:id':
        return this.mockSuperAdminCommunityResponse(method, options);

      case '/api/v1/super_admin/users':
        return this.mockSuperAdminUsersResponse(method, options);

      case '/api/v1/super_admin/users/:id':
        return this.mockSuperAdminUserResponse(method, options);

      default:
        return this.mockNotFoundResponse();
    }
  }

  private normalizeEndpoint(endpoint: string): string {
    // Replace numeric IDs with parameter placeholders
    return endpoint
      .replace(/\/\d+/g, '/:id')
      .replace(/\/(\d+)\/stories/, '/:community_id/stories')
      .replace(/\/(\d+)\/places/, '/:community_id/places');
  }

  private mockCommunitiesResponse(method: string, options: RequestOptions) {
    if (method !== 'GET') {
      return {
        statusCode: 405,
        body: { error: 'Method not allowed' },
        headers: {},
      };
    }

    return {
      statusCode: 200,
      body: {
        data: [
          {
            id: 1,
            name: 'Test Community',
            description: 'A test community',
            slug: 'test-community',
            publicStories: true,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        meta: {
          page: 1,
          limit: 20,
          total: 1,
        },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockCommunityResponse(method: string, options: RequestOptions) {
    if (method !== 'GET') {
      return {
        statusCode: 405,
        body: { error: 'Method not allowed' },
        headers: {},
      };
    }

    return {
      statusCode: 200,
      body: {
        data: {
          id: 1,
          name: 'Test Community',
          description: 'A test community',
          slug: 'test-community',
          publicStories: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockCommunityStoriesResponse(
    method: string,
    options: RequestOptions
  ) {
    if (method !== 'GET') {
      return {
        statusCode: 405,
        body: { error: 'Method not allowed' },
        headers: {},
      };
    }

    return {
      statusCode: 200,
      body: {
        data: [
          {
            id: 1,
            title: 'Test Story',
            description: 'A test story',
            communityId: 1,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        meta: {
          page: 1,
          limit: 20,
          total: 1,
        },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockStoryResponse(method: string, options: RequestOptions) {
    return {
      statusCode: 200,
      body: {
        data: {
          id: 1,
          title: 'Test Story',
          description: 'A test story',
          communityId: 1,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockPlaceResponse(method: string, options: RequestOptions) {
    return {
      statusCode: 200,
      body: {
        data: {
          id: 1,
          name: 'Test Place',
          description: 'A test place',
          location: {
            type: 'Point',
            coordinates: [-123.1234, 49.2827],
          },
          communityId: 1,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  // Member endpoints - require authentication
  private mockMemberStoriesResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    if (method === 'GET') {
      return this.mockCommunityStoriesResponse(method, options);
    }

    if (method === 'POST') {
      return {
        statusCode: 201,
        body: {
          data: {
            id: 2,
            ...options.data,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        headers: { 'Content-Type': 'application/json' },
      };
    }

    return {
      statusCode: 405,
      body: { error: 'Method not allowed' },
      headers: {},
    };
  }

  private mockMemberStoryResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    if (method === 'PUT') {
      return {
        statusCode: 200,
        body: {
          data: {
            id: 1,
            ...options.data,
            updatedAt: new Date().toISOString(),
          },
        },
        headers: { 'Content-Type': 'application/json' },
      };
    }

    if (method === 'DELETE') {
      return {
        statusCode: 204,
        body: null,
        headers: {},
      };
    }

    return {
      statusCode: 405,
      body: { error: 'Method not allowed' },
      headers: {},
    };
  }

  private mockMemberPlacesResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 200,
      body: {
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockMemberPlaceResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 405,
      body: { error: 'Method not allowed' },
      headers: {},
    };
  }

  private mockMemberSpeakersResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 200,
      body: {
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockMemberSpeakerResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 405,
      body: { error: 'Method not allowed' },
      headers: {},
    };
  }

  // Super admin endpoints
  private mockSuperAdminCommunitiesResponse(
    method: string,
    options: RequestOptions
  ) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    // Mock role check - would need actual role validation
    return {
      statusCode: 200,
      body: {
        data: [
          {
            id: 1,
            name: 'Test Community',
            description: 'A test community',
            slug: 'test-community',
            publicStories: true,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        meta: { page: 1, limit: 20, total: 1 },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockSuperAdminCommunityResponse(
    method: string,
    options: RequestOptions
  ) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 405,
      body: { error: 'Method not allowed' },
      headers: {},
    };
  }

  private mockSuperAdminUsersResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 200,
      body: {
        data: [],
        meta: { page: 1, limit: 20, total: 0 },
      },
      headers: { 'Content-Type': 'application/json' },
    };
  }

  private mockSuperAdminUserResponse(method: string, options: RequestOptions) {
    if (!options.auth) {
      return { statusCode: 401, body: { error: 'Unauthorized' }, headers: {} };
    }

    return {
      statusCode: 405,
      body: { error: 'Method not allowed' },
      headers: {},
    };
  }

  private mockNotFoundResponse() {
    return {
      statusCode: 404,
      body: { error: 'Not Found' },
      headers: { 'Content-Type': 'application/json' },
    };
  }
}
