/**
 * Canonical policy constants and storage-key helpers for community export
 * (SPEC-V2 §7 "Community export, withdrawal and erasure", #187; §7 Open item #5).
 *
 * Pure module with zero Node or database imports so Cloudflare Workers,
 * Node.js, and unit/QA tests share identical limits, token rules, and
 * storage-key layouts.
 */

/** Export manifest format version (§7). */
export const COMMUNITY_EXPORT_FORMAT_VERSION = '2.0';

/** Canonical logical schema version recorded inside each export manifest (§7). */
export const COMMUNITY_EXPORT_SCHEMA_VERSION = 'v2-launch-2026-11';

/** Lifetime of single-artifact download tokens and generated export objects (15 minutes). */
export const EXPORT_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Healthy-storage expiry sweep cadence / maximum scheduling grace (1 minute). */
export const EXPORT_EXPIRY_GRACE_MS = 60 * 1000;

/** Entropy of each single-artifact download token in bytes (256 bits). */
export const EXPORT_TOKEN_ENTROPY_BYTES = 32;

/** Wire format of an unguessable export download token (64 lowercase hex chars). */
export const EXPORT_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Stale `'generating'` reservation cutoff: if a Worker isolate or Node process
 * crashes mid-export without finalizing or failing its job, a cleanup sweep
 * reclaims the lock and aborts any orphan multipart upload after 5 minutes.
 */
export const EXPORT_GENERATION_STALE_MS = 5 * 60 * 1000;

/** Sliding window for per-community and per-account export generation rate limits (1 hour). */
export const EXPORT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Maximum export generations initiated per community inside one rate-limit window. */
export const EXPORT_RATE_LIMIT_PER_COMMUNITY = 8;

/** Maximum export generations initiated per administrator account inside one rate-limit window. */
export const EXPORT_RATE_LIMIT_PER_ACCOUNT = 5;

/**
 * Workers Free feasibility limits (§5, §7 Open item #5):
 * exports exceeding these bounds fail closed with a 422 naming the limit and
 * the self-hosted/field-kit profile rather than producing a partial archive or
 * exhausting the 10 ms CPU / 50 subrequest Workers Free invocation envelope.
 */
export const WORKERS_EXPORT_MAX_ROWS = 10_000;
export const WORKERS_EXPORT_MAX_FILES = 30;
export const WORKERS_EXPORT_MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50 MiB
export const WORKERS_EXPORT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Node self-hosted / field-kit archive bound (ZIP32 safe ceiling, 2 GiB). */
export const NODE_EXPORT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Maximum expired export jobs reclaimed per scheduled sweep tick. */
export const EXPORT_SWEEP_BATCH_LIMIT = 20;
/** Smaller per-tick batch for Workers Free scheduled crons (50-subrequest cap). */
export const WORKER_EXPORT_SWEEP_BATCH_LIMIT = 5;

/** Content-free AuditEntry actions emitted across the export lifecycle (§7). */
export const EXPORT_AUDIT_ACTIONS = {
  REQUEST: 'community.export.request',
  GENERATE: 'community.export.generate',
  DOWNLOAD: 'community.export.download',
} as const;

/**
 * Export lifecycle actions excluded from the exported manifest's auditEntries
 * array so taking an export never alters the next export (§7 "Scope").
 */
export const EXPORT_LIFECYCLE_AUDIT_ACTIONS = [
  EXPORT_AUDIT_ACTIONS.REQUEST,
  EXPORT_AUDIT_ACTIONS.GENERATE,
  EXPORT_AUDIT_ACTIONS.DOWNLOAD,
] as const;

/** Namespace constant for PostgreSQL per-community export advisory locks. */
export const EXPORT_PG_ADVISORY_LOCK_NS = 73013;

export interface ExportLimits {
  maxRows: number;
  maxFiles: number;
  maxMediaBytes: number;
  maxArchiveBytes: number;
  maxManifestBytes: number;
}

export interface ExportRateLimits {
  windowMs: number;
  maxPerCommunity: number;
  maxPerAccount: number;
}

export function exportLimitsForProfile(isWorkers: boolean): ExportLimits {
  if (isWorkers) {
    return {
      maxRows: WORKERS_EXPORT_MAX_ROWS,
      maxFiles: WORKERS_EXPORT_MAX_FILES,
      maxMediaBytes: WORKERS_EXPORT_MAX_MEDIA_BYTES,
      maxArchiveBytes: WORKERS_EXPORT_MAX_ARCHIVE_BYTES,
      maxManifestBytes: 8 * 1024 * 1024,
    };
  }
  return {
    maxRows: Number.MAX_SAFE_INTEGER,
    maxFiles: Number.MAX_SAFE_INTEGER,
    maxMediaBytes: NODE_EXPORT_MAX_ARCHIVE_BYTES,
    maxArchiveBytes: NODE_EXPORT_MAX_ARCHIVE_BYTES,
    maxManifestBytes: 64 * 1024 * 1024,
  };
}

/**
 * Community-scoped storage keys for temporary generated export artifacts.
 * Living under `communities/<id>/exports/...` guarantees community erasure
 * deletes any in-flight or uncleaned export artifact alongside media.
 */
export function exportArtifactStorageKeys(
  communityId: number,
  jobId: string
): {
  manifestStorageKey: string;
  zipStorageKey: string;
} {
  return {
    manifestStorageKey: `communities/${communityId}/exports/${jobId}/manifest.json`,
    zipStorageKey: `communities/${communityId}/exports/${jobId}/media.zip`,
  };
}

/** Deterministic ZIP member path for a community File ID. */
export function exportArchivePathForFile(fileId: string): string {
  return `media/${fileId}`;
}
