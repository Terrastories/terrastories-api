/**
 * Single source of truth for canonical V2 publication/lifecycle state mapped
 * onto transitional V1 physical columns during coexistence (docs/SPEC-V2.md
 * §6.1, §6.2, §6.3, §6.4a; docs/V2-DOMAIN-BUILD-PLAN.md "Ground rules").
 *
 * Pure module with zero database or Node-only imports so it runs identically
 * on Cloudflare Workers, Node.js, policy tests, and repository query builders.
 *
 * Every read mapping fails closed: null, undefined, and unrecognized physical
 * values resolve to the most restrictive state (`private`, `disabled`,
 * `hidden`). Every write mapping validates canonical inputs and never writes
 * legacy `'restricted'` or `isRestricted: true`.
 */

export const COMMUNITY_VISIBILITIES = ['public', 'private'] as const;
export type CommunityVisibility = (typeof COMMUNITY_VISIBILITIES)[number];

export const COMMUNITY_STATUSES = ['active', 'disabled'] as const;
export type CommunityStatus = (typeof COMMUNITY_STATUSES)[number];

export interface CanonicalCommunityState {
  visibility: CommunityVisibility;
  status: CommunityStatus;
}

export interface PhysicalCommunityState {
  publicStories: boolean;
  isActive: boolean;
}

export const STORY_VISIBILITIES = ['public', 'community', 'editors'] as const;
export type StoryVisibility = (typeof STORY_VISIBILITIES)[number];

/**
 * Runtime read outcome for a story row during coexistence: canonical V2
 * visibilities plus `'hidden'` for restricted or unknown/unevidenced rows
 * (#162 option A).
 */
export type CanonicalStoryVisibility = StoryVisibility | 'hidden';

export type PhysicalStoryPrivacyLevel = 'public' | 'members_only' | 'editors';

export interface PhysicalStoryState {
  privacyLevel: PhysicalStoryPrivacyLevel;
  isRestricted: false;
}

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface PhysicalUserState {
  isActive: boolean;
}

export function communityVisibilityFromPhysical(
  publicStories: unknown
): CommunityVisibility {
  return publicStories === true ? 'public' : 'private';
}

export function communityStatusFromPhysical(
  isActive: unknown
): CommunityStatus {
  return isActive === true ? 'active' : 'disabled';
}

export function communityFromPhysical(physical: {
  publicStories: unknown;
  isActive: unknown;
}): CanonicalCommunityState {
  return {
    visibility: communityVisibilityFromPhysical(physical.publicStories),
    status: communityStatusFromPhysical(physical.isActive),
  };
}

export function communityVisibilityToPhysical(
  visibility: CommunityVisibility
): boolean {
  if (visibility === 'public') return true;
  if (visibility === 'private') return false;
  throw new Error('Invalid canonical community visibility');
}

export function communityStatusToPhysical(status: CommunityStatus): boolean {
  if (status === 'active') return true;
  if (status === 'disabled') return false;
  throw new Error('Invalid canonical community status');
}

export function communityToPhysical(
  state: CanonicalCommunityState
): PhysicalCommunityState {
  return {
    publicStories: communityVisibilityToPhysical(state.visibility),
    isActive: communityStatusToPhysical(state.status),
  };
}

/**
 * Map transitional `(privacyLevel, isRestricted)` columns to canonical story
 * visibility or fail-closed `'hidden'` (#162).
 *
 * - `('public', false)` -> `'public'`
 * - `('members_only', false)` -> `'community'`
 * - `('editors', false)` -> `'editors'`
 * - `isRestricted !== false` (true, null, undefined, unknown) -> `'hidden'`
 * - `'restricted'`, `'private'`, `''`, null, undefined, unknown -> `'hidden'`
 */
export function storyVisibilityFromPhysical(
  privacyLevel: unknown,
  isRestricted: unknown
): CanonicalStoryVisibility {
  if (isRestricted !== false) {
    return 'hidden';
  }
  switch (privacyLevel) {
    case 'public':
      return 'public';
    case 'members_only':
      return 'community';
    case 'editors':
      return 'editors';
    default:
      return 'hidden';
  }
}

/**
 * Inverse mapping for V2 story writes: maps canonical `visibility` to the
 * transitional physical columns, always writing `isRestricted: false` and
 * never writing `'restricted'`.
 */
export function storyVisibilityToPhysical(
  visibility: StoryVisibility
): PhysicalStoryState {
  switch (visibility) {
    case 'public':
      return { privacyLevel: 'public', isRestricted: false };
    case 'community':
      return { privacyLevel: 'members_only', isRestricted: false };
    case 'editors':
      return { privacyLevel: 'editors', isRestricted: false };
    default:
      throw new Error('Invalid canonical story visibility');
  }
}

export function userStatusFromPhysical(isActive: unknown): UserStatus {
  return isActive === true ? 'active' : 'disabled';
}

export function userStatusToPhysical(status: UserStatus): PhysicalUserState {
  if (status === 'active') return { isActive: true };
  if (status === 'disabled') return { isActive: false };
  throw new Error('Invalid canonical user status');
}
