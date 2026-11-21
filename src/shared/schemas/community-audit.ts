/**
 * Zod wire schemas for Slice 13a community-scoped audit log read
 * (`GET /v2/community/audit-entries`; SPEC-V2 §6.8, §7; route registry §9).
 */

import { z } from 'zod';
import { MAX_DATABASE_ID } from '../types/public.js';

export const DEFAULT_AUDIT_PAGE_LIMIT = 20;
export const MAX_AUDIT_PAGE_LIMIT = 100;

export const AuditResourceIdSchema = z.union([
  z.number().int().min(0),
  z.string().min(1).max(64),
]);

export const CommunityAuditEntrySchema = z.object({
  id: z.number().int().positive().max(MAX_DATABASE_ID),
  communityId: z.number().int().positive().max(MAX_DATABASE_ID),
  actorId: z.number().int().positive().max(MAX_DATABASE_ID).nullable(),
  action: z.string().min(1).max(128),
  resourceType: z.string().min(1).max(64).nullable(),
  resourceIds: z.array(AuditResourceIdSchema),
  outcome: z.string().min(1).max(64),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type CommunityAuditEntry = z.infer<typeof CommunityAuditEntrySchema>;

export const CommunityAuditEntriesMetaSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(MAX_AUDIT_PAGE_LIMIT),
  offset: z.number().int().min(0),
  hasNextPage: z.boolean(),
});

export const CommunityAuditEntriesListResponseSchema = z.object({
  data: z.array(CommunityAuditEntrySchema),
  meta: CommunityAuditEntriesMetaSchema,
});
export type CommunityAuditEntriesListResponse = z.infer<
  typeof CommunityAuditEntriesListResponseSchema
>;

export const ListCommunityAuditEntriesQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => val >= 1 && val <= MAX_AUDIT_PAGE_LIMIT)
      .optional()
      .default(DEFAULT_AUDIT_PAGE_LIMIT),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine((val) => Number.isSafeInteger(val) && val >= 0)
      .optional()
      .default(0),
    action: z
      .string()
      .regex(/^[a-z][a-z0-9_.:-]{0,127}$/)
      .optional(),
    resourceType: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .optional(),
    outcome: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .optional(),
    actorId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform((val) => Number.parseInt(val, 10))
      .refine(
        (val) => Number.isSafeInteger(val) && val >= 1 && val <= MAX_DATABASE_ID
      )
      .optional(),
    from: z
      .string()
      .datetime({ offset: true })
      .transform((val) => new Date(val))
      .optional(),
    to: z
      .string()
      .datetime({ offset: true })
      .transform((val) => new Date(val))
      .optional(),
  })
  .strict()
  .refine(({ from, to }) => !from || !to || from.getTime() <= to.getTime(), {
    message: 'from must be on or before to',
    path: ['from'],
  });
export type ListCommunityAuditEntriesQuery = z.infer<
  typeof ListCommunityAuditEntriesQuerySchema
>;
