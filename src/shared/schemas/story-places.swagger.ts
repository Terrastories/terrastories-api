/**
 * Swagger/OpenAPI schemas for Story Places join table operations
 *
 * Comprehensive API documentation for story-place relationship management
 * including schemas, parameters, examples, and error handling
 */

// Schema definitions for Story Places relationship
export const storyPlaceSchemas = {
  StoryPlace: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        example: 1,
        description: 'Unique identifier for the story-place relationship',
      },
      storyId: {
        type: 'integer',
        example: 5,
        description: 'ID of the associated story',
      },
      placeId: {
        type: 'integer',
        example: 3,
        description: 'ID of the associated place',
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the relationship was created',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the relationship was last updated',
      },
    },
    required: ['id', 'storyId', 'placeId', 'createdAt', 'updatedAt'],
  },

  CreateStoryPlace: {
    type: 'object',
    properties: {
      storyId: {
        type: 'integer',
        example: 5,
        description: 'ID of the story to link',
      },
      placeId: {
        type: 'integer',
        example: 3,
        description: 'ID of the place to link',
      },
    },
    required: ['storyId', 'placeId'],
  },

  StoryPlaceResponse: {
    type: 'object',
    properties: {
      data: {
        $ref: '#/components/schemas/StoryPlace',
        description: 'Story place relationship data',
      },
      meta: {
        type: 'object',
        description: 'Response metadata',
      },
    },
  },

  StoryPlaceListResponse: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: { $ref: '#/components/schemas/StoryPlace' },
        description: 'Array of story place relationships',
      },
      meta: {
        type: 'object',
        properties: {
          total: {
            type: 'integer',
            description: 'Total number of relationships',
          },
          page: {
            type: 'integer',
            description: 'Current page number',
          },
          limit: {
            type: 'integer',
            description: 'Number of items per page',
          },
        },
      },
    },
  },

  ValidationError: {
    type: 'object',
    properties: {
      error: {
        type: 'string',
        example: 'Validation Error',
        description: 'Error type',
      },
      message: {
        type: 'string',
        example: 'Invalid input data',
        description: 'Error message',
      },
      details: {
        type: 'array',
        items: { type: 'string' },
        description: 'Detailed validation errors',
      },
    },
    required: ['error', 'message'],
  },

  ConflictError: {
    type: 'object',
    properties: {
      error: {
        type: 'string',
        example: 'Conflict Error',
        description: 'Error type',
      },
      message: {
        type: 'string',
        example: 'Story-place relationship already exists',
        description: 'Error message',
      },
      constraint: {
        type: 'string',
        example: 'story_place_unique',
        description: 'Database constraint that was violated',
      },
    },
    required: ['error', 'message'],
  },

  NotFoundError: {
    type: 'object',
    properties: {
      error: {
        type: 'string',
        example: 'Not Found',
        description: 'Error type',
      },
      message: {
        type: 'string',
        example: 'Story place relationship not found',
        description: 'Error message',
      },
    },
    required: ['error', 'message'],
  },
};

// Parameter definitions for Story Places operations
export const storyPlaceParameters = {
  storyId: {
    name: 'storyId',
    in: 'path',
    required: true,
    description: 'ID of the story',
    schema: {
      type: 'integer',
      minimum: 1,
    },
  },

  placeId: {
    name: 'placeId',
    in: 'path',
    required: true,
    description: 'ID of the place',
    schema: {
      type: 'integer',
      minimum: 1,
    },
  },

  page: {
    name: 'page',
    in: 'query',
    required: false,
    description: 'Page number for pagination',
    schema: {
      type: 'integer',
      minimum: 1,
      default: 1,
    },
  },

  limit: {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Number of items per page',
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
    },
  },

  communityFilter: {
    name: 'community',
    in: 'query',
    required: false,
    description: 'Filter by community ID',
    schema: {
      type: 'integer',
      minimum: 1,
    },
  },
};

// Example data for Story Places operations
export const storyPlaceExamples = {
  storyPlace: {
    summary: 'Complete story place relationship',
    value: {
      id: 1,
      storyId: 5,
      placeId: 3,
      createdAt: '2024-01-15T10:30:00Z',
      updatedAt: '2024-01-15T10:30:00Z',
    },
  },

  createStoryPlace: {
    summary: 'Create story place relationship',
    value: {
      storyId: 5,
      placeId: 3,
    },
  },

  storyPlaceList: {
    summary: 'Paginated list of story place relationships',
    value: {
      data: [
        {
          id: 1,
          storyId: 5,
          placeId: 3,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z',
        },
        {
          id: 2,
          storyId: 5,
          placeId: 7,
          createdAt: '2024-01-15T11:00:00Z',
          updatedAt: '2024-01-15T11:00:00Z',
        },
      ],
      meta: {
        total: 2,
        page: 1,
        limit: 20,
      },
    },
  },

  constraintViolation: {
    summary: 'Duplicate relationship error',
    value: {
      error: 'Conflict Error',
      message: 'Story-place relationship already exists',
      constraint: 'story_place_unique',
    },
  },
};
