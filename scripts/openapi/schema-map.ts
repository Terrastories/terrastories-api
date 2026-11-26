import type { z } from 'zod';
import {
  AdminAuditEntryListResponseSchema,
  AdminCommunityListResponseSchema,
  AdminCommunityResponseSchema,
  ClaimTokenIssuedResponseSchema,
  IssueClaimTokenRequestSchema,
  ProvisionCommunityRequestSchema,
  UpdateCommunityStatusRequestSchema,
} from '../../src/shared/schemas/admin.js';
import {
  RecoveryCodesRequestSchema,
  RecoveryCodesResponseSchema,
  RecoveryRedeemRequestSchema,
} from '../../src/shared/schemas/auth-recovery.js';
import {
  BootstrapClaimRequestSchema,
  BootstrapRequestSchema,
  BootstrapResponseSchema,
  BootstrapStatusResponseSchema,
} from '../../src/shared/schemas/bootstrap.js';
import { CommunityAuditEntriesListResponseSchema } from '../../src/shared/schemas/community-audit.js';
import {
  CreateCommunityExportRequestSchema,
  CreateCommunityExportResponseSchema,
} from '../../src/shared/schemas/community-export.js';
import {
  CommunityMapConfigResponseSchema,
  CommunityReadDetailResponseSchema,
  CommunityStoriesListResponseSchema,
  CommunityStoryDetailResponseSchema,
} from '../../src/shared/schemas/community-reads.js';
import {
  CancelSovereigntyRequestSchema,
  CancelSovereigntyResponseSchema,
  CommunityErasureRequestSchema,
  CommunityErasureResponseSchema,
  CommunitySovereigntyStatusResponseSchema,
  CommunityWithdrawalRequestSchema,
  CommunityWithdrawalResponseSchema,
  PutCommunityStewardRequestSchema,
  PutCommunityStewardResponseSchema,
} from '../../src/shared/schemas/community-sovereignty.js';
import {
  CreatePlaceRequestSchema,
  CreateSpeakerRequestSchema,
  PatchCommunityRequestSchema,
  PatchCommunityResponseSchema,
  PatchPlaceRequestSchema,
  PatchSpeakerRequestSchema,
  PlaceWriteResponseSchema,
  PutCommunityMapConfigRequestSchema,
  PutCommunityMapConfigResponseSchema,
  SpeakerWriteResponseSchema,
} from '../../src/shared/schemas/community-writes.js';
import {
  ImportManifestDetailResponseSchema,
  ImportManifestListResponseSchema,
} from '../../src/shared/schemas/imports.js';
import {
  PublicCommunitiesListResponseSchema,
  PublicCommunityDetailResponseSchema,
} from '../../src/shared/schemas/public-communities.js';
import {
  PublicPlaceDetailResponseSchema,
  PublicPlacesListResponseSchema,
  PublicSpeakerDetailResponseSchema,
  PublicSpeakersListResponseSchema,
  PublicStoriesListResponseSchema,
  PublicStoryDetailResponseSchema,
} from '../../src/shared/schemas/public-content.js';
import {
  CreateExternalMediaLinkRequestSchema,
  CreateStoryRequestSchema,
  ExternalMediaLinkWriteResponseSchema,
  PatchStoryRequestSchema,
  PutStoryPlacesRequestSchema,
  PutStorySpeakersRequestSchema,
  ReorderExternalMediaLinksRequestSchema,
  StoryWriteResponseSchema,
} from '../../src/shared/schemas/story-writes.js';

/**
 * Body schemas per route (#148). Partial on purpose: a route absent here is
 * still emitted with method, path, auth and status codes. Add an entry when
 * a route gains a zod schema; the generated document then changes and
 * `npm run openapi:generate` must be re-run.
 */
export interface RouteSchemas {
  request?: z.ZodType;
  response?: z.ZodType;
}

export const SCHEMA_MAP: Record<string, RouteSchemas> = {
  'POST /v2/auth/recovery-codes': {
    request: RecoveryCodesRequestSchema,
    response: RecoveryCodesResponseSchema,
  },
  'POST /v2/auth/recovery/redeem': { request: RecoveryRedeemRequestSchema },
  'GET /v2/bootstrap': { response: BootstrapStatusResponseSchema },
  'POST /v2/bootstrap': {
    request: BootstrapRequestSchema,
    response: BootstrapResponseSchema,
  },
  'POST /v2/bootstrap/claim': {
    request: BootstrapClaimRequestSchema,
    response: BootstrapResponseSchema,
  },
  'GET /v2/public/communities': {
    response: PublicCommunitiesListResponseSchema,
  },
  'GET /v2/public/communities/:slug': {
    response: PublicCommunityDetailResponseSchema,
  },
  'GET /v2/public/communities/:slug/stories': {
    response: PublicStoriesListResponseSchema,
  },
  'GET /v2/public/communities/:slug/stories/:storyId': {
    response: PublicStoryDetailResponseSchema,
  },
  'GET /v2/public/communities/:slug/places': {
    response: PublicPlacesListResponseSchema,
  },
  'GET /v2/public/communities/:slug/places/:placeId': {
    response: PublicPlaceDetailResponseSchema,
  },
  'GET /v2/public/communities/:slug/speakers': {
    response: PublicSpeakersListResponseSchema,
  },
  'GET /v2/public/communities/:slug/speakers/:speakerId': {
    response: PublicSpeakerDetailResponseSchema,
  },
  'GET /v2/community': { response: CommunityReadDetailResponseSchema },
  'PATCH /v2/community': {
    request: PatchCommunityRequestSchema,
    response: PatchCommunityResponseSchema,
  },
  'GET /v2/community/map-config': {
    response: CommunityMapConfigResponseSchema,
  },
  'PUT /v2/community/map-config': {
    request: PutCommunityMapConfigRequestSchema,
    response: PutCommunityMapConfigResponseSchema,
  },
  'GET /v2/stories': { response: CommunityStoriesListResponseSchema },
  'GET /v2/stories/:id': { response: CommunityStoryDetailResponseSchema },
  'POST /v2/stories': {
    request: CreateStoryRequestSchema,
    response: StoryWriteResponseSchema,
  },
  'PATCH /v2/stories/:id': {
    request: PatchStoryRequestSchema,
    response: StoryWriteResponseSchema,
  },
  'PUT /v2/stories/:id/places': { request: PutStoryPlacesRequestSchema },
  'PUT /v2/stories/:id/speakers': { request: PutStorySpeakersRequestSchema },
  'POST /v2/stories/:id/external-links': {
    request: CreateExternalMediaLinkRequestSchema,
    response: ExternalMediaLinkWriteResponseSchema,
  },
  'PATCH /v2/stories/:id/external-links/reorder': {
    request: ReorderExternalMediaLinksRequestSchema,
  },
  'POST /v2/places': {
    request: CreatePlaceRequestSchema,
    response: PlaceWriteResponseSchema,
  },
  'PATCH /v2/places/:id': {
    request: PatchPlaceRequestSchema,
    response: PlaceWriteResponseSchema,
  },
  'POST /v2/speakers': {
    request: CreateSpeakerRequestSchema,
    response: SpeakerWriteResponseSchema,
  },
  'PATCH /v2/speakers/:id': {
    request: PatchSpeakerRequestSchema,
    response: SpeakerWriteResponseSchema,
  },
  'GET /v2/imports': { response: ImportManifestListResponseSchema },
  'GET /v2/imports/:id': { response: ImportManifestDetailResponseSchema },
  'POST /v2/community/export': {
    request: CreateCommunityExportRequestSchema,
    response: CreateCommunityExportResponseSchema,
  },
  'GET /v2/community/sovereignty': {
    response: CommunitySovereigntyStatusResponseSchema,
  },
  'PUT /v2/community/steward': {
    request: PutCommunityStewardRequestSchema,
    response: PutCommunityStewardResponseSchema,
  },
  'POST /v2/community/withdrawal': {
    request: CommunityWithdrawalRequestSchema,
    response: CommunityWithdrawalResponseSchema,
  },
  'POST /v2/community/erasure': {
    request: CommunityErasureRequestSchema,
    response: CommunityErasureResponseSchema,
  },
  'POST /v2/community/sovereignty/cancel': {
    request: CancelSovereigntyRequestSchema,
    response: CancelSovereigntyResponseSchema,
  },
  'GET /v2/community/audit-entries': {
    response: CommunityAuditEntriesListResponseSchema,
  },
  'GET /v2/admin/communities': { response: AdminCommunityListResponseSchema },
  'POST /v2/admin/communities': {
    request: ProvisionCommunityRequestSchema,
    response: AdminCommunityResponseSchema,
  },
  'POST /v2/admin/communities/:id/claim-tokens': {
    request: IssueClaimTokenRequestSchema,
    response: ClaimTokenIssuedResponseSchema,
  },
  'PATCH /v2/admin/communities/:id/status': {
    request: UpdateCommunityStatusRequestSchema,
    response: AdminCommunityResponseSchema,
  },
  'GET /v2/admin/audit-entries': {
    response: AdminAuditEntryListResponseSchema,
  },
};
