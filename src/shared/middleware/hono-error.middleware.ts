/**
 * Hono Error Handling Utility
 *
 * Provides consistent error responses matching the V1 error envelope.
 * Uses the same mapErrorToHttpResponse as the Fastify version.
 */

import type { Context } from 'hono';
import { ZodError } from 'zod';
import {
  AppError,
  mapErrorToHttpResponse,
} from '../errors/index.js';

/**
 * Handle errors in Hono route handlers consistently.
 * Returns a Hono Response — use `return handleHonoError(c, error)`.
 */
export function handleHonoError(c: Context, error: unknown): Response {
  const { statusCode, body } = mapErrorToHttpResponse(error);
  return c.json(body, statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500);
}

/**
 * ZodError-specific handler for validation errors.
 * Matches V1 format: { error: string, statusCode: 400 }
 */
export function handleZodError(
  c: Context,
  error: ZodError
): Response {
  const firstError = error.issues[0];
  return c.json(
    {
      error: firstError ? firstError.message : 'Validation failed',
    },
    400
  );
}
