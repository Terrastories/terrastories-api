/**
 * Shared bound for the scheduled maintenance statements. Each of the three
 * jobs — `scrubExpiredAuditNetworkMetadata`, `sweepExpiredSessions` and
 * `sweepAuthThrottle` — runs as exactly one D1 statement capped at this many
 * rows per tick, so an hourly Workers invocation spends a small fixed cost
 * (three statements, three subrequests, at most this many rows each) on
 * maintenance. That cost is charged separately from the orphan sweep's
 * subrequest budget (`WORKER_SWEEP_SUBREQUEST_BUDGET`): the maintenance
 * statements touch no bytes and no R2, so they are neither funded nor paused
 * by the orphan sweep, and `ORPHAN_SWEEP_PAUSED` deliberately does not pause
 * them (it is the storage-restore hold for byte deletion). Rows beyond the
 * cap wait for the next hourly tick.
 */
export const MAINTENANCE_SWEEP_ROW_LIMIT = 500;
