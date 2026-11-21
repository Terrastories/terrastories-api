/**
 * Zod wire contracts for V2 system administration (`/v2/admin/*`, Slice 14;
 * SPEC-V2 §6.2, §6.8, §7; route registry §10).
 *
 * Strictly operational lifecycle state only: never accepts, validates, or
 * projects descriptive community fields (`name`, `description`, `locale`,
 * `country`, `visibility`), content rows, credentials, or token hashes.
 */
import { z } from 'zod';
import {
  CLAIM_TOKEN_MAX_TTL_MS,
  CLAIM_TOKEN_MIN_TTL_MS,
} from '../auth-policy.js';
import { MAX_DATABASE_ID } from '../types/public.js';
import { CommunitySlugSchema } from './bootstrap.js';

export const MAX_ADMIN_PAGE_LIMIT = 100;
export const DEFAULT_ADMIN_PAGE_LIMIT = 20;

export const MIN_CLAIM_TOKEN_TTL_SECONDS = CLAIM_TOKEN_MIN_TTL_MS / 1000;
export const MAX_CLAIM_TOKEN_TTL_SECONDS = CLAIM_TOKEN_MAX_TTL_MS / 1000;

export const AdminCommunityStatusSchema = z.enum(['active', 'disabled']);
export type AdminCommunityStatus = z.infer<typeof AdminCommunityStatusSchema>;

export const AdminCommunityClaimStatusSchema = z.enum([
  'unclaimed',
  'claim_pending',
  'claimed',
  'orphaned',
  'deprovisioned',
]);
export type AdminCommunityClaimStatus = z.infer<
  typeof AdminCommunityClaimStatusSchema
>;

export const AdminCommunityOperationalSchema = z
  .object({
    id: z.number().int().positive().max(MAX_DATABASE_ID),
    slug: z.string().min(1),
    status: AdminCommunityStatusSchema,
    claimStatus: AdminCommunityClaimStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminCommunityOperational = z.infer<
  typeof AdminCommunityOperationalSchema
>;

export const AdminPaginationMetaSchema = z
  .object({
    total: z.number().int().min(0),
    limit: z.number().int().min(1).max(MAX_ADMIN_PAGE_LIMIT),
    offset: z.number().int().min(0),
    hasNextPage: z.boolean(),
  })
  .strict();
export type AdminPaginationMeta = z.infer<typeof AdminPaginationMetaSchema>;

export const AdminCommunityListQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => val >= 1 && val <= MAX_ADMIN_PAGE_LIMIT, {
        message: `limit must be between 1 and ${MAX_ADMIN_PAGE_LIMIT}`,
      })
      .optional()
      .default(DEFAULT_ADMIN_PAGE_LIMIT),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => Number.isSafeInteger(val) && val >= 0, {
        message: 'offset must be a non-negative integer',
      })
      .optional()
      .default(0),
    status: AdminCommunityStatusSchema.optional(),
  })
  .strict();
export type AdminCommunityListQuery = z.infer<
  typeof AdminCommunityListQuerySchema
>;

export const AdminCommunityListResponseSchema = z
  .object({
    data: z.array(AdminCommunityOperationalSchema),
    meta: AdminPaginationMetaSchema,
  })
  .strict();
export type AdminCommunityListResponse = z.infer<
  typeof AdminCommunityListResponseSchema
>;

export const AdminCommunityResponseSchema = z
  .object({
    data: AdminCommunityOperationalSchema,
  })
  .strict();
export type AdminCommunityResponse = z.infer<
  typeof AdminCommunityResponseSchema
>;

export const ProvisionCommunityRequestSchema = z
  .object({
    slug: CommunitySlugSchema,
  })
  .strict();
export type ProvisionCommunityRequest = z.infer<
  typeof ProvisionCommunityRequestSchema
>;

export const IssueClaimTokenRequestSchema = z
  .object({
    ttlSeconds: z
      .number()
      .int('ttlSeconds must be an integer')
      .min(
        MIN_CLAIM_TOKEN_TTL_SECONDS,
        `ttlSeconds must be at least ${MIN_CLAIM_TOKEN_TTL_SECONDS}`
      )
      .max(
        MAX_CLAIM_TOKEN_TTL_SECONDS,
        `ttlSeconds must be at most ${MAX_CLAIM_TOKEN_TTL_SECONDS}`
      )
      .optional(),
  })
  .strict();
export type IssueClaimTokenRequest = z.infer<
  typeof IssueClaimTokenRequestSchema
>;

export const ClaimTokenIssuedSchema = z
  .object({
    id: z.number().int().positive().max(MAX_DATABASE_ID),
    communityId: z.number().int().positive().max(MAX_DATABASE_ID),
    token: z.string().min(20),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ClaimTokenIssued = z.infer<typeof ClaimTokenIssuedSchema>;

export const ClaimTokenIssuedResponseSchema = z
  .object({
    data: ClaimTokenIssuedSchema,
  })
  .strict();
export type ClaimTokenIssuedResponse = z.infer<
  typeof ClaimTokenIssuedResponseSchema
>;

export const UpdateCommunityStatusRequestSchema = z
  .object({
    status: AdminCommunityStatusSchema,
  })
  .strict();
export type UpdateCommunityStatusRequest = z.infer<
  typeof UpdateCommunityStatusRequestSchema
>;

const AUDIT_ACTION_QUERY_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const AUDIT_OUTCOME_QUERY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

export const AdminAuditEntriesQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => val >= 1 && val <= MAX_ADMIN_PAGE_LIMIT, {
        message: `limit must be between 1 and ${MAX_ADMIN_PAGE_LIMIT}`,
      })
      .optional()
      .default(DEFAULT_ADMIN_PAGE_LIMIT),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => Number.isSafeInteger(val) && val >= 0, {
        message: 'offset must be a non-negative integer',
      })
      .optional()
      .default(0),
    action: z.string().regex(AUDIT_ACTION_QUERY_PATTERN).optional(),
    outcome: z.string().regex(AUDIT_OUTCOME_QUERY_PATTERN).optional(),
  })
  .strict();
export type AdminAuditEntriesQuery = z.infer<
  typeof AdminAuditEntriesQuerySchema
>;

export const AdminSystemAuditEntrySchema = z
  .object({
    id: z.number().int().positive().max(MAX_DATABASE_ID),
    communityId: z.null(),
    actorId: z.number().int().positive().max(MAX_DATABASE_ID).nullable(),
    action: z.string().min(1),
    resourceType: z.string().min(1).nullable(),
    resourceIds: z.array(z.union([z.number().int().min(0), z.string().min(1)])),
    outcome: z.string().min(1),
    ipAddress: z.string().min(1).nullable(),
    userAgent: z.string().min(1).nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminSystemAuditEntry = z.infer<typeof AdminSystemAuditEntrySchema>;

export const AdminAuditEntryListResponseSchema = z
  .object({
    data: z.array(AdminSystemAuditEntrySchema),
    meta: AdminPaginationMetaSchema,
  })
  .strict();
export type AdminAuditEntryListResponse = z.infer<
  typeof AdminAuditEntryListResponseSchema
>;
