import type { Step } from '../runner.js';
export function userSteps(): Step[] {
  return [
    {
      name: 'list community users',
      method: 'GET',
      path: '/api/v1/users',
      expected: 200,
    },
    {
      name: 'create community viewer',
      method: 'POST',
      path: '/api/v1/users',
      expected: 201,
      captureId: 'user',
      body: {
        email: 'qa-created-viewer@example.test',
        password: 'QaCreatedPassword123!',
        firstName: 'QA',
        lastName: 'Created',
        role: 'viewer',
      },
    },
    {
      name: 'read community viewer',
      method: 'GET',
      path: '/api/v1/users/{user}',
      expected: 200,
    },
    {
      name: 'update community viewer',
      method: 'PUT',
      path: '/api/v1/users/{user}',
      expected: 200,
      body: {
        firstName: 'Revised',
        lastName: 'Created',
        role: 'viewer',
        isActive: true,
      },
    },
    {
      name: 'patch community viewer',
      method: 'PATCH',
      path: '/api/v1/users/{user}',
      expected: 200,
      body: { lastName: 'Revised' },
    },
    {
      name: 'delete community viewer',
      method: 'DELETE',
      path: '/api/v1/users/{user}',
      expected: 200,
    },
  ];
}
export function systemSteps(communityId: number): Step[] {
  return [
    {
      name: 'list system communities',
      method: 'GET',
      path: '/api/v1/super_admin/communities',
      expected: 200,
    },
    {
      name: 'read system community metadata',
      method: 'GET',
      path: `/api/v1/super_admin/communities/${communityId}`,
      expected: 200,
    },
    {
      name: 'create empty system community',
      method: 'POST',
      path: '/api/v1/super_admin/communities',
      expected: 201,
      captureId: 'community',
      body: { name: 'QA empty system community', slug: 'qa-empty-system' },
    },
    {
      name: 'update system community metadata',
      method: 'PUT',
      path: '/api/v1/super_admin/communities/{community}',
      expected: 200,
      body: { name: 'QA revised system community' },
    },
    {
      name: 'list system users',
      method: 'GET',
      path: '/api/v1/super_admin/users',
      expected: 200,
    },
    {
      name: 'reject community user creation by super admin',
      method: 'POST',
      path: '/api/v1/super_admin/users',
      expected: 403,
      body: {
        email: 'qa-super-denied@example.test',
        password: 'QaCreatedPassword123!',
        firstName: 'QA',
        lastName: 'Denied',
        role: 'viewer',
        communityId,
      },
    },
    {
      name: 'delete empty system community',
      method: 'DELETE',
      path: '/api/v1/super_admin/communities/{community}',
      expected: 200,
    },
  ];
}
