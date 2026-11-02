import { describe, expect, it } from 'vitest';
import {
  authorizeCommunityEnrollment,
  authorizePublicationChange,
  authorizeSystemAccountProvisioning,
  authorizeSystemAccountUpdate,
  createAdministrativeAuditEvent,
} from '../../src/shared/authorization/administrative-policy.js';

/**
 * SPEC-V2 §7 administrative authority primitives. Transport-independent, so
 * every decision branch is pinned here as well as end to end in
 * tests/security/sovereignty-administrative-sequences.test.ts.
 */
describe('administrative policy', () => {
  const admin = { id: 1, role: 'admin', communityId: 10 };

  describe('authorizeCommunityEnrollment', () => {
    it.each([
      [null, 'viewer', 'anonymous'],
      [admin, 'super_admin', 'system-role-not-assignable'],
      [
        { id: 2, role: 'super_admin', communityId: 10 },
        'viewer',
        'system-privilege-is-not-community-authority',
      ],
      [
        { id: 3, role: 'editor', communityId: 10 },
        'viewer',
        'not-community-admin',
      ],
      [
        { id: 4, role: 'viewer', communityId: 10 },
        'viewer',
        'not-community-admin',
      ],
      [
        { id: 5, role: 'elder', communityId: 10 },
        'viewer',
        'not-community-admin',
      ],
      [
        { id: 6, role: 'guest', communityId: 10 },
        'viewer',
        'not-community-admin',
      ],
      [{ id: 7, role: 'admin', communityId: 11 }, 'viewer', 'cross-community'],
    ] as const)(
      'denies %o enrolling %s (%s)',
      (actor, requestedRole, reason) => {
        expect(
          authorizeCommunityEnrollment({
            actor,
            targetCommunityId: 10,
            requestedRole,
          })
        ).toEqual({ allowed: false, reason });
      }
    );

    it.each(['admin', 'editor', 'viewer'])(
      'lets a same-community admin enroll a %s',
      (requestedRole) => {
        expect(
          authorizeCommunityEnrollment({
            actor: admin,
            targetCommunityId: 10,
            requestedRole,
          })
        ).toEqual({ allowed: true, reason: 'community-admin' });
      }
    );
  });

  describe('authorizeSystemAccountProvisioning', () => {
    const empty = { hasCommunityAccounts: false, hasContent: false };

    it('allows system accounts regardless of community state', () => {
      expect(
        authorizeSystemAccountProvisioning({
          requestedRole: 'super_admin',
          community: { hasCommunityAccounts: true, hasContent: true },
        })
      ).toEqual({ allowed: true, reason: 'system-account' });
    });

    it('allows only the first administrator of an empty community', () => {
      expect(
        authorizeSystemAccountProvisioning({
          requestedRole: 'admin',
          community: empty,
        })
      ).toEqual({ allowed: true, reason: 'unclaimed-empty-community' });
    });

    it.each([
      [{ hasCommunityAccounts: true, hasContent: false }],
      [{ hasCommunityAccounts: false, hasContent: true }],
      [{ hasCommunityAccounts: true, hasContent: true }],
    ])(
      'denies an administrator for a claimed or non-empty community %o',
      (community) => {
        expect(
          authorizeSystemAccountProvisioning({
            requestedRole: 'admin',
            community,
          })
        ).toEqual({
          allowed: false,
          reason: 'community-claimed-or-holds-content',
        });
      }
    );

    it.each(['viewer', 'editor', 'elder', 'guest'])(
      'denies a %s account even in an empty community',
      (requestedRole) => {
        expect(
          authorizeSystemAccountProvisioning({
            requestedRole,
            community: empty,
          })
        ).toEqual({ allowed: false, reason: 'first-administrator-only' });
      }
    );
  });

  describe('authorizeSystemAccountUpdate', () => {
    it.each([
      [{ role: 'viewer', communityId: 10 }, {}],
      [
        { role: 'viewer', communityId: 10 },
        { role: 'viewer', communityId: 10 },
      ],
    ])('allows lifecycle-only updates %#', (current, requested) => {
      expect(authorizeSystemAccountUpdate({ current, requested })).toEqual({
        allowed: true,
        reason: 'lifecycle-fields-only',
      });
    });

    it('allows moving a system account between system records', () => {
      expect(
        authorizeSystemAccountUpdate({
          current: { role: 'super_admin', communityId: 10 },
          requested: { communityId: 11 },
        })
      ).toEqual({ allowed: true, reason: 'system-account' });
    });

    it.each([
      [{ role: 'super_admin', communityId: 10 }, { role: 'admin' }],
      [{ role: 'viewer', communityId: 10 }, { role: 'admin' }],
      [{ role: 'admin', communityId: 10 }, { role: 'viewer' }],
      [{ role: 'admin', communityId: 10 }, { communityId: 11 }],
      [{ role: 'admin', communityId: 10 }, { role: 'super_admin' }],
    ])(
      'denies role or membership change from %o with %o',
      (current, requested) => {
        expect(authorizeSystemAccountUpdate({ current, requested })).toEqual({
          allowed: false,
          reason: 'system-privilege-is-not-community-authority',
        });
      }
    );
  });

  describe('authorizePublicationChange', () => {
    it.each([undefined, false])(
      'treats requestedPublic=%s on a private community as no change',
      (requestedPublic) => {
        expect(
          authorizePublicationChange({
            actor: null,
            communityId: 10,
            currentPublic: false,
            requestedPublic,
          })
        ).toEqual({ allowed: true, reason: 'no-publication-change' });
      }
    );

    it.each([
      [null, 'anonymous'],
      [
        { id: 2, role: 'super_admin', communityId: null },
        'system-privilege-is-not-community-authority',
      ],
      [{ id: 3, role: 'editor', communityId: 10 }, 'not-community-admin'],
      [{ id: 4, role: 'admin', communityId: 11 }, 'cross-community'],
    ] as const)('denies %o publishing (%s)', (actor, reason) => {
      expect(
        authorizePublicationChange({
          actor,
          communityId: 10,
          currentPublic: false,
          requestedPublic: true,
        })
      ).toEqual({ allowed: false, reason });
    });

    it('denies a super admin unpublishing too', () => {
      expect(
        authorizePublicationChange({
          actor: { id: 2, role: 'super_admin', communityId: null },
          communityId: 10,
          currentPublic: true,
          requestedPublic: false,
        }).allowed
      ).toBe(false);
    });

    it('lets a same-community admin change publication', () => {
      expect(
        authorizePublicationChange({
          actor: admin,
          communityId: 10,
          currentPublic: false,
          requestedPublic: true,
        })
      ).toEqual({ allowed: true, reason: 'community-admin' });
    });
  });

  it('builds content-free audit events', () => {
    expect(
      createAdministrativeAuditEvent({
        action: 'enrollment',
        actor: admin,
        communityId: 10,
        resourceId: 99,
        decision: { allowed: true, reason: 'community-admin' },
      })
    ).toEqual({
      event: 'administrative_decision',
      action: 'enrollment',
      actorId: 1,
      actorCommunityId: 10,
      communityId: 10,
      resourceId: 99,
      allowed: true,
      reason: 'community-admin',
    });
  });
});
