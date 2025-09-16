/**
 * Standardized error context utilities for consistent error reporting across repositories
 */

/**
 * Standard operation names for database operations
 */
export const DatabaseOperations = {
  // Create operations
  CREATE_COMMUNITY: 'createCommunity',
  CREATE_USER: 'createUser',
  CREATE_SPEAKER: 'createSpeaker',
  CREATE_PLACE: 'createPlace',
  CREATE_STORY: 'createStory',
  CREATE_THEME: 'createTheme',
  CREATE_FILE: 'createFile',

  // Read operations
  GET_BY_ID: 'getById',
  GET_BY_ID_WITH_COMMUNITY: 'getByIdWithCommunity',
  LIST_BY_COMMUNITY: 'listByCommunity',
  SEARCH: 'search',

  // Update operations
  UPDATE_BY_ID: 'updateById',
  UPDATE_COMMUNITY_DATA: 'updateCommunityData',

  // Delete operations
  DELETE_BY_ID: 'deleteById',
  SOFT_DELETE: 'softDelete',

  // Association operations
  CREATE_STORY_PLACE_ASSOCIATION: 'createStoryPlaceAssociation',
  CREATE_STORY_SPEAKER_ASSOCIATION: 'createStorySpeakerAssociation',
  UPDATE_ASSOCIATIONS: 'updateAssociations',

  // Validation operations
  VALIDATE_COMMUNITY_EXISTS: 'validateCommunityExists',
  VALIDATE_COORDINATES: 'validateCoordinates',
} as const;

/**
 * Standard context builder for database errors
 */
export interface ErrorContext {
  operation: string;
  resourceType: string;
  resourceId?: number | string;
  communityId?: number;
  userId?: number;
  originalError: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  additionalData?: Record<string, any>;
}

/**
 * Creates standardized error context for database operations
 */
export function createErrorContext(params: {
  operation: string;
  resourceType: string;
  resourceId?: number | string;
  communityId?: number;
  userId?: number;
  originalError: Error | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  additionalData?: Record<string, any>;
}): ErrorContext {
  return {
    operation: params.operation,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    communityId: params.communityId,
    userId: params.userId,
    originalError:
      typeof params.originalError === 'string'
        ? params.originalError
        : params.originalError.message,
    additionalData: params.additionalData,
  };
}

/**
 * Creates standardized error messages for common scenarios
 */
export const ErrorMessages = {
  UNKNOWN_ERROR: (operation: string, resourceType: string) =>
    `Unknown error occurred while ${operation} ${resourceType}`,

  NOT_FOUND: (resourceType: string, resourceId: number | string) =>
    `${resourceType} with ID ${resourceId} not found`,

  COMMUNITY_NOT_FOUND: (communityId: number) =>
    `Community with ID ${communityId} not found`,

  PERMISSION_DENIED: (operation: string, resourceType: string) =>
    `Permission denied for ${operation} on ${resourceType}`,

  VALIDATION_FAILED: (resourceType: string, field: string) =>
    `Validation failed for ${resourceType}: invalid ${field}`,

  DATABASE_COMPATIBILITY: (detail: string) =>
    `Database compatibility error: ${detail}`,
} as const;

/**
 * Resource type constants for consistency
 */
export const ResourceTypes = {
  COMMUNITY: 'community',
  USER: 'user',
  SPEAKER: 'speaker',
  PLACE: 'place',
  STORY: 'story',
  THEME: 'theme',
  FILE: 'file',
  STORY_PLACE_ASSOCIATION: 'storyPlaceAssociation',
  STORY_SPEAKER_ASSOCIATION: 'storySpeakerAssociation',
} as const;
