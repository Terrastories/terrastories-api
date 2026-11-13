import type { Step } from '../runner.js';
export function domainSteps(communityId: number): Step[] {
  const steps: Step[] = [];
  for (const [resource, body] of [
    ['places', { name: 'QA place', latitude: -3, longitude: -60 }],
    ['speakers', { name: 'QA speaker' }],
    ['themes', { name: 'QA theme', communityId }],
  ] as const) {
    steps.push(
      {
        name: `create ${resource}`,
        method: 'POST',
        path: `/api/v1/${resource}`,
        expected: 201,
        body,
        captureId: resource,
      },
      {
        name: `list ${resource}`,
        method: 'GET',
        path: `/api/v1/${resource}`,
        expected: 200,
      },
      {
        name: `read ${resource}`,
        method: 'GET',
        path: `/api/v1/${resource}/{${resource}}`,
        expected: 200,
      },
      {
        name: `update ${resource}`,
        method: 'PUT',
        path: `/api/v1/${resource}/{${resource}}`,
        expected: 200,
        body: { name: 'QA revised' },
      }
    );
    if (resource === 'speakers')
      steps.push({
        name: 'patch speaker',
        method: 'PATCH',
        path: '/api/v1/speakers/{speakers}',
        expected: 200,
        body: { bio: 'QA biography' },
      });
  }
  steps.push(
    {
      name: 'nearby places',
      method: 'GET',
      path: '/api/v1/places/near?latitude=-3&longitude=-60&radius=10',
      expected: 200,
    },
    {
      name: 'place bounds',
      method: 'GET',
      path: '/api/v1/places/bounds?north=0&south=-5&east=-55&west=-65',
      expected: 200,
    },
    {
      name: 'place statistics',
      method: 'GET',
      path: '/api/v1/places/stats',
      expected: 200,
    },
    {
      name: 'speaker search',
      method: 'GET',
      path: '/api/v1/speakers/search?q=QA',
      expected: 200,
    },
    {
      name: 'speaker statistics',
      method: 'GET',
      path: '/api/v1/speakers/stats',
      expected: 200,
    },
    {
      name: 'active theme',
      method: 'GET',
      path: '/api/v1/themes/active',
      expected: 200,
    },
    ...['places', 'speakers', 'themes'].map((resource) => ({
      name: `delete ${resource}`,
      method: 'DELETE',
      path: `/api/v1/${resource}/{${resource}}`,
      expected: 204,
    }))
  );
  return steps;
}
