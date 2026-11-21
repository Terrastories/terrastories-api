/**
 * Scheduled maintenance sweeps for the hourly Workers cron and the Node
 * unref'd interval (§6.7 §6.8): scrub expired audit network metadata, delete
 * expired session rows and delete spent, non-blocking throttle rows. Each of
 * the three jobs runs as exactly one row-capped D1 statement
 * (`MAINTENANCE_SWEEP_ROW_LIMIT`) in its own try/catch, so one failing job
 * never blocks the other two, the orphan sweep or the response path. These
 * jobs touch no bytes — only audit/session/throttle rows — so
 * `ORPHAN_SWEEP_PAUSED` (the storage-restore hold for byte deletion)
 * deliberately does not pause them.
 */
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { scrubExpiredAuditNetworkMetadata } from '../repositories/audit-entry.repository.js';
import { HonoAuthRepository } from '../repositories/hono-auth.repository.js';
import { CommunitySovereigntyRepository } from '../repositories/community-sovereignty.repository.js';
import { CommunityExportRepository } from '../repositories/community-export.repository.js';
import { CommunityExportService } from './community-export.service.js';
import type { FoundationStorage } from './hono-foundation.service.js';

/** Named delay before the first maintenance sweep after a Node boot. */
// Offset from the interval so the one-shot and the first interval tick never
// fire together and double one hour's row cap.
export const MAINTENANCE_SWEEP_FIRST_DELAY_MS = 30 * 60 * 1000; // 30 min

/** Named interval between maintenance sweeps on the Node server. */
export const MAINTENANCE_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 h

export interface RunMaintenanceSweepsOptions {
  /** Clock seam; defaults to the wall clock. */
  now?: () => Date;
  /** Content-free operator log sink; defaults to console.warn. */
  log?: (message: string) => void;
  /** Storage adapter for per-object expired export artifact cleanup (§7). */
  storage?: FoundationStorage;
  /** Optional batch limit for expired export cleanup. */
  exportSweepLimit?: number;
  /** Workers uses its dedicated minute tick to preserve the hourly R2 budget. */
  sovereigntyNotices?: boolean;
}

/**
 * Run the three maintenance sweeps. Each job's failure is logged
 * content-free (the job name only — never identifiers, keys or content) and
 * never rethrown: a failing sweep must not break the scheduled invocation.
 */
export async function runMaintenanceSweeps(
  database: Database | DrizzleD1Database,
  options: RunMaintenanceSweepsOptions = {}
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const log =
    options.log ??
    ((message: string) => {
      // eslint-disable-next-line no-console -- operator channel; content-free
      console.warn(message);
    });
  const auth = new HonoAuthRepository(database);
  const nowDate = now();
  const nowMs = nowDate.getTime();

  if (options.sovereigntyNotices !== false) {
    try {
      await new CommunitySovereigntyRepository(database).applyDueWithdrawals(
        nowDate
      );
    } catch {
      log('maintenance: sovereignty notice sweep failed');
    }
  }
  try {
    await scrubExpiredAuditNetworkMetadata(database, { now: nowDate });
  } catch {
    log('maintenance: audit metadata sweep failed');
  }
  try {
    await auth.sweepExpiredSessions(nowMs);
  } catch {
    log('maintenance: session sweep failed');
  }
  try {
    await auth.sweepAuthThrottle(nowMs);
  } catch {
    log('maintenance: auth throttle sweep failed');
  }
  if (options.storage) {
    try {
      const exportService = new CommunityExportService(
        new CommunityExportRepository(database),
        options.storage,
        { now: () => nowDate }
      );
      await exportService.cleanupExpiredExports({
        limit: options.exportSweepLimit,
      });
    } catch {
      log('maintenance: expired export sweep failed');
    }
  }
}

export interface ScheduleMaintenanceSweepsOptions {
  firstDelayMs?: number;
  intervalMs?: number;
  /** Test-only seam: the timer factories the delays are wired to. */
  setTimeoutFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
}

export interface ScheduledMaintenanceSweeps {
  /** The one-shot first sweep; fires MAINTENANCE_SWEEP_FIRST_DELAY_MS after boot. */
  first: NodeJS.Timeout;
  /** The recurring sweep; fires every MAINTENANCE_SWEEP_INTERVAL_MS. */
  interval: NodeJS.Timeout;
}

/**
 * Wire the first delayed sweep and the recurring interval; both are unref'd
 * so they never hold the Node process open. The injected timer factories are
 * for tests only.
 */
export function scheduleMaintenanceSweeps(
  run: () => void,
  options: ScheduleMaintenanceSweepsOptions = {}
): ScheduledMaintenanceSweeps {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const first = setTimeoutFn(
    run,
    options.firstDelayMs ?? MAINTENANCE_SWEEP_FIRST_DELAY_MS
  );
  first.unref?.();
  const interval = setIntervalFn(
    run,
    options.intervalMs ?? MAINTENANCE_SWEEP_INTERVAL_MS
  );
  interval.unref?.();
  return { first, interval };
}
