/**
 * Zod wire schemas for V2 community user management (Slice 11a, #188;
 * route registry §6 "Users").
 *
 * Responses never carry credential material (SPEC-V2 §6.8): no
 * `passwordVerifier`, algorithm, salt or params, no session token digests.
 */
import { z } from 'zod';
import { ARGON2ID_ALGORITHM, DERIVED_KEY_PATTERN } from '../auth-policy.js';
import { MAX_DATABASE_ID } from '../types/public.js';

export const MAX_USER_PAGE_LIMIT = 100;
export const DEFAULT_USER_PAGE_LIMIT = 20;
export const ManagedUserRoleSchema = z.enum([
  'viewer',
  'member',
  'editor',
  'admin',
]);

export const ManagedUserStatusSchema = z.enum(['active', 'disabled']);

/** The wire projection of a managed community account. Never credentials. */
export const ManagedUserSchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  email: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  // Stored role, surfaced verbatim: legacy transitional rows (e.g. 'elder')
  // appear as stored rather than being rewritten or hidden.
  role: z.string(),
  status: ManagedUserStatusSchema,
  createdAt: z.string().datetime(),
});
export type ManagedUser = z.infer<typeof ManagedUserSchema>;

export const ManagedUserListMetaSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(MAX_USER_PAGE_LIMIT),
  offset: z.number().int().min(0),
  hasNextPage: z.boolean(),
});
export const ManagedUserListResponseSchema = z.object({
  data: z.array(ManagedUserSchema),
  meta: ManagedUserListMetaSchema,
});
export type ManagedUserListResponse = z.infer<
  typeof ManagedUserListResponseSchema
>;

export const ManagedUserResponseSchema = z.object({
  data: ManagedUserSchema,
});
export type ManagedUserResponse = z.infer<typeof ManagedUserResponseSchema>;

/** Query string for GET /v2/users (limit/offset, Explore conventions). */
export const ListUsersQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => val >= 1 && val <= MAX_USER_PAGE_LIMIT)
      .optional()
      .default(DEFAULT_USER_PAGE_LIMIT),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => val >= 0)
      .optional()
      .default(0),
  })
  .strict();
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

/** Client-stretched verifier material for a new account or admin reset. */
export const VerifierMaterialSchema = z
  .object({
    algorithm: z.literal(ARGON2ID_ALGORITHM),
    salt: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
    // The wire carries the raw Argon2id-derived digest; the server stores
    // SHA-256 of it (SPEC-V2 §7 step 3).
    derivedKey: z.string().regex(DERIVED_KEY_PATTERN),
  })
  .strict();
export type VerifierMaterial = z.infer<typeof VerifierMaterialSchema>;

export const CreateManagedUserRequestSchema = z
  .object({
    username: z.string().trim().min(1).max(255),
    // Registry §6 marks email optional, but the physical `users.email` column
    // is NOT NULL until the users expand-contract migration lands, so V2
    // requires it here and reports the deferral instead of synthesizing one.
    email: z.string().trim().email().max(254),
    displayName: z.string().trim().min(1).max(255).nullable().optional(),
    role: ManagedUserRoleSchema,
    // Absent: a code-only account (passwordVerifier NULL); the admin issues
    // an admin_issued LoginCode (POST /v2/users/:id/login-codes) for it.
    password: VerifierMaterialSchema.optional(),
  })
  .strict();
export type CreateManagedUserRequest = z.infer<
  typeof CreateManagedUserRequestSchema
>;

export const PatchManagedUserRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).nullable().optional(),
    username: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().email().max(254).optional(),
    role: ManagedUserRoleSchema.optional(),
    status: ManagedUserStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });
export type PatchManagedUserRequest = z.infer<
  typeof PatchManagedUserRequestSchema
>;

/** POST /v2/users/:id/password-reset body (client-stretched temporary key). */
export const AdminPasswordResetRequestSchema = VerifierMaterialSchema;
export type AdminPasswordResetRequest = z.infer<
  typeof AdminPasswordResetRequestSchema
>;

/** 201 response of POST /v2/users/:id/login-codes — the raw code, exactly once. */
export const AdminLoginCodeResponseSchema = z.object({
  data: z.object({
    code: z.string().min(20),
    purpose: z.literal('admin_issued'),
    expiresAt: z.string().datetime(),
  }),
});
export type AdminLoginCodeResponse = z.infer<
  typeof AdminLoginCodeResponseSchema
>;

/** Metadata-only device-session projection (never tokens or hashes). */
export const DeviceSessionSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.literal('device'),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  idleExpiresAt: z.string().datetime().nullable(),
  absoluteExpiresAt: z.string().datetime().nullable(),
});
export const DeviceSessionListResponseSchema = z.object({
  data: z.array(DeviceSessionSchema),
});
export type DeviceSessionListResponse = z.infer<
  typeof DeviceSessionListResponseSchema
>;

/** Session path parameter: opaque, 1..64 chars, no separators. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
