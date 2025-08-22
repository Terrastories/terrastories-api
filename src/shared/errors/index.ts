/**
 * Centralized Error System for Terrastories API
 *
 * All custom errors should extend from these base classes to ensure
 * consistent error handling across repositories, services, and routes.
 */

/**
 * Base error class for all application errors
 */
export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly isOperational: boolean;

  constructor(
    message: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Base class for validation-related errors (400 status)
 */
export abstract class ValidationError extends AppError {
  public readonly statusCode = 400;
  public readonly isOperational = true;
}

/**
 * Base class for authentication-related errors (401 status)
 */
export abstract class AuthenticationError extends AppError {
  public readonly statusCode = 401;
  public readonly isOperational = true;
}

/**
 * Base class for authorization-related errors (403 status)
 */
export abstract class AuthorizationError extends AppError {
  public readonly statusCode = 403;
  public readonly isOperational = true;
}

/**
 * Base class for not found errors (404 status)
 */
export abstract class NotFoundError extends AppError {
  public readonly statusCode = 404;
  public readonly isOperational = true;
}

/**
 * Base class for conflict errors (409 status)
 */
export abstract class ConflictError extends AppError {
  public readonly statusCode = 409;
  public readonly isOperational = true;
}

/**
 * Base class for unprocessable entity errors (422 status)
 */
export abstract class UnprocessableEntityError extends AppError {
  public readonly statusCode = 422;
  public readonly isOperational = true;
}

/**
 * Base class for internal server errors (500 status)
 */
export abstract class InternalError extends AppError {
  public readonly statusCode = 500;
  public readonly isOperational = false;
}

// =============================================================================
// SPECIFIC ERROR CLASSES
// =============================================================================

// Validation Errors (400)
export class InvalidCoordinatesError extends ValidationError {
  constructor(latitude?: number, longitude?: number) {
    const coords = latitude && longitude ? ` (${latitude}, ${longitude})` : '';
    super(
      `Invalid coordinates${coords}. Latitude must be between -90 and 90, longitude between -180 and 180.`
    );
  }
}

export class InvalidBoundsError extends ValidationError {
  constructor(message = 'Invalid bounding box parameters') {
    super(message);
  }
}

export class InvalidFileDataError extends ValidationError {
  constructor(message = 'Invalid file data provided') {
    super(message);
  }
}

export class WeakPasswordError extends ValidationError {
  constructor() {
    super('Password does not meet security requirements');
  }
}

export class InvalidMediaUrlError extends ValidationError {
  constructor(url: string) {
    super(`Invalid media URL: ${url}`);
  }
}

export class InvalidRadiusError extends ValidationError {
  constructor(radius: number, min = 0, max = 1000) {
    super(
      `Search radius must be between ${min} and ${max} kilometers. Provided: ${radius}`
    );
  }
}

export class InvalidFieldLengthError extends ValidationError {
  constructor(fieldName: string, maxLength: number, actualLength: number) {
    super(
      `${fieldName} cannot exceed ${maxLength} characters. Current length: ${actualLength}`
    );
  }
}

export class RequiredFieldError extends ValidationError {
  constructor(fieldName: string) {
    super(`${fieldName} is required`);
  }
}

// Authentication Errors (401)
export class InvalidCredentialsError extends AuthenticationError {
  constructor() {
    super('Invalid credentials provided');
  }
}

export class TokenExpiredError extends AuthenticationError {
  constructor() {
    super('Authentication token has expired');
  }
}

// Authorization Errors (403)
export class InsufficientPermissionsError extends AuthorizationError {
  constructor(requiredRole?: string, userRole?: string) {
    const roleInfo =
      requiredRole && userRole
        ? ` Required: ${requiredRole}, User: ${userRole}`
        : '';
    super(`Insufficient permissions to perform this action.${roleInfo}`);
  }
}

export class CulturalProtocolViolationError extends AuthorizationError {
  constructor(message = 'Access denied due to cultural protocol restrictions') {
    super(message);
  }
}

export class DataSovereigntyViolationError extends AuthorizationError {
  constructor(message = 'Access denied due to data sovereignty restrictions') {
    super(message);
  }
}

export class RestrictedAccessError extends AuthorizationError {
  constructor(resourceType: string) {
    super(`Access to restricted ${resourceType} denied`);
  }
}

// Not Found Errors (404)
export class CommunityNotFoundError extends NotFoundError {
  constructor(identifier?: string | number) {
    const id = identifier ? ` with ID ${identifier}` : '';
    super(`Community${id} not found`);
  }
}

export class UserNotFoundError extends NotFoundError {
  constructor(identifier?: string | number) {
    const id = identifier ? ` with ID ${identifier}` : '';
    super(`User${id} not found`);
  }
}

export class PlaceNotFoundError extends NotFoundError {
  constructor(identifier?: string | number) {
    const id = identifier ? ` with ID ${identifier}` : '';
    super(`Place${id} not found`);
  }
}

export class StoryNotFoundError extends NotFoundError {
  constructor(identifier?: string | number) {
    const id = identifier ? ` with ID ${identifier}` : '';
    super(`Story${id} not found`);
  }
}

export class FileNotFoundError extends NotFoundError {
  constructor(identifier?: string | number) {
    const id = identifier ? ` with ID ${identifier}` : '';
    super(`File${id} not found`);
  }
}

// Conflict Errors (409)
export class DuplicateSlugError extends ConflictError {
  constructor(slug?: string) {
    const slugInfo = slug ? ` '${slug}'` : '';
    super(`Community slug${slugInfo} already exists`);
  }
}

export class DuplicateEmailError extends ConflictError {
  constructor(email?: string) {
    const emailInfo = email ? ` '${email}'` : '';
    super(`Email address${emailInfo} already exists`);
  }
}

export class ResourceInUseError extends ConflictError {
  constructor(resourceType: string, details?: string) {
    const detailsInfo = details ? `: ${details}` : '';
    super(
      `${resourceType} is currently in use and cannot be deleted${detailsInfo}`
    );
  }
}

// Unprocessable Entity Errors (422)
export class CommunityValidationError extends UnprocessableEntityError {
  constructor(message = 'Community validation failed') {
    super(message);
  }
}

export class InvalidCommunityDataError extends UnprocessableEntityError {
  constructor(message = 'Invalid community data provided') {
    super(message);
  }
}

export class InvalidFileAccessError extends UnprocessableEntityError {
  constructor(message = 'Invalid file access configuration') {
    super(message);
  }
}

// Internal Errors (500)
export class DatabaseError extends InternalError {
  constructor(
    message = 'Database operation failed',
    context?: Record<string, unknown>
  ) {
    super(message, context);
  }
}

export class FileSystemError extends InternalError {
  constructor(
    message = 'File system operation failed',
    context?: Record<string, unknown>
  ) {
    super(message, context);
  }
}

export class ExternalServiceError extends InternalError {
  constructor(service: string, message?: string) {
    super(message || `External service '${service}' unavailable`);
  }
}

// =============================================================================
// ERROR MAPPING UTILITIES
// =============================================================================

/**
 * Maps an error to appropriate HTTP status code and response format
 */
export function mapErrorToHttpResponse(error: unknown): {
  statusCode: number;
  body: { error: { message: string }; statusCode?: number };
} {
  // Handle our custom AppErrors
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: { message: error.message },
      },
    };
  }

  // Handle Zod validation errors
  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'ZodError'
  ) {
    return {
      statusCode: 400,
      body: {
        error: { message: 'Validation error' },
      },
    };
  }

  // Handle generic errors
  if (error instanceof Error) {
    return {
      statusCode: 500,
      body: {
        error: { message: 'Internal server error' },
      },
    };
  }

  // Handle unknown errors
  return {
    statusCode: 500,
    body: {
      error: { message: 'Unknown error occurred' },
    },
  };
}

/**
 * Type guard to check if an error is an operational error that should be exposed to clients
 */
export function isOperationalError(error: unknown): error is AppError {
  return error instanceof AppError && error.isOperational;
}

/**
 * Legacy error migration helper - maps old string-based error detection to new error classes
 * This helps during the migration period
 */
export function migrateLegacyError(error: Error): AppError {
  const message = error.message.toLowerCase();

  // Not found errors
  if (message.includes('not found')) {
    if (message.includes('community')) return new CommunityNotFoundError();
    if (message.includes('user')) return new UserNotFoundError();
    if (message.includes('place')) return new PlaceNotFoundError();
    if (message.includes('story')) return new StoryNotFoundError();
    if (message.includes('file')) return new FileNotFoundError();
    // Return a concrete NotFoundError implementation for generic cases
    return new PlaceNotFoundError('Resource not found');
  }

  // Validation errors
  if (message.includes('coordinate')) return new InvalidCoordinatesError();
  if (message.includes('bounding box') || message.includes('bounds'))
    return new InvalidBoundsError();
  if (message.includes('url')) return new InvalidMediaUrlError('Invalid URL');
  if (message.includes('password')) return new WeakPasswordError();

  // Permission errors
  if (message.includes('permission') || message.includes('insufficient')) {
    return new InsufficientPermissionsError();
  }
  if (message.includes('cultural') || message.includes('protocol')) {
    return new CulturalProtocolViolationError();
  }
  if (message.includes('restricted'))
    return new RestrictedAccessError('resource');

  // Conflict errors
  if (message.includes('already exists') || message.includes('duplicate')) {
    if (message.includes('slug')) return new DuplicateSlugError();
    if (message.includes('email')) return new DuplicateEmailError();
    // Return a concrete ConflictError implementation
    return new DuplicateSlugError('Resource already exists');
  }

  // Default to internal error for unmapped errors
  return new DatabaseError(error.message);
}
