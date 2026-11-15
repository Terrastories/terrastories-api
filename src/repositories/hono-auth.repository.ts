/**
 * Authentication data access for the Slice 10 client-stretching protocol
 * (SPEC-V2 §6.2, §6.8, §7 "Passwords" / "Sessions").
 *
 * The class is separate from `HonoFoundationRepository` (which keeps the
 * foundation session/identity gate used by every Slice 3 route) so the
 * credential-verification surface — verifier rows, `AuthThrottle`, prelogin
 * fakes, audit rows — lives in one reviewable place. It is transport-agnostic:
 * SQLite/D1, PostgreSQL and the Workers D1 batch share the same methods.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import type {
  FoundationUser,
  HonoFoundationRepository,
} from './hono-foundation.repository.js';
import {
  AUTH_THROTTLE_BACKOFF_MAX_MS,
  AUTH_THROTTLE_KEY_ACCOUNT,
  AUTH_THROTTLE_KEY_IP,
  AUTH_THROTTLE_MAX_FAILURES,
  AUTH_THROTTLE_WINDOW_MS,
  ARGON2ID_ALGORITHM,
  authThrottleBackoffMs,
  sessionLifetimesFor,
  type PasswordAlgorithm,
  type SessionKind,
} from '../shared/auth-policy.js';
import { sha256Hex } from '../shared/auth-crypto.js';

/** The account columns login, upgrade and password change need. */
export interface AuthAccount {
  id: number;
  communityId: number | null;
  role: string;
  isActive: boolean;
  communityIsActive: boolean | null;
  email: string;
  username: string | null;
  displayName: string | null;
  passwordHash: string;
  passwordVerifier: string | null;
  passwordAlgorithm: string | null;
  passwordSalt: string | null;
  passwordParams: string | null;
}

interface RawAuthAccount {
  id: number;
  communityId: number | null;
  role: string;
  isActive: number | boolean;
  communityIsActive: number | boolean | null;
  email: string;
  username: string | null;
  displayName: string | null;
  passwordHash: string;
  passwordVerifier: string | null;
  passwordAlgorithm: string | null;
  passwordSalt: string | null;
  passwordParams: string | null;
}

/** A failed-login counter update: at most two rows (SPEC-V2 §6.8). */
export interface ThrottleIncrement {
  account: { id: number; communityId: number | null } | null;
  clientIp: string;
  now: number;
}

export interface ThrottleState {
  blocked: boolean;
  failures: number;
  blockedUntil: number | null;
}

export interface VerifierWrite {
  passwordHash: string;
  passwordVerifier: string;
  passwordAlgorithm: PasswordAlgorithm;
  passwordSalt: string;
  passwordParams: string;
}

const toFlag = (value: number | boolean | null): boolean | null =>
  value === null ? null : value === true || value === 1;

/** Sum a per-algorithm `count(*)` grouping into the prelogin mix (§7 step 1). */
function mixOf(
  rows: ReadonlyArray<{ algorithm: string | null; total: number | string }>
): { upgraded: number; total: number } {
  let upgraded = 0;
  let total = 0;
  for (const row of rows) {
    const count = Number(row.total);
    total += count;
    if (row.algorithm === ARGON2ID_ALGORITHM) upgraded += count;
  }
  return { upgraded, total };
}

const AUTH_COLUMNS = (tables: ReturnType<typeof tablesFor>) => ({
  id: tables.users.id,
  communityId: tables.users.communityId,
  role: tables.users.role,
  isActive: tables.users.isActive,
  communityIsActive: tables.communities.isActive,
  email: tables.users.email,
  username: tables.users.username,
  displayName: tables.users.displayName,
  passwordHash: tables.users.passwordHash,
  passwordVerifier: tables.users.passwordVerifier,
  passwordAlgorithm: tables.users.passwordAlgorithm,
  passwordSalt: tables.users.passwordSalt,
  passwordParams: tables.users.passwordParams,
});

/**
 * Portable `CASE` ladder for the blocked-until backoff. SQLite has neither
 * `<<` nor `least()`, so the doubling is spelled out as a `CASE` built from the
 * one policy function that also serves `throttleState`, keeping the SQL and the
 * in-memory value identical by construction.
 */
function backoffLadderSql(
  nextFailures: ReturnType<typeof sql>
): ReturnType<typeof sql> {
  const branches = [
    sql`when ${nextFailures} < ${AUTH_THROTTLE_MAX_FAILURES} then 0`,
    ...Array.from(
      { length: 7 },
      (_, index) =>
        sql`when ${nextFailures} = ${AUTH_THROTTLE_MAX_FAILURES + index} then ${authThrottleBackoffMs(AUTH_THROTTLE_MAX_FAILURES + index)}`
    ),
    sql`else ${AUTH_THROTTLE_BACKOFF_MAX_MS}`,
  ];
  return sql`case ${sql.join(branches, sql` `)} end`;
}

export class HonoAuthRepository {
  // Drizzle PG / better-sqlite3 / D1 share runtime methods with union-incompatible TS overloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly tables;

  constructor(readonly connection: Database | DrizzleD1Database) {
    this.db = connection;
    this.tables = tablesFor(connection);
  }

  /**
   * Resolve login accounts for an identifier (+ optional community locator).
   *
   * Resolution is never first-match (SPEC-V2 §6.2): the caller receives up to
   * two matching rows and decides. `identifier` matches `email` case-sensitively
   * on the raw column and on `emailNormalized`, or `usernameNormalized`; a
   * username match and an email match in the same request are both returned so
   * an account whose username equals another account's email stays ambiguous.
   */
  async loginCandidates(
    identifier: string,
    normalizedIdentifier: string,
    communityId?: number
  ): Promise<AuthAccount[]> {
    const { users, communities } = this.tables;
    const rows: RawAuthAccount[] = await this.db
      .select(AUTH_COLUMNS(this.tables))
      .from(users)
      .leftJoin(communities, eq(users.communityId, communities.id))
      .where(
        and(
          or(
            eq(users.email, identifier),
            eq(users.emailNormalized, normalizedIdentifier),
            eq(users.usernameNormalized, normalizedIdentifier)
          ),
          communityId === undefined
            ? undefined
            : eq(users.communityId, communityId)
        )
      )
      .limit(2);
    return rows.map((row) => ({
      ...row,
      isActive: toFlag(row.isActive) === true,
      communityIsActive: toFlag(row.communityIsActive),
    }));
  }

  /**
   * The verifier row of an account that passed the authority gate, re-read at
   * write time. `null` means the account's authority changed (or it vanished)
   * between candidate resolution and verification, so the login must fail.
   */
  async verifiedAccount(
    account: Pick<AuthAccount, 'id' | 'passwordHash'>
  ): Promise<AuthAccount | null> {
    const { users, communities } = this.tables;
    const rows: RawAuthAccount[] = await this.db
      .select(AUTH_COLUMNS(this.tables))
      .from(users)
      .leftJoin(communities, eq(users.communityId, communities.id))
      .where(
        and(
          eq(users.id, account.id),
          eq(users.passwordHash, account.passwordHash)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      isActive: toFlag(row.isActive) === true,
      communityIsActive: toFlag(row.communityIsActive),
    };
  }

  /** One community slug → id lookup for the login/prelogin locator. */
  async communityIdBySlug(slug: string): Promise<number | null> {
    const { communities } = this.tables;
    const rows = await this.db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.slug, slug))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Prelogin verifier shape of one account (SPEC-V2 §7 step 1): the stored
   * algorithm, salt and params of a real account, or `null` when no single
   * account resolves (unknown identifier, ambiguous email without a locator).
   */
  async preloginAccount(
    normalizedIdentifier: string,
    communityId?: number
  ): Promise<{
    passwordAlgorithm: string;
    passwordSalt: string;
    passwordParams: string;
  } | null> {
    const { users } = this.tables;
    const rows = await this.db
      .select({
        passwordAlgorithm: users.passwordAlgorithm,
        passwordSalt: users.passwordSalt,
        passwordParams: users.passwordParams,
      })
      .from(users)
      .where(
        and(
          or(
            eq(users.emailNormalized, normalizedIdentifier),
            eq(users.usernameNormalized, normalizedIdentifier)
          ),
          communityId === undefined
            ? undefined
            : eq(users.communityId, communityId)
        )
      )
      .limit(2);
    const row = rows.length === 1 ? rows[0] : null;
    if (!row) return null;
    // A row with no verifier (code-only account) must not present a shape the
    // client cannot use: the fake path answers instead (§7 step 1).
    if (row.passwordAlgorithm === null || row.passwordSalt === null)
      return null;
    return {
      passwordAlgorithm: row.passwordAlgorithm,
      passwordSalt: row.passwordSalt,
      passwordParams: row.passwordParams ?? '',
    };
  }

  /**
   * Migrated-vs-upgraded mix of a community's accounts, for prelogin fakes
   * (SPEC-V2 §7 step 1: fakes mimic the mix so the response does not reveal
   * whether an account exists or was migrated). A community with no accounts
   * yet reports the new-password mix.
   */
  async communityAlgorithmMix(
    communityId: number
  ): Promise<{ upgraded: number; total: number }> {
    const { users } = this.tables;
    const rows = await this.db
      .select({
        algorithm: users.passwordAlgorithm,
        total: sql<number>`count(*)`,
      })
      .from(users)
      .where(eq(users.communityId, communityId))
      .groupBy(users.passwordAlgorithm);
    return mixOf(rows);
  }

  /**
   * The same mix for the whole deployment, used when prelogin has no
   * resolvable community (no slug sent, or a slug that names no community):
   * the fake must still mirror the population it is hiding in.
   */
  async globalAlgorithmMix(): Promise<{ upgraded: number; total: number }> {
    const { users } = this.tables;
    const rows = await this.db
      .select({
        algorithm: users.passwordAlgorithm,
        total: sql<number>`count(*)`,
      })
      .from(users)
      .groupBy(users.passwordAlgorithm);
    return mixOf(rows);
  }

  /**
   * Atomic verifier write (upgrade / password change), authority-guarded by
   * the re-read `password_hash`: a rejected request leaves the row byte-
   * identical and a concurrent reset wins the race. The
   * `users_revoke_sessions` trigger revokes the account's other sessions as a
   * consequence of the change (§6.8), so no extra delete is issued here.
   */
  async writeVerifierAtomically(
    account: Pick<AuthAccount, 'id' | 'passwordHash'>,
    verifier: VerifierWrite
  ): Promise<boolean> {
    const { users } = this.tables;
    const updated = await this.db
      .update(users)
      .set({
        passwordHash: verifier.passwordHash,
        passwordVerifier: verifier.passwordVerifier,
        passwordAlgorithm: verifier.passwordAlgorithm,
        passwordSalt: verifier.passwordSalt,
        passwordParams: verifier.passwordParams,
      })
      .where(
        and(
          eq(users.id, account.id),
          eq(users.passwordHash, account.passwordHash)
        )
      )
      .returning({ id: users.id });
    return updated.length > 0;
  }

  /**
   * Complete a verified login: when the caller passes a `verifier`, store it
   * first — the wrapped Rails-bcrypt upgrade saves verifier, salt, params and
   * algorithm in one atomic write (SPEC-V2 §7 step 4). A plain Argon2id login
   * passes `verifier: null` and writes nothing: the session write below is
   * itself authority-gated (the INSERT…SELECT re-reads the account), so a
   * no-op verifier re-write would only spend a D1 row write and risk
   * flipping a NULL salt to `''`.
   *
   * The verifier write is authority-guarded by the re-read `password_hash`,
   * so a concurrent reset makes it return `false` and no session is created.
   * On success the `users_revoke_sessions` trigger has already revoked the
   * account's other sessions, exactly as for a password change (§6.8).
   *
   * `previousToken`, when presented and well-formed, rotates the presented
   * same-user session row in place; a presented cookie belonging to another
   * user is revoked and this login gets a fresh row (#188).
   */
  async establishLogin(input: {
    repository: HonoFoundationRepository;
    account: AuthAccount;
    user: FoundationUser;
    verifier: VerifierWrite | null;
    kind: SessionKind;
    now: Date;
    previousToken?: string | undefined;
  }): Promise<{ token: string } | null> {
    const { repository, account, user, verifier, kind, now } = input;
    if (verifier !== null)
      if (!(await this.writeVerifierAtomically(account, verifier))) return null;
    const token = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const lifetimes = sessionLifetimesFor(kind, now.getTime());
    const previousHash =
      input.previousToken === undefined
        ? undefined
        : await sha256Hex(input.previousToken);
    const created = await repository.createSession({
      tokenHash: await sha256Hex(token),
      user,
      kind,
      createdAt: now,
      idleExpiresAt: new Date(lifetimes.idleExpiresAt),
      absoluteExpiresAt: new Date(lifetimes.absoluteExpiresAt),
      previousHash,
    });
    return created ? { token } : null;
  }

  // -------------------------------------------------------------------------
  // AuthThrottle (§6.8)
  // -------------------------------------------------------------------------

  /** Keyed hash (HMAC-SHA256) of a kind-prefixed input, hex-encoded. */
  async throttleKey(input: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(input)
    );
    return Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  accountThrottleKey(accountId: number, secret: string): Promise<string> {
    return this.throttleKey(`${AUTH_THROTTLE_KEY_ACCOUNT}${accountId}`, secret);
  }

  /** Per-IP throttle key (keyed hash of the client IP alone, §6.8). */
  ipThrottleKey(clientIp: string, secret: string): Promise<string> {
    return this.throttleKey(`${AUTH_THROTTLE_KEY_IP}${clientIp}`, secret);
  }

  /**
   * One `INSERT … ON CONFLICT DO UPDATE` counter statement. Both backends
   * evaluate the same expressions; the D1 batch bounds the failed login to a
   * single round trip (§7 step 6).
   */
  private incrementStatement(
    executor: typeof this.db,
    throttleKey: string,
    kind: 'account' | 'ip',
    communityId: number | null,
    now: number
  ) {
    const throttle = this.tables.authThrottle;
    const windowExpired = sql`${throttle.windowStartedAt} <= ${now - AUTH_THROTTLE_WINDOW_MS}`;
    // The successor of the failure count after this write, computed once so the
    // blocked_until branch cannot drift from the counter branch.
    const nextFailures = sql`(case when ${windowExpired} then 1 else ${throttle.failures} + 1 end)`;
    const blockedUntil = sql`(case when ${nextFailures} >= ${AUTH_THROTTLE_MAX_FAILURES} then ${now} + ${backoffLadderSql(nextFailures)} else null end)`;
    return executor
      .insert(throttle)
      .values({
        key: throttleKey,
        kind,
        communityId,
        failures: 1,
        windowStartedAt: now,
        blockedUntil: null,
      })
      .onConflictDoUpdate({
        target: throttle.key,
        set: {
          failures: nextFailures,
          windowStartedAt: sql`case when ${windowExpired} then ${now} else ${throttle.windowStartedAt} end`,
          blockedUntil,
        },
      });
  }

  /**
   * Record one failed login: the per-account counter (when the identifier and
   * locator resolved to exactly one account) and the per-IP counter in one
   * database round trip — one D1 batch, at most two rows written, exactly one
   * row when unresolved (SPEC-V2 §6.8, §7 step 6).
   */
  async recordLoginFailure(
    input: ThrottleIncrement,
    secret: string
  ): Promise<void> {
    const ipKey = await this.ipThrottleKey(input.clientIp, secret);
    const accountKey = input.account
      ? await this.accountThrottleKey(input.account.id, secret)
      : null;
    // Statements are built per executor so a transactional executor runs them
    // inside its own transaction, never on the outer connection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statementsFor = (executor: any) => {
      const statements = [];
      if (input.account && accountKey !== null) {
        statements.push(
          this.incrementStatement(
            executor,
            accountKey,
            'account',
            input.account.communityId,
            input.now
          )
        );
      }
      statements.push(
        this.incrementStatement(executor, ipKey, 'ip', null, input.now)
      );
      return statements;
    };
    const db = this.db;
    if (typeof db.batch === 'function') {
      await db.batch(statementsFor(db));
      return;
    }
    if (dialectOf(this.connection) === 'postgresql') {
      await db.transaction(async (tx: typeof db) => {
        for (const statement of statementsFor(tx)) await statement;
      });
      return;
    }
    // better-sqlite3 (drizzle "sync" mode) exposes only synchronous
    // transactions; the callback runs inline, nothing to await or call.
    db.transaction((tx: typeof db) => {
      for (const statement of statementsFor(tx)) statement.run();
    });
  }

  /** Current throttle state of one account or IP key. */
  async throttleState(
    throttleKey: string,
    now: number
  ): Promise<ThrottleState> {
    const throttle = this.tables.authThrottle;
    const rows = await this.db
      .select({
        failures: throttle.failures,
        blockedUntil: throttle.blockedUntil,
      })
      .from(throttle)
      .where(eq(throttle.key, throttleKey))
      .limit(1);
    const row = rows[0];
    const blockedUntil = row?.blockedUntil ?? null;
    return {
      blocked: blockedUntil !== null && blockedUntil > now,
      failures: row?.failures ?? 0,
      blockedUntil,
    };
  }

  /** Clear an account's and IP's counters on a successful login (§6.8). */
  async resetThrottle(
    accountId: number | null,
    clientIp: string,
    secret: string
  ): Promise<void> {
    const throttle = this.tables.authThrottle;
    const keys = [await this.ipThrottleKey(clientIp, secret)];
    if (accountId !== null)
      keys.push(await this.accountThrottleKey(accountId, secret));
    await this.db.delete(throttle).where(inArray(throttle.key, keys));
  }

  /**
   * Content-free audit row (SPEC-V2 §6.8, §7 "Audit logging"). Every caller
   * passes an already `validateContentFreeAuditEntry`-checked record.
   */
  async writeAudit(
    input: {
      communityId: number | null;
      actorId: number | null;
      action: string;
      outcome: string;
      resourceType: string | null;
      resourceIds: Array<number | string>;
      ipAddress: string | null;
      userAgent: string | null;
      now: Date;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any = this.db
  ): Promise<void> {
    const { auditEntries } = this.tables;
    await executor.insert(auditEntries).values({
      communityId: input.communityId,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceIds: input.resourceIds,
      outcome: input.outcome,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      createdAt: input.now,
    });
  }

  /** Delete expired session rows (scheduled sweep, §7 "Sessions"). */
  async sweepExpiredSessions(now: number): Promise<number> {
    const sessions = this.tables.sessions;
    const deleted = await this.db
      .delete(sessions)
      .where(
        or(
          sql`coalesce(${sessions.idleExpiresAt}, ${sessions.expiresAt}) <= ${now}`,
          and(
            sql`${sessions.absoluteExpiresAt} IS NOT NULL`,
            sql`${sessions.absoluteExpiresAt} <= ${now}`
          )
        )
      )
      .returning({ id: sessions.id });
    return Array.isArray(deleted) ? deleted.length : 0;
  }
}
