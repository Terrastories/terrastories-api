/**
 * Swagger/OpenAPI schema definitions for Files V2
 *
 * Comprehensive API documentation for the entity-based file service.
 * Supports multipart/form-data uploads and structured error responses.
 */

// File upload response schema
export const fileV2UploadResponseSchema = {
  type: 'object' as const,
  properties: {
    data: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string' as const,
          description: 'Sanitized filename used for storage',
          example: 'story-photo.jpg',
        },
        path: {
          type: 'string' as const,
          description: 'Full path to the stored file',
          example: 'uploads/community-1/stories/123/story-photo.jpg',
        },
        size: {
          type: 'integer' as const,
          description: 'File size in bytes',
          example: 1048576,
        },
        contentType: {
          type: 'string' as const,
          description: 'MIME type of the uploaded file',
          example: 'image/jpeg',
        },
        etag: {
          type: 'string' as const,
          description: 'ETag for file integrity verification',
          example: 'd41d8cd98f00b204e9800998ecf8427e',
        },
        entity: {
          type: 'string' as const,
          enum: ['stories', 'places', 'speakers'],
          description: 'Target entity type',
          example: 'stories',
        },
        entityId: {
          type: 'integer' as const,
          description: 'Target entity ID',
          example: 123,
        },
        community: {
          type: 'string' as const,
          description: 'Community identifier',
          example: 'community-1',
        },
        uploadedAt: {
          type: 'string' as const,
          format: 'date-time',
          description: 'Timestamp when file was uploaded',
          example: '2024-03-20T10:30:00.000Z',
        },
      },
      required: [
        'filename',
        'path',
        'size',
        'contentType',
        'etag',
        'entity',
        'entityId',
        'community',
        'uploadedAt',
      ],
    },
  },
  required: ['data'],
};

// File upload request schema (for documentation)
export const fileV2UploadRequestSchema = {
  type: 'object' as const,
  properties: {
    community: {
      type: 'string' as const,
      description: 'Community identifier',
      pattern: '^[a-zA-Z0-9\\-_]+$',
      example: 'community-1',
    },
    entity: {
      type: 'string' as const,
      enum: ['stories', 'places', 'speakers'],
      description: 'Target entity type',
      example: 'stories',
    },
    entityId: {
      type: 'string' as const,
      pattern: '^[1-9]\\d*$',
      description: 'Target entity ID (as string in form data)',
      example: '123',
    },
    file: {
      type: 'string' as const,
      format: 'binary',
      description: 'File to upload (multipart/form-data)',
    },
  },
  required: ['community', 'entity', 'entityId', 'file'],
};

// Path parameters schema
export const fileV2PathParamsSchema = {
  type: 'object' as const,
  properties: {
    community: {
      type: 'string' as const,
      description: 'Community identifier',
      pattern: '^[a-zA-Z0-9\\-_]+$',
      example: 'community-1',
    },
    entity: {
      type: 'string' as const,
      enum: ['stories', 'places', 'speakers'],
      description: 'Entity type',
      example: 'stories',
    },
    entityId: {
      type: 'string' as const,
      pattern: '^[1-9]\\d*$',
      description: 'Entity ID',
      example: '123',
    },
    filename: {
      type: 'string' as const,
      description: 'Filename to download or delete',
      example: 'story-photo.jpg',
    },
  },
  required: ['community', 'entity', 'entityId', 'filename'],
};

// File list response schema
export const fileV2ListResponseSchema = {
  type: 'object' as const,
  properties: {
    data: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          filename: {
            type: 'string' as const,
            description: 'File name',
            example: 'story-photo.jpg',
          },
          path: {
            type: 'string' as const,
            description: 'Full path to file',
            example: 'uploads/community-1/stories/123/story-photo.jpg',
          },
          size: {
            type: 'integer' as const,
            description: 'File size in bytes',
            example: 1048576,
          },
          contentType: {
            type: 'string' as const,
            description: 'MIME type',
            example: 'image/jpeg',
            nullable: true,
          },
          etag: {
            type: 'string' as const,
            description: 'ETag for file integrity',
            example: 'd41d8cd98f00b204e9800998ecf8427e',
            nullable: true,
          },
          lastModified: {
            type: 'string' as const,
            format: 'date-time',
            description: 'Last modification timestamp',
            example: '2024-03-20T10:30:00.000Z',
            nullable: true,
          },
        },
        required: ['filename', 'path', 'size'],
      },
    },
    meta: {
      type: 'object' as const,
      properties: {
        count: {
          type: 'integer' as const,
          description: 'Number of files returned',
          example: 3,
        },
        entity: {
          type: 'string' as const,
          enum: ['stories', 'places', 'speakers'],
          description: 'Entity type',
          example: 'stories',
        },
        entityId: {
          type: 'integer' as const,
          description: 'Entity ID',
          example: 123,
        },
        community: {
          type: 'string' as const,
          description: 'Community identifier',
          example: 'community-1',
        },
      },
      required: ['count', 'entity', 'entityId', 'community'],
    },
  },
  required: ['data', 'meta'],
};

// Success response for delete operations
export const fileV2DeleteResponseSchema = {
  type: 'object' as const,
  properties: {
    message: {
      type: 'string' as const,
      description: 'Success message',
      example: 'File deleted successfully',
    },
    deletedFile: {
      type: 'object' as const,
      properties: {
        filename: {
          type: 'string' as const,
          description: 'Name of deleted file',
          example: 'story-photo.jpg',
        },
        path: {
          type: 'string' as const,
          description: 'Path of deleted file',
          example: 'uploads/community-1/stories/123/story-photo.jpg',
        },
      },
      required: ['filename', 'path'],
    },
  },
  required: ['message', 'deletedFile'],
};

// Error response schemas
export const fileV2ValidationErrorSchema = {
  type: 'object' as const,
  properties: {
    error: {
      type: 'string' as const,
      description: 'Error message',
      example: 'Validation failed',
    },
    code: {
      type: 'string' as const,
      description: 'Error code',
      example: 'VALIDATION_ERROR',
    },
    statusCode: {
      type: 'integer' as const,
      description: 'HTTP status code',
      example: 400,
    },
    details: {
      type: 'object' as const,
      properties: {
        field: {
          type: 'string' as const,
          description: 'Field that failed validation',
          example: 'community',
        },
        message: {
          type: 'string' as const,
          description: 'Detailed validation error',
          example: 'Community name is required',
        },
      },
    },
  },
  required: ['error', 'code', 'statusCode'],
};

export const fileV2NotFoundErrorSchema = {
  type: 'object' as const,
  properties: {
    error: {
      type: 'string' as const,
      description: 'Error message',
      example: 'File not found',
    },
    code: {
      type: 'string' as const,
      description: 'Error code',
      example: 'FILE_NOT_FOUND',
    },
    statusCode: {
      type: 'integer' as const,
      description: 'HTTP status code',
      example: 404,
    },
    details: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Path that was not found',
          example: 'uploads/community-1/stories/123/nonexistent.jpg',
        },
      },
    },
  },
  required: ['error', 'code', 'statusCode'],
};

export const fileV2UnauthorizedErrorSchema = {
  type: 'object' as const,
  properties: {
    error: {
      type: 'string' as const,
      description: 'Error message',
      example: 'Authentication required',
    },
    code: {
      type: 'string' as const,
      description: 'Error code',
      example: 'AUTHENTICATION_REQUIRED',
    },
    statusCode: {
      type: 'integer' as const,
      description: 'HTTP status code',
      example: 401,
    },
  },
  required: ['error', 'code', 'statusCode'],
};

export const fileV2ForbiddenErrorSchema = {
  type: 'object' as const,
  properties: {
    error: {
      type: 'string' as const,
      description: 'Error message',
      example: 'Access denied to community resources',
    },
    code: {
      type: 'string' as const,
      description: 'Error code',
      example: 'ACCESS_DENIED',
    },
    statusCode: {
      type: 'integer' as const,
      description: 'HTTP status code',
      example: 403,
    },
  },
  required: ['error', 'code', 'statusCode'],
};

export const fileV2PayloadTooLargeErrorSchema = {
  type: 'object' as const,
  properties: {
    error: {
      type: 'string' as const,
      description: 'Error message',
      example: 'File size exceeds maximum allowed size',
    },
    code: {
      type: 'string' as const,
      description: 'Error code',
      example: 'PAYLOAD_TOO_LARGE',
    },
    statusCode: {
      type: 'integer' as const,
      description: 'HTTP status code',
      example: 413,
    },
    details: {
      type: 'object' as const,
      properties: {
        maxSize: {
          type: 'integer' as const,
          description: 'Maximum allowed file size in bytes',
          example: 26214400,
        },
        actualSize: {
          type: 'integer' as const,
          description: 'Actual file size in bytes',
          example: 31457280,
        },
      },
    },
  },
  required: ['error', 'code', 'statusCode'],
};

// Consolidated schemas export
export const filesV2Schemas = {
  FileV2UploadResponse: fileV2UploadResponseSchema,
  FileV2UploadRequest: fileV2UploadRequestSchema,
  FileV2PathParams: fileV2PathParamsSchema,
  FileV2ListResponse: fileV2ListResponseSchema,
  FileV2DeleteResponse: fileV2DeleteResponseSchema,
  FileV2ValidationError: fileV2ValidationErrorSchema,
  FileV2NotFoundError: fileV2NotFoundErrorSchema,
  FileV2UnauthorizedError: fileV2UnauthorizedErrorSchema,
  FileV2ForbiddenError: fileV2ForbiddenErrorSchema,
  FileV2PayloadTooLargeError: fileV2PayloadTooLargeErrorSchema,
};

// Route-specific schema combinations for easier use
export const fileV2RouteSchemas = {
  upload: {
    summary: 'Upload file to entity',
    description:
      'Upload a file and associate it with a specific entity (story, place, or speaker)',
    tags: ['Files V2'],
    consumes: ['multipart/form-data'],
    body: fileV2UploadRequestSchema,
    response: {
      201: fileV2UploadResponseSchema,
      400: fileV2ValidationErrorSchema,
      401: fileV2UnauthorizedErrorSchema,
      403: fileV2ForbiddenErrorSchema,
      413: fileV2PayloadTooLargeErrorSchema,
    },
  },
  download: {
    summary: 'Download file by path',
    description: 'Download a file associated with an entity',
    tags: ['Files V2'],
    params: fileV2PathParamsSchema,
    response: {
      200: {
        description: 'File content',
        type: 'string' as const,
        format: 'binary',
      },
      401: fileV2UnauthorizedErrorSchema,
      403: fileV2ForbiddenErrorSchema,
      404: fileV2NotFoundErrorSchema,
    },
  },
  delete: {
    summary: 'Delete file by path',
    description: 'Delete a file associated with an entity',
    tags: ['Files V2'],
    params: fileV2PathParamsSchema,
    response: {
      200: fileV2DeleteResponseSchema,
      401: fileV2UnauthorizedErrorSchema,
      403: fileV2ForbiddenErrorSchema,
      404: fileV2NotFoundErrorSchema,
    },
  },
  list: {
    summary: 'List files for entity',
    description: 'List all files associated with a specific entity',
    tags: ['Files V2'],
    params: {
      type: 'object' as const,
      properties: {
        community: fileV2PathParamsSchema.properties.community,
        entity: fileV2PathParamsSchema.properties.entity,
        entityId: fileV2PathParamsSchema.properties.entityId,
      },
      required: ['community', 'entity', 'entityId'],
    },
    response: {
      200: fileV2ListResponseSchema,
      401: fileV2UnauthorizedErrorSchema,
      403: fileV2ForbiddenErrorSchema,
    },
  },
};
