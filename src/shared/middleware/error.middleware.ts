import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  AppError,
  mapErrorToHttpResponse,
  isOperationalError,
} from '../errors/index.js';

/**
 * Global error handler for Fastify
 *
 * This handler ensures consistent error responses across the entire API
 * and properly handles both operational and programming errors.
 */
export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Log error details for debugging (avoid logging sensitive data)
  const logContext = {
    errorName: error.name,
    errorMessage: error.message,
    statusCode: error.statusCode,
    method: request.method,
    url: request.url,
    userAgent: request.headers['user-agent'],
    timestamp: new Date().toISOString(),
  };

  // Log operational errors as warnings, programming errors as errors
  if (isOperationalError(error)) {
    request.log.warn(logContext, 'Operational error occurred');
  } else {
    request.log.error(logContext, 'Programming error occurred');
  }

  // Map error to HTTP response
  const { statusCode, body } = mapErrorToHttpResponse(error);

  // Send response
  return reply.status(statusCode).send(body);
}

/**
 * Error handling utility for route handlers
 *
 * Use this to handle errors in route handlers consistently:
 *
 * ```typescript
 * import { handleRouteError } from '../shared/middleware/error.middleware.js';
 *
 * try {
 *   // ... route logic
 * } catch (error) {
 *   return handleRouteError(error, reply, request);
 * }
 * ```
 */
export async function handleRouteError(
  error: unknown,
  reply: FastifyReply,
  request: FastifyRequest
): Promise<void> {
  // Convert to FastifyError for consistent handling
  let fastifyError: FastifyError;

  if (error instanceof AppError) {
    fastifyError = {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
    } as FastifyError;
  } else if (error instanceof ZodError) {
    fastifyError = {
      name: 'ZodError',
      message: 'Validation error',
      statusCode: 400,
    } as FastifyError;
  } else if (error instanceof Error) {
    fastifyError = {
      name: error.name,
      message: error.message,
      statusCode: 500,
    } as FastifyError;
  } else {
    fastifyError = {
      name: 'UnknownError',
      message: 'Unknown error occurred',
      statusCode: 500,
    } as FastifyError;
  }

  return errorHandler(fastifyError, request, reply);
}
