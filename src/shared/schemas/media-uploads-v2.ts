/**
 * Direct multipart media upload contracts (#286, SPEC-V2 §6.7).
 *
 * `POST /v2/media/uploads` creates a session; the client sends each part to
 * the returned target; `POST /v2/media/uploads/:id/complete` finishes it.
 */

import { z } from 'zod';

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'Must be a 64-character hex SHA-256')
  .transform((value) => value.toLowerCase());

/** Hard ceiling on parts per upload (S3/R2 allow 10,000). */
export const MAX_DIRECT_UPLOAD_PARTS = 10_000;

export const CreateDirectUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(127),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: hex64,
    partSize: z.number().int().positive().optional(),
    partSha256: z.array(hex64).min(1).max(MAX_DIRECT_UPLOAD_PARTS),
    role: z.string().min(1).max(64).optional(),
    ownerType: z.string().min(1).max(64).optional(),
    ownerId: z
      .union([z.number().int().positive(), z.string().min(1).max(32)])
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CreateDirectUploadRequest = z.infer<
  typeof CreateDirectUploadRequestSchema
>;

export const CompleteDirectUploadRequestSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(MAX_DIRECT_UPLOAD_PARTS),
            etag: z.string().min(1).max(256),
          })
          .strict()
      )
      .min(1)
      .max(MAX_DIRECT_UPLOAD_PARTS),
  })
  .strict();

export const DirectUploadPartTargetSchema = z
  .object({
    partNumber: z.number().int().positive(),
    method: z.literal('PUT'),
    url: z.string(),
    /** Headers the client must send exactly as given (besides Content-Length). */
    headers: z.record(z.string(), z.string()),
    size: z.number().int().positive(),
  })
  .strict();

export type DirectUploadPartTarget = z.infer<
  typeof DirectUploadPartTargetSchema
>;

export const DirectUploadSessionResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string().uuid(),
        /** `presigned`: parts go straight to R2; `api`: parts go to this API. */
        mode: z.enum(['presigned', 'api']),
        expiresAt: z.string(),
        partSize: z.number().int().positive(),
        partCount: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
        parts: z.array(DirectUploadPartTargetSchema),
      })
      .strict(),
  })
  .strict();

export const DirectUploadPartResponseSchema = z
  .object({
    data: z
      .object({
        partNumber: z.number().int().positive(),
        etag: z.string(),
      })
      .strict(),
  })
  .strict();
