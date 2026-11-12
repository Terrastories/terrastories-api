import { communitySteps } from './community.js';
import { dashboardSteps } from './member-dashboard.js';
import { userSteps, systemSteps } from './users.js';
import { mediaSteps } from './media.js';
import { domainSteps } from './domain.js';
import type { Journey, Step } from '../runner.js';
export interface PersonaFixture {
  communityId: number;
  publicStoryId: number;
  placeId: number;
  systemUserId: number;
  speakerId: number;
  editableStoryIds: Record<'editor' | 'admin', number>;
  foreignStoryId: number;
  restrictedStoryId: number;
  unevidencedStoryId: number;
  credentials: Record<
    'viewer' | 'member' | 'editor' | 'admin' | 'super_admin',
    {
      email: string;
      password: string;
      communityId?: number;
    }
  >;
}
export function buildJourneys(fixture: PersonaFixture): Journey[] {
  const browse: Step[] = [
    {
      name: 'browse stories',
      method: 'GET',
      path: '/api/v1/member/stories',
      expected: 200,
      check: (body) =>
        typeof body === 'object' &&
        body !== null &&
        'data' in body &&
        Array.isArray(body.data) &&
        !body.data.some(
          (row: { id?: number }) =>
            row.id === fixture.foreignStoryId ||
            row.id === fixture.restrictedStoryId
        ),
    },
    {
      name: 'reject foreign story',
      method: 'GET',
      path: `/api/v1/member/stories/${fixture.foreignStoryId}`,
      expected: 404,
    },
    {
      name: 'hide restricted story',
      method: 'GET',
      path: `/api/v1/member/stories/${fixture.restrictedStoryId}`,
      expected: 404,
    },
    {
      name: 'reject malformed id',
      method: 'GET',
      path: '/api/v1/member/stories/not-an-id',
      expected: 400,
    },
  ];
  browse.push({
    name: 'hide unevidenced privacy story',
    method: 'GET',
    path: `/api/v1/member/stories/${fixture.unevidencedStoryId}`,
    expected: 404,
  });
  const login = (role: keyof PersonaFixture['credentials']): Step => ({
    name: 'login',
    method: 'POST',
    path: '/api/v1/auth/login',
    expected: 200,
    body: fixture.credentials[role],
  });
  const logout: Step = {
    name: 'logout',
    method: 'POST',
    path: '/api/v1/auth/logout',
    expected: 200,
  };
  const revoked: Step = {
    name: 'reject revoked session',
    method: 'GET',
    path: '/api/v1/auth/me',
    expected: 401,
  };
  return [
    {
      persona: 'anonymous',
      steps: [
        {
          name: 'public story detail',
          method: 'GET',
          path: `/api/communities/${fixture.communityId}/stories/${fixture.publicStoryId}`,
          expected: 200,
        },
        {
          name: 'public place detail',
          method: 'GET',
          path: `/api/communities/${fixture.communityId}/places/${fixture.placeId}`,
          expected: 200,
        },
        {
          name: 'reject malformed registration',
          method: 'POST',
          path: '/api/v1/auth/register',
          body: {},
          expected: 400,
        },
        {
          name: 'reject malformed recovery request',
          method: 'POST',
          path: '/api/v1/auth/forgot-password',
          body: {},
          expected: 400,
        },
        {
          name: 'reject invalid reset token',
          method: 'POST',
          path: '/api/v1/auth/reset-password',
          body: { token: 'invalid', password: 'QaNewPassword123!' },
          expected: 400,
        },
        {
          name: 'public communities',
          method: 'GET',
          path: '/api/communities',
          expected: 200,
        },
        {
          name: 'public stories',
          method: 'GET',
          path: `/api/communities/${fixture.communityId}/stories`,
          expected: 200,
        },
        {
          name: 'public places',
          method: 'GET',
          path: `/api/communities/${fixture.communityId}/places`,
          expected: 200,
        },
        { name: 'health', method: 'GET', path: '/health', expected: 200 },
        {
          name: 'require login',
          method: 'GET',
          path: '/api/v1/member/stories',
          expected: 401,
        },
      ],
    },
    ...(['viewer', 'member', 'editor', 'admin'] as const).map((role) => ({
      persona: role,
      steps: [
        login(role),
        ...browse,
        ...communitySteps(fixture.communityId, fixture.publicStoryId),
        ...(role === 'admin'
          ? [
              ...domainSteps(fixture.communityId),
              ...mediaSteps(),
              ...userSteps(),
              ...dashboardSteps(fixture.communityId, {
                stories: fixture.publicStoryId,
                places: fixture.placeId,
                speakers: fixture.speakerId,
              }),
              {
                name: 'admin-only boundary',
                method: 'GET',
                path: '/api/v1/auth/admin-only',
                expected: 200,
              },
            ]
          : []),
        ...(role === 'editor' || role === 'admin'
          ? [
              {
                name: 'create story',
                method: 'POST',
                path: '/api/v1/stories/',
                expected: 201,
                body: {
                  title: `QA ${role} created`,
                  communityId: fixture.communityId,
                },
              },
              {
                name: 'read story',
                method: 'GET',
                path: `/api/v1/stories/${fixture.editableStoryIds[role]}`,
                expected: 200,
              },
              {
                name: 'edit story',
                method: 'PATCH',
                path: `/api/v1/stories/${fixture.editableStoryIds[role]}`,
                expected: 200,
                body: { title: 'QA updated' },
              },
              {
                name: 'delete story',
                method: 'DELETE',
                path: `/api/v1/stories/${fixture.editableStoryIds[role]}`,
                expected: 204,
              },
            ]
          : [
              {
                name: 'deny story creation',
                method: 'POST',
                path: '/api/v1/stories/',
                expected: 403,
                body: { title: 'Denied', communityId: fixture.communityId },
              },
            ]),
        logout,
        revoked,
      ],
    })),
    {
      persona: 'restricted-holder',
      steps: [login('admin'), ...browse, logout],
    },
    {
      persona: 'super_admin',
      steps: [
        login('super_admin'),
        ...systemSteps(fixture.communityId),
        {
          name: 'deny restricted story for super admin',
          method: 'GET',
          path: `/api/v1/member/stories/${fixture.restrictedStoryId}`,
          expected: 403,
        },
        {
          name: 'deny unevidenced story for super admin',
          method: 'GET',
          path: `/api/v1/member/stories/${fixture.unevidencedStoryId}`,
          expected: 403,
        },
        {
          name: 'read system user',
          method: 'GET',
          path: `/api/v1/super_admin/users/${fixture.systemUserId}`,
          expected: 200,
        },
        {
          name: 'update system user',
          method: 'PUT',
          path: `/api/v1/super_admin/users/${fixture.systemUserId}`,
          expected: 200,
          body: { firstName: 'QA revised' },
        },
        {
          name: 'delete system user',
          method: 'DELETE',
          path: `/api/v1/super_admin/users/${fixture.systemUserId}`,
          expected: 200,
        },
        {
          name: 'legacy community creation route',
          method: 'POST',
          path: '/api/v1/communities',
          expected: 201,
          body: { name: 'QA legacy route community', slug: 'qa-legacy-route' },
        },
        {
          name: 'deny community content',
          method: 'GET',
          path: '/api/v1/member/stories',
          expected: 403,
        },
        logout,
      ],
    },
    {
      persona: 'field-kit',
      steps: [],
      skipped:
        'Phase 1: disconnected browser and recovery-code proof belongs to #147.',
    },
  ];
}
