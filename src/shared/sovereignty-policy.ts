/**
 * Canonical policy constants and out-of-band erasure storage helpers for
 * community sovereignty (SPEC-V2 §6.2, §6.8, §7 "Community export, withdrawal
 * and erasure", #187; route registry §9 & §10).
 *
 * Pure module with zero Node or database imports so Cloudflare Workers,
 * Node.js, and unit/QA tests share identical notice periods, SLA bounds,
 * dispute windows, and out-of-band record rules.
 */

/** Steward notice period before a steward withdrawal/erasure takes effect (7 days, §7). */
export const STEWARD_NOTICE_PERIOD_DAYS = 7;
export const STEWARD_NOTICE_PERIOD_SECONDS =
  STEWARD_NOTICE_PERIOD_DAYS * 24 * 60 * 60;
export const STEWARD_NOTICE_PERIOD_MS = STEWARD_NOTICE_PERIOD_SECONDS * 1000;

/** Maximum live-deletion SLA once an erasure takes effect (24 hours, §7). */
export const ERASURE_LIVE_DELETION_SLA_MS = 24 * 60 * 60 * 1000;

/** Dispute/reconciliation window during which requestingActorId stays visible (30 days, §7). */
export const ERASURE_DISPUTE_WINDOW_DAYS = 30;
export const ERASURE_DISPUTE_WINDOW_MS =
  ERASURE_DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Stale `'executing'` erasure reclaim cutoff: if a Worker isolate or Node
 * process crashes mid-erasure, a subsequent sweep reclaims execution after 5m
 * without waiting for manual intervention.
 */
export const ERASURE_EXECUTION_STALE_MS = 5 * 60 * 1000;

/** Batch limits for scheduled sovereignty sweeps (steward notices + live erasures). */
export const SOVEREIGNTY_SWEEP_BATCH_LIMIT = 20;
export const WORKER_SOVEREIGNTY_SWEEP_BATCH_LIMIT = 5;

/**
 * Per-run R2 subrequest budget reserved for live community erasure during a
 * Workers Free cron tick (below Workers Free 50-subrequest limit). Large
 * communities resume across subsequent runs within the 24h SLA.
 */
export const WORKER_ERASURE_STORAGE_OP_BUDGET = 25;

/** Namespace constant for PostgreSQL per-community sovereignty advisory locks. */
export const SOVEREIGNTY_PG_ADVISORY_LOCK_NS = 73014;

/** Maximum recent historical sovereignty requests projected on GET /v2/community/sovereignty. */
export const SOVEREIGNTY_RECENT_REQUESTS_LIMIT = 20;

export const SOVEREIGNTY_REQUEST_KINDS = ['withdrawal', 'erasure'] as const;
export type SovereigntyRequestKind = (typeof SOVEREIGNTY_REQUEST_KINDS)[number];

export const SOVEREIGNTY_REQUEST_STATES = [
  'requested',
  'notice',
  'cancelled',
  'executing',
  'completed',
] as const;
export type SovereigntyRequestState =
  (typeof SOVEREIGNTY_REQUEST_STATES)[number];

export const SOVEREIGNTY_INITIATOR_ROLES = ['admin', 'steward'] as const;
export type SovereigntyInitiatorRole =
  (typeof SOVEREIGNTY_INITIATOR_ROLES)[number];

export const ARCHIVE_CUSTODY_TYPES = ['community', 'steward'] as const;
export type ArchiveCustodyType = (typeof ARCHIVE_CUSTODY_TYPES)[number];

export const ARCHIVE_CUSTODY_STATUSES = ['held', 'destroyed'] as const;
export type ArchiveCustodyStatus = (typeof ARCHIVE_CUSTODY_STATUSES)[number];

export const ERASURE_RECORD_OUTCOMES = [
  'pending',
  'executing',
  'completed',
  'failed',
] as const;
export type ErasureRecordOutcome = (typeof ERASURE_RECORD_OUTCOMES)[number];

/** Prefix under the out-of-band erasure store / R2 bucket outside tenant prefixes. */
export const ERASURE_RECORD_STORAGE_PREFIX = 'system/erasure-records/';

const ERASURE_RECORD_KEY_PATTERN =
  /^system\/erasure-records\/community-([1-9][0-9]*)\.json$/;

export function erasureRecordStorageKey(communityId: number): string {
  if (!Number.isSafeInteger(communityId) || communityId < 1) {
    throw new Error('communityId must be a positive safe integer');
  }
  return `${ERASURE_RECORD_STORAGE_PREFIX}community-${communityId}.json`;
}

export function isErasureRecordStorageKey(key: string): boolean {
  return ERASURE_RECORD_KEY_PATTERN.test(key);
}

/**
 * Whether `nowMs` is still inside the 30-day dispute/reconciliation window
 * (§7): pending/incomplete records always keep the actor id until 30 days
 * after completion, after which it is dropped to `null`.
 */
export function isWithinErasureDisputeWindow(
  completedAtMs: number | null,
  nowMs: number
): boolean {
  if (completedAtMs === null) return true;
  return nowMs < completedAtMs + ERASURE_DISPUTE_WINDOW_MS;
}

/** Content-free AuditEntry actions for Slice 13b sovereignty & restore hooks. */
export const SOVEREIGNTY_AUDIT_ACTIONS = {
  STEWARD_DESIGNATED: 'community.sovereignty.steward.designated',
  STEWARD_REMOVED: 'community.sovereignty.steward.removed',
  WITHDRAWAL_NOTICE_STARTED: 'community.sovereignty.withdrawal.notice_started',
  WITHDRAWAL_COMPLETED: 'community.sovereignty.withdrawal.completed',
  ERASURE_NOTICE_STARTED: 'community.sovereignty.erasure.notice_started',
  ERASURE_REQUESTED: 'community.sovereignty.erasure.requested',
  ERASURE_COMPLETED: 'community.sovereignty.erasure.completed',
  REQUEST_CANCELLED: 'community.sovereignty.request.cancelled',
  RESTORE_RECONCILE: 'system.restore.erasure_reconcile',
} as const;

export const ERASURE_FINALITY_NOTICE =
  'Community erasure is permanent and irreversible. Live deletion begins immediately, stops all exports, and removes every live row, media object, object version, multipart upload, session, manifest, and community audit entry; all backup copies and any held legacy archive are destroyed within the profile 30-day window.';
