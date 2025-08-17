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

  // Error schemas
  ValidationError: userSchemas.ValidationError,
  NotFoundError: userSchemas.NotFoundError,
  ConflictError: userSchemas.ConflictError,
  UnauthorizedError: userSchemas.UnauthorizedError,
  ForbiddenError: userSchemas.ForbiddenError,
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
