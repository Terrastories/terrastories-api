/**
 * Swagger/OpenAPI schema definitions
 *
 * Exports all OpenAPI schemas for automatic registration with Fastify Swagger
 */

import { userSchemas, userParameters, userExamples } from './users.swagger.js';
import {
  placeSchemas,
  placeParameters,
  placeExamples,
} from './places.swagger.js';
import {
  storySchemas,
  storyParameters,
  storyExamples,
} from './stories.swagger.js';
import {
  speakerSchemas,
  speakerParameters,
  speakerExamples,
} from './speakers.swagger.js';
import { fileSchemas, fileParameters, fileExamples } from './files.swagger.js';
import {
  superAdminSchemas,
  superAdminParameters,
  superAdminExamples,
} from './super-admin.swagger.js';
// Community swagger schemas removed temporarily due to missing dependency

// All schema definitions for OpenAPI
export const swaggerSchemas = {
  // User schemas
  User: userSchemas.User,
  CreateUser: userSchemas.CreateUser,
  UpdateUser: userSchemas.UpdateUser,
  UserResponse: userSchemas.UserResponse,
  UserListResponse: userSchemas.UserListResponse,

  // Place schemas
  Place: placeSchemas.Place,
  CreatePlace: placeSchemas.CreatePlace,
  UpdatePlace: placeSchemas.UpdatePlace,
  PlaceResponse: placeSchemas.PlaceResponse,
  PlaceListResponse: placeSchemas.PlaceListResponse,

  // Story schemas
  Story: storySchemas.Story,
  CreateStory: storySchemas.CreateStory,
  UpdateStory: storySchemas.UpdateStory,
  StoryResponse: storySchemas.StoryResponse,
  StoryListResponse: storySchemas.StoryListResponse,

  // Speaker schemas
  Speaker: speakerSchemas.Speaker,
  CreateSpeaker: speakerSchemas.CreateSpeaker,
  UpdateSpeaker: speakerSchemas.UpdateSpeaker,
  SpeakerResponse: speakerSchemas.SpeakerResponse,
  SpeakerListResponse: speakerSchemas.SpeakerListResponse,

  // File schemas
  File: fileSchemas.File,
  FileUploadResponse: fileSchemas.FileUploadResponse,
  FileListResponse: fileSchemas.FileListResponse,
  FileErrorResponse: fileSchemas.FileErrorResponse,

  // Super Admin schemas
  Community: superAdminSchemas.Community,
  CreateCommunityRequest: superAdminSchemas.CreateCommunityRequest,
  UpdateCommunityRequest: superAdminSchemas.UpdateCommunityRequest,
  SuperAdminUser: superAdminSchemas.User,
  CreateUserRequest: superAdminSchemas.CreateUserRequest,
  UpdateUserRequest: superAdminSchemas.UpdateUserRequest,
  PaginatedCommunitiesResponse: superAdminSchemas.PaginatedCommunitiesResponse,
  PaginatedUsersResponse: superAdminSchemas.PaginatedUsersResponse,
  CommunityCreatedResponse: superAdminSchemas.CommunityCreatedResponse,
  CommunityUpdatedResponse: superAdminSchemas.CommunityUpdatedResponse,
  CommunityDeletedResponse: superAdminSchemas.CommunityDeletedResponse,
  UserCreatedResponse: superAdminSchemas.UserCreatedResponse,
  UserUpdatedResponse: superAdminSchemas.UserUpdatedResponse,
  UserDeletedResponse: superAdminSchemas.UserDeletedResponse,

  // Community schemas (legacy - temporarily disabled)
  // Community: communitySwaggerSchemas.CommunityResponse,
  // CreateCommunity: communitySwaggerSchemas.CreateCommunityRequest,
  // UpdateCommunity: communitySwaggerSchemas.UpdateCommunityRequest,
  // CommunityResponse: communitySwaggerSchemas.CommunityResponse,
  // CommunitySearchResponse: communitySwaggerSchemas.CommunitySearchResponse,
  // CulturalProtocols: communitySwaggerSchemas.CulturalProtocols,

  // Error schemas (using comprehensive super admin schemas)
  ValidationError: superAdminSchemas.ValidationError,
  NotFoundError: superAdminSchemas.NotFoundError,
  ConflictError: superAdminSchemas.ConflictError,
  UnauthorizedError: superAdminSchemas.UnauthorizedError,
  ForbiddenError: superAdminSchemas.ForbiddenError,
  InternalServerError: superAdminSchemas.InternalServerError,
};

// All parameter definitions
export const swaggerParameters = {
  // User parameters
  userId: userParameters.userId,
  communityFilter: userParameters.communityFilter,
  roleFilter: userParameters.roleFilter,
  activeFilter: userParameters.activeFilter,
  pageParam: userParameters.pageParam,
  limitParam: userParameters.limitParam,

  // Place parameters
  placeId: placeParameters.placeId,
  latitude: placeParameters.latitude,
  longitude: placeParameters.longitude,
  radius: placeParameters.radius,
  regionFilter: placeParameters.regionFilter,
  restrictedFilter: placeParameters.restrictedFilter,

  // Story parameters
  storyId: storyParameters.storyId,
  languageFilter: storyParameters.languageFilter,

  // Speaker parameters
  speakerId: speakerParameters.speakerId,
  elderStatusFilter: speakerParameters.elderStatusFilter,

  // File parameters
  fileId: fileParameters.fileId,
  page: fileParameters.page,
  limit: fileParameters.limit,
  search: fileParameters.search,
  mimeType: fileParameters.mimeType,
  culturalRestrictions: fileParameters.culturalRestrictions,

  // Super Admin parameters
  saPage: superAdminParameters.page,
  saLimit: superAdminParameters.limit,
  communitySearch: superAdminParameters.communitySearch,
  communityLocale: superAdminParameters.communityLocale,
  communityActive: superAdminParameters.communityActive,
  userCommunity: superAdminParameters.userCommunity,
  userRole: superAdminParameters.userRole,
  userSearch: superAdminParameters.userSearch,
  userActive: superAdminParameters.userActive,
  communityId: superAdminParameters.communityId,
  saUserId: superAdminParameters.userId,
};

// All example definitions
export const swaggerExamples = {
  // User examples
  user: userExamples.user,
  createUser: userExamples.createUser,
  updateUser: userExamples.updateUser,
  userList: userExamples.userList,

  // Place examples
  place: placeExamples.place,
  createPlace: placeExamples.createPlace,
  restrictedPlace: placeExamples.restrictedPlace,
  placeList: placeExamples.placeList,
  ceremonialSite: placeExamples.ceremonialSite,

  // Story examples
  story: storyExamples.story,
  createStory: storyExamples.createStory,
  mediaRichStory: storyExamples.mediaRichStory,
  storyList: storyExamples.storyList,
  culturalStory: storyExamples.culturalStory,

  // Speaker examples
  speaker: speakerExamples.speaker,
  createSpeaker: speakerExamples.createSpeaker,
  culturalSpeaker: speakerExamples.culturalSpeaker,
  speakerList: speakerExamples.speakerList,
  elderSpeaker: speakerExamples.elderSpeaker,

  // File examples
  uploadImageRequest: fileExamples.uploadImageRequest,
  uploadAudioRequest: fileExamples.uploadAudioRequest,
  uploadSuccessResponse: fileExamples.uploadSuccessResponse,
  uploadErrorResponse: fileExamples.uploadErrorResponse,
  fileListResponse: fileExamples.fileListResponse,

  // Super Admin examples
  secwepemcCommunity: superAdminExamples.communities.secwepemc,
  mikmaqCommunity: superAdminExamples.communities.mikmaq,
  adminUser: superAdminExamples.users.admin,
  editorUser: superAdminExamples.users.editor,
};

// Export individual schema modules for specific use
export { userSchemas, userParameters, userExamples } from './users.swagger.js';
export {
  placeSchemas,
  placeParameters,
  placeExamples,
} from './places.swagger.js';
export {
  storySchemas,
  storyParameters,
  storyExamples,
} from './stories.swagger.js';
export {
  speakerSchemas,
  speakerParameters,
  speakerExamples,
} from './speakers.swagger.js';
export { fileSchemas, fileParameters, fileExamples } from './files.swagger.js';
export {
  superAdminSchemas,
  superAdminParameters,
  superAdminExamples,
} from './super-admin.swagger.js';
// export { communitySwaggerSchemas } from './communities.swagger.js';
