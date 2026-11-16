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
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { Database } from '../db/index.js';
import { dialectOf, tablesFor } from '../db/dialect.js';
import type {
  FoundationUser,
  HonoFoundationRepository,
} from './hono-foundation.repository.js';
import {
  AUTH_PRELOGIN_MIX_TTL_MS,
  AUTH_THROTTLE_BACKOFF_MAX_MS,
  AUTH_THROTTLE_KEY_ACCOUNT,
  AUTH_THROTTLE_KEY_IP,
  AUTH_THROTTLE_MAX_FAILURES,
  AUTH_THROTTLE_WINDOW_MS,
  ARGON2ID_ALGORITHM,
  BCRYPT_RAILS_COSTS,
  RAILS_BCRYPT_ALGORITHM,
  authThrottleBackoffMs,
  sessionLifetimesFor,
  ipThrottleBucket,
  MIN_SALT_BYTES,
  MAX_SALT_BYTES,
  type PasswordAlgorithm,
  type SessionKind,
} from '../shared/auth-policy.js';
import { sha256Hex } from '../shared/auth-crypto.js';
import {
  parseStoredPasswordParams,
  type PreloginMix,
} from '../shared/prelogin.js';
import { MAINTENANCE_SWEEP_ROW_LIMIT } from '../shared/maintenance-sweep.js';

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
  /** TTL cache for the prelogin population mix (finding C). */
  private mixCache: {
    at: number;
    mix: PreloginMix;
  } | null = null;

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
   * The account row of an authenticated user, re-read for a verifier-changing
   * operation (password change). `null` means the account vanished between
   * the session re-read and the write, which is fail-closed.
   */
  async accountById(id: number): Promise<AuthAccount | null> {
    const { users, communities } = this.tables;
    const rows: RawAuthAccount[] = await this.db
      .select(AUTH_COLUMNS(this.tables))
      .from(users)
      .leftJoin(communities, eq(users.communityId, communities.id))
      .where(eq(users.id, id))
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
   * Prelogin verifier shape of one account (SPEC-V2 §7 step 1), resolved
   * identifier-first: `communityId` narrows only an identifier that matches
   * more than one account, never a uniquely resolved one — a locator that
   * flipped a unique answer to the fake would enumerate accounts and
   * communities (paired-request oracle). Returns a tri-state so every caller
   * can reproduce the same resolution without ever trusting the slug:
   *
   *  - `one`: exactly one account matches the identifier
   *  - `many`: several accounts match (an email shared across communities, a
   *    username likewise) — the slug then disambiguates
   *  - `none`: no account matches
   *
   * `account` is the single match for `one`, and `null` otherwise (a row with
   * no verifier material must not present a shape the client cannot use — the
   * fake path answers instead).
   */
  async preloginAccount(
    normalizedIdentifier: string,
    communityId?: number
  ): Promise<{
    kind: 'none' | 'one' | 'many';
    account: {
      passwordAlgorithm: string;
      passwordSalt: string;
      passwordParams: string;
    } | null;
  }> {
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
    if (rows.length > 1) return { kind: 'many', account: null };
    const row = rows[0] ?? null;
    if (!row) return { kind: 'none', account: null };
    // A row with no verifier (code-only account) must not present a shape the
    // client cannot use: the fake path answers instead (§7 step 1).
    if (row.passwordAlgorithm === null || row.passwordSalt === null)
      return { kind: 'none', account: null };
    return {
      kind: 'one',
      account: {
        passwordAlgorithm: row.passwordAlgorithm,
        passwordSalt: row.passwordSalt,
        passwordParams: row.passwordParams ?? '',
      },
    };
  }

  /**
   * The deployment-wide migrated-vs-upgraded mix of all accounts, for prelogin
   * fakes (SPEC-V2 §7 step 1: fakes mimic the mix so the response does not
   * reveal whether an account exists or was migrated).
   *
   * The mix is deliberately deployment-wide and not per community: a
   * community-scoped mix made a real slug answer with that community's
   * algorithm while an unknown slug fell back to the global mix, which
   * enumerated private or disabled community slugs (finding 5). The fake is
   * also keyed only by the normalized identifier, never by the slug.
   */
  async globalAlgorithmMix(): Promise<{ upgraded: number; total: number }> {
    const mix = await this.preloginMix();
    return { upgraded: mix.upgraded, total: mix.total };
  }

  /**
   * The bcrypt costs migrated Rails rows actually carry, so a prelogin fake
   * draws from the same distribution (finding C). Falls back to the canonical
   * Rails 10/12 set when no migrated row exists yet.
   */
  async bcryptCostMix(): Promise<number[]> {
    return [...((await this.preloginMix()).costs ?? BCRYPT_RAILS_COSTS)];
  }

  /**
   * The raw population-mix group rows (algorithm × params × salt length).
   * Diagnostic/test surface; the cached {@link preloginMix} is the normal
   * consumer. The group set is bounded by the number of algorithms, stored
   * params combos and salt lengths, never by the account count.
   */
  async preloginMixGroups(): Promise<
    Array<{
      algorithm: string | null;
      passwordParams: string | null;
      saltBytes: number | null;
      total: number;
    }>
  > {
    const { users } = this.tables;
    // Portable base64 byte length from its text length: `rtrim` on the `=`
    // padding, integer division, same result on SQLite/D1 and PostgreSQL.
    // Keeping the group key a small integer instead of the salt itself (a
    // unique-per-user column) bounds the group set.
    const saltBytesSql = sql<
      number | null
    >`cast((length(rtrim(${users.passwordSalt}, '=')) * 3) / 4 as integer)`;
    const rows: Array<{
      algorithm: string | null;
      passwordParams: string | null;
      saltBytes: number | string | null;
      total: number | string;
    }> = await this.db
      .select({
        algorithm: users.passwordAlgorithm,
        passwordParams: users.passwordParams,
        saltBytes: saltBytesSql,
        total: sql<number>`count(*)`,
      })
      .from(users)
      .groupBy(users.passwordAlgorithm, users.passwordParams, saltBytesSql);
    return rows.map((row) => ({
      ...row,
      saltBytes:
        row.saltBytes === null || row.saltBytes === undefined
          ? null
          : Number(row.saltBytes),
      total: Number(row.total),
    }));
  }

  /**
   * The deployment-wide prelogin population, cached for
   * `AUTH_PRELOGIN_MIX_TTL_MS`: the upgraded/total ratio plus the observed
   * bcrypt costs, Argon2id parameter combos and salt byte lengths. Every prelogin path (real account or fake) reads this same
   * cache, so the mix computation runs — or is served — uniformly and never
   * full-scans `users` per request (finding C).
   */
  async preloginMix(now: number = Date.now()): Promise<PreloginMix> {
    const cached = this.mixCache;
    if (cached !== null && now - cached.at < AUTH_PRELOGIN_MIX_TTL_MS)
      return cached.mix;
    const rows = await this.preloginMixGroups();
    let upgraded = 0;
    let total = 0;
    const costCounts = new Map<number, number>();
    const paramsCounts = new Map<
      string,
      {
        memoryKiB: number;
        iterations: number;
        parallelism: number;
        count: number;
      }
    >();
    const saltLengthCounts = new Map<number, number>();
    for (const row of rows) {
      const count = Number(row.total);
      total += count;
      const params = parseStoredPasswordParams(
        row.algorithm ?? null,
        row.passwordParams
      );
      if (
        row.algorithm === ARGON2ID_ALGORITHM &&
        params !== null &&
        'memoryKiB' in params
      ) {
        upgraded += count;
        const key = `${params.memoryKiB}:${params.iterations}:${params.parallelism}`;
        const existing = paramsCounts.get(key);
        if (existing) existing.count += count;
        else
          paramsCounts.set(key, {
            memoryKiB: params.memoryKiB,
            iterations: params.iterations,
            parallelism: params.parallelism,
            count,
          });
        const saltBytes = row.saltBytes ?? -1;
        if (saltBytes >= MIN_SALT_BYTES && saltBytes <= MAX_SALT_BYTES)
          saltLengthCounts.set(
            saltBytes,
            (saltLengthCounts.get(saltBytes) ?? 0) + count
          );
      } else if (
        row.algorithm === RAILS_BCRYPT_ALGORITHM &&
        params !== null &&
        'cost' in params
      ) {
        costCounts.set(params.cost, (costCounts.get(params.cost) ?? 0) + count);
      }
    }
    const observed = [...costCounts.keys()].sort((a, b) => a - b);
    const costCountsArr = [...costCounts.entries()]
      .map(([cost, count]) => ({ cost, count }))
      .sort((a, b) => a.cost - b.cost);
    const params = [...paramsCounts.values()].sort((a, b) => b.count - a.count);
    const saltLengths = [...saltLengthCounts.entries()]
      .map(([length, count]) => ({ length, count }))
      .sort((a, b) => a.length - b.length);
    const mix: PreloginMix = {
      upgraded,
      total,
      costs: observed.length > 0 ? observed : [...BCRYPT_RAILS_COSTS],
      costCounts: costCountsArr,
      params,
      saltLengths,
    };
    this.mixCache = { at: now, mix };
    return mix;
  }

  /**
   * Atomic verifier write (upgrade / password change), authority-guarded by
   * the re-read `password_hash`: a rejected request leaves the row byte-
   * identical and a concurrent reset wins the race. The
   * `users_revoke_sessions` trigger revokes the account's other sessions as a
   * consequence of the change (§6.8), so no extra delete is issued here.
   */
  async writeVerifierAtomically(
    account: Pick<AuthAccount, 'id' | 'passwordHash' | 'passwordVerifier'>,
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
          eq(users.passwordHash, account.passwordHash),
          // A stale verifier (the account changed between the read and the
          // write) must lose the race rather than overwrite the new one
          // (finding G).
          account.passwordVerifier === null
            ? isNull(users.passwordVerifier)
            : eq(users.passwordVerifier, account.passwordVerifier)
        )
      )
      .returning({ id: users.id });
    return updated.length > 0;
  }

  /**
   * Complete a verified login. When the caller passes a `verifier` (the
   * wrapped Rails-bcrypt upgrade, or a password change), the verifier write
   * and the session insert are coupled in one unit — `db.batch` on D1, one
   * transaction on SQLite/PostgreSQL — so a lost authority race leaves both
   * writes undone and a `null` result is truthful (§7 step 4, finding 7). A
   * plain Argon2id login passes `verifier: null` and writes only the session:
   * that write is itself authority-gated (the INSERT…SELECT re-reads the
   * account), so a no-op verifier re-write would only spend a D1 row write.
   *
   * `previousToken`, when presented and well-formed, rotates the presented
   * same-user session row in place; a presented cookie belonging to another
   * user is revoked and this login gets a fresh row (#188).
   *
   * Returns `verifierWritten` so the caller audits only what actually landed.
   */
  async establishLogin(input: {
    repository: HonoFoundationRepository;
    account: AuthAccount;
    user: FoundationUser;
    verifier: VerifierWrite | null;
    kind: SessionKind;
    now: Date;
    previousToken?: string | undefined;
  }): Promise<{ token: string; verifierWritten: boolean } | null> {
    const { repository, account, user, verifier, kind, now } = input;
    const token = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const lifetimes = sessionLifetimesFor(kind, now.getTime());
    const tokenHash = await sha256Hex(token);
    const previousHash =
      input.previousToken === undefined
        ? undefined
        : await sha256Hex(input.previousToken);
    const sessionWrite = {
      tokenHash,
      user,
      kind,
      createdAt: now,
      idleExpiresAt: new Date(lifetimes.idleExpiresAt),
      absoluteExpiresAt: new Date(lifetimes.absoluteExpiresAt),
      previousHash,
    };
    if (verifier !== null) {
      const result = await repository.createSessionWithVerifier({
        ...sessionWrite,
        verifier,
        previousVerifier: account.passwordVerifier,
      });
      if (!result.established) return null;
      return { token, verifierWritten: result.verifierWritten };
    }
    const created = await repository.createSession({
      ...sessionWrite,
      // Plain Argon2id logins anchor to the verifier they just verified
      // against (§7 step 4). Concurrent verifier replacement then yields no
      // session instead of a valid session for stale credentials.
      expectedVerifier: account.passwordVerifier ?? null,
    });
    return created ? { token, verifierWritten: false } : null;
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

  /**
   * Per-IP throttle key (keyed hash of the client IP alone, §6.8). IPv6 is
   * keyed on its /64 prefix so rotating within a /64 does not mint fresh
   * buckets; IPv4 is keyed verbatim.
   */
  ipThrottleKey(clientIp: string, secret: string): Promise<string> {
    return this.throttleKey(
      `${AUTH_THROTTLE_KEY_IP}${ipThrottleBucket(clientIp)}`,
      secret
    );
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
    // The counter decays only after a full quiet window *past the last block*,
    // not from when the counter started: `coalesce(blocked_until,
    // window_started_at)` anchors both branches, so an active or only just
    // lapsed block does not reset the ladder and the backoff escalates on
    // the realistic timeline (each attempt right after its predecessor's
    // block lapses). Decaying mid-block silently caps the ladder at the
    // first rung (finding A).
    const windowExpired = sql`coalesce(${throttle.blockedUntil}, ${throttle.windowStartedAt}) <= ${now - AUTH_THROTTLE_WINDOW_MS}`;
    // The successor of the failure count after this write, computed once so the
    // blocked_until branch cannot drift from the counter branch.
    const nextFailures = sql`(case when ${windowExpired} then 1 else ${throttle.failures} + 1 end)`;
    // `now` is epoch milliseconds added to the small-integer backoff ladder.
    // PostgreSQL resolves the parameter from the ladder's `int4` result and
    // would bind it as `integer`, overflowing on any millisecond value
    // (`22003`); SQLite has one 64-bit integer type and no such inference.
    // The explicit `bigint` cast pins the parameter width on both backends
    // without changing the value or the expression's meaning.
    const blockedUntil = sql`(case when ${nextFailures} >= ${AUTH_THROTTLE_MAX_FAILURES} then cast(${now} as bigint) + ${backoffLadderSql(nextFailures)} else null end)`;
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

  /**
   * Clear the account's and the client address's failure counters after a
   * successful login (§6.8 — "counters reset on success"). A shared NAT or
   * proxy address carrying many accounts must not let ten unrelated typos
   * lock the whole community out for an exponentially growing backoff when
   * anyone behind it authenticates correctly.
   */
  async resetAccountThrottle(
    accountId: number,
    clientIp: string,
    secret: string
  ): Promise<void> {
    const throttle = this.tables.authThrottle;
    await this.db
      .delete(throttle)
      .where(
        inArray(throttle.key, [
          await this.accountThrottleKey(accountId, secret),
          await this.ipThrottleKey(clientIp, secret),
        ])
      );
  }

  /**
   * Delete throttle rows whose window is spent and that are not currently
   * blocking, for the scheduled sweep (§6.8). Bounded to
   * MAINTENANCE_SWEEP_ROW_LIMIT rows in one statement so a scheduled
   * invocation stays within its budget; rows beyond the cap wait for the
   * next tick.
   */
  async sweepAuthThrottle(
    now: number,
    limit: number = MAINTENANCE_SWEEP_ROW_LIMIT
  ): Promise<number> {
    const throttle = this.tables.authThrottle;
    // Same anchor as the increment path's decay: a row is spent only after a
    // full quiet window past its block (or its window start when never
    // blocked). Anchoring on window_started_at alone deleted a just-lapsed
    // escalated block and reset the backoff ladder on the next cron tick.
    // This also keeps every currently-blocked row.
    const eligible = sql`coalesce(${throttle.blockedUntil}, ${throttle.windowStartedAt}) <= ${now - AUTH_THROTTLE_WINDOW_MS}`;
    const deleted = await this.db
      .delete(throttle)
      .where(
        inArray(
          throttle.key,
          this.db
            .select({ key: throttle.key })
            .from(throttle)
            .where(eligible)
            .limit(limit)
        )
      )
      .returning({ key: throttle.key });
    return Array.isArray(deleted) ? deleted.length : 0;
  }

  /**
   * Delete expired session rows, for the scheduled sweep (§7 "Sessions").
   * Bounded to MAINTENANCE_SWEEP_ROW_LIMIT rows in one statement so a
   * scheduled invocation stays within its budget; rows beyond the cap wait
   * for the next tick.
   */
  async sweepExpiredSessions(
    now: number,
    limit: number = MAINTENANCE_SWEEP_ROW_LIMIT
  ): Promise<number> {
    const sessions = this.tables.sessions;
    const eligible = or(
      sql`coalesce(${sessions.idleExpiresAt}, ${sessions.expiresAt}) <= ${now}`,
      and(
        sql`${sessions.absoluteExpiresAt} IS NOT NULL`,
        sql`${sessions.absoluteExpiresAt} <= ${now}`
      )
    );
    const deleted = await this.db
      .delete(sessions)
      .where(
        inArray(
          sessions.id,
          this.db
            .select({ id: sessions.id })
            .from(sessions)
            .where(eligible)
            .limit(limit)
        )
      )
      .returning({ id: sessions.id });
    return Array.isArray(deleted) ? deleted.length : 0;
  }
}
