import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
import * as UserServiceModule from '../../src/services/user.service.js';
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
    it('does not let a stale no-op publicStories resend overwrite a community unpublish', async () => {
      // Deterministic replay of the race: the system request read the
      // community while it was public (so `publicStories: true` looked like
      // a no-op), then the community admin unpublished it before the write.
      const [stored] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(stored.publicStories).toBe(false);
      const staleRead = vi
        .spyOn(communityRepository, 'findById')
        .mockResolvedValueOnce({ ...stored, publicStories: true });
      const write = vi.spyOn(communityRepository, 'update');

      await communityService.updateCommunityAsSuperAdmin(privateCommunityId, {
        name: 'GUARD-STALE-RENAME',
        publicStories: true,
      });

      const [row] = await db
        .select()
        .from(communitiesSqlite)
        .where(eq(communitiesSqlite.id, privateCommunityId));
      expect(row.publicStories).toBe(false);
      expect(row.name).toBe('GUARD-STALE-RENAME');
      for (const call of write.mock.calls) {
        expect(call[1]).not.toHaveProperty('publicStories');
      }
      staleRead.mockRestore();
      write.mockRestore();
    });

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
      // A system account's reactivation is a membership change: it goes
      // through the compare-and-set path with isActive:true.
      const cas = vi.spyOn(userRepository, 'compareAndSetMembership');
      await service.updateUserAsSuperAdmin(system.id, { isActive: true });
      expect(cas).toHaveBeenCalledTimes(1);
      expect(cas.mock.calls[0][2].isActive).toBe(true);
      // ...and the community account above never reached it.
      expect(write).toHaveBeenCalledTimes(1);

      cas.mockRestore();
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

  describe('membership compare-and-set (round 6)', () => {
    // Reviewer round 6: every write of role, isActive or communityId on a
    // user must compare-and-set against the snapshot the decision was made
    // on. A decision taken from a stale snapshot must not land, and two
    // decisions that each pass on their own must not together break the
    // last-active-admin invariant.
    const rowFor = async (id: number) => {
      const [row] = await db
        .select()
        .from(usersSqlite)
        .where(eq(usersSqlite.id, id));
      return row;
    };

    const activeAdminsIn = async (communityId: number) =>
      (await usersInCommunity(communityId)).filter(
        (row) => row.role === 'admin' && row.isActive
      );

    /**
     * MembershipConflictError is not exported yet (round 6 RED step); reach
     * it through the module namespace so the file still loads and each test
     * fails on its own assertion.
     */
    function membershipConflictError(): new (...args: never[]) => Error {
      const type = (UserServiceModule as unknown as Record<string, unknown>)
        .MembershipConflictError;
      if (typeof type !== 'function') {
        throw new Error(
          'MembershipConflictError is not exported from src/services/user.service.ts yet (round 6)'
        );
      }
      return type as unknown as new (...args: never[]) => Error;
    }

    /** Expects the attempt to reject with MembershipConflictError. */
    async function expectMembershipConflict(attempt: Promise<unknown>) {
      const thrown = await attempt.then(
        () => null,
        (error: unknown) => error
      );
      if (thrown === null) {
        throw new Error(
          'expected MembershipConflictError, but the update resolved'
        );
      }
      expect(thrown).toBeInstanceOf(membershipConflictError());
    }

    type CasExpected = { role: string; isActive: boolean; communityId: number };
    type CasOutcome =
      | { status: 'updated'; user: User }
      | { status: 'conflict' }
      | { status: 'last-admin' };

    /** Calls UserRepository.compareAndSetMembership (round 6 contract). */
    async function compareAndSet(
      repository: UserRepository,
      id: number,
      expected: CasExpected,
      patch: Record<string, unknown>,
      options?: { requireOtherActiveAdmin?: boolean }
    ): Promise<CasOutcome> {
      const method = (
        repository as unknown as {
          compareAndSetMembership?: (
            id: number,
            expected: CasExpected,
            patch: Record<string, unknown>,
            options?: { requireOtherActiveAdmin?: boolean }
          ) => Promise<CasOutcome>;
        }
      ).compareAndSetMembership;
      if (typeof method !== 'function') {
        throw new Error(
          'UserRepository.compareAndSetMembership is not implemented yet (round 6)'
        );
      }
      return method.call(repository, id, expected, patch, options);
    }

    it('system stale same-role resend cannot undo a community demotion (Sol P1)', async () => {
      // A second active administrator keeps the community demotion of this
      // admin otherwise allowed.
      await insertUser(privateCommunityId, 'admin', 'round6-remaining');

      const repository = new UserRepository(db);
      const service = new UserService(repository, communityRepository);
      const realFind = repository.findByIdAsSuperAdmin.bind(repository);
      vi.spyOn(repository, 'findByIdAsSuperAdmin').mockImplementationOnce(
        async (id: number) => {
          const snapshot = await realFind(id);
          // The community demotes the admin after the system read.
          await userService.updateUserInCommunity(
            id,
            { role: 'viewer' },
            privateCommunityId
          );
          return snapshot;
        }
      );

      // The system re-sends the role it read (admin), renaming as it goes.
      const resolved = await service
        .updateUserAsSuperAdmin(admin.id, {
          role: 'admin',
          firstName: 'System rename',
        })
        .then(
          () => true,
          () => false
        );

      const current = await realFind(admin.id);
      expect(current?.role).toBe('viewer');
      if (resolved) {
        expect(current?.firstName).toBe('System rename');
      }
    });

    it('two system deactivations must preserve one active admin (Sol P2)', async () => {
      const second = await insertUser(
        privateCommunityId,
        'admin',
        'round6-second'
      );
      const repository = new UserRepository(db);
      const service = new UserService(repository, communityRepository);
      const realFind = repository.findByIdAsSuperAdmin.bind(repository);

      // Both snapshot reads observe both administrators still active.
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(repository, 'findByIdAsSuperAdmin').mockImplementation(
        async (...args: Parameters<typeof realFind>) => {
          const snapshot = await realFind(...args);
          if (++arrivals === 2) release();
          await gate;
          return snapshot;
        }
      );

      const outcomes = await Promise.allSettled([
        service.updateUserAsSuperAdmin(admin.id, { isActive: false }),
        service.updateUserAsSuperAdmin(second.id, { isActive: false }),
      ]);

      expect(await activeAdminsIn(privateCommunityId)).toHaveLength(1);
      const rejected = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        LastActiveAdministratorError
      );
    });

    it('two delete-path deactivations must preserve one active admin', async () => {
      const second = await insertUser(
        privateCommunityId,
        'admin',
        'round6-delete-second'
      );
      const repository = new UserRepository(db);
      const service = new UserService(repository, communityRepository);
      const realFind = repository.findByIdAsSuperAdmin.bind(repository);

      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(repository, 'findByIdAsSuperAdmin').mockImplementation(
        async (...args: Parameters<typeof realFind>) => {
          const snapshot = await realFind(...args);
          if (++arrivals === 2) release();
          await gate;
          return snapshot;
        }
      );

      const outcomes = await Promise.allSettled([
        service.deactivateUserAsSuperAdmin(admin.id),
        service.deactivateUserAsSuperAdmin(second.id),
      ]);

      expect(await activeAdminsIn(privateCommunityId)).toHaveLength(1);
      const rejected = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        LastActiveAdministratorError
      );
    });

    it('two community admins deactivating each other must preserve one active admin', async () => {
      const peer = await insertUser(privateCommunityId, 'admin', 'round6-peer');
      const service = new UserService(
        new UserRepository(db),
        communityRepository
      );
      const realGet = service.getUserByIdInCommunity.bind(service);

      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(service, 'getUserByIdInCommunity').mockImplementation(
        async (...args: Parameters<typeof realGet>) => {
          const snapshot = await realGet(...args);
          if (++arrivals === 2) release();
          await gate;
          return snapshot;
        }
      );

      await Promise.allSettled([
        service.updateUserInCommunity(
          peer.id,
          { isActive: false },
          privateCommunityId
        ),
        service.updateUserInCommunity(
          admin.id,
          { isActive: false },
          privateCommunityId
        ),
      ]);

      expect(await activeAdminsIn(privateCommunityId)).toHaveLength(1);
    });

    it('two community admins deleting each other must preserve one active admin', async () => {
      const second = await insertUser(
        privateCommunityId,
        'admin',
        'round6-delete-peer'
      );
      const service = new UserService(
        new UserRepository(db),
        communityRepository
      );
      const realGet = service.getUserByIdInCommunity.bind(service);

      // Both delete-path snapshot reads observe both administrators still
      // active before either write runs.
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(service, 'getUserByIdInCommunity').mockImplementation(
        async (...args: Parameters<typeof realGet>) => {
          const snapshot = await realGet(...args);
          if (++arrivals === 2) release();
          await gate;
          return snapshot;
        }
      );

      const outcomes = await Promise.allSettled([
        service.deleteUserInCommunity(second.id, privateCommunityId, admin.id),
        service.deleteUserInCommunity(admin.id, privateCommunityId, second.id),
      ]);

      expect(await activeAdminsIn(privateCommunityId)).toHaveLength(1);
      const rejected = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        LastActiveAdministratorError
      );
    });

    it('a system deactivation racing an admin self-deactivation must preserve one active admin', async () => {
      const second = await insertUser(
        privateCommunityId,
        'admin',
        'round6-mixed-second'
      );
      const repository = new UserRepository(db);
      const systemService = new UserService(repository, communityRepository);
      const communityService = new UserService(repository, communityRepository);
      const realFind = repository.findByIdAsSuperAdmin.bind(repository);
      const realGet =
        communityService.getUserByIdInCommunity.bind(communityService);

      // Both snapshot reads observe both administrators still active: the
      // system path reads through the repository, the community path through
      // the service, and one shared gate releases when both have arrived.
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(repository, 'findByIdAsSuperAdmin').mockImplementation(
        async (...args: Parameters<typeof realFind>) => {
          const snapshot = await realFind(...args);
          if (++arrivals === 2) release();
          await gate;
          return snapshot;
        }
      );
      vi.spyOn(communityService, 'getUserByIdInCommunity').mockImplementation(
        async (...args: Parameters<typeof realGet>) => {
          const snapshot = await realGet(...args);
          if (++arrivals === 2) release();
          await gate;
          return snapshot;
        }
      );

      await Promise.allSettled([
        systemService.updateUserAsSuperAdmin(admin.id, { isActive: false }),
        communityService.updateUserInCommunity(
          second.id,
          { isActive: false },
          privateCommunityId
        ),
      ]);

      expect(await activeAdminsIn(privateCommunityId)).toHaveLength(1);
    });

    it('rejects a community-admin stale role write with MembershipConflictError', async () => {
      const target = await insertUser(
        privateCommunityId,
        'viewer',
        'round6-stale-role',
        { firstName: 'Stale' }
      );
      const service = new UserService(
        new UserRepository(db),
        communityRepository
      );
      const realGet = service.getUserByIdInCommunity.bind(service);
      vi.spyOn(service, 'getUserByIdInCommunity').mockImplementationOnce(
        async (userId: number, communityId: number) => {
          const snapshot = await realGet(userId, communityId);
          // Admin B promotes the target before admin A's write lands.
          await userService.updateUserInCommunity(
            userId,
            { role: 'editor' },
            communityId
          );
          return snapshot;
        }
      );

      // A decides from the stale viewer snapshot to promote to admin.
      await expectMembershipConflict(
        service.updateUserInCommunity(
          target.id,
          { role: 'admin' },
          privateCommunityId
        )
      );

      const row = await rowFor(target.id);
      expect(row.role).toBe('editor');
    });

    it('a community-admin same-value resend writes nothing over a newer role', async () => {
      const target = await insertUser(
        privateCommunityId,
        'viewer',
        'round6-resend',
        { firstName: 'Resend-Before' }
      );
      const service = new UserService(
        new UserRepository(db),
        communityRepository
      );
      const realGet = service.getUserByIdInCommunity.bind(service);
      vi.spyOn(service, 'getUserByIdInCommunity').mockImplementationOnce(
        async (userId: number, communityId: number) => {
          const snapshot = await realGet(userId, communityId);
          await userService.updateUserInCommunity(
            userId,
            { role: 'editor' },
            communityId
          );
          return snapshot;
        }
      );

      // A re-sends the role it read (viewer); only the rename is new.
      await service.updateUserInCommunity(
        target.id,
        { role: 'viewer', firstName: 'Resend' },
        privateCommunityId
      );

      const row = await rowFor(target.id);
      expect(row.role).toBe('editor');
      expect(row.firstName).toBe('Resend');
    });

    it('a same-value isActive resend performs no compare-and-set write', async () => {
      const target = await insertUser(
        privateCommunityId,
        'viewer',
        'round6-resend-active',
        { firstName: 'Before' }
      );
      const repository = new UserRepository(db);
      const service = new UserService(repository, communityRepository);
      const cas = vi.spyOn(repository, 'compareAndSetMembership');

      // Re-sends the isActive value already stored on the row; only the
      // rename is new, so no membership CAS write may happen.
      await service.updateUserInCommunity(
        target.id,
        { isActive: (await rowFor(target.id)).isActive, firstName: 'Same' },
        privateCommunityId
      );

      expect(cas).not.toHaveBeenCalled();
      const row = await rowFor(target.id);
      expect(row.firstName).toBe('Same');
    });

    it('rejects a super-admin stale deactivation after a community demotion', async () => {
      await insertUser(privateCommunityId, 'admin', 'round6-demote-second');
      const repository = new UserRepository(db);
      const service = new UserService(repository, communityRepository);
      const realFind = repository.findByIdAsSuperAdmin.bind(repository);
      vi.spyOn(repository, 'findByIdAsSuperAdmin').mockImplementationOnce(
        async (id: number) => {
          const snapshot = await realFind(id);
          // A community admin demotes the target to viewer after the read.
          await userService.updateUserInCommunity(
            id,
            { role: 'viewer' },
            privateCommunityId
          );
          return snapshot;
        }
      );

      await expectMembershipConflict(
        service.updateUserAsSuperAdmin(admin.id, { isActive: false })
      );

      const row = await rowFor(admin.id);
      expect(row.role).toBe('viewer');
      expect(row.isActive).toBe(true);
    });

    describe('repository contract', () => {
      it('returns updated and writes when expected matches the row', async () => {
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          viewer.id,
          { role: 'viewer', isActive: true, communityId: privateCommunityId },
          { role: 'editor' }
        );
        expect(outcome.status).toBe('updated');
        expect((await rowFor(viewer.id)).role).toBe('editor');
      });

      it('returns conflict and writes nothing when expected.role mismatches', async () => {
        const target = await insertUser(
          privateCommunityId,
          'viewer',
          'round6-conflict',
          { firstName: 'Before' }
        );
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          target.id,
          { role: 'admin', isActive: true, communityId: privateCommunityId },
          { role: 'admin', firstName: 'Must Not Land' }
        );
        expect(outcome.status).toBe('conflict');
        const row = await rowFor(target.id);
        expect(row.role).toBe('viewer');
        expect(row.firstName).toBe('Before');
      });

      it('returns conflict and writes nothing when expected.isActive mismatches', async () => {
        const target = await insertUser(
          privateCommunityId,
          'viewer',
          'round6-conflict-active',
          { firstName: 'Before' }
        );
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          target.id,
          { role: 'viewer', isActive: false, communityId: privateCommunityId },
          { isActive: false, firstName: 'Must Not Land' }
        );
        expect(outcome.status).toBe('conflict');
        const row = await rowFor(target.id);
        expect(row.isActive).toBe(true);
        expect(row.firstName).toBe('Before');
      });

      it('returns conflict and writes nothing when expected.communityId mismatches', async () => {
        const target = await insertUser(
          privateCommunityId,
          'viewer',
          'round6-conflict-community',
          { firstName: 'Before' }
        );
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          target.id,
          { role: 'viewer', isActive: true, communityId: otherCommunityId },
          { communityId: otherCommunityId, firstName: 'Must Not Land' }
        );
        expect(outcome.status).toBe('conflict');
        const row = await rowFor(target.id);
        expect(row.communityId).toBe(privateCommunityId);
        expect(row.firstName).toBe('Before');
      });

      it('returns last-admin and writes nothing when it would drop the only active admin', async () => {
        const communityId = await insertCommunity('GUARD-CAS-SOLO');
        const solo = await insertUser(communityId, 'admin', 'cas-solo');
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          solo.id,
          { role: 'admin', isActive: true, communityId },
          { isActive: false },
          { requireOtherActiveAdmin: true }
        );
        expect(outcome.status).toBe('last-admin');
        expect((await rowFor(solo.id)).isActive).toBe(true);
      });

      it('returns updated with requireOtherActiveAdmin when another active admin exists', async () => {
        const communityId = await insertCommunity('GUARD-CAS-PAIR');
        const first = await insertUser(communityId, 'admin', 'cas-first');
        await insertUser(communityId, 'admin', 'cas-second');
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          first.id,
          { role: 'admin', isActive: true, communityId },
          { isActive: false },
          { requireOtherActiveAdmin: true }
        );
        expect(outcome.status).toBe('updated');
        expect((await rowFor(first.id)).isActive).toBe(false);
      });

      it('does not count an inactive other admin', async () => {
        const communityId = await insertCommunity('GUARD-CAS-INACTIVE');
        const solo = await insertUser(communityId, 'admin', 'cas-active-solo');
        await insertUser(communityId, 'admin', 'cas-inactive-peer', {
          isActive: false,
        });
        const repository = new UserRepository(db);
        const outcome = await compareAndSet(
          repository,
          solo.id,
          { role: 'admin', isActive: true, communityId },
          { isActive: false },
          { requireOtherActiveAdmin: true }
        );
        expect(outcome.status).toBe('last-admin');
        expect((await rowFor(solo.id)).isActive).toBe(true);
      });
    });

    describe('locking pins', () => {
      it('runs compareAndSetMembership in a BEGIN IMMEDIATE transaction on SQLite', async () => {
        const repository = new UserRepository(db);
        const txSpy = vi.spyOn(db, 'transaction');

        const outcome = await compareAndSet(
          repository,
          viewer.id,
          { role: 'viewer', isActive: true, communityId: privateCommunityId },
          { firstName: 'Cas Locked' }
        );
        expect(outcome.status).toBe('updated');
        expect(txSpy).toHaveBeenCalledWith(expect.any(Function), {
          behavior: 'immediate',
        });

        txSpy.mockRestore();
      });

      it('locks the community row through provisioningLockQuery on PostgreSQL', async () => {
        // Source pin: the PG branch of compareAndSetMembership must take the
        // same community-row lock the provisioning path uses. The real PG
        // concurrency run lives in the parity script; a PG CI lane is #161.
        const source = readFileSync(
          new URL('../../src/repositories/user.repository.ts', import.meta.url),
          'utf8'
        );
        const start = source.indexOf('compareAndSetMembership');
        expect(
          start,
          'UserRepository.compareAndSetMembership must exist'
        ).toBeGreaterThanOrEqual(0);
        const rest = source.slice(start);
        const nextMember = rest.search(/\n  [a-zA-Z]/);
        const body = nextMember === -1 ? rest : rest.slice(0, nextMember);
        expect(body).toContain('provisioningLockQuery(');
      });
    });
  });
});
