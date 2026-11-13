import { describe, expect, it } from 'vitest';
import {
  excludesIds,
  isolationSteps,
  wrongRoleSteps,
  restrictionApplicability,
} from '../../../scripts/qa/personas/negative-matrix.js';
import type { PersonaFixture } from '../../../scripts/qa/personas/journeys.js';
const fixture: PersonaFixture = {
  communityId: 1,
  foreignCommunityId: 2,
  publicStoryId: 10,
  placeId: 11,
  systemUserId: 12,
  speakerId: 13,
  editableStoryIds: { editor: 14, admin: 15 },
  foreignStoryId: 20,
  restrictedStoryId: 21,
  unevidencedStoryId: 22,
  foreignIds: {
    places: 30,
    speakers: 31,
    themes: 32,
    users: 33,
    files: 'foreign-file',
  },
  heldPlaceId: 34,
  heldFileId: 'held-file',
  unknownFileId: 'unknown-file',
  credentials: {} as PersonaFixture['credentials'],
};
describe('negative persona matrices', () => {
  it('denies every member-dashboard write for viewer and member', () => {
    for (const role of ['viewer', 'member'] as const) {
      const steps = wrongRoleSteps(fixture, role);
      for (const [resource, id] of [
        ['stories', fixture.publicStoryId],
        ['places', fixture.placeId],
        ['speakers', fixture.speakerId],
      ] as const) {
        for (const method of ['POST', 'PUT', 'DELETE']) {
          const path = `/api/v1/member/${resource}${method === 'POST' ? '' : `/${id}`}`;
          expect(steps).toContainEqual(
            expect.objectContaining({ method, path, expected: 403 })
          );
        }
      }
    }
  });
  it('rejects restricted, foreign and unevidenced IDs in list projections', () => {
    const check = excludesIds([20, 21, 22]);
    for (const id of [20, 21, 22])
      expect(check({ data: [{ id }] })).toBe(false);
    expect(check({ data: [{ id: 10 }] })).toBe(true);
    expect(check({})).toBe(false);
    for (const row of [{}, { id: null }, { id: 0 }, { id: '' }]) {
      expect(check({ data: [row] })).toBe(false);
    }
    const withReadable = excludesIds([20, 21, 22], 10);
    expect(withReadable({ data: [] })).toBe(false);
    expect(withReadable({ data: [{ id: 11 }] })).toBe(false);
    expect(withReadable({ data: [{ id: 10 }] })).toBe(true);
  });
  it('checks all story read families for editor/admin and public readers', () => {
    for (const role of ['editor', 'admin', 'super_admin'] as const) {
      const steps = isolationSteps(fixture, role);
      for (const root of [
        '/api/communities/1',
        '/api/v1',
        '/api/v1/communities/1',
      ])
        for (const id of [20, 21, 22])
          expect(
            steps.some((step) => step.path === `${root}/stories/${id}`)
          ).toBe(true);
      for (const family of ['places', 'speakers', 'themes', 'users', 'files'])
        expect(steps.some((step) => step.path === `/api/v1/${family}`)).toBe(
          true
        );
    }
  });
  it('tests admin-only denials for viewer/member/editor without denying editor content rights', () => {
    for (const role of ['viewer', 'member', 'editor'] as const) {
      const steps = wrongRoleSteps(fixture, role);
      expect(
        steps.some(
          (step) =>
            step.path === '/api/v1/users' &&
            step.method === 'POST' &&
            step.expected === 403
        )
      ).toBe(true);
      expect(
        steps.some(
          (step) =>
            step.path === '/api/v1/auth/admin-only' && step.expected === 403
        )
      ).toBe(true);
      expect(steps.some((step) => step.path === '/api/v1/files/upload')).toBe(
        role !== 'editor'
      );
    }
    expect(Object.keys(restrictionApplicability)).toHaveLength(6);
  });
});
