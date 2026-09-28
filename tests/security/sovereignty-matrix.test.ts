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
  fastifyStoryToAudience,
  roleCanReadStoryAudience,
  type AuthorizationActor,
  type ContentRouteFamily,
  type ProtectedSurface,
} from '../../src/shared/authorization/sovereignty-policy.js';

const communityActor = (
  role: (typeof V2_COMMUNITY_ROLES)[number],
  communityId = 1,
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
          communityActive: true,
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
          communityActive: true,
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
          communityActive: true,
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
      explicitlyPublic: false,
      communityActive: true,
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
      explicitlyPublic: true,
      communityActive: true,
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
        explicitlyPublic: true,
        communityActive: true,
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
        communityActive: false,
      })
    ).toMatchObject({ allowed: false, reason: 'inactive-community' });

    expect(
      authorizeCommunityContent({
        actor: communityActor('admin', 1, false),
        resourceCommunityId: 1,
        family: 'places',
        surface: 'crud',
        visibility: 'community-only',
        communityActive: true,
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
        communityActive: true,
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
        explicitlyPublic: true,
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
      communityActive: true,
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

  it('maps every Fastify column state to a canonical audience fail-closed', () => {
    expect(fastifyStoryToAudience('public', false)).toBe('public');
    expect(fastifyStoryToAudience('members_only', false)).toBe('community');
    // Restriction overrides every privacy level (elder/admin-only has no
    // canonical runtime equivalent; editors is the closest retained audience).
    expect(fastifyStoryToAudience('public', true)).toBe('editors');
    expect(fastifyStoryToAudience('members_only', true)).toBe('editors');
    // Unknown legacy values never widen access.
    expect(fastifyStoryToAudience('private', false)).toBe('editors');
    expect(fastifyStoryToAudience('restricted', false)).toBe('editors');
    expect(fastifyStoryToAudience('', false)).toBe('editors');
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
