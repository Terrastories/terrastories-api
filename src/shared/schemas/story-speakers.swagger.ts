/**
 * Swagger/OpenAPI schemas for Story Speakers join table operations
 *
 * Comprehensive API documentation for story-speaker relationship management
 * including schemas, parameters, examples, and error handling
 */

// Schema definitions for Story Speakers relationship
export const storySpeakerSchemas = {
  StorySpeaker: {
    type: 'object',
    properties: {
      id: {
        type: 'integer',
        example: 1,
        description: 'Unique identifier for the story-speaker relationship',
      },
      storyId: {
        type: 'integer',
        example: 5,
        description: 'ID of the associated story',
      },
      speakerId: {
        type: 'integer',
        example: 2,
        description: 'ID of the associated speaker',
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
    required: ['id', 'storyId', 'speakerId', 'createdAt', 'updatedAt'],
  },

  CreateStorySpeaker: {
    type: 'object',
    properties: {
      storyId: {
        type: 'integer',
        example: 5,
        description: 'ID of the story to link',
      },
      speakerId: {
        type: 'integer',
        example: 2,
        description: 'ID of the speaker to link',
      },
    },
    required: ['storyId', 'speakerId'],
  },

  StorySpeakerResponse: {
    type: 'object',
    properties: {
      data: {
        $ref: '#/components/schemas/StorySpeaker',
        description: 'Story speaker relationship data',
      },
      meta: {
        type: 'object',
        description: 'Response metadata',
      },
    },
  },

  StorySpeakerListResponse: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: { $ref: '#/components/schemas/StorySpeaker' },
        description: 'Array of story speaker relationships',
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
        example: 'Story-speaker relationship already exists',
        description: 'Error message',
      },
      constraint: {
        type: 'string',
        example: 'story_speaker_unique',
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
        example: 'Story speaker relationship not found',
        description: 'Error message',
      },
    },
    required: ['error', 'message'],
  },
};

// Parameter definitions for Story Speakers operations
export const storySpeakerParameters = {
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

  speakerId: {
    name: 'speakerId',
    in: 'path',
    required: true,
    description: 'ID of the speaker',
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

// Example data for Story Speakers operations
export const storySpeakerExamples = {
  storySpeaker: {
    summary: 'Complete story speaker relationship',
    value: {
      id: 1,
      storyId: 5,
      speakerId: 2,
      createdAt: '2024-01-15T10:30:00Z',
      updatedAt: '2024-01-15T10:30:00Z',
    },
  },

  createStorySpeaker: {
    summary: 'Create story speaker relationship',
    value: {
      storyId: 5,
      speakerId: 2,
    },
  },

  storySpeakerList: {
    summary: 'Paginated list of story speaker relationships',
    value: {
      data: [
        {
          id: 1,
          storyId: 5,
          speakerId: 2,
          createdAt: '2024-01-15T10:30:00Z',
          updatedAt: '2024-01-15T10:30:00Z',
        },
        {
          id: 2,
          storyId: 5,
          speakerId: 4,
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
      message: 'Story-speaker relationship already exists',
      constraint: 'story_speaker_unique',
    },
  },
};
