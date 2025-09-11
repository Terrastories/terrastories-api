/**
 * TypeScript-Native File Service Types
 *
 * Type definitions for the new file service designed for ActiveStorage replacement.
 * These types support entity-based file operations and pluggable storage.
 */

import { z } from 'zod';

// Entity types supported by the file service
export const EntityType = z.enum(['stories', 'places', 'speakers']);
export type EntityType = z.infer<typeof EntityType>;

// File service configuration
export interface FileServiceV2Config {
  /** Maximum file size in bytes */
  maxFileSize: number;

  /** Allowed MIME types by category */
  allowedMimeTypes: {
    image: string[];
    audio: string[];
    video: string[];
  };

  /** Whether video uploads are enabled */
  enableVideo: boolean;

  /** Rate limiting configuration */
  rateLimiting: {
    /** Time window in milliseconds */
    windowMs: number;
    /** Maximum uploads per window */
    maxUploads: number;
  };
}

// File upload options
export interface FileUploadOptions {
  /** Community identifier */
  community: string;

  /** Entity type */
  entity: EntityType;

  /** Entity ID */
  entityId: number;

  /** User ID who is uploading */
  uploadedBy: number;

  /** Whether to preserve original filename (default: false, generates UUID) */
  preserveFilename?: boolean;
}

// File upload result
export interface FileUploadResult {
  /** Generated filename (UUID-based or original) */
  filename: string;

  /** Original filename from upload */
  originalName: string;

  /** Storage path relative to base directory */
  path: string;

  /** Public URL for accessing the file */
  url: string;

  /** File size in bytes */
  size: number;

  /** MIME type */
  mimeType: string;

  /** Community identifier */
  community: string;

  /** Entity type */
  entity: EntityType;

  /** Entity ID */
  entityId: number;

  /** User ID who uploaded */
  uploadedBy: number;

  /** Upload timestamp */
  createdAt: Date;

  /** ETag for cache validation */
  etag?: string;
}

// File download options
export interface FileDownloadOptions {
  /** Community identifier */
  community: string;

  /** Entity type */
  entity: EntityType;

  /** Entity ID */
  entityId: number;

  /** Filename */
  filename: string;
}

// File download result
export interface FileDownloadResult {
  /** File buffer */
  buffer: Buffer;

  /** File metadata */
  metadata: {
    filename: string;
    originalName: string;
    size: number;
    mimeType: string;
    etag?: string;
  };
}

// File deletion options
export interface FileDeleteOptions {
  /** Community identifier */
  community: string;

  /** Entity type */
  entity: EntityType;

  /** Entity ID */
  entityId: number;

  /** Filename */
  filename: string;
}

// File listing options
export interface FileListOptions {
  /** Community identifier */
  community: string;

  /** Filter by entity type */
  entity?: EntityType;

  /** Filter by entity ID */
  entityId?: number;

  /** Page number for pagination */
  page?: number;

  /** Items per page */
  limit?: number;
}

// File listing result
export interface FileListResult {
  /** Array of file metadata */
  files: Array<{
    filename: string;
    originalName: string;
    path: string;
    url: string;
    size: number;
    mimeType: string;
    community: string;
    entity: EntityType;
    entityId: number;
    uploadedBy: number;
    createdAt: Date;
    etag?: string;
  }>;

  /** Total number of files */
  total: number;

  /** Current page */
  page: number;

  /** Total pages */
  totalPages: number;
}

// Validation schemas for API endpoints
export const FileUploadRequestSchema = z.object({
  community: z.string().min(1, 'Community is required'),
  entity: EntityType,
  entityId: z.coerce
    .number()
    .int()
    .positive('Entity ID must be a positive integer'),
});

export const FilePathParamsSchema = z.object({
  community: z.string().min(1, 'Community is required'),
  entity: EntityType,
  entityId: z.coerce
    .number()
    .int()
    .positive('Entity ID must be a positive integer'),
  filename: z.string().min(1, 'Filename is required'),
});

export const FileListQuerySchema = z.object({
  community: z.string().min(1, 'Community is required'),
  entity: EntityType.optional(),
  entityId: z.coerce
    .number()
    .int()
    .positive('Entity ID must be a positive integer')
    .optional(),
  page: z.coerce.number().int().min(1, 'Page must be at least 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'Limit must be at least 1')
    .max(100, 'Limit cannot exceed 100')
    .default(20),
});
