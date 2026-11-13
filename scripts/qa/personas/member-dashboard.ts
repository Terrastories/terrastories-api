import type { Step } from '../runner.js';
export function dashboardSteps(
  communityId: number,
  _ids: Record<string, number>
): Step[] {
  const steps: Step[] = [];
  for (const [resource, body] of [
    ['stories', { title: 'QA dashboard story', communityId }],
    ['places', { name: 'QA dashboard place', lat: -4, lng: -61 }],
    ['speakers', { name: 'QA dashboard speaker' }],
  ] as const) {
    steps.push(
      {
        name: `dashboard list ${resource}`,
        method: 'GET',
        path: `/api/v1/member/${resource}`,
        expected: 200,
      },
      {
        name: `dashboard create ${resource}`,
        method: 'POST',
        path: `/api/v1/member/${resource}`,
        expected: 201,
        captureId: `dashboard${resource}`,
        body,
        check: (body) =>
          typeof body === 'object' &&
          body !== null &&
          'data' in body &&
          typeof (body.data as { id?: unknown })?.id === 'number',
      },
      {
        name: `dashboard read ${resource}`,
        method: 'GET',
        path: `/api/v1/member/${resource}/{dashboard${resource}}`,
        expected: 200,
      },
      {
        name: `dashboard update ${resource}`,
        method: 'PUT',
        path: `/api/v1/member/${resource}/{dashboard${resource}}`,
        expected: 200,
        body:
          resource === 'stories'
            ? { title: 'QA dashboard revised' }
            : { name: 'QA dashboard revised' },
      },
      {
        name: `dashboard delete ${resource}`,
        method: 'DELETE',
        path: `/api/v1/member/${resource}/{dashboard${resource}}`,
        expected: 204,
      }
    );
  }
  return steps;
}
