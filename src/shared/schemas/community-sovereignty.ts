/**
 * Zod wire contracts for Slice 13b community sovereignty endpoints and
 * `GET /v2/admin/erasures` (SPEC-V2 §6.2, §6.8, §7, #187; route registry §9 & §10).
 *
 * Responses carry strictly operational sovereignty/custody metadata and
 * opaque identifiers — never credentials, hashes, secrets, or cultural content.
 */

import { z } from 'zod';
import { isDerivedKeyOrBcryptHash } from '../auth-policy.js';
import { MAX_DATABASE_ID } from '../types/public.js';
import {
  ARCHIVE_CUSTODY_STATUSES,
  ARCHIVE_CUSTODY_TYPES,
  ERASURE_RECORD_OUTCOMES,
  SOVEREIGNTY_INITIATOR_ROLES,
  SOVEREIGNTY_REQUEST_KINDS,
  SOVEREIGNTY_REQUEST_STATES,
} from '../sovereignty-policy.js';
import { V2_COMMUNITY_ROLES } from '../authorization/sovereignty-policy.js';

export const StepUpDerivedKeySchema = z
  .string()
  .refine(isDerivedKeyOrBcryptHash, { message: 'Invalid derived key' });

export const SovereigntyCommunitySlugLocatorSchema = z
  .string()
  .min(1, 'communitySlug must not be empty')
  .max(255, 'communitySlug must be at most 255 characters')
  .refine(
    (value) => value.trim() === value && !/[\r\n\0]/.test(value),
    'communitySlug must be a trimmed single-line identifier'
  );

export const PutCommunityStewardRequestSchema = z
  .object({
    stewardUserId: z
      .number()
      .int('stewardUserId must be an integer')
      .positive('stewardUserId must be positive')
      .max(MAX_DATABASE_ID)
      .nullable(),
    currentDerivedKey: StepUpDerivedKeySchema.optional(),
  })
  .strict();

export type PutCommunityStewardRequest = z.infer<
  typeof PutCommunityStewardRequestSchema
>;

function addMutualLocatorRefinement(
  data: { communityId?: number; communitySlug?: string },
  ctx: z.RefinementCtx
): void {
  if (data.communityId !== undefined && data.communitySlug !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['communitySlug'],
      message: 'Specify at most one of communityId or communitySlug',
    });
  }
}

export const CommunityWithdrawalRequestSchema = z
  .object({
    currentDerivedKey: StepUpDerivedKeySchema.optional(),
    communityId: z
      .number()
      .int('communityId must be an integer')
      .positive('communityId must be positive')
      .max(MAX_DATABASE_ID)
      .optional(),
    communitySlug: SovereigntyCommunitySlugLocatorSchema.optional(),
  })
  .strict()
  .superRefine(addMutualLocatorRefinement);

export type CommunityWithdrawalRequest = z.infer<
  typeof CommunityWithdrawalRequestSchema
>;

export const CommunityErasureRequestSchema = z
  .object({
    confirmFinality: z.literal(true),
    currentDerivedKey: StepUpDerivedKeySchema.optional(),
    communityId: z
      .number()
      .int('communityId must be an integer')
      .positive('communityId must be positive')
      .max(MAX_DATABASE_ID)
      .optional(),
    communitySlug: SovereigntyCommunitySlugLocatorSchema.optional(),
  })
  .strict()
  .superRefine(addMutualLocatorRefinement);

export type CommunityErasureRequest = z.infer<
  typeof CommunityErasureRequestSchema
>;

export const CancelSovereigntyRequestSchema = z
  .object({
    requestId: z.string().uuid().optional(),
    currentDerivedKey: StepUpDerivedKeySchema.optional(),
  })
  .strict();

export type CancelSovereigntyRequest = z.infer<
  typeof CancelSovereigntyRequestSchema
>;

export const CommunityStewardViewSchema = z
  .object({
    userId: z.number().int().positive().max(MAX_DATABASE_ID),
    role: z.enum(V2_COMMUNITY_ROLES),
    status: z.enum(['active', 'disabled']),
    sameCommunity: z.boolean(),
    designatedBy: z.number().int().positive().max(MAX_DATABASE_ID).nullable(),
    designatedAt: z.string().datetime(),
  })
  .strict();

export type CommunityStewardView = z.infer<typeof CommunityStewardViewSchema>;

export const SovereigntyRequestViewSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(SOVEREIGNTY_REQUEST_KINDS),
    state: z.enum(SOVEREIGNTY_REQUEST_STATES),
    initiatedBy: z.number().int().positive().max(MAX_DATABASE_ID).nullable(),
    initiatedByRole: z.enum(SOVEREIGNTY_INITIATOR_ROLES),
    requestedAt: z.string().datetime(),
    noticeEndsAt: z.string().datetime().nullable(),
    effectiveAt: z.string().datetime().nullable(),
    cancelledAt: z.string().datetime().nullable(),
    cancelledBy: z.number().int().positive().max(MAX_DATABASE_ID).nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export type SovereigntyRequestView = z.infer<
  typeof SovereigntyRequestViewSchema
>;

export const ArchiveCustodyViewSchema = z
  .object({
    status: z.enum(ARCHIVE_CUSTODY_STATUSES),
    custodianType: z.enum(ARCHIVE_CUSTODY_TYPES),
    custodianUserId: z
      .number()
      .int()
      .positive()
      .max(MAX_DATABASE_ID)
      .nullable(),
    retentionUntil: z.string().datetime(),
    destroyedAt: z.string().datetime().nullable(),
    destructionAttestationRef: z.string().nullable(),
  })
  .strict();

export type ArchiveCustodyView = z.infer<typeof ArchiveCustodyViewSchema>;

export const CommunitySovereigntyStatusResponseSchema = z
  .object({
    data: z
      .object({
        communityId: z.number().int().positive().max(MAX_DATABASE_ID),
        status: z.enum(['active', 'disabled']),
        steward: CommunityStewardViewSchema.nullable(),
        noticePeriodSeconds: z.number().int().positive(),
        pendingRequests: z.array(SovereigntyRequestViewSchema),
        recentRequests: z.array(SovereigntyRequestViewSchema),
        archiveCustody: ArchiveCustodyViewSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type CommunitySovereigntyStatusResponse = z.infer<
  typeof CommunitySovereigntyStatusResponseSchema
>;

export const PutCommunityStewardResponseSchema = z
  .object({
    data: z
      .object({
        communityId: z.number().int().positive().max(MAX_DATABASE_ID),
        steward: CommunityStewardViewSchema.nullable(),
        cancelledRequestIds: z.array(z.string().uuid()),
      })
      .strict(),
  })
  .strict();

export type PutCommunityStewardResponse = z.infer<
  typeof PutCommunityStewardResponseSchema
>;

export const CommunityWithdrawalResponseSchema = z
  .object({
    data: z
      .object({
        communityId: z.number().int().positive().max(MAX_DATABASE_ID),
        status: z.enum(['active', 'disabled']),
        request: SovereigntyRequestViewSchema,
      })
      .strict(),
  })
  .strict();

export type CommunityWithdrawalResponse = z.infer<
  typeof CommunityWithdrawalResponseSchema
>;

export const ErasureRecordSummarySchema = z
  .object({
    communityId: z.number().int().positive().max(MAX_DATABASE_ID),
    requestId: z.string().uuid(),
    outcome: z.enum(ERASURE_RECORD_OUTCOMES),
    requestedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export type ErasureRecordSummary = z.infer<typeof ErasureRecordSummarySchema>;

export const CommunityErasureResponseSchema = z
  .object({
    data: z
      .object({
        communityId: z.number().int().positive().max(MAX_DATABASE_ID),
        status: z.enum(['active', 'disabled']),
        finalityNotice: z.string().min(1),
        archiveCustody: ArchiveCustodyViewSchema.nullable(),
        request: SovereigntyRequestViewSchema,
        erasureRecord: ErasureRecordSummarySchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type CommunityErasureResponse = z.infer<
  typeof CommunityErasureResponseSchema
>;

export const CancelSovereigntyResponseSchema = z
  .object({
    data: z
      .object({
        communityId: z.number().int().positive().max(MAX_DATABASE_ID),
        cancelledRequests: z.array(SovereigntyRequestViewSchema),
      })
      .strict(),
  })
  .strict();

export type CancelSovereigntyResponse = z.infer<
  typeof CancelSovereigntyResponseSchema
>;
