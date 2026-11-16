/**
 * Scheduling for the Node server's restart-safe orphan sweep. The first run
 * is a named delay after boot, not a startup sweep: a process that just
 * restored its storage before the files table finished restoring must not
 * see an empty files table as an invitation to delete bytes.
 */

/** Named delay before the first restart-safe sweep after a Node boot. */
export const ORPHAN_SWEEP_FIRST_DELAY_MS = 60 * 60 * 1000; // 1 h

/** Named interval between restart-safe orphan sweeps on the Node server. */
export const ORPHAN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

export interface ScheduleOrphanSweepOptions {
  firstDelayMs?: number;
  intervalMs?: number;
  /** Test-only seam: the timer factories the delays are wired to. */
  setTimeoutFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
  setIntervalFn?: (callback: () => void, ms: number) => NodeJS.Timeout;
}

export interface ScheduledOrphanSweep {
  /** The one-shot first sweep; fires ORPHAN_SWEEP_FIRST_DELAY_MS after boot. */
  first: NodeJS.Timeout;
  /** The recurring sweep; fires every ORPHAN_SWEEP_INTERVAL_MS. */
  interval: NodeJS.Timeout;
}

/**
 * Wire the first delayed sweep and the recurring interval; both are unref'd
 * so they never hold the Node process open. The injected timer factories are
 * for tests only.
 */
export function scheduleOrphanSweep(
  run: () => void,
  options: ScheduleOrphanSweepOptions = {}
): ScheduledOrphanSweep {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const first = setTimeoutFn(
    run,
    options.firstDelayMs ?? ORPHAN_SWEEP_FIRST_DELAY_MS
  );
  first.unref?.();
  const interval = setIntervalFn(
    run,
    options.intervalMs ?? ORPHAN_SWEEP_INTERVAL_MS
  );
  interval.unref?.();
  return { first, interval };
}
