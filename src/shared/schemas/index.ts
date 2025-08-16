/**
 * Swagger/OpenAPI schema definitions
 *
 * Exports all OpenAPI schemas for automatic registration with Fastify Swagger
 */

import { userSchemas, userParameters, userExamples } from './users.swagger.js';

// All schema definitions for OpenAPI
export const swaggerSchemas = {
  // User schemas
  User: userSchemas.User,
  CreateUser: userSchemas.CreateUser,
  UpdateUser: userSchemas.UpdateUser,
  UserResponse: userSchemas.UserResponse,
  UserListResponse: userSchemas.UserListResponse,

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
};

// All example definitions
export const swaggerExamples = {
  // User examples
  user: userExamples.user,
  createUser: userExamples.createUser,
  updateUser: userExamples.updateUser,
  userList: userExamples.userList,
};

// Export individual schema modules for specific use
export { userSchemas, userParameters, userExamples } from './users.swagger.js';
