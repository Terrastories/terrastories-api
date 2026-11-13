import { domainSteps } from './domain.js';
import { dashboardSteps } from './member-dashboard.js';
import { userSteps } from './users.js';
import { mediaSteps } from './media.js';
import type { Step } from '../runner.js';
import type { PersonaFixture } from './journeys.js';

type Role =
  | 'anonymous'
  | 'viewer'
  | 'member'
  | 'editor'
  | 'admin'
  | 'super_admin';
export const restrictionApplicability = {
  stories: 'isRestricted and privacyLevel hold/unknown states',
  places: 'isRestricted hold state; no independent unknown audience column',
  files: 'culturalRestrictions hold/unknown states',
  speakers:
    'No independent privacy column; community isolation and story-derived publication gates apply',
  themes: 'No independent privacy column; community isolation applies',
  users:
    'No independent privacy column; community isolation and admin-only access apply',
};
export function excludesIds(
  ids: (number | string)[],
  requiredId?: number | string
) {
  return (body: unknown): boolean => {
    if (
      !body ||
      typeof body !== 'object' ||
      !('data' in body) ||
      !Array.isArray(body.data)
    )
      return false;
    const rows = body.data;
    return (
      rows.every((row: unknown) => {
        if (!row || typeof row !== 'object' || !('id' in row)) return false;
        const id = row.id;
        return (
          ((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
            (typeof id === 'string' && id.trim().length > 0)) &&
          !ids.includes(id as number | string)
        );
      }) &&
      (requiredId === undefined ||
        rows.some((row: { id: unknown }) => row.id === requiredId))
    );
  };
}
export function isolationSteps(f: PersonaFixture, role: Role): Step[] {
  const steps: Step[] = [];
  const blocked = [f.foreignStoryId, f.restrictedStoryId, f.unevidencedStoryId];
  const publicRoot = `/api/communities/${f.communityId}`;
  const roots =
    role === 'anonymous'
      ? [publicRoot]
      : [publicRoot, '/api/v1', `/api/v1/communities/${f.communityId}`];
  for (const root of roots) {
    const denied = role === 'super_admin' && root.startsWith('/api/v1');
    steps.push({
      name: `${role} ${root} excludes unavailable stories`,
      method: 'GET',
      path: `${root}/stories`,
      expected: denied ? 403 : 200,
      ...(!denied ? { check: excludesIds(blocked, f.publicStoryId) } : {}),
    });
    for (const id of blocked)
      steps.push({
        name: `${role} ${root} unavailable story ${id}`,
        method: 'GET',
        path: `${root}/stories/${id}`,
        expected: denied ? 403 : 404,
      });
  }
  if (role === 'anonymous') {
    steps.push({
      name: 'public places exclude held and foreign',
      method: 'GET',
      path: `${publicRoot}/places`,
      expected: 200,
      check: excludesIds([f.heldPlaceId, f.foreignIds.places]),
    });
    for (const id of [f.heldPlaceId, f.foreignIds.places])
      steps.push({
        name: 'public unavailable place',
        method: 'GET',
        path: `${publicRoot}/places/${id}`,
        expected: 404,
      });
    return steps;
  }
  for (const resource of [
    'places',
    'speakers',
    'themes',
    'users',
    'files',
  ] as const) {
    const denied =
      role === 'super_admin' || (resource === 'users' && role !== 'admin');
    const foreignId = f.foreignIds[resource];
    const hidden = [
      foreignId,
      ...(resource === 'places'
        ? [f.heldPlaceId]
        : resource === 'files'
          ? [f.heldFileId, f.unknownFileId]
          : []),
    ];
    steps.push({
      name: `${role} ${resource} list isolation`,
      method: 'GET',
      path: `/api/v1/${resource}`,
      expected: denied ? 403 : 200,
      ...(!denied ? { check: excludesIds(hidden) } : {}),
    });
    for (const id of hidden) {
      steps.push({
        name: `${role} unavailable ${resource}`,
        method: 'GET',
        path: `/api/v1/${resource}/${id}${resource === 'files' ? '/info' : ''}`,
        expected: denied ? 403 : 404,
      });
      if (resource === 'files')
        steps.push({
          name: `${role} unavailable media bytes`,
          method: 'GET',
          path: `/api/v1/files/${id}`,
          expected: denied ? 403 : 404,
        });
    }
    if (resource === 'places' || resource === 'speakers') {
      steps.push({
        name: `${role} member ${resource} isolation`,
        method: 'GET',
        path: `/api/v1/member/${resource}`,
        expected: role === 'super_admin' ? 403 : 200,
        ...(role !== 'super_admin' ? { check: excludesIds(hidden) } : {}),
      });
      for (const id of hidden)
        steps.push({
          name: `${role} member unavailable ${resource}`,
          method: 'GET',
          path: `/api/v1/member/${resource}/${id}`,
          expected: role === 'super_admin' ? 403 : 404,
        });
    }
  }
  if (role === 'super_admin') {
    const replacements: Record<string, number | string> = {
      places: f.heldPlaceId,
      speakers: f.speakerId,
      themes: f.foreignIds.themes,
      user: f.systemUserId,
      file: f.heldFileId,
      dashboardstories: f.publicStoryId,
      dashboardplaces: f.placeId,
      dashboardspeakers: f.speakerId,
    };
    const operations = [
      ...domainSteps(f.communityId),
      ...dashboardSteps(f.communityId, {
        stories: f.publicStoryId,
        places: f.placeId,
        speakers: f.speakerId,
      }),
      ...userSteps(),
      ...mediaSteps(),
    ];
    for (const operation of operations) {
      const {
        captureId: _capture,
        check: _check,
        prepare: _prepare,
        ...request
      } = operation;
      steps.push({
        ...request,
        name: `super admin cannot ${operation.name}`,
        path: operation.path.replace(/\{(\w+)\}/g, (_, key: string) =>
          String(replacements[key])
        ),
        expected: 403,
      });
    }
    for (const [method, path, body] of [
      [
        'POST',
        '/api/v1/stories/',
        { title: 'Denied SA', communityId: f.communityId },
      ],
      ['PATCH', `/api/v1/stories/${f.publicStoryId}`, { title: 'Denied SA' }],
      ['DELETE', `/api/v1/stories/${f.publicStoryId}`, undefined],
      [
        'GET',
        `/api/v1/stories/slug/qa-public/community/${f.communityId}`,
        undefined,
      ],
    ] as const)
      steps.push({
        name: `super admin cannot ${method} stories`,
        method,
        path,
        expected: 403,
        ...(body ? { body } : {}),
      });
  }
  return steps;
}
export function wrongRoleSteps(f: PersonaFixture, role: Role): Step[] {
  if (!['viewer', 'member', 'editor'].includes(role)) return [];
  const steps: Step[] = [
    {
      name: `${role} cannot use admin-only`,
      method: 'GET',
      path: '/api/v1/auth/admin-only',
      expected: 403,
    },
  ];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    steps.push({
      name: `${role} cannot ${method} community users`,
      method,
      path: `/api/v1/users${['GET', 'POST'].includes(method) ? '' : `/${f.systemUserId}`}`,
      expected: 403,
      ...(method === 'POST'
        ? {
            body: {
              email: `denied-${role}@example.test`,
              password: 'QaDeniedPassword123!',
              firstName: 'Denied',
              lastName: 'User',
              role: 'viewer',
            },
          }
        : method === 'PUT'
          ? {
              body: {
                firstName: 'Denied',
                lastName: 'User',
                role: 'viewer',
                isActive: true,
              },
            }
          : method === 'PATCH'
            ? { body: { firstName: 'Denied' } }
            : {}),
    });
  }
  steps.push({
    name: `${role} cannot create theme`,
    method: 'POST',
    path: '/api/v1/themes',
    body: { name: 'Denied theme', communityId: f.communityId },
    expected: 403,
  });
  if (role === 'editor') return steps;
  for (const resource of ['stories', 'places', 'speakers'] as const) {
    const id =
      resource === 'stories'
        ? f.publicStoryId
        : resource === 'places'
          ? f.placeId
          : f.speakerId;
    const body =
      resource === 'stories'
        ? { title: 'Denied', communityId: f.communityId }
        : resource === 'places'
          ? { name: 'Denied', latitude: -3, longitude: -60, lat: -3, lng: -60 }
          : { name: 'Denied' };
    for (const prefix of ['/api/v1', '/api/v1/member'])
      for (const method of ['POST', 'PUT', 'DELETE']) {
        if (prefix === '/api/v1' && resource === 'stories' && method === 'PUT')
          continue;
        steps.push({
          name: `${role} cannot ${method} ${prefix}/${resource}`,
          method,
          path: `${prefix}/${resource}${method === 'POST' ? '' : `/${id}`}`,
          expected: 403,
          ...(method !== 'DELETE' ? { body } : {}),
        });
      }
  }
  // A valid multipart body reaches authorization rather than failing request validation.
  const boundary = 'qa-denied-upload';
  steps.push({
    name: `${role} cannot upload media`,
    method: 'POST',
    path: '/api/v1/files/upload',
    expected: 403,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    rawBody: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa.txt"\r\nContent-Type: text/plain\r\n\r\nQA\r\n--${boundary}--\r\n`,
  });
  return steps;
}
