/**
 * Places Swagger/OpenAPI Schema Definitions
 *
 * Comprehensive OpenAPI schemas for the Places entity including:
 * - Complete schema definitions for all CRUD operations
 * - Request/response schemas with proper validation
 * - Error schemas for all possible error states
 * - Parameters for filtering and pagination
 * - Examples for all operations including spatial considerations
 * - PostGIS geometry handling and coordinate validation
 */

// Core Place Schema
export const placeSchemas = {
  Place: {
    type: 'object',
    required: [
      'id',
      'name',
      'communityId',
      'latitude',
      'longitude',
      'isRestricted',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: {
        type: 'integer',
        description: 'Unique identifier for the place',
        example: 1,
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Name of the geographic location',
        example: 'Sacred Mountain Overlook',
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Detailed description of the place and its significance',
        example:
          'A traditional gathering place overlooking the sacred mountain, where ceremonies have been held for generations.',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this place belongs to',
        example: 1,
      },
      latitude: {
        type: 'number',
        minimum: -90,
        maximum: 90,
        description: 'Latitude coordinate in decimal degrees (WGS84)',
        example: -15.7801,
      },
      longitude: {
        type: 'number',
        minimum: -180,
        maximum: 180,
        description: 'Longitude coordinate in decimal degrees (WGS84)',
        example: -47.9292,
      },
      region: {
        type: 'string',
        maxLength: 100,
        description: 'Geographic region or area name',
        example: 'Central Highlands',
      },
      mediaUrls: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uri',
        },
        description:
          'DEPRECATED: Use photoUrl instead. Array of media file URLs associated with this place',
        example: [
          'https://example.com/images/sacred-mountain.jpg',
          'https://example.com/audio/ceremony-sounds.mp3',
        ],
        default: [],
        deprecated: true,
      },
      photoUrl: {
        type: 'string',
        format: 'uri',
        description:
          'Direct URL to the primary photo file for this place (dual-read capability)',
        example: 'https://example.com/images/sacred-mountain.jpg',
      },
      culturalSignificance: {
        type: 'string',
        maxLength: 1000,
        description:
          'Description of the cultural or spiritual significance of this place',
        example:
          'This overlook has been used for sunrise ceremonies for over 500 years and is considered a sacred site by our community.',
      },
      isRestricted: {
        type: 'boolean',
        description:
          'Whether access to this place location should be restricted for cultural protection',
        example: false,
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the place was created',
        example: '2024-01-15T10:30:00Z',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'Timestamp when the place was last updated',
        example: '2024-01-15T15:45:00Z',
      },
    },
  },

  CreatePlace: {
    type: 'object',
    required: ['name', 'communityId', 'latitude', 'longitude'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Name of the geographic location',
        example: 'Sacred Mountain Overlook',
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Detailed description of the place',
        example: 'A traditional gathering place with spiritual significance.',
      },
      communityId: {
        type: 'integer',
        description: 'ID of the community this place belongs to',
        example: 1,
      },
      latitude: {
        type: 'number',
        minimum: -90,
        maximum: 90,
        description: 'Latitude coordinate in decimal degrees',
        example: -15.7801,
      },
      longitude: {
        type: 'number',
        minimum: -180,
        maximum: 180,
        description: 'Longitude coordinate in decimal degrees',
        example: -47.9292,
      },
      region: {
        type: 'string',
        maxLength: 100,
        description: 'Geographic region name',
        example: 'Central Highlands',
      },
      mediaUrls: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uri',
        },
        description: 'Array of media file URLs',
        example: ['https://example.com/images/location.jpg'],
        default: [],
      },
      culturalSignificance: {
        type: 'string',
        maxLength: 1000,
        description: 'Cultural or spiritual significance description',
        example: 'Sacred ceremony site for sunrise rituals.',
      },
      isRestricted: {
        type: 'boolean',
        description: 'Whether access should be restricted',
        example: false,
        default: false,
      },
    },
  },

  UpdatePlace: {
    type: 'object',
    required: [],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Updated name of the place',
        example: 'Sacred Mountain Overlook (Protected Site)',
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Updated description',
        example: 'An updated description with additional historical context.',
      },
      latitude: {
        type: 'number',
        minimum: -90,
        maximum: 90,
        description: 'Updated latitude coordinate',
        example: -15.7802,
      },
      longitude: {
        type: 'number',
        minimum: -180,
        maximum: 180,
        description: 'Updated longitude coordinate',
        example: -47.9293,
      },
      region: {
        type: 'string',
        maxLength: 100,
        description: 'Updated region name',
        example: 'Central Sacred Highlands',
      },
      mediaUrls: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uri',
        },
        description: 'Updated array of media URLs',
        example: ['https://example.com/images/updated-location.jpg'],
      },
      culturalSignificance: {
        type: 'string',
        maxLength: 1000,
        description: 'Updated cultural significance',
        example: 'Enhanced description with elder testimonies.',
      },
      isRestricted: {
        type: 'boolean',
        description: 'Updated restriction status',
        example: true,
      },
    },
  },

  PlaceResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: {
        type: 'boolean',
        default: true,
        description: 'Indicates successful operation',
      },
      data: {
        $ref: '#/components/schemas/Place',
      },
    },
  },

  PlaceListResponse: {
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
          $ref: '#/components/schemas/Place',
        },
        description: 'Array of places',
      },
      meta: {
        type: 'object',
        required: ['total', 'page', 'limit'],
        properties: {
          total: {
            type: 'integer',
            description: 'Total number of places',
            example: 28,
          },
          page: {
            type: 'integer',
            description: 'Current page number',
            example: 1,
          },
          limit: {
            type: 'integer',
            description: 'Number of places per page',
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
              region: {
                type: 'string',
                description: 'Region filter applied',
                example: 'Central Highlands',
              },
              restricted: {
                type: 'boolean',
                description: 'Restriction filter applied',
                example: false,
              },
              withinRadius: {
                type: 'object',
                description: 'Spatial radius filter applied',
                properties: {
                  latitude: { type: 'number', example: -15.7801 },
                  longitude: { type: 'number', example: -47.9292 },
                  radiusKm: { type: 'number', example: 10 },
                },
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
        example: 'Invalid coordinate data',
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
          { field: 'latitude', message: 'Latitude must be between -90 and 90' },
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
        example: 'Place not found',
      },
      resource: {
        type: 'string',
        example: 'place',
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
        example: 'Place with this name already exists at these coordinates',
      },
      conflictType: {
        type: 'string',
        example: 'duplicate_location',
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
        example: 'Access to this place location is restricted',
      },
      reason: {
        type: 'string',
        example: 'culturally_sensitive_location',
      },
    },
  },
};

// Parameters for API endpoints
export const placeParameters = {
  placeId: {
    name: 'placeId',
    in: 'path',
    required: true,
    schema: {
      type: 'integer',
      minimum: 1,
    },
    description: 'Unique identifier of the place',
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
    description: 'Filter places by community ID',
    example: 1,
  },

  regionFilter: {
    name: 'region',
    in: 'query',
    required: false,
    schema: {
      type: 'string',
      maxLength: 100,
    },
    description: 'Filter places by region name',
    example: 'Central Highlands',
  },

  restrictedFilter: {
    name: 'restricted',
    in: 'query',
    required: false,
    schema: {
      type: 'boolean',
    },
    description: 'Filter places by restriction status',
    example: false,
  },

  // Spatial filtering parameters
  latitude: {
    name: 'latitude',
    in: 'query',
    required: false,
    schema: {
      type: 'number',
      minimum: -90,
      maximum: 90,
    },
    description: 'Center latitude for spatial search',
    example: -15.7801,
  },

  longitude: {
    name: 'longitude',
    in: 'query',
    required: false,
    schema: {
      type: 'number',
      minimum: -180,
      maximum: 180,
    },
    description: 'Center longitude for spatial search',
    example: -47.9292,
  },

  radius: {
    name: 'radius',
    in: 'query',
    required: false,
    schema: {
      type: 'number',
      minimum: 0.1,
      maximum: 1000,
    },
    description: 'Search radius in kilometers',
    example: 10,
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
    description: 'Number of places per page',
    example: 20,
  },
};

// Examples for different scenarios
export const placeExamples = {
  place: {
    id: 1,
    name: 'Sacred Mountain Overlook',
    description:
      'A traditional gathering place overlooking the sacred mountain, where ceremonies have been held for generations. This site offers panoramic views and serves as a spiritual center for the community.',
    communityId: 1,
    latitude: -15.7801,
    longitude: -47.9292,
    region: 'Central Highlands',
    mediaUrls: [
      'https://example.com/images/sacred-mountain-overlook.jpg',
      'https://example.com/audio/ceremony-chants.mp3',
    ],
    culturalSignificance:
      'This overlook has been used for sunrise ceremonies for over 500 years and is considered one of the most sacred sites by our community. Elders gather here to share traditional knowledge.',
    isRestricted: false,
    createdAt: '2024-01-15T10:30:00Z',
    updatedAt: '2024-01-20T14:15:00Z',
  },

  createPlace: {
    name: 'Sacred Mountain Overlook',
    description:
      'A traditional gathering place overlooking the sacred mountain.',
    communityId: 1,
    latitude: -15.7801,
    longitude: -47.9292,
    region: 'Central Highlands',
    mediaUrls: ['https://example.com/images/mountain-view.jpg'],
    culturalSignificance: 'Traditional ceremony site for sunrise rituals.',
    isRestricted: false,
  },

  restrictedPlace: {
    id: 2,
    name: 'Ancient Burial Ground',
    description: 'Sacred burial site of our ancestors.',
    communityId: 1,
    latitude: -15.7912,
    longitude: -47.9401,
    region: 'Sacred Valley',
    mediaUrls: [],
    culturalSignificance:
      'This site contains the remains of our ancestors and is considered highly sacred. Access is restricted to authorized community members only.',
    isRestricted: true,
    createdAt: '2024-01-10T09:00:00Z',
    updatedAt: '2024-01-10T09:00:00Z',
  },

  waterSource: {
    id: 3,
    name: 'Healing Springs',
    description:
      'Natural spring with medicinal properties known to our people for centuries.',
    communityId: 1,
    latitude: -15.7723,
    longitude: -47.9156,
    region: 'Valley Floor',
    mediaUrls: [
      'https://example.com/images/healing-springs.jpg',
      'https://example.com/video/spring-ritual.mp4',
    ],
    culturalSignificance:
      'These springs have been used for healing ceremonies and water blessing rituals. The water is believed to have special healing properties.',
    isRestricted: false,
    createdAt: '2024-01-12T14:20:00Z',
    updatedAt: '2024-01-18T16:30:00Z',
  },

  ceremonialSite: {
    id: 4,
    name: 'Circle of Stones',
    description:
      'Ancient stone circle used for community gatherings and seasonal celebrations.',
    communityId: 1,
    latitude: -15.7645,
    longitude: -47.9378,
    region: 'Eastern Plateau',
    mediaUrls: [
      'https://example.com/images/stone-circle.jpg',
      'https://example.com/images/seasonal-ceremony.jpg',
    ],
    culturalSignificance:
      'This stone circle was built by our ancestors over 800 years ago and continues to be used for equinox and solstice ceremonies.',
    isRestricted: false,
    createdAt: '2024-01-20T11:45:00Z',
    updatedAt: '2024-01-22T09:15:00Z',
  },

  huntingGround: {
    id: 5,
    name: 'Traditional Hunting Grounds',
    description:
      'Ancestral hunting territory with established trails and seasonal camps.',
    communityId: 1,
    latitude: -15.8034,
    longitude: -47.8967,
    region: 'Northern Forest',
    mediaUrls: ['https://example.com/images/hunting-trails.jpg'],
    culturalSignificance:
      'These hunting grounds have sustained our community for generations. Traditional hunting protocols and sustainable practices are still followed here.',
    isRestricted: false,
    createdAt: '2024-01-25T13:30:00Z',
    updatedAt: '2024-01-25T13:30:00Z',
  },

  placeList: {
    success: true,
    data: [
      {
        id: 1,
        name: 'Sacred Mountain Overlook',
        description: 'Traditional gathering place with panoramic views.',
        communityId: 1,
        latitude: -15.7801,
        longitude: -47.9292,
        region: 'Central Highlands',
        mediaUrls: ['https://example.com/images/mountain-overlook.jpg'],
        culturalSignificance: 'Sunrise ceremony site for over 500 years.',
        isRestricted: false,
        createdAt: '2024-01-15T10:30:00Z',
        updatedAt: '2024-01-20T14:15:00Z',
      },
      {
        id: 2,
        name: 'Healing Springs',
        description: 'Natural spring with medicinal properties.',
        communityId: 1,
        latitude: -15.7723,
        longitude: -47.9156,
        region: 'Valley Floor',
        mediaUrls: ['https://example.com/images/healing-springs.jpg'],
        culturalSignificance: 'Traditional healing and water blessing site.',
        isRestricted: false,
        createdAt: '2024-01-12T14:20:00Z',
        updatedAt: '2024-01-18T16:30:00Z',
      },
    ],
    meta: {
      total: 23,
      page: 1,
      limit: 20,
      filters: {
        community: 1,
        region: undefined,
        restricted: false,
        withinRadius: {
          latitude: -15.7801,
          longitude: -47.9292,
          radiusKm: 10,
        },
      },
    },
  },
};
