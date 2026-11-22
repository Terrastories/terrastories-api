/**
 * Content-free audit entry validation and 90-day network metadata scrub helpers
 * (SPEC-V2 §6.8 and §7).
 *
 * Pure module with zero Node-only or database imports so it runs identically
 * on Cloudflare Workers, Node.js, and unit tests.
 */

export const AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_NETWORK_METADATA_MAX_RETENTION_MS =
  AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS * DAY_MS;

const ALLOWED_AUDIT_INPUT_KEYS = new Set([
  'communityId',
  'actorId',
  'action',
  'resourceType',
  'resourceIds',
  'outcome',
  'ipAddress',
  'userAgent',
]);

// Auth and system resource types are the only entries permitted to omit
// communityId (§6.8); every community-content entry must bind a community.
const NULL_COMMUNITY_RESOURCE_TYPES = new Set([
  'auth',
  'authentication',
  'session',
  'sessions',
  'login_code',
  'login_codes',
  'recovery_code',
  'recovery_codes',
  'auth_throttle',
  'security',
  'system',
  'bootstrap',
  'super_admin',
  'community_erasure',
]);

const NULL_COMMUNITY_ACTION_PREFIX = /^(?:auth|security|system|bootstrap)\./;

// Content-bearing resource types must never attach IP/User-Agent metadata (§6.8).
const CONTENT_RESOURCE_TYPES = new Set([
  'story',
  'stories',
  'place',
  'places',
  'speaker',
  'speakers',
  'theme',
  'themes',
  'file',
  'files',
  'media',
  'attachment',
  'attachments',
  'map_config',
  'import_manifest',
  'import_manifests',
  'community_export',
  'community_exports',
]);

const ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const OPAQUE_RESOURCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const CONTROL_OR_NEWLINE_PATTERN = /[\r\n\0]/;

export class AuditEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditEntryValidationError';
  }
}

export interface ContentFreeAuditEntryInput {
  communityId?: number | null;
  actorId?: number | null;
  action: string;
  resourceType?: string | null;
  resourceIds?: Array<number | string>;
  outcome: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ValidatedAuditEntryRecord {
  communityId: number | null;
  actorId: number | null;
  action: string;
  resourceType: string | null;
  resourceIds: Array<number | string>;
  outcome: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function assertOptionalPositiveInt(
  value: unknown,
  field: string
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new AuditEntryValidationError(
      `Audit entry ${field} must be a positive integer or null`
    );
  }
  return value;
}

function validateResourceIds(raw: unknown): Array<number | string> {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new AuditEntryValidationError(
      'Audit entry resourceIds must be an array'
    );
  }
  return raw.map((item) => {
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || item < 0) {
        throw new AuditEntryValidationError(
          'Audit entry numeric resourceId must be a non-negative integer'
        );
      }
      return item;
    }
    if (typeof item === 'string' && OPAQUE_RESOURCE_ID_PATTERN.test(item)) {
      return item;
    }
    throw new AuditEntryValidationError(
      'Audit entry string resourceId must be an opaque identifier without whitespace or content'
    );
  });
}

function assertOptionalNetworkField(
  value: unknown,
  field: 'ipAddress' | 'userAgent',
  maxLength: number,
  disallowWhitespace: boolean
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AuditEntryValidationError(
      `Audit entry ${field} must be a string or null`
    );
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new AuditEntryValidationError(
      `Audit entry ${field} exceeds allowed length or is blank`
    );
  }
  if (
    CONTROL_OR_NEWLINE_PATTERN.test(trimmed) ||
    (disallowWhitespace && /\s/.test(trimmed))
  ) {
    throw new AuditEntryValidationError(
      `Audit entry ${field} contains disallowed characters`
    );
  }
  return trimmed;
}

/**
 * Validate and normalize a content-free audit entry input fail-closed.
 * Rejects any unexpected field (such as title, description, name, email,
 * details, metadata, tokens, or URLs) as well as free-text payloads.
 */
export function validateContentFreeAuditEntry(
  input: unknown
): ValidatedAuditEntryRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AuditEntryValidationError('Audit entry input must be an object');
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_AUDIT_INPUT_KEYS.has(key)) {
      throw new AuditEntryValidationError(
        `Audit entry field "${key}" is forbidden by the content-free schema`
      );
    }
  }

  if (
    typeof record.action !== 'string' ||
    !ACTION_PATTERN.test(record.action)
  ) {
    throw new AuditEntryValidationError(
      'Audit entry action must be a lowercase identifier token'
    );
  }
  if (
    typeof record.outcome !== 'string' ||
    !TOKEN_PATTERN.test(record.outcome)
  ) {
    throw new AuditEntryValidationError(
      'Audit entry outcome must be a lowercase identifier token'
    );
  }

  let resourceType: string | null = null;
  if (record.resourceType !== undefined && record.resourceType !== null) {
    if (
      typeof record.resourceType !== 'string' ||
      !TOKEN_PATTERN.test(record.resourceType)
    ) {
      throw new AuditEntryValidationError(
        'Audit entry resourceType must be a lowercase identifier token or null'
      );
    }
    resourceType = record.resourceType;
  }

  const ipAddress = assertOptionalNetworkField(
    record.ipAddress,
    'ipAddress',
    64,
    true
  );
  const userAgent = assertOptionalNetworkField(
    record.userAgent,
    'userAgent',
    512,
    false
  );

  if (
    resourceType !== null &&
    CONTENT_RESOURCE_TYPES.has(resourceType) &&
    (ipAddress !== null || userAgent !== null)
  ) {
    throw new AuditEntryValidationError(
      'Network metadata (ipAddress/userAgent) is restricted to authentication and security events'
    );
  }

  const communityId = assertOptionalPositiveInt(
    record.communityId,
    'communityId'
  );
  if (communityId === null) {
    if (resourceType !== null) {
      if (!NULL_COMMUNITY_RESOURCE_TYPES.has(resourceType)) {
        throw new AuditEntryValidationError(
          `Audit entry resourceType "${resourceType}" requires a non-null communityId`
        );
      }
    } else if (!NULL_COMMUNITY_ACTION_PREFIX.test(record.action)) {
      throw new AuditEntryValidationError(
        'Audit entry without communityId must target an auth or system resource/action'
      );
    }
  }

  return {
    communityId,
    actorId: assertOptionalPositiveInt(record.actorId, 'actorId'),
    action: record.action,
    resourceType,
    resourceIds: validateResourceIds(record.resourceIds),
    outcome: record.outcome,
    ipAddress,
    userAgent,
  };
}

/**
 * Compute the UTC cutoff timestamp for scrubbing IP address and User-Agent
 * from audit entries (at most 90 days retention, configurably less).
 */
export function auditNetworkMetadataCutoff(
  referenceTime: Date = new Date(),
  retentionDays: number = AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS
): Date {
  if (
    !(referenceTime instanceof Date) ||
    Number.isNaN(referenceTime.getTime())
  ) {
    throw new AuditEntryValidationError('referenceTime must be a valid Date');
  }
  if (
    typeof retentionDays !== 'number' ||
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0 ||
    retentionDays > AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS
  ) {
    throw new AuditEntryValidationError(
      `retentionDays must be between 0 (exclusive) and ${AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS}`
    );
  }
  return new Date(referenceTime.getTime() - retentionDays * DAY_MS);
}

/**
 * Pure scrub helper for an in-memory audit entry record. Nullifies ipAddress
 * and userAgent when createdAt <= cutoff without modifying any other field.
 */
export function scrubAuditNetworkMetadataRecord<
  T extends {
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date | number | string;
  },
>(
  entry: T,
  cutoff: Date
): {
  entry: Omit<T, 'ipAddress' | 'userAgent'> & {
    ipAddress: string | null;
    userAgent: string | null;
  };
  scrubbed: boolean;
} {
  const createdAtDate =
    entry.createdAt instanceof Date
      ? entry.createdAt
      : new Date(entry.createdAt);
  if (Number.isNaN(createdAtDate.getTime())) {
    throw new AuditEntryValidationError('Audit entry has invalid createdAt');
  }

  const hasNetworkMetadata =
    (entry.ipAddress ?? null) !== null || (entry.userAgent ?? null) !== null;
  const expired = createdAtDate.getTime() <= cutoff.getTime();

  if (expired && hasNetworkMetadata) {
    return {
      entry: {
        ...entry,
        ipAddress: null,
        userAgent: null,
      },
      scrubbed: true,
    };
  }

  return {
    entry: {
      ...entry,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    },
    scrubbed: false,
  };
}
