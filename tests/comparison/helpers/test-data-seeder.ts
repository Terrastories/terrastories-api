import { DualApiClient } from './dual-client';

/**
 * Test data seeder for the deterministic comparison harness.
 *
 * The comparison tests currently share the isolated TypeScript test database.
 * Any Rails-backed data seeding belongs in the future real dual-transport harness;
 * this helper must fail closed if the expected local fixture baseline is missing.
 */
export class TestDataSeeder {
  constructor(private dualClient: DualApiClient) {}

  async seedIdenticalData(): Promise<void> {
    const communityCheck = await this.dualClient['makeTypescriptRequest'](
      'GET',
      '/api/communities'
    );

    if (communityCheck.statusCode !== 200) {
      throw new Error(
        `Comparison fixture baseline unavailable: communities endpoint returned ${communityCheck.statusCode}`
      );
    }
  }
}
