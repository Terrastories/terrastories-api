/**
 * Stories Swagger/OpenAPI Schema Definitions
 *
 * Comprehensive OpenAPI schemas for the Stories entity including:
 * - Complete schema definitions for all CRUD operations
 * - Request/response schemas with proper validation
 * - Error schemas for all possible error states
 * - Parameters for filtering and pagination
 * - Examples for all operations including cultural considerations
 */

// Core Story Schema
export const storySchemas = {
  Story: {
    type: 'object',
    required: [
      'id',
      'title',
      'communityId',
      'createdBy',
      'isRestricted',
      'language',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: {
        type: 'integer',
        description: 'Unique identifier for the story',
        example: 1,
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Title of the story',
        example: 'The Legend of the Sacred Mountain',
      },
      description: {
        type: 'string',
        maxLength: 5000,
        description: 'Detailed description of the story',
        example:
          'A traditional story passed down through generations about the sacred mountain and its spiritual significance.',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this story belongs to',
        example: 1,
      },
      createdBy: {
        type: 'integer',
        description: 'ID of the user who created this story',
        example: 5,
      },
      isRestricted: {
        type: 'boolean',
        description:
          'Whether this story contains culturally sensitive content that should be restricted',
        example: false,
      },
      mediaUrls: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uri',
        },
        description:
          'DEPRECATED: Use imageUrl and audioUrl instead. Array of media file URLs associated with this story',
        example: [
          'https://example.com/audio/story1.mp3',
          'https://example.com/images/mountain.jpg',
        ],
        default: [],
        deprecated: true,
      },
      imageUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Direct URL to the primary image file for this story (dual-read capability)',
        example: 'https://example.com/images/mountain.jpg',
      },
      audioUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Direct URL to the primary audio file for this story (dual-read capability)',
        example: 'https://example.com/audio/story1.mp3',
      },
      language: {
        type: 'string',
        minLength: 2,
        maxLength: 5,
        description: 'Language code for the story (ISO 639-1 format)',
        example: 'en',
        default: 'en',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
        description: 'Array of tags for categorizing the story',
        example: ['traditional-knowledge', 'sacred-places', 'elders'],
        default: [],
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the story was created',
        example: '2024-01-15T10:30:00Z',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the story was last updated',
        example: '2024-01-15T15:45:00Z',
      },
    },
  },

  CreateStory: {
    type: 'object',
    required: ['title', 'communityId', 'createdBy'],
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Title of the story',
        example: 'The Legend of the Sacred Mountain',
      },
      description: {
        type: 'string',
        maxLength: 5000,
        description: 'Detailed description of the story',
        example: 'A traditional story passed down through generations.',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this story belongs to',
        example: 1,
      },
      createdBy: {
        type: 'integer',
        description: 'ID of the user creating this story',
        example: 5,
      },
      isRestricted: {
        type: 'boolean',
        description: 'Whether this story contains culturally sensitive content',
        example: false,
        default: false,
      },
      mediaUrls: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uri',
        },
        description:
          'DEPRECATED: Use imageUrl and audioUrl instead. Array of media file URLs associated with this story',
        example: ['https://example.com/audio/story1.mp3'],
        default: [],
        deprecated: true,
      },
      imageUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Direct URL to the primary image file for this story (dual-read capability)',
        example: 'https://example.com/images/story-image.jpg',
      },
      audioUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Direct URL to the primary audio file for this story (dual-read capability)',
        example: 'https://example.com/audio/story1.mp3',
      },
      language: {
        type: 'string',
        minLength: 2,
        maxLength: 5,
        description: 'Language code for the story',
        example: 'en',
        default: 'en',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
        description: 'Array of tags for categorizing the story',
        example: ['traditional-knowledge', 'sacred-places'],
        default: [],
      },
    },
  },

  UpdateStory: {
    type: 'object',
    required: [],
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Updated title of the story',
        example: 'The Legend of the Sacred Mountain (Revised)',
      },
      description: {
        type: 'string',
        maxLength: 5000,
        description: 'Updated description of the story',
        example: 'An updated version of the traditional story.',
      },
      isRestricted: {
        type: 'boolean',
        description: 'Updated restriction status',
        example: true,
      },
      mediaUrls: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uri',
        },
        description:
          'DEPRECATED: Use imageUrl and audioUrl instead. Updated array of media file URLs',
        example: ['https://example.com/audio/story1_updated.mp3'],
        deprecated: true,
      },
      imageUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Updated direct URL to the primary image file (dual-read capability)',
        example: 'https://example.com/images/updated-image.jpg',
      },
      audioUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Updated direct URL to the primary audio file (dual-read capability)',
        example: 'https://example.com/audio/story1_updated.mp3',
      },
      language: {
        type: 'string',
        minLength: 2,
        maxLength: 5,
        description: 'Updated language code',
        example: 'fr',
      },
      tags: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
        description: 'Updated array of tags',
        example: ['traditional-knowledge', 'sacred-places', 'updated'],
      },
    },
  },

  StoryResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: {
        type: 'boolean',
        default: true,
        description: 'Indicates successful operation',
      },
      data: {
        $ref: '#/components/schemas/Story',
      },
    },
  },

  StoryListResponse: {
    type: 'object',
    required: ['success', 'data', 'meta'],
    properties: {
      success: {
        type: 'boolean',
        default: true,
        description: 'Indicates successful operation',
      },
      data: {
        type: 'array',
        items: {
          $ref: '#/components/schemas/Story',
        },
        description: 'Array of stories',
      },
      meta: {
        type: 'object',
        required: ['total', 'page', 'limit'],
        properties: {
          total: {
            type: 'integer',
            description: 'Total number of stories',
            example: 42,
          },
          page: {
            type: 'integer',
            description: 'Current page number',
            example: 1,
          },
          limit: {
            type: 'integer',
            description: 'Number of stories per page',
            example: 20,
          },
          filters: {
            type: 'object',
            description: 'Applied filters',
            properties: {
              community: {
                type: 'integer',
                description: 'Community filter applied',
                example: 1,
              },
              language: {
                type: 'string',
                description: 'Language filter applied',
                example: 'en',
              },
              restricted: {
                type: 'boolean',
                description: 'Restriction filter applied',
                example: false,
              },
            },
          },
        },
      },
    },
  },

  // Error Schemas
  ValidationError: {
    type: 'object',
    required: ['error', 'message', 'details'],
    properties: {
      error: {
        type: 'string',
        example: 'ValidationError',
      },
      message: {
        type: 'string',
        example: 'Invalid input data',
      },
      details: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            message: { type: 'string' },
          },
        },
        example: [
          { field: 'title', message: 'Title is required' },
          { field: 'mediaUrls[0]', message: 'Invalid URL format' },
        ],
      },
    },
  },

  NotFoundError: {
    type: 'object',
    required: ['error', 'message', 'resource'],
    properties: {
      error: {
        type: 'string',
        example: 'NotFoundError',
      },
      message: {
        type: 'string',
        example: 'Story not found',
      },
      resource: {
        type: 'string',
        example: 'story',
      },
    },
  },

  ConflictError: {
    type: 'object',
    required: ['error', 'message', 'conflictType'],
    properties: {
      error: {
        type: 'string',
        example: 'ConflictError',
      },
      message: {
        type: 'string',
        example: 'Story with this title already exists in the community',
      },
      conflictType: {
        type: 'string',
        example: 'duplicate_title',
      },
    },
  },

  UnauthorizedError: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: {
        type: 'string',
        example: 'UnauthorizedError',
      },
      message: {
        type: 'string',
        example: 'Authentication required',
      },
    },
  },

  ForbiddenError: {
    type: 'object',
    required: ['error', 'message', 'reason'],
    properties: {
      error: {
        type: 'string',
        example: 'ForbiddenError',
      },
      message: {
        type: 'string',
        example: 'Access to this story is restricted',
      },
      reason: {
        type: 'string',
        example: 'culturally_sensitive_content',
      },
    },
  },
};

// Parameters for API endpoints
export const storyParameters = {
  storyId: {
    name: 'storyId',
    in: 'path',
    required: true,
    schema: {
      type: 'integer',
      minimum: 1,
    },
    description: 'Unique identifier of the story',
    example: 1,
  },

  communityFilter: {
    name: 'community',
    in: 'query',
    required: false,
    schema: {
      type: 'integer',
      minimum: 1,
    },
    description: 'Filter stories by community ID',
    example: 1,
  },

  languageFilter: {
    name: 'language',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      minLength: 2,
      maxLength: 5,
    },
    description: 'Filter stories by language code',
    example: 'en',
  },

  restrictedFilter: {
    name: 'restricted',
    in: 'query',
    required: false,
    schema: {
      type: 'boolean',
    },
    description: 'Filter stories by cultural restriction status',
    example: false,
  },

  page: {
    name: 'page',
    in: 'query',
    required: false,
    schema: {
      type: 'integer',
      minimum: 1,
      default: 1,
    },
    description: 'Page number for pagination',
    example: 1,
  },

  limit: {
    name: 'limit',
    in: 'query',
    required: false,
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
    },
    description: 'Number of stories per page',
    example: 20,
  },
};

// Examples for different scenarios
export const storyExamples = {
  story: {
    id: 1,
    title: 'The Legend of the Sacred Mountain',
    description:
      'A traditional story passed down through generations about the sacred mountain and its spiritual significance to our people.',
    communityId: 1,
    createdBy: 5,
    isRestricted: false,
    mediaUrls: [
      'https://example.com/audio/sacred_mountain_story.mp3',
      'https://example.com/images/sacred_mountain.jpg',
    ],
    imageUrl: 'https://example.com/images/sacred_mountain.jpg',
    audioUrl: 'https://example.com/audio/sacred_mountain_story.mp3',
    language: 'en',
    tags: [
      'traditional-knowledge',
      'sacred-places',
      'mountains',
      'spirituality',
    ],
    createdAt: '2024-01-15T10:30:00Z',
    updatedAt: '2024-01-15T15:45:00Z',
  },

  createStory: {
    title: 'The Legend of the Sacred Mountain',
    description: 'A traditional story about our sacred mountain.',
    communityId: 1,
    createdBy: 5,
    isRestricted: false,
    mediaUrls: ['https://example.com/audio/story.mp3'],
    imageUrl: 'https://example.com/images/story-image.jpg',
    audioUrl: 'https://example.com/audio/story.mp3',
    language: 'en',
    tags: ['traditional-knowledge', 'sacred-places'],
  },

  culturalStory: {
    id: 2,
    title: 'The Sacred Ceremony of the Elders',
    description:
      'A story about a traditional ceremony that should only be shared within the community.',
    communityId: 1,
    createdBy: 3,
    isRestricted: true,
    mediaUrls: [],
    imageUrl: null,
    audioUrl: null,
    language: 'indigenous-lang',
    tags: ['traditional-knowledge', 'ceremony', 'elders', 'restricted'],
    createdAt: '2024-01-10T14:20:00Z',
    updatedAt: '2024-01-10T14:20:00Z',
  },

  mediaRichStory: {
    id: 3,
    title: 'The Seasonal Migration Story',
    description:
      'A multimedia story documenting traditional seasonal migration patterns.',
    communityId: 1,
    createdBy: 8,
    isRestricted: false,
    mediaUrls: [
      'https://example.com/video/migration_route.mp4',
      'https://example.com/audio/elder_narration.mp3',
      'https://example.com/images/migration_map.jpg',
      'https://example.com/images/seasonal_markers.jpg',
    ],
    imageUrl: 'https://example.com/images/migration_map.jpg',
    audioUrl: 'https://example.com/audio/elder_narration.mp3',
    language: 'en',
    tags: ['migration', 'seasons', 'traditional-knowledge', 'geography'],
    createdAt: '2024-01-20T09:15:00Z',
    updatedAt: '2024-01-22T11:30:00Z',
  },

  storyList: {
    success: true,
    data: [
      {
        id: 1,
        title: 'The Legend of the Sacred Mountain',
        description: 'A traditional story about the sacred mountain.',
        communityId: 1,
        createdBy: 5,
        isRestricted: false,
        mediaUrls: ['https://example.com/audio/story1.mp3'],
        imageUrl: 'https://example.com/images/story1-image.jpg',
        audioUrl: 'https://example.com/audio/story1.mp3',
        language: 'en',
        tags: ['traditional-knowledge', 'sacred-places'],
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-15T15:45:00Z',
      },
      {
        id: 2,
        title: 'The Origin of Our People',
        description: 'Creation story explaining the origins of our community.',
        communityId: 1,
        createdBy: 3,
        isRestricted: false,
        mediaUrls: [],
        imageUrl: null,
        audioUrl: null,
        language: 'en',
        tags: ['creation', 'origin', 'traditional-knowledge'],
        createdAt: '2024-01-10T14:20:00Z',
        updatedAt: '2024-01-10T14:20:00Z',
      },
    ],
    meta: {
      total: 25,
      page: 1,
      limit: 20,
      filters: {
        community: 1,
        language: 'en',
        restricted: false,
      },
    },
  },
};
