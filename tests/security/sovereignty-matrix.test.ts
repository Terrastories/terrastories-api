import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_MATRIX,
  CONTENT_ROUTE_FAMILIES,
  FIELD_VISIBILITY_CATEGORIES,
  PROTECTED_SURFACES,
  STORY_AUDIENCES,
  STORY_AUDIENCE_ROLES,
  V2_COMMUNITY_ROLES,
  authorizeCommunityContent,
  canExposeField,
  createAuthorizationAuditEvent,
  fastifyCommunityToGates,
  fastifyRoleToV2Role,
  storyAccessForPhysicalRole,
  physicalRoleCanReadStoryAccess,
  fastifyStoryToAudience,
  roleCanReadStoryAccess,
  roleCanReadStoryAudience,
  storyAccessForRole,
  type AuthorizationActor,
  type ContentRouteFamily,
  type ProtectedSurface,
} from '../../src/shared/authorization/sovereignty-policy.js';

const communityActor = (
  role: (typeof V2_COMMUNITY_ROLES)[number],
  communityId: number | null = 1,
  active = true
): AuthorizationActor => ({
  id: 10,
  role,
  communityId,
  active,
});

describe('V2 sovereignty authorization matrix', () => {
  it('contains only the canonical V2 roles', () => {
    expect(V2_COMMUNITY_ROLES).toEqual([
      'viewer',
      'member',
      'editor',
      'admin',
      'super_admin',
    ]);
    expect(V2_COMMUNITY_ROLES).not.toContain('elder');
  });

  it('represents every protected route family, side-channel surface, and field category', () => {
    expect(CONTENT_ROUTE_FAMILIES).toEqual([
      'stories',
      'places',
      'speakers',
      'themes',
      'files',
      'nested-relations',
      'aggregates',
      'exports',
    ]);
    expect(PROTECTED_SURFACES).toEqual([
      'crud',
      'list',
      'search',
      'stats',
      'public-api',
      'export',
      'file',
      'nested-relation',
      'aggregate',
      'error',
    ]);
    expect(FIELD_VISIBILITY_CATEGORIES).toEqual([
      'public',
      'community-only',
      'role-restricted',
      'never-exposed',
    ]);

    for (const family of CONTENT_ROUTE_FAMILIES) {
      expect(AUTHORIZATION_MATRIX.content[family]).toBeDefined();
    }
    for (const surface of PROTECTED_SURFACES) {
      expect(AUTHORIZATION_MATRIX.surfaces[surface]).toBeDefined();
    }
    for (const category of FIELD_VISIBILITY_CATEGORIES) {
      expect(AUTHORIZATION_MATRIX.fields[category]).toBeDefined();
    }
  });

  it('allows viewer/editor/admin only inside their own active community', () => {
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      expect(
        authorizeCommunityContent({
          actor: communityActor(role, 7),
          resourceCommunityId: 7,
          family: 'stories',
          surface: 'list',
          visibility: 'community-only',
          communityStatus: 'active',
        })
      ).toMatchObject({ allowed: true, reason: 'same-community' });
    }
  });

  it('blocks super-admin from every community-content family and every protected surface', () => {
    const actor = communityActor('super_admin', 0);

    for (const family of CONTENT_ROUTE_FAMILIES) {
      for (const surface of PROTECTED_SURFACES) {
        const decision = authorizeCommunityContent({
          actor,
          resourceCommunityId: 9,
          family,
          surface,
          visibility: 'community-only',
          communityStatus: 'active',
        });
        expect(decision.allowed, `${family}/${surface}`).toBe(false);
        expect(decision.reason).toBe('super-admin-content-denied');
      }
    }
  });

  it('blocks every community role from cross-community non-public observation on every side-channel surface', () => {
    const roles = ['viewer', 'editor', 'admin'] as const;

    for (const role of roles) {
      for (const surface of PROTECTED_SURFACES) {
        const decision = authorizeCommunityContent({
          actor: communityActor(role, 1),
          resourceCommunityId: 2,
          family: familyForSurface(surface),
          surface,
          visibility: 'community-only',
          communityStatus: 'active',
        });
        expect(decision.allowed, `${role}/${surface}`).toBe(false);
        expect(decision.reason).toBe('cross-community-denied');
      }
    }
  });

  it('does not infer public visibility from a route namespace', () => {
    const missingExplicitGrant = authorizeCommunityContent({
      actor: null,
      resourceCommunityId: 3,
      family: 'stories',
      surface: 'public-api',
      visibility: 'public',
      communityVisibility: 'private',
      communityStatus: 'active',
    });
    expect(missingExplicitGrant).toMatchObject({
      allowed: false,
      reason: 'not-explicitly-public',
    });

    const explicitGrant = authorizeCommunityContent({
      actor: null,
      resourceCommunityId: 3,
      family: 'stories',
      surface: 'public-api',
      visibility: 'public',
      communityVisibility: 'public',
      communityStatus: 'active',
    });
    expect(explicitGrant).toMatchObject({
      allowed: true,
      reason: 'explicit-public',
    });
  });

  it('does not treat public content as public on member-only surfaces', () => {
    expect(
      authorizeCommunityContent({
        actor: null,
        resourceCommunityId: 3,
        family: 'stories',
        surface: 'list',
        visibility: 'public',
        communityVisibility: 'public',
        communityStatus: 'active',
      })
    ).toMatchObject({ allowed: false, reason: 'authentication-required' });
  });

  it('fails closed for inactive communities and disabled users', () => {
    expect(
      authorizeCommunityContent({
        actor: communityActor('admin', 1),
        resourceCommunityId: 1,
        family: 'places',
        surface: 'crud',
        visibility: 'community-only',
        communityStatus: 'disabled',
      })
    ).toMatchObject({ allowed: false, reason: 'inactive-community' });

    expect(
      authorizeCommunityContent({
        actor: communityActor('admin', 1, false),
        resourceCommunityId: 1,
        family: 'places',
        surface: 'crud',
        visibility: 'community-only',
        communityStatus: 'active',
      })
    ).toMatchObject({ allowed: false, reason: 'disabled-user' });

    expect(
      authorizeCommunityContent({
        actor: {
          id: 10,
          role: 'viewer',
          communityId: 1,
          active: undefined as unknown as boolean,
        },
        resourceCommunityId: 1,
        family: 'places',
        surface: 'list',
        visibility: 'community-only',
        communityStatus: 'active',
      })
    ).toMatchObject({ allowed: false, reason: 'disabled-user' });
  });

  it('enforces field visibility without leaking operational fields', () => {
    const viewer = communityActor('viewer', 5);
    const admin = communityActor('admin', 5);

    expect(
      canExposeField({
        category: 'public',
        actor: null,
        actorCommunityId: null,
        resourceCommunityId: 5,
        communityVisibility: 'public',
      })
    ).toBe(true);
    expect(
      canExposeField({
        category: 'community-only',
        actor: viewer,
        actorCommunityId: 5,
        resourceCommunityId: 5,
      })
    ).toBe(true);
    expect(
      canExposeField({
        category: 'role-restricted',
        actor: viewer,
        actorCommunityId: 5,
        resourceCommunityId: 5,
        allowedRoles: ['admin'],
      })
    ).toBe(false);
    expect(
      canExposeField({
        category: 'role-restricted',
        actor: admin,
        actorCommunityId: 5,
        resourceCommunityId: 5,
        allowedRoles: ['admin'],
      })
    ).toBe(true);
    expect(
      canExposeField({
        category: 'never-exposed',
        actor: admin,
        actorCommunityId: 5,
        resourceCommunityId: 5,
      })
    ).toBe(false);
    expect(
      canExposeField({
        category: 'community-only',
        actor: {
          id: 10,
          role: 'viewer',
          communityId: 5,
          active: undefined as unknown as boolean,
        },
        actorCommunityId: 5,
        resourceCommunityId: 5,
      })
    ).toBe(false);
  });

  it('creates content-free audit records for allow and deny decisions', () => {
    const decision = authorizeCommunityContent({
      actor: communityActor('editor', 1),
      resourceCommunityId: 2,
      family: 'stories',
      surface: 'search',
      visibility: 'community-only',
      communityStatus: 'active',
    });
    const event = createAuthorizationAuditEvent({
      actor: communityActor('editor', 1),
      resourceCommunityId: 2,
      family: 'stories',
      surface: 'search',
      decision,
    });

    expect(event).toEqual({
      action: 'authorization_decision',
      actorId: 10,
      actorRole: 'editor',
      actorCommunityId: 1,
      resourceCommunityId: 2,
      family: 'stories',
      surface: 'search',
      allowed: false,
      reason: 'cross-community-denied',
    });
    expect(event).not.toHaveProperty('body');
    expect(event).not.toHaveProperty('content');
    expect(event).not.toHaveProperty('payload');
  });
});

describe('V2 story audiences (SPEC-V2 §6.2/§6.3)', () => {
  it('lists exactly the canonical story audiences', () => {
    expect(STORY_AUDIENCES).toEqual(['public', 'community', 'editors']);
  });

  it('grants each role exactly its §6.2 audiences', () => {
    expect(STORY_AUDIENCE_ROLES.public).toEqual([
      'viewer',
      'member',
      'editor',
      'admin',
    ]);
    expect(STORY_AUDIENCE_ROLES.community).toEqual([
      'member',
      'editor',
      'admin',
    ]);
    expect(STORY_AUDIENCE_ROLES.editors).toEqual(['editor', 'admin']);

    // No role table ever grants super_admin an authenticated story audience.
    for (const audience of STORY_AUDIENCES) {
      expect(STORY_AUDIENCE_ROLES[audience]).not.toContain('super_admin');
      expect(STORY_AUDIENCE_ROLES[audience]).not.toContain('elder');
    }
  });

  it('lets member read public and community but not editors audiences', () => {
    expect(roleCanReadStoryAudience('member', 'public')).toBe(true);
    expect(roleCanReadStoryAudience('member', 'community')).toBe(true);
    expect(roleCanReadStoryAudience('member', 'editors')).toBe(false);
  });

  it('restricts viewer to the public audience', () => {
    expect(roleCanReadStoryAudience('viewer', 'public')).toBe(true);
    expect(roleCanReadStoryAudience('viewer', 'community')).toBe(false);
    expect(roleCanReadStoryAudience('viewer', 'editors')).toBe(false);
  });

  it('maps every Fastify column state to a runtime read access, fail-closed', () => {
    expect(fastifyStoryToAudience('public', false)).toBe('public');
    expect(fastifyStoryToAudience('members_only', false)).toBe('community');
    // Restricted rows are unavailable to EVERY role (SPEC-V2 §6.3): the
    // V1 elder/admin audience has no canonical equivalent, so the rows
    // stay unreadable until a community-approved explicit disposition.
    expect(fastifyStoryToAudience('public', true)).toBe('unavailable');
    expect(fastifyStoryToAudience('members_only', true)).toBe('unavailable');
    // Unknown legacy values follow the same explicit-disposition path:
    // never `editors`, never `public` (SPEC-V2 §6.3).
    expect(fastifyStoryToAudience('private', false)).toBe('unavailable');
    expect(fastifyStoryToAudience('restricted', false)).toBe('unavailable');
    expect(fastifyStoryToAudience('', false)).toBe('unavailable');
  });

  it('denies the unavailable access to every V2 role', () => {
    for (const role of V2_COMMUNITY_ROLES) {
      expect(roleCanReadStoryAccess(role, 'unavailable')).toBe(false);
    }
  });

  it('never grants a role the unavailable access in its list/count filters', () => {
    for (const role of V2_COMMUNITY_ROLES) {
      expect(storyAccessForRole(role)).not.toContain('unavailable');
    }
    // Canonical audiences stay untouched; on the Fastify schema the
    // `editors` audience simply matches no row at runtime.
    expect(storyAccessForRole('admin')).toEqual([
      'public',
      'community',
      'editors',
    ]);
    expect(storyAccessForRole('viewer')).toEqual(['public']);
    expect(storyAccessForRole('super_admin')).toEqual([]);
  });
});

describe('V2 community gates and super-admin boundary (SPEC-V2 §6.1/§6.2)', () => {
  it('maps the Fastify community columns to canonical gates', () => {
    expect(fastifyCommunityToGates(true, true)).toEqual({
      visibility: 'public',
      status: 'active',
    });
    expect(fastifyCommunityToGates(false, true)).toEqual({
      visibility: 'private',
      status: 'active',
    });
    expect(fastifyCommunityToGates(true, false)).toEqual({
      visibility: 'public',
      status: 'disabled',
    });
    expect(fastifyCommunityToGates(false, false)).toEqual({
      visibility: 'private',
      status: 'disabled',
    });
  });

  it('admits anonymous public projections only for an active public community', () => {
    const input = {
      actor: null,
      resourceCommunityId: 5,
      family: 'stories' as const,
      surface: 'public-api' as const,
      visibility: 'public' as const,
    };
    expect(
      authorizeCommunityContent({
        ...input,
        communityStatus: 'active',
        communityVisibility: 'public',
      })
    ).toMatchObject({ allowed: true, reason: 'explicit-public' });
    expect(
      authorizeCommunityContent({
        ...input,
        communityStatus: 'active',
        communityVisibility: 'private',
      })
    ).toMatchObject({ allowed: false, reason: 'not-explicitly-public' });
    expect(
      authorizeCommunityContent({
        ...input,
        communityStatus: 'disabled',
        communityVisibility: 'public',
      })
    ).toMatchObject({ allowed: false, reason: 'inactive-community' });
  });

  it('keeps the strict super-admin deny even on fully public gates', () => {
    // Defense in depth (§6.2): a super admin consumes public projections as
    // an anonymous caller (the public-api routes never attach an actor), and
    // any actor-bearing super-admin request is denied on every surface.
    const decision = authorizeCommunityContent({
      actor: communityActor('super_admin', null),
      resourceCommunityId: 5,
      family: 'stories',
      surface: 'public-api',
      visibility: 'public',
      communityStatus: 'active',
      communityVisibility: 'public',
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'super-admin-content-denied',
    });
  });

  it('treats a canonical null-community actor as outside every community', () => {
    const decision = authorizeCommunityContent({
      actor: { ...communityActor('viewer', 1), communityId: null },
      resourceCommunityId: 1,
      family: 'stories',
      surface: 'list',
      visibility: 'community-only',
      communityStatus: 'active',
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: 'cross-community-denied',
    });
  });
});

describe('Fastify physical role mapping (SPEC-V2 §6.2)', () => {
  it('decides direct reads from the physical role, denying unknown roles', () => {
    expect(physicalRoleCanReadStoryAccess('viewer', 'community')).toBe(true);
    expect(physicalRoleCanReadStoryAccess('elder', 'community')).toBe(true);
    expect(physicalRoleCanReadStoryAccess('elder', 'editors')).toBe(false);
    expect(physicalRoleCanReadStoryAccess('admin', 'editors')).toBe(true);
    for (const role of ['viewer', 'editor', 'admin', 'elder']) {
      expect(physicalRoleCanReadStoryAccess(role, 'unavailable')).toBe(false);
    }
    // Unknown roles never read anything, not even public rows.
    expect(physicalRoleCanReadStoryAccess('guest', 'public')).toBe(false);
    expect(physicalRoleCanReadStoryAccess('', 'public')).toBe(false);
    expect(physicalRoleCanReadStoryAccess('super_admin', 'public')).toBe(false);
  });

  it('derives list/count story accesses from the physical role, fail-closed', () => {
    expect(storyAccessForPhysicalRole('viewer')).toEqual([
      'public',
      'community',
    ]);
    // Legacy elder keeps member reach; unavailable rows stay unavailable.
    expect(storyAccessForPhysicalRole('elder')).toEqual([
      'public',
      'community',
    ]);
    expect(storyAccessForPhysicalRole('super_admin')).toEqual([]);
    // Unknown roles hold no access at all.
    expect(storyAccessForPhysicalRole('unknown')).toEqual([]);
    expect(storyAccessForPhysicalRole('')).toEqual([]);
    for (const role of ['viewer', 'editor', 'admin', 'elder']) {
      expect(storyAccessForPhysicalRole(role)).not.toContain('unavailable');
    }
  });

  it('maps a physical Fastify viewer to canonical V2 member, never to V2 viewer', () => {
    // §6.2: V1 viewer story reads filtered only `isRestricted = false` and
    // never enforced privacyLevel, so a physical Fastify viewer effectively
    // reads members_only stories — the audience V2 grants to `member`.
    // Mapping to V2 viewer would silently narrow that user's access.
    expect(fastifyRoleToV2Role('viewer')).toBe('member');
    expect(fastifyRoleToV2Role('viewer')).not.toBe('viewer');
  });

  it('maps the other canonical roles identity', () => {
    expect(fastifyRoleToV2Role('member')).toBe('member');
    expect(fastifyRoleToV2Role('editor')).toBe('editor');
    expect(fastifyRoleToV2Role('admin')).toBe('admin');
    expect(fastifyRoleToV2Role('super_admin')).toBe('super_admin');
  });

  it('returns null for elder, empty, and unknown physical roles (legacy V1 path)', () => {
    expect(fastifyRoleToV2Role('elder')).toBeNull();
    expect(fastifyRoleToV2Role('')).toBeNull();
    expect(fastifyRoleToV2Role('unknown')).toBeNull();
  });
});

function familyForSurface(surface: ProtectedSurface): ContentRouteFamily {
  switch (surface) {
    case 'file':
      return 'files';
    case 'export':
      return 'exports';
    case 'nested-relation':
      return 'nested-relations';
    case 'aggregate':
    case 'stats':
      return 'aggregates';
    default:
      return 'stories';
  }
}
