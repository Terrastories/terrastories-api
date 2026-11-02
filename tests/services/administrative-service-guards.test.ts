import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  communitiesPg,
  communitiesSqlite,
  filesSqlite,
  placesSqlite,
  speakersSqlite,
  themesSqlite,
  usersSqlite,
  type User,
} from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import {
  CommunityRepository,
  provisioningLockQuery,
} from '../../src/repositories/community.repository.js';
import {
  CommunityAuthorityRequiredError,
  LastActiveAdministratorError,
  UserService,
} from '../../src/services/user.service.js';
import {
  CommunityService,
  PublicationAuthorityRequiredError,
} from '../../src/services/community.service.js';
import type { AdministrativeActor } from '../../src/shared/authorization/administrative-policy.js';
import {
  TestDataFactory,
  testDb,
  type TestDatabase,
} from '../helpers/database.js';

/**
 * SPEC-V2 §7 administrative authority, enforced by the services themselves
 * (not only the routes), against a real SQLite database. Mirrors the HTTP
 * sequence suite (tests/security/sovereignty-administrative-sequences) at the
 * service boundary: enrollment needs a same-community admin, system privilege
 * provisions only system accounts and the first administrator of an unclaimed
 * empty community, and publication needs community authority.
 */
describe('administrative service guards (SPEC-V2 §7)', () => {
  let db: TestDatabase;
  let communityRepository: CommunityRepository;
  let userService: UserService;
  let communityService: CommunityService;

  let stamp: string;
  let privateCommunityId: number;
  let otherCommunityId: number;
  let emptyCommunityId: number;
  let admin: User;
  let viewer: User;
  let otherAdmin: User;
  let passwordHash: string;

  // Meets the real (unmocked) password strength validator.
  const STRONG_PASSWORD = 'GuardProbe2026!Pass';

  const insertCommunity = async (
    name: string,
    overrides: { publicStories?: boolean; isActive?: boolean } = {}
  ) => {
    const [row] = await db
      .insert(communitiesSqlite)
      .values(
        TestDataFactory.createCommunity({
          name,
          slug: `${name.toLowerCase()}-${stamp}`,
          publicStories: overrides.publicStories ?? false,
          isActive: overrides.isActive ?? true,
        })
      )
      .returning();
    return row.id;
  };

  const insertUser = async (
    communityId: number,
    role: 'admin' | 'viewer' | 'super_admin',
    label: string,
    overrides: Partial<User> = {}
  ) => {
    const [row] = await db
      .insert(usersSqlite)
      .values(
        TestDataFactory.createUser(communityId, {
          email: `guard-${label}-${stamp}@example.test`,
          role,
          passwordHash,
          ...overrides,
        })
      )
      .returning();
    return row;
  };

  const adminActor = (
    communityId = privateCommunityId,
    id = admin.id
  ): AdministrativeActor => ({ id, role: 'admin', communityId });

  /** Captures the rejection and pins both the error type and its reason. */
  async function expectCommunityAuthorityDenied(
    attempt: Promise<unknown>,
    reason: string
  ): Promise<CommunityAuthorityRequiredError> {
    const error = (await attempt.then(
      () => null,
      (thrown) => thrown
    )) as CommunityAuthorityRequiredError | null;
    expect(error).toBeInstanceOf(CommunityAuthorityRequiredError);
    expect(error?.reason).toBe(reason);
    return error as CommunityAuthorityRequiredError;
  }

  const usersInCommunity = async (communityId: number) =>
    db
      .select()
      .from(usersSqlite)
      .where(eq(usersSqlite.communityId, communityId));

  beforeEach(async () => {
    db = await testDb.setup();
    await testDb.clearData();

    communityRepository = new CommunityRepository(db);
    userService = new UserService(new UserRepository(db), communityRepository);
    communityService = new CommunityService(communityRepository);

    stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    passwordHash = await hashPassword(STRONG_PASSWORD);

    privateCommunityId = await insertCommunity('GUARD-PRIVATE');
    otherCommunityId = await insertCommunity('GUARD-OTHER', {
      publicStories: true,
    });
    emptyCommunityId = await insertCommunity('GUARD-EMPTY');

    admin = await insertUser(privateCommunityId, 'admin', 'admin');
    viewer = await insertUser(privateCommunityId, 'viewer', 'viewer');
    otherAdmin = await insertUser(otherCommunityId, 'admin', 'other-admin');
  });

  afterEach(async () => {
    await testDb.teardown();
  });

  describe('createUserAsSuperAdmin', () => {
    it('rejects an admin into a community that already has a user', async () => {
      await expectCommunityAuthorityDenied(
        userService.createUserAsSuperAdmin({
          email: `guard-second-admin-${stamp}@example.test`,
          password: STRONG_PASSWORD,
          firstName: 'Second',
          lastName: 'Admin',
          role: 'admin',
          communityId: privateCommunityId,
        }),
        'community-claimed-or-holds-content'
      );
      expect(await usersInCommunity(privateCommunityId)).toHaveLength(2);
    });

    it('rejects a viewer into an empty community (first administrator only)', async () => {
      await expectCommunityAuthorityDenied(
        userService.createUserAsSuperAdmin({
          email: `guard-system-viewer-${stamp}@example.test`,
          password: STRONG_PASSWORD,
          firstName: 'System',
          lastName: 'Viewer',
          role: 'viewer',
          communityId: emptyCommunityId,
        }),
        'first-administrator-only'
      );
      expect(await usersInCommunity(emptyCommunityId)).toHaveLength(0);
    });

    it('provisions the first administrator of an empty community', async () => {
      const created = await userService.createUserAsSuperAdmin({
        email: `guard-first-admin-${stamp}@example.test`,
        password: STRONG_PASSWORD,
        firstName: 'First',
        lastName: 'Admin',
        role: 'admin',
        communityId: emptyCommunityId,
      });
      expect(created.role).toBe('admin');
      expect(created.communityId).toBe(emptyCommunityId);
      const rows = await usersInCommunity(emptyCommunityId);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('admin');
    });

    it('creates a super_admin account even in a claimed community', async () => {
      const created = await userService.createUserAsSuperAdmin({
        email: `guard-system-account-${stamp}@example.test`,
        password: STRONG_PASSWORD,
        firstName: 'System',
        lastName: 'Account',
        role: 'super_admin',
        communityId: privateCommunityId,
      });
      expect(created.role).toBe('super_admin');
      expect(created.communityId).toBe(privateCommunityId);
    });

    it('provisions exactly one administrator when five creates race', async () => {
      const raceCommunityId = await insertCommunity('GUARD-RACE');
      const outcomes = await Promise.allSettled(
        [0, 1, 2, 3, 4].map((index) =>
          userService.createUserAsSuperAdmin({
            email: `guard-race-${index}-${stamp}@example.test`,
            password: STRONG_PASSWORD,
            firstName: 'Race',
            lastName: `Admin${index}`,
            role: 'admin',
            communityId: raceCommunityId,
          })
        )
      );

      const fulfilled = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled'
      );
      const rejected = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const outcome of rejected) {
        expect(outcome.reason).toBeInstanceOf(CommunityAuthorityRequiredError);
        expect(outcome.reason.reason).toBe(
          'community-claimed-or-holds-content'
        );
      }

      const rows = await usersInCommunity(raceCommunityId);
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('admin');
    });
  });

  describe('updateUserAsSuperAdmin', () => {
    it('rejects a role change', async () => {
      await expectCommunityAuthorityDenied(
        userService.updateUserAsSuperAdmin(viewer.id, { role: 'admin' }),
        'system-privilege-is-not-community-authority'
      );
      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, viewer.id));
      expect(row.role).toBe('viewer');
    });

    it('rejects a communityId change', async () => {
      await expectCommunityAuthorityDenied(
        userService.updateUserAsSuperAdmin(otherAdmin.id, {
          communityId: privateCommunityId,
        }),
        'system-privilege-is-not-community-authority'
      );
      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, otherAdmin.id));
      expect(row.communityId).toBe(otherCommunityId);
    });

    it('rejects reactivating a deactivated community account, which stays inactive', async () => {
      const deactivated = await insertUser(
        privateCommunityId,
        'viewer',
        'deactivated-viewer',
        { isActive: false }
      );

      await expectCommunityAuthorityDenied(
        userService.updateUserAsSuperAdmin(deactivated.id, {
          isActive: true,
        }),
        'reactivation-requires-community-authority'
      );

      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, deactivated.id));
      expect(row.isActive).toBe(false);
    });

    it('reactivates an inactive super_admin account', async () => {
      const inactiveSystem = await insertUser(
        otherCommunityId,
        'super_admin',
        'inactive-system',
        { isActive: false }
      );

      const updated = await userService.updateUserAsSuperAdmin(
        inactiveSystem.id,
        { isActive: true }
      );
      expect(updated.isActive).toBe(true);
    });

    it('applies a firstName change', async () => {
      const updated = await userService.updateUserAsSuperAdmin(viewer.id, {
        firstName: 'Renamed',
      });
      expect(updated.firstName).toBe('Renamed');
      expect(updated.role).toBe('viewer');
    });

    it('applies deactivation (isActive: false)', async () => {
      const updated = await userService.updateUserAsSuperAdmin(viewer.id, {
        isActive: false,
      });
      expect(updated.isActive).toBe(false);
    });
  });

  describe('updateCommunityAsSuperAdmin', () => {
    it('rejects a publicStories flip and leaves the row unchanged', async () => {
      await expect(
        communityService.updateCommunityAsSuperAdmin(privateCommunityId, {
          publicStories: true,
        })
      ).rejects.toThrow(PublicationAuthorityRequiredError);

      const [row] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(row.publicStories).toBe(false);
    });

    it('accepts re-sending the stored publicStories value', async () => {
      const updated = await communityService.updateCommunityAsSuperAdmin(
        privateCommunityId,
        { publicStories: false }
      );
      expect(updated.publicStories).toBe(false);
    });

    it('accepts a name-only update', async () => {
      const updated = await communityService.updateCommunityAsSuperAdmin(
        privateCommunityId,
        { name: 'GUARD-RENAMED' }
      );
      expect(updated.name).toBe('GUARD-RENAMED');
      expect(updated.publicStories).toBe(false);
    });
  });

  describe('setPublicationAsCommunityAdmin', () => {
    it('updates publicStories for a same-community admin', async () => {
      const updated = await communityService.setPublicationAsCommunityAdmin(
        privateCommunityId,
        true,
        adminActor()
      );
      expect(updated?.publicStories).toBe(true);

      const [row] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(row.publicStories).toBe(true);
    });

    it('rejects a super_admin actor', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          true,
          { id: admin.id, role: 'super_admin', communityId: privateCommunityId }
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('rejects an other-community admin', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          true,
          adminActor(otherCommunityId, otherAdmin.id)
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('rejects a same-community viewer', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          true,
          { id: viewer.id, role: 'viewer', communityId: privateCommunityId }
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('rejects a null actor', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          true,
          null
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('resolves null for a disabled community even with a same-community admin', async () => {
      const disabledCommunityId = await insertCommunity('GUARD-DISABLED', {
        isActive: false,
      });
      const result = await communityService.setPublicationAsCommunityAdmin(
        disabledCommunityId,
        true,
        adminActor(disabledCommunityId)
      );
      expect(result).toBeNull();

      const [row] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, disabledCommunityId));
      expect(row.publicStories).toBe(false);
    });
  });

  describe('community enrollment authority (registerUser / createUserInCommunity)', () => {
    const enrollmentData = (email: string) => ({
      email,
      password: STRONG_PASSWORD,
      firstName: 'Enrolled',
      lastName: 'Member',
      role: 'viewer' as const,
      communityId: privateCommunityId,
    });

    const enrollVia = {
      registerUser: (
        email: string,
        actor: AdministrativeActor | null
      ): Promise<User> =>
        userService.registerUser(enrollmentData(email), actor),
      createUserInCommunity: (
        email: string,
        actor: AdministrativeActor | null
      ): Promise<User> =>
        userService.createUserInCommunity(enrollmentData(email), actor),
    };

    it.each(['registerUser', 'createUserInCommunity'] as const)(
      '%s rejects a null actor',
      async (method) => {
        await expectCommunityAuthorityDenied(
          enrollVia[method](`guard-null-${method}-${stamp}@example.test`, null),
          'anonymous'
        );
      }
    );

    it.each(['registerUser', 'createUserInCommunity'] as const)(
      '%s rejects an other-community admin',
      async (method) => {
        await expectCommunityAuthorityDenied(
          enrollVia[method](
            `guard-cross-${method}-${stamp}@example.test`,
            adminActor(otherCommunityId, otherAdmin.id)
          ),
          'cross-community'
        );
      }
    );

    it.each(['registerUser', 'createUserInCommunity'] as const)(
      '%s rejects a same-community editor',
      async (method) => {
        await expectCommunityAuthorityDenied(
          enrollVia[method](`guard-editor-${method}-${stamp}@example.test`, {
            id: admin.id,
            role: 'editor',
            communityId: privateCommunityId,
          }),
          'not-community-admin'
        );
      }
    );

    it.each(['registerUser', 'createUserInCommunity'] as const)(
      '%s enrolls for a same-community admin',
      async (method) => {
        const created = await enrollVia[method](
          `guard-admin-${method}-${stamp}@example.test`,
          adminActor()
        );
        expect(created.role).toBe('viewer');
        expect(created.communityId).toBe(privateCommunityId);
        expect(created.isActive).toBe(true);
      }
    );
  });

  describe('claim state per content table (SPEC-V2 §7 first administrator)', () => {
    // A community that holds exactly one row of one content table and
    // nothing else must read as claimed: no system lifecycle action may
    // provision its first administrator into existing content.
    async function expectHeldByContent(
      label: string,
      seedContent: (communityId: number) => Promise<void>
    ) {
      const communityId = await insertCommunity(`GUARD-CONTENT-${label}`, {
        publicStories: false,
      });
      await seedContent(communityId);

      const claimState = await communityRepository.getClaimState(communityId);
      expect(claimState).toEqual({
        hasCommunityAccounts: false,
        hasContent: true,
      });

      await expectCommunityAuthorityDenied(
        userService.createUserAsSuperAdmin({
          email: `guard-claim-${label}-${stamp}@example.test`,
          password: STRONG_PASSWORD,
          firstName: 'First',
          lastName: 'Admin',
          role: 'admin',
          communityId,
        }),
        'community-claimed-or-holds-content'
      );
      expect(await usersInCommunity(communityId)).toHaveLength(0);
    }

    it('holds a place row only', async () => {
      await expectHeldByContent('PLACE', async (communityId) => {
        await db.insert(placesSqlite).values({
          name: 'GUARD-CLAIM-PLACE',
          communityId,
          latitude: 49.28,
          longitude: -123.12,
        });
      });
    });

    it('holds a speaker row only', async () => {
      await expectHeldByContent('SPEAKER', async (communityId) => {
        await db.insert(speakersSqlite).values({
          name: 'GUARD-CLAIM-SPEAKER',
          communityId,
        });
      });
    });

    it('holds a file row only', async () => {
      await expectHeldByContent('FILE', async (communityId) => {
        // uploadedBy must reference an existing user; a user from another
        // community keeps this community free of community accounts.
        await db.insert(filesSqlite).values({
          filename: 'guard-claim.jpg',
          originalName: 'guard-claim.jpg',
          path: '/uploads/guard-claim.jpg',
          url: `https://example.test/guard-claim-${stamp}.jpg`,
          mimeType: 'image/jpeg',
          size: 1024,
          communityId,
          uploadedBy: admin.id,
        });
      });
    });

    it('holds a theme row only', async () => {
      await expectHeldByContent('THEME', async (communityId) => {
        await db.insert(themesSqlite).values({
          name: 'GUARD-CLAIM-THEME',
          communityId,
        });
      });
    });

    it('treats a community holding only a super_admin row as claimable', async () => {
      const communityId = await insertCommunity('GUARD-SYSTEM-ONLY');
      await insertUser(communityId, 'super_admin', 'resident-system');

      const claimState = await communityRepository.getClaimState(communityId);
      expect(claimState).toEqual({
        hasCommunityAccounts: false,
        hasContent: false,
      });

      const created = await userService.createUserAsSuperAdmin({
        email: `guard-beside-system-${stamp}@example.test`,
        password: STRONG_PASSWORD,
        firstName: 'First',
        lastName: 'Admin',
        role: 'admin',
        communityId,
      });
      expect(created.role).toBe('admin');
      expect(created.communityId).toBe(communityId);
    });
  });

  describe('updateUserAsSuperAdmin stale-read reactivation (B5)', () => {
    it('does not let a stale active read reactivate a row the community deactivated', async () => {
      // Deterministic replay of the race: the super admin's read saw the
      // account while it was still active, then the community deactivated
      // it before the write landed. The write must not resurrect it.
      await db
        .update(usersSqlite)
        .set({ isActive: false })
        .where(eq(usersSqlite.id, viewer.id));
      const [deactivatedRow] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, viewer.id));
      expect(deactivatedRow.isActive).toBe(false);

      const userRepository = new UserRepository(db);
      const staleService = new UserService(userRepository, communityRepository);
      const staleRead = vi
        .spyOn(userRepository, 'findByIdAsSuperAdmin')
        .mockResolvedValueOnce({ ...deactivatedRow, isActive: true })
        .mockResolvedValueOnce({ ...deactivatedRow, isActive: true });

      // The call may resolve or reject; either way the stored row must not
      // be reactivated.
      await staleService
        .updateUserAsSuperAdmin(viewer.id, { isActive: true })
        .catch(() => undefined);
      let [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, viewer.id));
      expect(row.isActive).toBe(false);

      // A profile field bundled onto the stale reactivation must not
      // smuggle isActive back in either.
      const second = await staleService
        .updateUserAsSuperAdmin(viewer.id, {
          firstName: 'Stale',
          isActive: true,
        })
        .then(
          () => true,
          () => false
        );
      [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, viewer.id));
      expect(row.isActive).toBe(false);
      // The profile write is only observable when the call resolved.
      if (second) {
        expect(row.firstName).toBe('Stale');
      }

      staleRead.mockRestore();
    });

    it('never asks the repository to write isActive:true for a community account', async () => {
      // Pins the service layer on its own (the repository's conditional
      // SQL is the second layer, tested below).
      const userRepository = new UserRepository(db);
      const service = new UserService(userRepository, communityRepository);
      const write = vi.spyOn(userRepository, 'updateByIdAsSuperAdmin');

      await service.updateUserAsSuperAdmin(viewer.id, {
        firstName: 'StillActive',
        isActive: true,
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][1].isActive).toBeUndefined();
      expect(write.mock.calls[0][1].firstName).toBe('StillActive');

      const [system] = await db
        .insert(usersSqlite)
        .values(
          TestDataFactory.createUser(otherCommunityId, {
            email: `guard-strip-system-${stamp}@example.test`,
            role: 'super_admin',
            isActive: false,
            passwordHash,
          })
        )
        .returning();
      await service.updateUserAsSuperAdmin(system.id, { isActive: true });
      expect(write.mock.calls[1][1].isActive).toBe(true);

      write.mockRestore();
    });
  });

  describe('updateByIdAsSuperAdmin conditional write (B5)', () => {
    it('refuses to reactivate a deactivated community account but reactivates a super_admin row', async () => {
      const userRepository = new UserRepository(db);
      const inactiveViewer = await insertUser(
        privateCommunityId,
        'viewer',
        'conditional-viewer',
        { isActive: false }
      );

      // The repository write must not reactivate a community account on its
      // own; it may throw instead.
      await userRepository
        .updateByIdAsSuperAdmin(inactiveViewer.id, { isActive: true })
        .catch(() => undefined);
      const [viewerRow] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, inactiveViewer.id));
      expect(viewerRow.isActive).toBe(false);

      // The same write on a system account is a lifecycle record: it may
      // reactivate it.
      const inactiveSystem = await insertUser(
        otherCommunityId,
        'super_admin',
        'conditional-system',
        { isActive: false }
      );
      await userRepository.updateByIdAsSuperAdmin(inactiveSystem.id, {
        isActive: true,
      });
      const [systemRow] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, inactiveSystem.id));
      expect(systemRow.isActive).toBe(true);
    });
  });

  describe('setPublicationAsCommunityAdmin no-op authority (Sol)', () => {
    // Re-sending the stored publicStories value is still a publication
    // decision: the no-op shortcut must not hand the community row to a
    // caller without community authority. privateCommunity stores
    // publicStories = false.
    it('rejects a null actor even for the stored value, and a missing community does not soften the check', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          false,
          null
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);

      await expect(
        communityService.setPublicationAsCommunityAdmin(
          999_999_999,
          false,
          null
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('rejects an other-community admin for the stored value and returns no row', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          false,
          adminActor(otherCommunityId, otherAdmin.id)
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('rejects a same-community viewer for the stored value and returns no row', async () => {
      await expect(
        communityService.setPublicationAsCommunityAdmin(
          privateCommunityId,
          false,
          { id: viewer.id, role: 'viewer', communityId: privateCommunityId }
        )
      ).rejects.toThrow(PublicationAuthorityRequiredError);
    });

    it('resolves the no-op to the community row for a same-community admin', async () => {
      const updated = await communityService.setPublicationAsCommunityAdmin(
        privateCommunityId,
        false,
        adminActor()
      );
      expect(updated?.id).toBe(privateCommunityId);
      expect(updated?.publicStories).toBe(false);
    });
  });

  describe('first-administrator provisioning lock pins (Nit 1)', () => {
    it('locks the community row with SELECT ... FOR UPDATE on PostgreSQL', async () => {
      // Lazy client on an unroutable address: toSQL() only renders SQL, so
      // it never connects and there is nothing to close.
      //
      // The real PG concurrency run lives in the parity script; a PG CI lane
      // is #161.
      const lazyClient = postgres('postgres://u:p@127.0.0.1:1/x', { max: 1 });
      const pgDb = drizzle(lazyClient);

      const query = provisioningLockQuery(pgDb, communitiesPg, 7);
      const { sql, params } = query.toSQL();

      expect(sql).toMatch(/for update/i);
      expect(params).toContain(7);
    });

    it('runs SQLite provisioning in a BEGIN IMMEDIATE transaction', async () => {
      const txSpy = vi.spyOn(db, 'transaction');

      const values = TestDataFactory.createUser(emptyCommunityId, {
        email: `guard-provision-${stamp}@example.test`,
        role: 'admin',
        passwordHash,
        isActive: true,
      });
      const created =
        await communityRepository.provisionFirstAdministrator(values);

      expect(created).not.toBeNull();
      expect(created).toMatchObject({
        communityId: emptyCommunityId,
        role: 'admin',
      });
      expect(txSpy).toHaveBeenCalledWith(expect.any(Function), {
        behavior: 'immediate',
      });

      txSpy.mockRestore();
    });
  });

  describe('last active administrator recoverability (Nit 2)', () => {
    // A community must never lose its last active administrator: neither
    // system privilege nor the administrator themself may remove it.
    const rowFor = async (id: number) => {
      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, id));
      return row;
    };

    it('rejects a super admin deactivating the only active administrator, who stays active', async () => {
      await expect(
        userService.updateUserAsSuperAdmin(admin.id, { isActive: false })
      ).rejects.toThrow(LastActiveAdministratorError);
      expect((await rowFor(admin.id)).isActive).toBe(true);
    });

    it('rejects a super admin deactivating the only active administrator through the delete path', async () => {
      await expect(
        userService.deactivateUserAsSuperAdmin(admin.id)
      ).rejects.toThrow(LastActiveAdministratorError);
    });

    it('rejects the sole administrator deactivating themself in their own community', async () => {
      await expect(
        userService.updateUserInCommunity(
          admin.id,
          { isActive: false },
          privateCommunityId
        )
      ).rejects.toThrow();
    });

    it('rejects the sole administrator demoting themself, keeping the role', async () => {
      await expect(
        userService.updateUserInCommunity(
          admin.id,
          { role: 'editor' },
          privateCommunityId
        )
      ).rejects.toThrow();
      expect((await rowFor(admin.id)).role).toBe('admin');
    });

    it('allows deactivating one administrator once a second active administrator exists', async () => {
      await insertUser(privateCommunityId, 'admin', 'second-admin');
      const updated = await userService.updateUserAsSuperAdmin(admin.id, {
        isActive: false,
      });
      expect(updated.isActive).toBe(false);
      expect((await rowFor(admin.id)).isActive).toBe(false);
    });

    it('does not count an inactive second administrator', async () => {
      await insertUser(privateCommunityId, 'admin', 'inactive-second-admin', {
        isActive: false,
      });
      await expect(
        userService.updateUserAsSuperAdmin(admin.id, { isActive: false })
      ).rejects.toThrow(LastActiveAdministratorError);
    });

    it('refuses to provision an inactive first administrator and creates no row', async () => {
      await expect(
        userService.createUserAsSuperAdmin({
          email: `guard-inactive-first-${stamp}@example.test`,
          password: STRONG_PASSWORD,
          firstName: 'Inactive',
          lastName: 'First',
          role: 'admin',
          isActive: false,
          communityId: emptyCommunityId,
        })
      ).rejects.toThrow(LastActiveAdministratorError);
      expect(await usersInCommunity(emptyCommunityId)).toHaveLength(0);
    });
  });
});
