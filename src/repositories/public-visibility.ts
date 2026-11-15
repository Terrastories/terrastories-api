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
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DialectTables } from '../db/dialect.js';
import {
  communityToPhysical,
  storyVisibilityToPhysical,
  userStatusToPhysical,
} from '../policy/canonical-state.js';
import {
  readRuleOutcome,
  type AssociatedReadAssociation,
  type MediaReadAssociation,
  type ReadRuleViewer,
  type StoryReadAssociation,
} from '../policy/read-rules.js';

const ANON_PUBLIC: ReadRuleViewer = 'anonymous-public';
const STORY_AUDIENCE_PUBLIC: StoryReadAssociation = 'audience-public';
const ASSOCIATED_VIA_READABLE_STORY: AssociatedReadAssociation =
  'via-readable-story';
const MEDIA_COMMUNITY_BRANDING: MediaReadAssociation = 'community-branding';
const MEDIA_STORY_PUBLIC: MediaReadAssociation = 'story-media-public';
const MEDIA_PLACE_SPEAKER_READABLE: MediaReadAssociation =
  'place-speaker-media-via-readable-story';

const STORY_PUBLIC_ALLOWED =
  readRuleOutcome({
    resource: 'story',
    association: STORY_AUDIENCE_PUBLIC,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'visible';

const PLACE_ASSOCIATED_ALLOWED =
  readRuleOutcome({
    resource: 'place',
    association: ASSOCIATED_VIA_READABLE_STORY,
    viewer: ANON_PUBLIC,
    privacyEvidence: 'clear',
    viewerIsOwner: false,
  }) === 'with-readable-stories';

const SPEAKER_ASSOCIATED_ALLOWED =
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

/** Publicly readable story gate in `communityId` (SPEC-V2 §6.3, §6.4a, #162). */
export function publicStoryCondition(
  stories: DialectTables['stories'],
  communityId: number
): SQL {
  if (!STORY_PUBLIC_ALLOWED) return FAIL_CLOSED_SQL;
  const { privacyLevel, isRestricted } = storyVisibilityToPhysical('public');
  return and(
    eq(stories.communityId, communityId),
    eq(stories.privacyLevel, privacyLevel),
    eq(stories.isRestricted, isRestricted)
  )!;
}

/** Same-community unrestricted place base gate (#162). */
export function publicPlaceBaseCondition(
  places: DialectTables['places'],
  communityId: number
): SQL {
  if (!PLACE_ASSOCIATED_ALLOWED) return FAIL_CLOSED_SQL;
  return and(
    eq(places.communityId, communityId),
    eq(places.isRestricted, false)
  )!;
}

/** Same-community active speaker base gate (§6.4a; withdrawn speakers are inactive). */
export function publicSpeakerBaseCondition(
  speakers: DialectTables['speakers'],
  communityId: number
): SQL {
  if (!SPEAKER_ASSOCIATED_ALLOWED) return FAIL_CLOSED_SQL;
  const { isActive } = userStatusToPhysical('active');
  return and(
    eq(speakers.communityId, communityId),
    eq(speakers.isActive, isActive)
  )!;
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
  if (!PLACE_ASSOCIATED_ALLOWED || !STORY_PUBLIC_ALLOWED) {
    return FAIL_CLOSED_SQL;
  }
  const storyGate = publicStoryCondition(tables.stories, communityId);
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
    publicPlaceBaseCondition(placeTable, communityId),
    or(viaEdge, viaInterviewLocation)
  )!;
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
  if (!SPEAKER_ASSOCIATED_ALLOWED || !STORY_PUBLIC_ALLOWED) {
    return FAIL_CLOSED_SQL;
  }
  const storyGate = publicStoryCondition(tables.stories, communityId);
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
    publicSpeakerBaseCondition(speakerTable, communityId),
    or(viaEdge, viaInterviewer)
  )!;
}
