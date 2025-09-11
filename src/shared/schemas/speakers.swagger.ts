/**
 * Speakers Swagger/OpenAPI Schema Definitions
 *
 * Comprehensive OpenAPI schemas for the Speakers entity including:
 * - Complete schema definitions for all CRUD operations
 * - Request/response schemas with proper validation
 * - Error schemas for all possible error states
 * - Parameters for filtering and pagination
 * - Examples for all operations including cultural considerations
 * - Special handling for elder status and cultural roles
 */

// Core Speaker Schema
export const speakerSchemas = {
  Speaker: {
    type: 'object',
    required: [
      'id',
      'name',
      'communityId',
      'elderStatus',
      'isActive',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: {
        type: 'integer',
        description: 'Unique identifier for the speaker',
        example: 1,
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Full name of the speaker',
        example: 'Maria Awatí-Santos',
      },
      bio: {
        type: 'string',
        maxLength: 2000,
        description: 'Biography and background information about the speaker',
        example:
          'A traditional knowledge keeper and storyteller who has been sharing our ancestral stories for over 40 years.',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this speaker belongs to',
        example: 1,
      },
      photoUrl: {
        type: 'string',
        format: 'uri',
        description: "URL to the speaker's profile photo",
        example: 'https://example.com/photos/maria-awati.jpg',
      },
      bioAudioUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Direct URL to audio biography file for this speaker (dual-read capability)',
        example: 'https://example.com/audio/maria-awati-bio.mp3',
      },
      birthYear: {
        type: 'integer',
        minimum: 1900,
        maximum: 2024,
        description:
          'Birth year for age calculation and elder status recognition',
        example: 1955,
      },
      elderStatus: {
        type: 'boolean',
        description:
          'Recognition as an elder within the community with special cultural authority',
        example: true,
      },
      culturalRole: {
        type: 'string',
        maxLength: 100,
        description:
          'Cultural position or role within the community (e.g., Traditional Knowledge Keeper)',
        example: 'Traditional Knowledge Keeper',
      },
      isActive: {
        type: 'boolean',
        description:
          'Whether the speaker is currently active in storytelling activities',
        example: true,
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the speaker profile was created',
        example: '2024-01-15T10:30:00Z',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the speaker profile was last updated',
        example: '2024-01-15T15:45:00Z',
      },
    },
  },

  CreateSpeaker: {
    type: 'object',
    required: ['name', 'communityId'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Full name of the speaker',
        example: 'Maria Awatí-Santos',
      },
      bio: {
        type: 'string',
        maxLength: 2000,
        description: 'Biography and background information',
        example: 'A traditional knowledge keeper and storyteller.',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this speaker belongs to',
        example: 1,
      },
      photoUrl: {
        type: 'string',
        format: 'uri',
        description: "URL to the speaker's profile photo",
        example: 'https://example.com/photos/speaker.jpg',
      },
      birthYear: {
        type: 'integer',
        minimum: 1900,
        maximum: 2024,
        description: 'Birth year for age calculation',
        example: 1955,
      },
      elderStatus: {
        type: 'boolean',
        description: 'Recognition as an elder within the community',
        example: false,
        default: false,
      },
      culturalRole: {
        type: 'string',
        maxLength: 100,
        description: 'Cultural position or role within the community',
        example: 'Storyteller',
      },
      isActive: {
        type: 'boolean',
        description: 'Whether the speaker is currently active',
        example: true,
        default: true,
      },
    },
  },

  UpdateSpeaker: {
    type: 'object',
    required: [],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Updated name of the speaker',
        example: 'Maria Awatí-Santos (Elder)',
      },
      bio: {
        type: 'string',
        maxLength: 2000,
        description: 'Updated biography',
        example: 'A revered elder and traditional knowledge keeper.',
      },
      photoUrl: {
        type: 'string',
        format: 'uri',
        description: 'Updated photo URL',
        example: 'https://example.com/photos/updated_speaker.jpg',
      },
      birthYear: {
        type: 'integer',
        minimum: 1900,
        maximum: 2024,
        description: 'Updated birth year',
        example: 1950,
      },
      elderStatus: {
        type: 'boolean',
        description: 'Updated elder status recognition',
        example: true,
      },
      culturalRole: {
        type: 'string',
        maxLength: 100,
        description: 'Updated cultural role',
        example: 'Traditional Knowledge Keeper',
      },
      isActive: {
        type: 'boolean',
        description: 'Updated active status',
        example: false,
      },
    },
  },

  SpeakerResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: {
        type: 'boolean',
        default: true,
        description: 'Indicates successful operation',
      },
      data: {
        $ref: '#/components/schemas/Speaker',
      },
    },
  },

  SpeakerListResponse: {
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
          $ref: '#/components/schemas/Speaker',
        },
        description: 'Array of speakers',
      },
      meta: {
        type: 'object',
        required: ['total', 'page', 'limit'],
        properties: {
          total: {
            type: 'integer',
            description: 'Total number of speakers',
            example: 15,
          },
          page: {
            type: 'integer',
            description: 'Current page number',
            example: 1,
          },
          limit: {
            type: 'integer',
            description: 'Number of speakers per page',
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
              elderStatus: {
                type: 'boolean',
                description: 'Elder status filter applied',
                example: true,
              },
              active: {
                type: 'boolean',
                description: 'Active status filter applied',
                example: true,
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
          { field: 'name', message: 'Name is required' },
          { field: 'birthYear', message: 'Birth year cannot be in the future' },
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
        example: 'Speaker not found',
      },
      resource: {
        type: 'string',
        example: 'speaker',
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
        example: 'Speaker with this name already exists in the community',
      },
      conflictType: {
        type: 'string',
        example: 'duplicate_name',
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
        example: 'Access to this speaker profile is restricted',
      },
      reason: {
        type: 'string',
        example: 'community_access_required',
      },
    },
  },
};

// Parameters for API endpoints
export const speakerParameters = {
  speakerId: {
    name: 'speakerId',
    in: 'path',
    required: true,
    schema: {
      type: 'integer',
      minimum: 1,
    },
    description: 'Unique identifier of the speaker',
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
    description: 'Filter speakers by community ID',
    example: 1,
  },

  elderStatusFilter: {
    name: 'elderStatus',
    in: 'query',
    required: false,
    schema: {
      type: 'boolean',
    },
    description: 'Filter speakers by elder status recognition',
    example: true,
  },

  activeFilter: {
    name: 'active',
    in: 'query',
    required: false,
    schema: {
      type: 'boolean',
    },
    description: 'Filter speakers by active status',
    example: true,
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
    description: 'Number of speakers per page',
    example: 20,
  },
};

// Examples for different scenarios
export const speakerExamples = {
  speaker: {
    id: 1,
    name: 'Maria Awatí-Santos',
    bio: 'A traditional knowledge keeper and storyteller who has been sharing our ancestral stories for over 40 years. She is deeply respected in the community for her wisdom and cultural expertise.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/maria-awati.jpg',
    birthYear: 1955,
    elderStatus: true,
    culturalRole: 'Traditional Knowledge Keeper',
    isActive: true,
    createdAt: '2024-01-15T10:30:00Z',
    updatedAt: '2024-01-20T14:15:00Z',
  },

  createSpeaker: {
    name: 'João Tuxá-Silva',
    bio: 'A young storyteller learning traditional narratives from the elders.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/joao-tuxa.jpg',
    birthYear: 1985,
    elderStatus: false,
    culturalRole: 'Apprentice Storyteller',
    isActive: true,
  },

  elderSpeaker: {
    id: 2,
    name: 'Antônio Kalapalo-Mendes',
    bio: 'Revered elder and spiritual leader who has preserved our ceremonial traditions for seven decades. Recognized as the most knowledgeable keeper of sacred stories.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/antonio-kalapalo.jpg',
    birthYear: 1940,
    elderStatus: true,
    culturalRole: 'Spiritual Leader',
    isActive: true,
    createdAt: '2024-01-10T09:00:00Z',
    updatedAt: '2024-01-10T09:00:00Z',
  },

  culturalSpeaker: {
    id: 3,
    name: 'Ana Xingu-Costa',
    bio: 'Traditional healer and keeper of medicinal plant knowledge. She bridges traditional wisdom with contemporary understanding.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/ana-xingu.jpg',
    birthYear: 1962,
    elderStatus: false,
    culturalRole: 'Traditional Healer',
    isActive: true,
    createdAt: '2024-01-12T11:20:00Z',
    updatedAt: '2024-01-18T16:30:00Z',
  },

  youngSpeaker: {
    id: 4,
    name: 'Carlos Tupinambá-Oliveira',
    bio: 'Young community member passionate about documenting and sharing traditional stories through modern media.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/carlos-tupinamba.jpg',
    birthYear: 1995,
    elderStatus: false,
    culturalRole: 'Digital Storyteller',
    isActive: true,
    createdAt: '2024-01-20T13:45:00Z',
    updatedAt: '2024-01-22T10:15:00Z',
  },

  traditionalSpeaker: {
    id: 5,
    name: 'Rosa Pataxó-Ferreira',
    bio: 'Master craftsperson and oral historian who maintains the traditional art forms and their associated stories.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/rosa-pataxo.jpg',
    birthYear: 1958,
    elderStatus: true,
    culturalRole: 'Traditional Crafts Master',
    isActive: true,
    createdAt: '2024-01-08T14:30:00Z',
    updatedAt: '2024-01-08T14:30:00Z',
  },

  inactiveSpeaker: {
    id: 6,
    name: 'Pedro Guarani-Souza',
    bio: 'Former storyteller who contributed greatly to our oral tradition before retiring from active storytelling.',
    communityId: 1,
    photoUrl: 'https://example.com/photos/pedro-guarani.jpg',
    birthYear: 1945,
    elderStatus: true,
    culturalRole: 'Former Storyteller',
    isActive: false,
    createdAt: '2024-01-05T08:15:00Z',
    updatedAt: '2024-01-25T12:00:00Z',
  },

  speakerList: {
    success: true,
    data: [
      {
        id: 1,
        name: 'Maria Awatí-Santos',
        bio: 'Traditional knowledge keeper and storyteller.',
        communityId: 1,
        photoUrl: 'https://example.com/photos/maria-awati.jpg',
        birthYear: 1955,
        elderStatus: true,
        culturalRole: 'Traditional Knowledge Keeper',
        isActive: true,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-20T14:15:00Z',
      },
      {
        id: 2,
        name: 'João Tuxá-Silva',
        bio: 'Young storyteller learning traditional narratives.',
        communityId: 1,
        photoUrl: 'https://example.com/photos/joao-tuxa.jpg',
        birthYear: 1985,
        elderStatus: false,
        culturalRole: 'Apprentice Storyteller',
        isActive: true,
        createdAt: '2024-01-18T09:20:00Z',
        updatedAt: '2024-01-18T09:20:00Z',
      },
    ],
    meta: {
      total: 12,
      page: 1,
      limit: 20,
      filters: {
        community: 1,
        elderStatus: undefined,
        active: true,
      },
    },
  },
};
