/**
 * Role-scoped data access for Slice 6 authenticated community read endpoints.
 *
 * Reuses shared visibility predicates from `public-visibility.ts` (`readRuleOutcome`)
 * and parameterised query/hydration helpers on `PublicCommunitiesRepository` and
 * `PublicContentRepository` so active-community reads hold across public and
 * private communities without duplicating SQL or projection logic.
 */
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import type { OwnCommunityReadViewer } from './public-visibility.js';
import {
  PublicCommunitiesRepository,
  type PublicCommunityBrandingRow,
  type PublicCommunityRow,
  type PublicMapConfigRow,
  type PublicPlaceRow,
  type PublicSpeakerRow,
} from './public-communities.repository.js';
import {
  PublicContentRepository,
  type PublicPlaceDetailResult,
  type PublicPlacesPageResult,
  type PublicSpeakerDetailResult,
  type PublicSpeakersPageResult,
  type PublicStoriesPageResult,
  type PublicStoryDetailResult,
} from './public-content.repository.js';
import type {
  CommunityPlacesQuery,
  CommunityStoriesQuery,
  PublicPaginationQuery,
} from '../shared/schemas/community-reads.js';

export interface CommunityDetailData {
  community: PublicCommunityRow;
  mapConfig: PublicMapConfigRow | null;
  branding: PublicCommunityBrandingRow;
  storiesCount: number;
  points: PublicPlaceRow[];
  filterPlaces: Array<{ id: number; name: string }>;
  regions: string[];
  typesOfPlace: string[];
  speakers: PublicSpeakerRow[];
  topics: string[];
  languages: string[];
  affiliations: string[];
}

export class CommunityReadsRepository {
  private readonly communitiesRepo: PublicCommunitiesRepository;
  private readonly contentRepo: PublicContentRepository;

  constructor(database: Database | DrizzleD1Database) {
    this.communitiesRepo = new PublicCommunitiesRepository(database);
    this.contentRepo = new PublicContentRepository(
      database,
      this.communitiesRepo
    );
  }

  activeCommunity(communityId: number): Promise<PublicCommunityRow | null> {
    return this.communitiesRepo.activeCommunityById(communityId);
  }

  async getCommunityDetail(
    community: PublicCommunityRow,
    viewer: OwnCommunityReadViewer
  ): Promise<CommunityDetailData> {
    const [
      mapConfig,
      branding,
      storiesCount,
      points,
      filterPlaces,
      regions,
      typesOfPlace,
      speakers,
      topics,
      languages,
      affiliations,
    ] = await Promise.all([
      this.communitiesRepo.communityMapConfig(community.id, true),
      this.communitiesRepo.communityBranding(community.id, true),
      this.communitiesRepo.publicStoriesCount(community.id, viewer),
      this.communitiesRepo.publicPlacesOfCommunityStories(community.id, viewer),
      this.communitiesRepo.filterPlaces(community.id, viewer),
      this.communitiesRepo.filterRegions(community.id, viewer),
      this.communitiesRepo.filterTypesOfPlace(community.id, viewer),
      this.communitiesRepo.filterSpeakers(community.id, viewer),
      this.communitiesRepo.filterTopics(community.id, viewer),
      this.communitiesRepo.filterLanguages(community.id, viewer),
      this.communitiesRepo.filterAffiliations(community.id, viewer),
    ]);

    return {
      community,
      mapConfig,
      branding,
      storiesCount,
      points,
      filterPlaces,
      regions,
      typesOfPlace,
      speakers,
      topics,
      languages,
      affiliations,
    };
  }

  getMapConfig(communityId: number): Promise<PublicMapConfigRow | null> {
    return this.communitiesRepo.communityMapConfig(communityId, true);
  }

  listStories(
    community: PublicCommunityRow,
    query: CommunityStoriesQuery,
    viewer: OwnCommunityReadViewer
  ): Promise<PublicStoriesPageResult> {
    return this.contentRepo.listStoriesInCommunity(community, query, viewer);
  }

  getStoryById(
    community: PublicCommunityRow,
    storyId: number,
    viewer: OwnCommunityReadViewer
  ): Promise<PublicStoryDetailResult | null> {
    return this.contentRepo.getStoryByIdInCommunity(community, storyId, viewer);
  }

  listPlaces(
    community: PublicCommunityRow,
    query: CommunityPlacesQuery,
    viewer: OwnCommunityReadViewer
  ): Promise<PublicPlacesPageResult> {
    return this.contentRepo.listPlacesInCommunity(community, query, viewer);
  }

  getPlaceById(
    community: PublicCommunityRow,
    placeId: number,
    viewer: OwnCommunityReadViewer
  ): Promise<PublicPlaceDetailResult | null> {
    return this.contentRepo.getPlaceByIdInCommunity(community, placeId, viewer);
  }

  listSpeakers(
    community: PublicCommunityRow,
    pagination: PublicPaginationQuery,
    viewer: OwnCommunityReadViewer
  ): Promise<PublicSpeakersPageResult> {
    return this.contentRepo.listSpeakersInCommunity(
      community,
      pagination,
      viewer
    );
  }

  getSpeakerById(
    community: PublicCommunityRow,
    speakerId: number,
    viewer: OwnCommunityReadViewer
  ): Promise<PublicSpeakerDetailResult | null> {
    return this.contentRepo.getSpeakerByIdInCommunity(
      community,
      speakerId,
      viewer
    );
  }
}
