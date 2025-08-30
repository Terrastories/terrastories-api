import { DualApiClient } from './dual-client';

/**
 * Test Data Seeder for consistent data across both APIs
 */
export class TestDataSeeder {
  private testCommunityId = 1;
  private testStoryId = 1;
  private testPlaceId = 1;
  private elderOnlyStoryId = 2;

  constructor(private dualClient: DualApiClient) {}

  /**
   * Seed identical test data in both APIs
   */
  async seedIdenticalData(): Promise<void> {
    // For now, we'll rely on existing test database setup
    // The test setup in tests/setup.ts creates the base test data
    // This method is a placeholder for future enhancement when Rails API is available

    console.log('Using existing test database setup for consistent data');

    // Verify test data exists by checking TypeScript API
    try {
      const communityCheck = await this.dualClient['makeTypescriptRequest'](
        'GET',
        '/api/communities'
      );
      if (communityCheck.statusCode !== 200) {
        console.warn(
          'Test data may not be available - communities endpoint returned:',
          communityCheck.statusCode
        );
      }
    } catch (error) {
      console.warn('Failed to verify test data:', error);
    }
  }

  /**
   * Get test community ID for testing
   */
  async getTestCommunityId(): Promise<number> {
    return this.testCommunityId;
  }

  /**
   * Get test story IDs for testing
   */
  async getTestStoryIds(): Promise<{ communityId: number; storyId: number }> {
    return {
      communityId: this.testCommunityId,
      storyId: this.testStoryId,
    };
  }

  /**
   * Get test place IDs for testing
   */
  async getTestPlaceIds(): Promise<{ communityId: number; placeId: number }> {
    return {
      communityId: this.testCommunityId,
      placeId: this.testPlaceId,
    };
  }

  /**
   * Get elder-only story ID for cultural protocol testing
   */
  async getElderOnlyStoryId(): Promise<number> {
    return this.elderOnlyStoryId;
  }

  /**
   * Get test story data for creation testing
   */
  async getTestStoryData(): Promise<any> {
    return {
      title: 'Test Story for Comparison',
      description: 'A story created during API comparison testing',
      communityId: this.testCommunityId,
      isElderOnly: false,
      placeIds: [this.testPlaceId],
      speakerIds: [],
    };
  }

  /**
   * Get test place data for creation testing
   */
  async getTestPlaceData(): Promise<any> {
    return {
      name: 'Test Place for Comparison',
      description: 'A place created during API comparison testing',
      location: {
        type: 'Point',
        coordinates: [-123.1234, 49.2827],
      },
      communityId: this.testCommunityId,
      isElderOnly: false,
    };
  }

  /**
   * Get test community data for creation testing
   */
  async getTestCommunityData(): Promise<any> {
    return {
      name: 'Test Community for Comparison',
      description: 'A community created during API comparison testing',
      slug: 'test-community-comparison-' + Date.now(),
      publicStories: true,
    };
  }

  /**
   * Clean up test data from both APIs
   */
  async cleanupTestData(): Promise<void> {
    // Test cleanup is handled by the test database reset in beforeEach
    // This method is for future enhancement when Rails API integration is complete
    console.log('Test cleanup handled by test database reset');
  }
}
