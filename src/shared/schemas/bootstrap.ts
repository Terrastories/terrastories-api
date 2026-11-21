/**
 * Zod wire schemas for V2 installation bootstrap and hosted community claim
 * (Slice 11b-B and 11b-C, #188; SPEC-V2 §4, §6.8, §7; route registry §1).
 *
 * Responses never carry credential hashes, verifier material, raw token/code
 * digests, or raw session tokens (sessions travel strictly via the HttpOnly
 * `ts_session` cookie).
 */
import { z } from 'zod';
import { RECOVERY_CODE_COUNT } from '../auth-policy.js';
import { MAX_DATABASE_ID } from '../types/public.js';
import { CommunityReadVisibilitySchema } from './community-reads.js';
import {
  addDescriptionValidationIssues,
  NullableTrimmedText,
} from './community-writes.js';
import { VerifierMaterialSchema } from './users-admin.js';

/** GET /v2/bootstrap status payload (fail-closed boolean, no community data). */
export const BootstrapStatusResponseSchema = z.object({
  open: z.boolean(),
});
export type BootstrapStatusResponse = z.infer<
  typeof BootstrapStatusResponseSchema
>;

export const CommunitySlugSchema = z
  .string()
  .trim()
  .min(1, 'Slug must not be empty')
  .max(100, 'Slug must be at most 100 characters')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug must contain lowercase letters, digits, and single hyphens'
  );

export const BootstrapLocaleSchema = z
  .string()
  .trim()
  .min(1, 'Locale must not be empty')
  .max(35, 'Locale must be at most 35 characters')
  .regex(/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/, 'Invalid locale format');

/** POST /v2/bootstrap request body (fresh-installation first community + admin). */
export const BootstrapRequestSchema = z
  .object({
    community: z
      .object({
        name: z
          .string()
          .trim()
          .min(1, 'Name must not be empty')
          .max(255, 'Name must be at most 255 characters'),
        slug: CommunitySlugSchema.optional(),
        description: z.union([z.string(), z.null()]).optional(),
        locale: BootstrapLocaleSchema.optional().default('en'),
        country: NullableTrimmedText('Country', 120).optional(),
        visibility: CommunityReadVisibilitySchema.optional().default('private'),
      })
      .strict(),
    admin: z
      .object({
        username: z.string().trim().min(1).max(254),
        email: z.string().trim().email().max(254),
        displayName: z.string().trim().min(1).max(255).nullable().optional(),
        password: VerifierMaterialSchema,
      })
      .strict(),
    /**
     * Operator-provided installation bootstrap secret (PR #252 bot finding 1;
     * SPEC-V2 §7). Optional on the wire on purpose: a missing value must fail
     * CLOSED through the secret comparison (wrong/missing => the same 403 body
     * as a closed installation), never through a validation success that skips
     * the gate. Max length keeps the compare material bounded.
     */
    bootstrapSecret: z.string().trim().min(1).max(256).optional(),
    deviceSession: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    addDescriptionValidationIssues(
      data.community.description,
      'community.description',
      ctx
    );
  });
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

/** Community summary returned on initial bootstrap or hosted claim. */
export const BootstrapCommunityProjectionSchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  name: z.string(),
  slug: z.string().min(1),
  description: z.string().nullable(),
  locale: z.string(),
  country: z.string().nullable(),
  visibility: CommunityReadVisibilitySchema,
  status: z.literal('active'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BootstrapCommunityProjection = z.infer<
  typeof BootstrapCommunityProjectionSchema
>;

/** Initial administrator projection returned on bootstrap / claim. */
export const BootstrapAdminProjectionSchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  email: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.literal('admin'),
  communityId: z.number().int().positive().max(MAX_DATABASE_ID),
  recoveryCodesConfirmed: z.literal(true),
});
export type BootstrapAdminProjection = z.infer<
  typeof BootstrapAdminProjectionSchema
>;

/** 201 response of POST /v2/bootstrap (and shared envelope with claim). */
export const BootstrapResponseSchema = z.object({
  data: z.object({
    community: BootstrapCommunityProjectionSchema,
    user: BootstrapAdminProjectionSchema,
    recoveryCodes: z.object({
      codes: z.array(z.string().min(20)).length(RECOVERY_CODE_COUNT),
      purpose: z.literal('recovery'),
      createdAt: z.string().datetime(),
    }),
    caFingerprint: z.string().min(1).optional(),
  }),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

/** POST /v2/bootstrap/claim request body (unauthenticated ClaimToken holder). */
export const BootstrapClaimRequestSchema = z
  .object({
    token: z.string().min(1).max(256),
    username: z.string().trim().min(1).max(254),
    email: z.string().trim().email().max(254),
    displayName: z.string().trim().min(1).max(255).nullable().optional(),
    password: VerifierMaterialSchema,
    deviceSession: z.boolean().optional(),
  })
  .strict();
export type BootstrapClaimRequest = z.infer<typeof BootstrapClaimRequestSchema>;
