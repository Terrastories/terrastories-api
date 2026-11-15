/**
 * Shared public-surface visibility predicates for Slice 4 (`/v2/public/communities*`)
 * and Slice 5 (`/v2/public/communities/:slug/stories|places|speakers|media/*`).
 *
 * Driven directly by `readRuleOutcome` (`src/policy/read-rules.ts`) and
 * `canonical-state.ts` (`communityToPhysical`, `storyVisibilityToPhysical`,
 * `userStatusToPhysical`) so public community, story, place, speaker, and
 * attachment gates stay fail-closed and single-sourced across all public routes.
 */
import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DialectTables } from '../db/dialect.js';
import {
  communityStatusToPhysical,
  communityToPhysical,
  storyVisibilityToPhysical,
  userStatusToPhysical,
  type StoryVisibility,
} from '../policy/canonical-state.js';
import {
  readRuleOutcome,
  type AssociatedReadAssociation,
  type MediaReadAssociation,
  type ReadRuleViewer,
  type StoryReadAssociation,
} from '../policy/read-rules.js';

const ANON_PUBLIC: ReadRuleViewer = 'anonymous-public';
const ASSOCIATED_VIA_READABLE_STORY: AssociatedReadAssociation =
  'via-readable-story';
const MEDIA_COMMUNITY_BRANDING: MediaReadAssociation = 'community-branding';
const MEDIA_STORY_PUBLIC: MediaReadAssociation = 'story-media-public';
const MEDIA_PLACE_SPEAKER_READABLE: MediaReadAssociation =
  'place-speaker-media-via-readable-story';

export const PLACE_ASSOCIATED_ALLOWED =
  readRuleOutcome({
    resource: 'place',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'with-readable-stories';

export const SPEAKER_ASSOCIATED_ALLOWED =
  readRuleOutcome({
    resource: 'speaker',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'with-readable-stories';

export const PUBLIC_BRANDING_MEDIA_ALLOWED =
  readRuleOutcome({
    resource: 'media',
    association: MEDIA_COMMUNITY_BRANDING,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'visible';

export const PUBLIC_STORY_MEDIA_ALLOWED =
  readRuleOutcome({
    resource: 'media',
    association: MEDIA_STORY_PUBLIC,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'visible';

export const PUBLIC_ASSOCIATED_MEDIA_ALLOWED =
  readRuleOutcome({
    resource: 'media',
    association: MEDIA_PLACE_SPEAKER_READABLE,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'with-readable-stories';

const FAIL_CLOSED_SQL: SQL = sql`1 = 0`;

export type OwnCommunityReadViewer =
  | 'own-viewer'
  | 'own-member'
  | 'own-editor'
  | 'own-admin';

/** Map an authenticated session role to a `ReadRuleViewer` for own-community reads. */
export function ownCommunityViewerForRole(
  role: string
): OwnCommunityReadViewer | null {
  switch (role) {
    case 'viewer':
      return 'own-viewer';
    case 'member':
      return 'own-member';
    case 'editor':
      return 'own-editor';
    case 'admin':
      return 'own-admin';
    default:
      return null;
  }
}

const STORY_VISIBILITY_ASSOCIATIONS: ReadonlyArray<{
  visibility: StoryVisibility;
  association: StoryReadAssociation;
}> = [
  { visibility: 'public', association: 'audience-public' },
  { visibility: 'community', association: 'audience-community' },
  { visibility: 'editors', association: 'audience-editors' },
];

/** Canonical story visibilities permitted for `viewer` under `SPEC-V2` §6.4a. */
export function allowedStoryVisibilitiesForViewer(
  viewer: ReadRuleViewer
): StoryVisibility[] {
  const allowed: StoryVisibility[] = [];
  for (const entry of STORY_VISIBILITY_ASSOCIATIONS) {
    if (
      readRuleOutcome({
        resource: 'story',
        association: entry.association,
        viewer,
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      }) === 'visible'
    ) {
      allowed.push(entry.visibility);
    }
  }
  return allowed;
}

export function isValidCoordinates(
  latitude: number | null,
  longitude: number | null
): latitude is number {
  return (
    latitude !== null &&
    longitude !== null &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Active community gate derived from canonical state (Slice 6). */
export function activeCommunityCondition(
  communities: DialectTables['communities']
): SQL {
  return eq(communities.isActive, communityStatusToPhysical('active'));
}

/** Active + public community gate derived from canonical state. */
export function publicCommunityCondition(
  communities: DialectTables['communities']
): SQL {
  const { publicStories, isActive } = communityToPhysical({
    visibility: 'public',
    status: 'active',
  });
  return and(
    eq(communities.publicStories, publicStories),
    eq(communities.isActive, isActive)
  )!;
}

/** Role-parameterised readable story gate in `communityId` (SPEC-V2 §6.3, §6.4a, #162). */
export function storyConditionForViewer(
  stories: DialectTables['stories'],
  communityId: number,
  viewer: ReadRuleViewer
): SQL {
  const allowed = allowedStoryVisibilitiesForViewer(viewer);
  if (allowed.length === 0) {
    return FAIL_CLOSED_SQL;
  }
  const privacyLevels = allowed.map(
    (visibility) => storyVisibilityToPhysical(visibility).privacyLevel
  );
  return and(
    eq(stories.communityId, communityId),
    inArray(stories.privacyLevel, privacyLevels),
    eq(stories.isRestricted, false)
  )!;
}

/** Publicly readable story gate in `communityId` (SPEC-V2 §6.3, §6.4a, #162). */
export function publicStoryCondition(
  stories: DialectTables['stories'],
  communityId: number
): SQL {
  return storyConditionForViewer(stories, communityId, ANON_PUBLIC);
}

/** Role-parameterised same-community unrestricted place base gate (#162). */
export function placeBaseConditionForViewer(
  places: DialectTables['places'],
  communityId: number,
  viewer: ReadRuleViewer
): SQL {
  const viaStoryOutcome = readRuleOutcome({
    resource: 'place',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  const storyLessOutcome = readRuleOutcome({
    resource: 'place',
    association: 'story-less',
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  if (viaStoryOutcome === 'hidden' && storyLessOutcome === 'hidden') {
    return FAIL_CLOSED_SQL;
  }
  return and(
    eq(places.communityId, communityId),
    eq(places.isRestricted, false)
  )!;
}

/** Same-community unrestricted place base gate (#162). */
export function publicPlaceBaseCondition(
  places: DialectTables['places'],
  communityId: number
): SQL {
  return placeBaseConditionForViewer(places, communityId, ANON_PUBLIC);
}

/**
 * Role-parameterised same-community speaker base gate (§6.4a, §6.5).
 * Viewer/member/anonymous callers see only active (`isActive = true`) speakers;
 * own-community editors/admins (`story-less === 'visible'`) see withdrawn
 * speakers too while preserving community isolation.
 */
export function speakerBaseConditionForViewer(
  speakers: DialectTables['speakers'],
  communityId: number,
  viewer: ReadRuleViewer
): SQL {
  const viaStoryOutcome = readRuleOutcome({
    resource: 'speaker',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  const storyLessOutcome = readRuleOutcome({
    resource: 'speaker',
    association: 'story-less',
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  if (viaStoryOutcome === 'hidden' && storyLessOutcome === 'hidden') {
    return FAIL_CLOSED_SQL;
  }
  if (storyLessOutcome === 'visible') {
    return eq(speakers.communityId, communityId);
  }
  const { isActive } = userStatusToPhysical('active');
  return and(
    eq(speakers.communityId, communityId),
    eq(speakers.isActive, isActive)
  )!;
}

/** Same-community active speaker base gate (§6.4a; withdrawn speakers are inactive). */
export function publicSpeakerBaseCondition(
  speakers: DialectTables['speakers'],
  communityId: number
): SQL {
  return speakerBaseConditionForViewer(speakers, communityId, ANON_PUBLIC);
}

/** WGS84 finite coordinate bounds for publishable map points. */
export function validPointCoordinatesCondition(
  places: DialectTables['places']
): SQL {
  return and(
    gte(places.latitude, -90),
    lte(places.latitude, 90),
    gte(places.longitude, -180),
    lte(places.longitude, 180)
  )!;
}

/** Active, unrestricted file gate (#162). */
export function activeUnrestrictedFileCondition(
  files: DialectTables['files'],
  communityId?: number
): SQL {
  return and(
    ...(communityId !== undefined ? [eq(files.communityId, communityId)] : []),
    eq(files.isActive, true),
    isNull(files.culturalRestrictions)
  )!;
}

/**
 * Role-parameterised place predicate matching SPEC-V2 §6.4a + #162:
 * - When `story-less === 'visible'` (`own-editor`, `own-admin`): every
 *   same-community unrestricted place.
 * - When `via-readable-story === 'with-readable-stories'`: same-community
 *   unrestricted places referenced by >= 1 readable story via `story_places`
 *   OR `stories.interview_location_id`.
 */
export function readablePlaceConditionForViewer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  tables: DialectTables,
  communityId: number,
  viewer: ReadRuleViewer,
  placeTable: DialectTables['places'] = tables.places
): SQL {
  const storyLessOutcome = readRuleOutcome({
    resource: 'place',
    association: 'story-less',
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  const viaStoryOutcome = readRuleOutcome({
    resource: 'place',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  if (storyLessOutcome === 'visible') {
    return placeBaseConditionForViewer(placeTable, communityId, viewer);
  }
  if (viaStoryOutcome !== 'with-readable-stories') {
    return FAIL_CLOSED_SQL;
  }
  const storyGate = storyConditionForViewer(
    tables.stories,
    communityId,
    viewer
  );
  const viaEdge = exists(
    database
      .select({ one: sql`1` })
      .from(tables.storyPlaces)
      .innerJoin(
        tables.stories,
        eq(tables.storyPlaces.storyId, tables.stories.id)
      )
      .where(
        and(
          eq(tables.storyPlaces.communityId, communityId),
          eq(tables.storyPlaces.placeId, placeTable.id),
          storyGate
        )
      )
  );
  const viaInterviewLocation = exists(
    database
      .select({ one: sql`1` })
      .from(tables.stories)
      .where(
        and(eq(tables.stories.interviewLocationId, placeTable.id), storyGate)
      )
  );
  return and(
    placeBaseConditionForViewer(placeTable, communityId, viewer),
    or(viaEdge, viaInterviewLocation)
  )!;
}

/**
 * Place predicate matching SPEC-V2 §6.4a `with readable stories`:
 * same community, unrestricted, and referenced by >= 1 publicly readable
 * story via `story_places` OR `stories.interview_location_id`.
 */
export function readablePlaceCondition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  tables: DialectTables,
  communityId: number,
  placeTable: DialectTables['places'] = tables.places
): SQL {
  return readablePlaceConditionForViewer(
    database,
    tables,
    communityId,
    ANON_PUBLIC,
    placeTable
  );
}

/**
 * Role-parameterised speaker predicate matching SPEC-V2 §6.4a + §6.5:
 * - When `story-less === 'visible'` (`own-editor`, `own-admin`): every
 *   same-community speaker.
 * - When `via-readable-story === 'with-readable-stories'`: same-community
 *   active speakers referenced by >= 1 readable story via `story_speakers`
 *   OR `stories.interviewer_id`.
 */
export function readableSpeakerConditionForViewer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  tables: DialectTables,
  communityId: number,
  viewer: ReadRuleViewer,
  speakerTable: DialectTables['speakers'] = tables.speakers
): SQL {
  const storyLessOutcome = readRuleOutcome({
    resource: 'speaker',
    association: 'story-less',
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  const viaStoryOutcome = readRuleOutcome({
    resource: 'speaker',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  if (storyLessOutcome === 'visible') {
    return speakerBaseConditionForViewer(speakerTable, communityId, viewer);
  }
  if (viaStoryOutcome !== 'with-readable-stories') {
    return FAIL_CLOSED_SQL;
  }
  const storyGate = storyConditionForViewer(
    tables.stories,
    communityId,
    viewer
  );
  const viaEdge = exists(
    database
      .select({ one: sql`1` })
      .from(tables.storySpeakers)
      .innerJoin(
        tables.stories,
        eq(tables.storySpeakers.storyId, tables.stories.id)
      )
      .where(
        and(
          eq(tables.storySpeakers.communityId, communityId),
          eq(tables.storySpeakers.speakerId, speakerTable.id),
          storyGate
        )
      )
  );
  const viaInterviewer = exists(
    database
      .select({ one: sql`1` })
      .from(tables.stories)
      .where(and(eq(tables.stories.interviewerId, speakerTable.id), storyGate))
  );
  return and(
    speakerBaseConditionForViewer(speakerTable, communityId, viewer),
    or(viaEdge, viaInterviewer)
  )!;
}

/** Whether `viewer` can read story media attachments on readable stories. */
export function storyMediaAllowedForViewer(viewer: ReadRuleViewer): boolean {
  return (
    readRuleOutcome({
      resource: 'media',
      association: MEDIA_STORY_PUBLIC,
      viewer,
      privacyEvidence: 'clear',
      viewerIsOwner: false,
    }) === 'visible'
  );
}

/** Whether `viewer` can read media attachments on readable places/speakers. */
export function associatedMediaAllowedForViewer(
  viewer: ReadRuleViewer
): boolean {
  const outcome = readRuleOutcome({
    resource: 'media',
    association: MEDIA_PLACE_SPEAKER_READABLE,
    viewer,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  });
  return outcome === 'with-readable-stories' || outcome === 'visible';
}

/**
 * Speaker predicate matching SPEC-V2 §6.4a `with readable stories`:
 * same community, active (`is_active = true`), and referenced by >= 1
 * publicly readable story via `story_speakers` OR `stories.interviewer_id`.
 */
export function readableSpeakerCondition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  tables: DialectTables,
  communityId: number,
  speakerTable: DialectTables['speakers'] = tables.speakers
): SQL {
  return readableSpeakerConditionForViewer(
    database,
    tables,
    communityId,
    ANON_PUBLIC,
    speakerTable
  );
}
