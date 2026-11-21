/**
 * Zod wire schemas for Slice 13a community export endpoints (SPEC-V2 §7, #187;
 * route registry §9).
 */

import { z } from 'zod';
import { EXPORT_TOKEN_PATTERN } from '../export-policy.js';

export const ExportSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ExportArtifactDescriptorSchema = z.object({
  token: z.string().regex(EXPORT_TOKEN_PATTERN),
  downloadPath: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().min(0),
  checksum: ExportSha256Schema,
});

export const ExportMediaZipDescriptorSchema =
  ExportArtifactDescriptorSchema.extend({
    fileCount: z.number().int().min(0),
  });

export const CreateCommunityExportResponseSchema = z.object({
  data: z.object({
    exportId: z.string().min(1),
    exportFormatVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    artifacts: z.object({
      manifest: ExportArtifactDescriptorSchema,
      mediaZip: ExportMediaZipDescriptorSchema,
    }),
  }),
});

export type CreateCommunityExportResponse = z.infer<
  typeof CreateCommunityExportResponseSchema
>;

/** Strict request body schema for `POST /v2/community/export` (empty object). */
export const CreateCommunityExportRequestSchema = z.object({}).strict();
