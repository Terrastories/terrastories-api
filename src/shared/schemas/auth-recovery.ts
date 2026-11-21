/**
 * Zod wire schemas for V2 recovery codes and login-code redemption
 * (Slice 11b-A, #188; SPEC-V2 §6.8, §7; route registry §1).
 *
 * Responses never carry credential hashes, verifier material, or raw session
 * tokens (those travel strictly via the HttpOnly `ts_session` cookie).
 */
import { z } from 'zod';
import {
  RECOVERY_CODE_COUNT,
  isDerivedKeyOrBcryptHash,
} from '../auth-policy.js';
import { VerifierMaterialSchema } from './users-admin.js';

/**
 * POST /v2/auth/recovery-codes request body.
 *
 * `currentDerivedKey` is required for every password-backed / recovery session
 * and omitted ONLY when exercising a fresh, unconsumed `admin_issued` step-up
 * session. An empty request body is normalized to `{}` by the route.
 */
export const RecoveryCodesRequestSchema = z
  .object({
    currentDerivedKey: z
      .string()
      .refine(isDerivedKeyOrBcryptHash, { message: 'Invalid derived key' })
      .optional(),
  })
  .strict();

export type RecoveryCodesRequest = z.infer<typeof RecoveryCodesRequestSchema>;

/** 201 response of POST /v2/auth/recovery-codes: 10 single-use codes, shown once. */
export const RecoveryCodesResponseSchema = z.object({
  data: z.object({
    codes: z.array(z.string().min(20)).length(RECOVERY_CODE_COUNT),
    purpose: z.literal('recovery'),
    createdAt: z.string().datetime(),
  }),
});

export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponseSchema>;

/**
 * POST /v2/auth/recovery/redeem request body (unauthenticated).
 *
 * `password` is mandatory for `recovery` codes (validated at the service layer
 * after looking up the code) and optional for `admin_issued` codes (code-only
 * enrolment / non-KDF device vs assisted recovery with password reset).
 */
export const RecoveryRedeemRequestSchema = z
  .object({
    code: z.string().min(1).max(256),
    identifier: z.string().min(1).max(254).optional(),
    communitySlug: z.string().min(1).max(255).optional(),
    password: VerifierMaterialSchema.optional(),
    deviceSession: z.boolean().optional(),
  })
  .strict();

export type RecoveryRedeemRequest = z.infer<typeof RecoveryRedeemRequestSchema>;
