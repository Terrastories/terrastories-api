import type { Step } from '../runner.js';
export function communitySteps(communityId: number, storyId: number): Step[] {
  return [
    {
      name: 'current identity',
      method: 'GET',
      path: '/api/v1/auth/me',
      expected: 200,
    },
    {
      name: 'community identity',
      method: 'GET',
      path: '/api/v1/auth/community-data',
      expected: 200,
    },
    {
      name: 'community list',
      method: 'GET',
      path: '/api/v1/communities',
      expected: 200,
    },
    {
      name: 'community metadata',
      method: 'GET',
      path: `/api/v1/communities/${communityId}`,
      expected: 200,
    },
    {
      name: 'community stories',
      method: 'GET',
      path: `/api/v1/communities/${communityId}/stories`,
      expected: 200,
    },
    {
      name: 'community story',
      method: 'GET',
      path: `/api/v1/communities/${communityId}/stories/${storyId}`,
      expected: 200,
    },
    {
      name: 'story list',
      method: 'GET',
      path: '/api/v1/stories',
      expected: 200,
    },
    {
      name: 'story slug',
      method: 'GET',
      path: `/api/v1/stories/slug/qa-public/community/${communityId}`,
      expected: 200,
    },
  ];
}
