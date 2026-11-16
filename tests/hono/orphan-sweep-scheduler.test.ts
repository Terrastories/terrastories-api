/**
 * Focused tests for the Node server's orphan-sweep scheduling: the first run
 * is a named delay after boot, never a startup sweep.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ORPHAN_SWEEP_FIRST_DELAY_MS,
  ORPHAN_SWEEP_INTERVAL_MS,
  scheduleOrphanSweep,
} from '../../src/services/orphan-sweep-scheduler.js';

describe('scheduleOrphanSweep', () => {
  it('names a first-sweep delay that is a real delay (not at startup)', () => {
    expect(ORPHAN_SWEEP_FIRST_DELAY_MS).toBeGreaterThan(0);
    expect(ORPHAN_SWEEP_FIRST_DELAY_MS).toBe(60 * 60 * 1000);
    expect(ORPHAN_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('schedules the first run once after the named delay and the interval on repeat', () => {
    const calls: Array<{ ms: number; repeat: boolean }> = [];
    const firstTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const intervalTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const fakeSetTimeout = (cb: () => void, ms: number) => {
      void cb;
      calls.push({ ms, repeat: false });
      return firstTimer;
    };
    const fakeSetInterval = (cb: () => void, ms: number) => {
      void cb;
      calls.push({ ms, repeat: true });
      return intervalTimer;
    };

    const run = vi.fn();
    const scheduled = scheduleOrphanSweep(run, {
      setTimeoutFn: fakeSetTimeout,
      setIntervalFn: fakeSetInterval,
    });

    // No sweep runs eagerly at scheduling time (i.e. not at startup).
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { ms: ORPHAN_SWEEP_FIRST_DELAY_MS, repeat: false },
      { ms: ORPHAN_SWEEP_INTERVAL_MS, repeat: true },
    ]);
    expect(scheduled.first).toBe(firstTimer);
    expect(scheduled.interval).toBe(intervalTimer);
    for (const timer of [firstTimer, intervalTimer]) {
      expect(timer.unref).toHaveBeenCalledTimes(1);
    }
  });

  it('honours injected delays so operators can tune them', () => {
    const firstTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const intervalTimer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const delays: number[] = [];
    const scheduled = scheduleOrphanSweep(() => {}, {
      firstDelayMs: 5,
      intervalMs: 7,
      setTimeoutFn: (cb, ms) => {
        void cb;
        delays.push(ms);
        return firstTimer;
      },
      setIntervalFn: (cb, ms) => {
        void cb;
        delays.push(ms);
        return intervalTimer;
      },
    });
    expect(delays).toEqual([5, 7]);
    expect(scheduled.first).toBe(firstTimer);
    expect(scheduled.interval).toBe(intervalTimer);
  });
});
