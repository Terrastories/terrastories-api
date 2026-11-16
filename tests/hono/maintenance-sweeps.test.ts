/**
 * Focused tests for the scheduled maintenance sweeps (§6.7 §6.8): the hourly
 * Workers cron and the Node unref'd interval run the 90-day audit IP/UA
 * scrub, the expired-session delete and the spent non-blocking throttle-row
 * delete. Each job is one row-capped statement in its own try/catch: one
 * failing job must not block the others, and the rows beyond the cap wait
 * for the next tick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  MAINTENANCE_SWEEP_FIRST_DELAY_MS,
  MAINTENANCE_SWEEP_INTERVAL_MS,
  runMaintenanceSweeps,
  scheduleMaintenanceSweeps,
} from '../../src/services/maintenance-sweeps.js';
import { HonoAuthRepository } from '../../src/repositories/hono-auth.repository.js';
import { scrubExpiredAuditNetworkMetadata } from '../../src/repositories/audit-entry.repository.js';
import { AUTH_THROTTLE_WINDOW_MS } from '../../src/shared/auth-policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('scheduleMaintenanceSweeps', () => {
  it('names first-delay and interval constants on the hourly cadence', () => {
    expect(MAINTENANCE_SWEEP_FIRST_DELAY_MS).toBe(60 * 60 * 1000);
    expect(MAINTENANCE_SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('schedules the first run once after the named delay and the interval on repeat, unref’d', () => {
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
    const scheduled = scheduleMaintenanceSweeps(run, {
      setTimeoutFn: fakeSetTimeout,
      setIntervalFn: fakeSetInterval,
    });

    // No sweep runs eagerly at scheduling time (i.e. not at startup).
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { ms: MAINTENANCE_SWEEP_FIRST_DELAY_MS, repeat: false },
      { ms: MAINTENANCE_SWEEP_INTERVAL_MS, repeat: true },
    ]);
    expect(scheduled.first).toBe(firstTimer);
    expect(scheduled.interval).toBe(intervalTimer);
    for (const timer of [firstTimer, intervalTimer]) {
      expect(timer.unref).toHaveBeenCalledTimes(1);
    }
  });
});

describe('runMaintenanceSweeps', () => {
  const openDbs: Sqlite.Database[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
  });

  function seed(): { sqlite: Sqlite.Database; nowMs: number } {
    const sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    openDbs.push(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    const nowMs = Date.now();
    sqlite
      .prepare(
        "INSERT INTO communities(id,name,slug,created_at,updated_at) VALUES(1,'Sweep Nation','sweep-nation',?,?)"
      )
      .run(nowMs, nowMs);
    sqlite
      .prepare(
        "INSERT INTO users(id,email,password_hash,first_name,last_name,role,community_id,created_at,updated_at) VALUES(1,'sweep@example.test','anchor-hash','Sweep','User','member',1,?,?)"
      )
      .run(nowMs, nowMs);
    return { sqlite, nowMs };
  }

  function seedAuditRow(
    sqlite: Sqlite.Database,
    action: string,
    createdAtMs: number
  ) {
    sqlite
      .prepare(
        `INSERT INTO audit_entries(community_id,actor_id,action,resource_type,resource_ids,outcome,ip_address,user_agent,created_at)
         VALUES(1,1,?,?, '[]','success',?,?,?)`
      )
      .run(action, 'auth', '203.0.113.9', 'sweep-agent/1.0', createdAtMs);
  }

  function seedSession(
    sqlite: Sqlite.Database,
    id: string,
    idleExpiresAtMs: number,
    absoluteExpiresAtMs: number | null
  ) {
    sqlite
      .prepare(
        `INSERT INTO sessions(id,token_hash,user_id,expires_at,kind,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
         VALUES(?,?,1,?,'standard',?,?,?,?)`
      )
      .run(
        id,
        `hash-${id}`,
        idleExpiresAtMs,
        idleExpiresAtMs - 1000,
        idleExpiresAtMs - 1000,
        idleExpiresAtMs,
        absoluteExpiresAtMs
      );
  }

  function seedThrottle(
    sqlite: Sqlite.Database,
    key: string,
    windowStartedAtMs: number,
    blockedUntilMs: number | null
  ) {
    sqlite
      .prepare(
        "INSERT INTO auth_throttle(key,kind,community_id,failures,window_started_at,blocked_until) VALUES(?,'ip',NULL,3,?,?)"
      )
      .run(key, windowStartedAtMs, blockedUntilMs);
  }

  it('scrubs the past-90-day audit row, removes the expired session and the spent throttle row, keeps live rows', async () => {
    const { sqlite, nowMs } = seed();
    seedAuditRow(sqlite, 'auth.login', nowMs - 100 * DAY_MS);
    seedAuditRow(sqlite, 'auth.logout', nowMs - 10 * DAY_MS);
    seedSession(sqlite, 'sess-idle-expired', nowMs - 1000, nowMs + 30 * DAY_MS);
    seedSession(
      sqlite,
      'sess-absolute-expired',
      nowMs + 5 * DAY_MS,
      nowMs - 1000
    );
    seedSession(sqlite, 'sess-live', nowMs + 5 * DAY_MS, nowMs + 30 * DAY_MS);
    seedThrottle(
      sqlite,
      'throttle-spent',
      nowMs - 2 * AUTH_THROTTLE_WINDOW_MS,
      null
    );
    seedThrottle(
      sqlite,
      'throttle-blocked',
      nowMs - 2 * AUTH_THROTTLE_WINDOW_MS,
      nowMs + 3600_000
    );

    const log = vi.fn();
    const db = drizzle(sqlite);
    await runMaintenanceSweeps(db, { now: () => new Date(nowMs), log });
    expect(log).not.toHaveBeenCalled();

    const audits = sqlite
      .prepare(
        'SELECT action, ip_address, user_agent FROM audit_entries ORDER BY id'
      )
      .all() as Array<{
      action: string;
      ip_address: string | null;
      user_agent: string | null;
    }>;
    expect(audits).toHaveLength(2);
    expect(audits[0]).toEqual({
      action: 'auth.login',
      ip_address: null,
      user_agent: null,
    });
    expect(audits[1]).toEqual({
      action: 'auth.logout',
      ip_address: '203.0.113.9',
      user_agent: 'sweep-agent/1.0',
    });

    const sessionIds = (
      sqlite.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(sessionIds).toEqual(['sess-live']);

    const throttleKeys = (
      sqlite.prepare('SELECT key FROM auth_throttle').all() as Array<{
        key: string;
      }>
    ).map((row) => row.key);
    expect(throttleKeys).toEqual(['throttle-blocked']);
  });

  it('caps each statement at the row limit; rows beyond the cap wait for the next tick', async () => {
    const { sqlite, nowMs } = seed();
    seedAuditRow(sqlite, 'auth.login', nowMs - 100 * DAY_MS);
    seedAuditRow(sqlite, 'auth.revoke', nowMs - 100 * DAY_MS);
    seedSession(sqlite, 'sess-1', nowMs - 1000, null);
    seedSession(sqlite, 'sess-2', nowMs - 1000, null);
    seedThrottle(
      sqlite,
      'throttle-1',
      nowMs - 2 * AUTH_THROTTLE_WINDOW_MS,
      null
    );
    seedThrottle(
      sqlite,
      'throttle-2',
      nowMs - 2 * AUTH_THROTTLE_WINDOW_MS,
      null
    );

    const db = drizzle(sqlite);
    const scrub = await scrubExpiredAuditNetworkMetadata(db, {
      now: new Date(nowMs),
      limit: 1,
    });
    expect(scrub.scrubbedCount).toBe(1);
    const auth = new HonoAuthRepository(db);
    expect(await auth.sweepExpiredSessions(nowMs, 1)).toBe(1);
    expect(await auth.sweepAuthThrottle(nowMs, 1)).toBe(1);

    const remainingAudit = sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM audit_entries WHERE ip_address IS NOT NULL'
      )
      .get() as { n: number };
    expect(remainingAudit.n).toBe(1);
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {
          n: number;
        }
      ).n
    ).toBe(1);
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS n FROM auth_throttle').get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });

  it('isolates a failing job: one broken sweep does not block the other two', async () => {
    const { sqlite, nowMs } = seed();
    seedAuditRow(sqlite, 'auth.login', nowMs - 100 * DAY_MS);
    seedThrottle(
      sqlite,
      'throttle-spent',
      nowMs - 2 * AUTH_THROTTLE_WINDOW_MS,
      null
    );
    // Break only the sessions sweep.
    sqlite.exec('DROP TABLE sessions');

    const log = vi.fn();
    const db = drizzle(sqlite);
    await expect(
      runMaintenanceSweeps(db, { now: () => new Date(nowMs), log })
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith('maintenance: session sweep failed');
    expect(log).toHaveBeenCalledTimes(1);

    const audit = sqlite
      .prepare('SELECT ip_address, user_agent FROM audit_entries')
      .get() as { ip_address: string | null; user_agent: string | null };
    expect(audit.ip_address).toBeNull();
    expect(audit.user_agent).toBeNull();
    const throttle = sqlite
      .prepare('SELECT key FROM auth_throttle')
      .all() as Array<{ key: string }>;
    expect(throttle).toHaveLength(0);
  });
});
