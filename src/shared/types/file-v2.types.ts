/**
 * File Service V2 Types
 *
 * Shared type definitions for the TypeScript-native file service.
 * Used across routes, services, and tests for consistent typing.
 */

// Re-export main types from service
export type {
  FileServiceV2Entity,
  FileServiceV2Config,
  FileV2UploadResult,
  FileV2DownloadResult,
  FileV2ListItem,
} from '../../services/file-v2.service.js';

// Re-export error classes
export {
  FileValidationError,
  FileSizeError,
  FileTypeError,
} from '../../services/file-v2.service.js';

// Re-export storage types
export type {
  StorageAdapter,
  StorageUploadResult,
  StorageMetadata,
} from '../../services/storage/storage-adapter.interface.js';

export {
  StorageError,
  StorageNotFoundError,
  StorageConflictError,
  StoragePermissionError,
} from '../../services/storage/storage-adapter.interface.js';

// Import the entity type
import type { FileServiceV2Entity } from '../../services/file-v2.service.js';

// Request/Response types for routes
export interface FileV2UploadRequest {
  community: string;
  entity: FileServiceV2Entity;
  entityId: string; // String in request, converted to number
  file: unknown; // MultipartFile from Fastify (avoid any)
}

export interface FileV2PathParams {
  community: string;
  entity: FileServiceV2Entity;
  entityId: string; // String in URL params
  filename: string;
}

export interface FileV2ErrorResponse {
  error: string;
  code: string;
  statusCode: number;
  details?: unknown;
}

// Configuration defaults
export const FILE_V2_DEFAULTS = {
  MAX_SIZE_BYTES: 25 * 1024 * 1024, // 25MB
  ALLOWED_MIME_TYPES: ['image/*', 'audio/*'],
  UPLOAD_RATE_LIMIT: 10,
  BASE_UPLOAD_PATH: 'uploads',
} as const;
