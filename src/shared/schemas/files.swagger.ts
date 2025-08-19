/**
 * Swagger/OpenAPI schema definitions for Files
 *
 * This file defines the OpenAPI schemas for file upload and management operations,
 * ensuring consistent API documentation with proper multipart/form-data support.
 */

export const fileSchemas = {
  // File object schema
  File: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: 'Unique file identifier',
      },
      filename: {
        type: 'string' as const,
        description: 'Sanitized filename used for storage',
      },
      originalName: {
        type: 'string' as const,
        description: 'Original filename as uploaded by user',
      },
      path: {
        type: 'string' as const,
        description: 'File storage path relative to upload directory',
      },
      url: {
        type: 'string' as const,
        format: 'uri',
        description: 'Public URL to access the file',
      },
      size: {
        type: 'integer',
        minimum: 0,
        description: 'File size in bytes',
      },
      mimeType: {
        type: 'string' as const,
        pattern: '^[a-z]+/[a-z0-9\\-+.]+$',
        description: 'MIME type of the file',
        example: 'image/jpeg',
      },
      communityId: {
        type: 'integer' as const,
        minimum: 1,
        description: 'ID of the community that owns this file',
      },
      uploadedBy: {
        type: 'integer' as const,
        minimum: 1,
        description: 'ID of the user who uploaded this file',
      },
      metadata: {
        type: 'object' as const,
        description: 'File metadata (dimensions, duration, etc.)',
        properties: {
          width: { type: 'integer', description: 'Image width in pixels' },
          height: { type: 'integer', description: 'Image height in pixels' },
          duration: {
            type: 'number',
            description: 'Audio/video duration in seconds',
          },
          fps: { type: 'number', description: 'Video frame rate' },
          bitrate: { type: 'integer', description: 'Audio/video bitrate' },
          channels: { type: 'integer', description: 'Audio channels' },
          sampleRate: { type: 'integer', description: 'Audio sample rate' },
          codec: { type: 'string', description: 'Audio/video codec' },
        },
        additionalProperties: true,
      },
      culturalRestrictions: {
        type: 'object' as const,
        description: 'Cultural access restrictions for Indigenous content',
        properties: {
          elderOnly: {
            type: 'boolean',
            description: 'Restrict access to community elders only',
          },
          ceremonialUse: {
            type: 'boolean',
            description: 'Content is for ceremonial use only',
          },
          seasonalAccess: {
            type: 'object',
            description: 'Seasonal access restrictions',
            properties: {
              startMonth: { type: 'integer', minimum: 1, maximum: 12 },
              endMonth: { type: 'integer', minimum: 1, maximum: 12 },
            },
          },
          accessLevel: {
            type: 'string',
            enum: ['public', 'community', 'family', 'individual'],
            description: 'Access level for the content',
          },
          permission: {
            type: 'object',
            description: 'Permission requirements',
            properties: {
              required: { type: 'boolean' },
              grantedBy: {
                type: 'array',
                items: { type: 'string' },
                description: 'Users who granted permission',
              },
            },
          },
        },
        additionalProperties: false,
      },
      createdAt: {
        type: 'string' as const,
        format: 'date-time',
        description: 'File upload timestamp',
      },
    },
    required: [
      'id',
      'filename',
      'originalName',
      'path',
      'url',
      'size',
      'mimeType',
      'communityId',
      'uploadedBy',
      'createdAt',
    ],
    additionalProperties: false,
  },

  // File upload response schema
  FileUploadResponse: {
    type: 'object' as const,
    properties: {
      data: { $ref: '#/components/schemas/File' },
      message: {
        type: 'string' as const,
        description: 'Success message',
        example: 'File uploaded successfully',
      },
    },
    required: ['data', 'message'],
    additionalProperties: false,
  },

  // File list response schema
  FileListResponse: {
    type: 'object' as const,
    properties: {
      data: {
        type: 'array' as const,
        items: { $ref: '#/components/schemas/File' },
        description: 'Array of files',
      },
      meta: {
        type: 'object' as const,
        properties: {
          page: {
            type: 'integer',
            minimum: 1,
            description: 'Current page number',
          },
          limit: { type: 'integer', minimum: 1, description: 'Items per page' },
          total: {
            type: 'integer',
            minimum: 0,
            description: 'Total number of files',
          },
          totalPages: {
            type: 'integer',
            minimum: 0,
            description: 'Total number of pages',
          },
          hasNextPage: {
            type: 'boolean',
            description: 'Whether there are more pages',
          },
          hasPreviousPage: {
            type: 'boolean',
            description: 'Whether there are previous pages',
          },
        },
        required: [
          'page',
          'limit',
          'total',
          'totalPages',
          'hasNextPage',
          'hasPreviousPage',
        ],
        additionalProperties: false,
      },
    },
    required: ['data', 'meta'],
    additionalProperties: false,
  },

  // Error response schema
  FileErrorResponse: {
    type: 'object' as const,
    properties: {
      error: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string' as const,
            description: 'Error message',
          },
          code: {
            type: 'string' as const,
            description: 'Error code',
          },
          details: {
            type: 'object' as const,
            description: 'Additional error details',
            additionalProperties: true,
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
    required: ['error'],
    additionalProperties: false,
  },
};

export const fileParameters = {
  fileId: {
    name: 'id',
    in: 'path' as const,
    required: true,
    description: 'File ID',
    schema: {
      type: 'string' as const,
      format: 'uuid',
    },
  },
  page: {
    name: 'page',
    in: 'query' as const,
    required: false,
    description: 'Page number for pagination',
    schema: {
      type: 'integer' as const,
      minimum: 1,
      default: 1,
    },
  },
  limit: {
    name: 'limit',
    in: 'query' as const,
    required: false,
    description: 'Number of items per page',
    schema: {
      type: 'integer' as const,
      minimum: 1,
      maximum: 100,
      default: 20,
    },
  },
  search: {
    name: 'search',
    in: 'query' as const,
    required: false,
    description: 'Search term to filter files by filename',
    schema: {
      type: 'string' as const,
      minLength: 1,
    },
  },
  mimeType: {
    name: 'mimeType',
    in: 'query' as const,
    required: false,
    description: 'Filter files by MIME type (can be specified multiple times)',
    schema: {
      type: 'array' as const,
      items: { type: 'string' },
    },
    style: 'form',
    explode: true,
  },
  culturalRestrictions: {
    name: 'culturalRestrictions',
    in: 'query' as const,
    required: false,
    description: 'Cultural restrictions as JSON string',
    schema: {
      type: 'string' as const,
      description: 'JSON object with cultural restrictions',
      example: '{"elderOnly": true}',
    },
  },
};

export const fileExamples = {
  // File upload examples
  uploadImageRequest: {
    summary: 'Upload image file',
    description: 'Upload a JPEG image with cultural restrictions',
    value: {
      file: '(binary data)',
      culturalRestrictions: '{"elderOnly": true, "accessLevel": "community"}',
    },
  },
  uploadAudioRequest: {
    summary: 'Upload audio file',
    description: 'Upload an MP3 audio file for storytelling',
    value: {
      file: '(binary data)',
      culturalRestrictions: '{"ceremonialUse": true}',
    },
  },

  // Response examples
  uploadSuccessResponse: {
    summary: 'Successful upload',
    description: 'File uploaded successfully with metadata',
    value: {
      data: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        filename: '44411228-c475-4991-a7bb-c611743f3a93.jpg',
        originalName: 'storytelling-image.jpg',
        path: 'community-1/images/2023/08/44411228-c475-4991-a7bb-c611743f3a93.jpg',
        url: '/api/v1/files/community-1/images/2023/08/44411228-c475-4991-a7bb-c611743f3a93.jpg',
        size: 245760,
        mimeType: 'image/jpeg',
        communityId: 1,
        uploadedBy: 123,
        metadata: {
          width: 800,
          height: 600,
          channels: 3,
          format: 'jpeg',
        },
        culturalRestrictions: {
          elderOnly: true,
          accessLevel: 'community',
        },
        createdAt: '2023-08-19T10:30:00.000Z',
      },
      message: 'File uploaded successfully',
    },
  },
  uploadErrorResponse: {
    summary: 'Upload failed',
    description: 'File upload failed due to validation error',
    value: {
      error: {
        message: 'File type not allowed',
        code: 'INVALID_FILE_TYPE',
        details: {
          allowedTypes: ['image/jpeg', 'image/png', 'audio/mpeg'],
          receivedType: 'application/pdf',
        },
      },
    },
  },

  // File list examples
  fileListResponse: {
    summary: 'List of files',
    description: 'Paginated list of community files',
    value: {
      data: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          filename: '44411228-c475-4991-a7bb-c611743f3a93.jpg',
          originalName: 'storytelling-image.jpg',
          path: 'community-1/images/2023/08/44411228-c475-4991-a7bb-c611743f3a93.jpg',
          url: '/api/v1/files/community-1/images/2023/08/44411228-c475-4991-a7bb-c611743f3a93.jpg',
          size: 245760,
          mimeType: 'image/jpeg',
          communityId: 1,
          uploadedBy: 123,
          createdAt: '2023-08-19T10:30:00.000Z',
        },
      ],
      meta: {
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    },
  },
};
