import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usersSqlite } from '../../src/db/schema/index.js';
import { CommunityRepository } from '../../src/repositories/community.repository.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import {
  AuthenticationError,
  UserService,
} from '../../src/services/user.service.js';
import * as passwordService from '../../src/services/password.service.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';

vi.mock('../../src/services/password.service.js', () => ({
  hashPassword: vi.fn(),
  validatePasswordStrength: vi.fn(),
  comparePassword: vi.fn(),
}));

describe('inactive principal sovereignty guard', () => {
  let db: TestDatabase;
  let communityRepository: CommunityRepository;
  let userService: UserService;
  let communityId: number;
  let email: string;

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();
    const fixtures = await testDb.seedTestData();
    communityId = fixtures.communities[0].id;

    const userRepository = new UserRepository(db);
    communityRepository = new CommunityRepository(db);
    userService = new UserService(userRepository, communityRepository);

    email = `inactive-community-${Date.now()}@example.test`;
    await db.insert(usersSqlite).values(
      TestDataFactory.createUser(communityId, {
        email,
        role: 'viewer',
        isActive: true,
      })
    );

    vi.mocked(passwordService.hashPassword).mockResolvedValue('equalizer-hash');
    vi.mocked(passwordService.comparePassword).mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await testDb.clearData();
  });

  it('rejects scoped authentication after the community is deactivated', async () => {
    expect(await communityRepository.deactivate(communityId)).toBe(true);

    await expect(
      userService.authenticateUser(email, 'candidate', communityId)
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects global authentication after the community is deactivated', async () => {
    expect(await communityRepository.deactivate(communityId)).toBe(true);

    await expect(
      userService.authenticateUserGlobal(email, 'candidate')
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
