import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_STATUSES,
  COMMUNITY_VISIBILITIES,
  STORY_VISIBILITIES,
  USER_STATUSES,
  communityFromPhysical,
  communityStatusFromPhysical,
  communityStatusToPhysical,
  communityToPhysical,
  communityVisibilityFromPhysical,
  communityVisibilityToPhysical,
  storyVisibilityFromPhysical,
  storyVisibilityToPhysical,
  userStatusFromPhysical,
  userStatusToPhysical,
  type CommunityStatus,
  type CommunityVisibility,
  type StoryVisibility,
  type UserStatus,
} from '../../src/policy/canonical-state.js';
import {
  STORY_AUDIENCES,
  fastifyCommunityToGates,
  fastifyStoryToAudience,
} from '../../src/shared/authorization/sovereignty-policy.js';

describe('canonical-state single-source mapping (#189)', () => {
  describe('community visibility and status', () => {
    it('maps the full boolean truth table to canonical visibility/status', () => {
      const cases: Array<
        [boolean, boolean, CommunityVisibility, CommunityStatus]
      > = [
        [true, true, 'public', 'active'],
        [false, true, 'private', 'active'],
        [true, false, 'public', 'disabled'],
        [false, false, 'private', 'disabled'],
      ];

      for (const [publicStories, isActive, visibility, status] of cases) {
        expect(communityFromPhysical({ publicStories, isActive })).toEqual({
          visibility,
          status,
        });
        expect(communityVisibilityFromPhysical(publicStories)).toBe(visibility);
        expect(communityStatusFromPhysical(isActive)).toBe(status);
        expect(fastifyCommunityToGates(publicStories, isActive)).toEqual({
          visibility,
          status,
        });
      }
    });

    it('fails closed on non-boolean, null, or unknown community values', () => {
      for (const unknown of [null, undefined, '', 'true', 'public', 1, 0, {}]) {
        expect(communityVisibilityFromPhysical(unknown)).toBe('private');
        expect(communityStatusFromPhysical(unknown)).toBe('disabled');
        expect(
          communityFromPhysical({
            publicStories: unknown,
            isActive: unknown,
          })
        ).toEqual({ visibility: 'private', status: 'disabled' });
      }
    });

    it('round-trips every canonical community visibility and status for V2 writes', () => {
      for (const visibility of COMMUNITY_VISIBILITIES) {
        for (const status of COMMUNITY_STATUSES) {
          const physical = communityToPhysical({ visibility, status });
          expect(communityFromPhysical(physical)).toEqual({
            visibility,
            status,
          });
          expect(communityVisibilityToPhysical(visibility)).toBe(
            physical.publicStories
          );
          expect(communityStatusToPhysical(status)).toBe(physical.isActive);
        }
      }
    });

    it('rejects invalid canonical community values on write', () => {
      expect(() =>
        communityVisibilityToPhysical(
          'hidden' as unknown as CommunityVisibility
        )
      ).toThrow();
      expect(() =>
        communityStatusToPhysical('archived' as unknown as CommunityStatus)
      ).toThrow();
    });
  });

  describe('story visibility (#162 fail-closed)', () => {
    it('maps the complete physical truth table to canonical visibility or hidden', () => {
      const privacyValues = [
        'public',
        'members_only',
        'editors',
        'restricted',
        'private',
        'PUBLIC',
        'members',
        '',
        null,
        undefined,
        0,
        false,
      ];
      const restrictedValues = [
        false,
        true,
        null,
        undefined,
        'false',
        'true',
        0,
        1,
      ];

      for (const privacyLevel of privacyValues) {
        for (const isRestricted of restrictedValues) {
          const expected =
            isRestricted !== false
              ? 'hidden'
              : privacyLevel === 'public'
                ? 'public'
                : privacyLevel === 'members_only'
                  ? 'community'
                  : privacyLevel === 'editors'
                    ? 'editors'
                    : 'hidden';

          expect(
            storyVisibilityFromPhysical(privacyLevel, isRestricted),
            `(${String(privacyLevel)}, ${String(isRestricted)})`
          ).toBe(expected);
        }
      }
    });

    it('keeps fastifyStoryToAudience aligned with canonical story mapping', () => {
      expect(STORY_VISIBILITIES).toEqual(STORY_AUDIENCES);
      expect(fastifyStoryToAudience('public', false)).toBe('public');
      expect(fastifyStoryToAudience('members_only', false)).toBe('community');
      expect(fastifyStoryToAudience('editors', false)).toBe('editors');
      expect(fastifyStoryToAudience('public', true)).toBe('unavailable');
      expect(fastifyStoryToAudience('editors', true)).toBe('unavailable');
      expect(fastifyStoryToAudience('restricted', false)).toBe('unavailable');
      expect(fastifyStoryToAudience('private', false)).toBe('unavailable');
      expect(fastifyStoryToAudience('', false)).toBe('unavailable');
    });

    it('maps canonical story visibilities for V2 writes without ever writing restricted', () => {
      expect(storyVisibilityToPhysical('public')).toEqual({
        privacyLevel: 'public',
        isRestricted: false,
      });
      expect(storyVisibilityToPhysical('community')).toEqual({
        privacyLevel: 'members_only',
        isRestricted: false,
      });
      expect(storyVisibilityToPhysical('editors')).toEqual({
        privacyLevel: 'editors',
        isRestricted: false,
      });

      for (const visibility of STORY_VISIBILITIES) {
        const physical = storyVisibilityToPhysical(visibility);
        expect(physical.isRestricted).toBe(false);
        expect(physical.privacyLevel).not.toBe('restricted');
        expect(
          storyVisibilityFromPhysical(
            physical.privacyLevel,
            physical.isRestricted
          )
        ).toBe(visibility);
      }
    });

    it('rejects hidden or unknown story visibilities on V2 write', () => {
      for (const invalid of [
        'hidden',
        'restricted',
        'private',
        'members_only',
        '',
        null,
      ]) {
        expect(() =>
          storyVisibilityToPhysical(invalid as unknown as StoryVisibility)
        ).toThrow();
      }
    });
  });

  describe('user status', () => {
    it('maps isActive to active/disabled and fails closed on non-true values', () => {
      expect(userStatusFromPhysical(true)).toBe('active');
      for (const inactive of [false, null, undefined, '', 'true', 1, 0]) {
        expect(userStatusFromPhysical(inactive)).toBe('disabled');
      }
    });

    it('round-trips canonical user statuses for V2 writes and rejects invalid values', () => {
      for (const status of USER_STATUSES) {
        const physical = userStatusToPhysical(status);
        expect(userStatusFromPhysical(physical.isActive)).toBe(status);
      }
      expect(() =>
        userStatusToPhysical('pending' as unknown as UserStatus)
      ).toThrow();
    });
  });
});
