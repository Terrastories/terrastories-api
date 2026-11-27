/**
 * Emergency global session revocation (#137). Operator procedure, not an HTTP
 * route: use after a suspected session-token leak or a leaked database copy.
 *
 * In ONE transaction it (1) deletes every session row (same effect as
 * per-account revocation: a presented cookie can never authenticate again),
 * (2) supersedes every unconsumed login code (recovery and admin_issued) and
 * every unconsumed claim token, so a leaked database copy cannot mint new
 * sessions through them, and (3) writes one content-free audit entry
 * (`security.sessions.revoke_all`). Either all of it commits or none of it.
 *
 * Installed image:  node dist/ops/revoke-all-sessions.js [--confirm]
 * Source checkout:  npx tsx scripts/ops/revoke-all-sessions.ts [--confirm]
 * Without --confirm it is a dry run that only prints counts. DATABASE_URL must
 * be set explicitly. Cloudflare D1: see docs/OPERATIONS-GOVERNANCE.md (R1a).
 */
/* eslint-disable no-console -- operator CLI: stdout/stderr is its interface */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { and, count, isNull, sql } from 'drizzle-orm';
import { dialectOf, tablesFor } from '../db/dialect.js';
import { buildAuditEntryInsert } from '../repositories/audit-entry.repository.js';

/** PostgreSQL attempts when a deadlock or serialization failure aborts a run. */
export const REVOKE_MAX_ATTEMPTS = 5;

export const REVOKE_ALL_AUDIT_ACTION = 'security.sessions.revoke_all';

/** Opaque run id: lets an operator tell this run's audit entry from any other. */
export const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

export interface RevokeAllResult {
  /** Unique id of this run; stored in the audit entry's resource ids. */
  runId: string;
  /** Session rows deleted. */
  revoked: number;
  loginCodesSuperseded: number;
  claimTokensSuperseded: number;
}

/** Revoke every session, supersede unconsumed codes/tokens, audit. Atomic. */
export async function revokeAllSessions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  now: Date = new Date(),
  runId: string = randomUUID()
): Promise<RevokeAllResult> {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid run id');
  const { sessions, loginCodes, claimTokens } = tablesFor(db);
  const at = now.getTime();
  const supersedeCodes = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any
  ) =>
    tx
      .update(loginCodes)
      .set({ supersededAt: at })
      .where(and(isNull(loginCodes.usedAt), isNull(loginCodes.supersededAt)))
      .returning({ id: loginCodes.id });
  const supersedeTokens = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any
  ) =>
    tx
      .update(claimTokens)
      .set({ supersededAt: at })
      .where(
        and(isNull(claimTokens.consumedAt), isNull(claimTokens.supersededAt))
      )
      .returning({ id: claimTokens.id });
  const audit = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any
  ) =>
    buildAuditEntryInsert(
      tx,
      {
        action: REVOKE_ALL_AUDIT_ACTION,
        outcome: 'success',
        resourceType: 'system',
        resourceIds: [runId],
      },
      now
    );

  if (dialectOf(db) === 'sqlite') {
    // better-sqlite3 transactions are synchronous and roll back on a throw.
    return db.transaction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tx: any): RevokeAllResult => {
        // Supersede first: a redemption consumes with a conditional UPDATE
        // (unused AND unsuperseded), so it cannot succeed after this point.
        const codes = supersedeCodes(tx).all() as unknown[];
        const tokens = supersedeTokens(tx).all() as unknown[];
        const deleted = tx
          .delete(sessions)
          .returning({ id: sessions.id })
          .all() as unknown[];
        audit(tx).run();
        return {
          runId,
          revoked: deleted.length,
          loginCodesSuperseded: codes.length,
          claimTokensSuperseded: tokens.length,
        };
      },
      // BEGIN IMMEDIATE: take the write lock up front so no other writer can
      // interleave between the supersede and the session delete.
      { behavior: 'immediate' }
    );
  }
  // PostgreSQL: retry the whole transaction on deadlock / serialization
  // failure (see the lock-order note below), a few times with backoff.
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await db.transaction(async (tx: any): Promise<RevokeAllResult> => {
        // Never wait forever on a lock held by a stuck transaction.
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        // PostgreSQL (READ COMMITTED). The paths that create sessions or
        // consume codes do not share one lock order (claim: claim_tokens ->
        // sessions; redemption: sessions -> login_codes), so no single order
        // here is deadlock-free against both. We take the table locks
        // claim_tokens -> sessions -> login_codes-rows, BEFORE any row update:
        //  - an in-flight claim or redemption that already holds what we need
        //    finishes first, so its session is visible to the DELETE below and
        //    its new codes are caught by the supersede;
        //  - a new one blocks until we commit, then fails its conditional
        //    consume against the superseded row.
        // A deadlock with a redemption that holds session rows while we hold
        // claim_tokens is still possible; PostgreSQL aborts one side (40P01)
        // and we retry the whole transaction. lock_timeout bounds each wait.
        await tx.execute(sql`LOCK TABLE claim_tokens IN EXCLUSIVE MODE`);
        await tx.execute(sql`LOCK TABLE sessions IN EXCLUSIVE MODE`);
        const tokens = (await supersedeTokens(tx)) as unknown[];
        const codes = (await supersedeCodes(tx)) as unknown[];
        const deleted = (await tx
          .delete(sessions)
          .returning({ id: sessions.id })) as unknown[];
        await audit(tx);
        return {
          runId,
          revoked: deleted.length,
          loginCodesSuperseded: codes.length,
          claimTokensSuperseded: tokens.length,
        };
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const retryable = code === '40P01' || code === '40001';
      if (!retryable || attempt >= REVOKE_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt ** 2));
    }
  }
}

/** What a run would change. */
export async function countAffected(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<Omit<RevokeAllResult, 'runId'>> {
  const { sessions, loginCodes, claimTokens } = tablesFor(db);
  const n = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any
  ): Promise<number> => Number((await query)[0]?.n ?? 0);
  return {
    revoked: await n(db.select({ n: count() }).from(sessions)),
    loginCodesSuperseded: await n(
      db
        .select({ n: count() })
        .from(loginCodes)
        .where(and(isNull(loginCodes.usedAt), isNull(loginCodes.supersededAt)))
    ),
    claimTokensSuperseded: await n(
      db
        .select({ n: count() })
        .from(claimTokens)
        .where(
          and(isNull(claimTokens.consumedAt), isNull(claimTokens.supersededAt))
        )
    ),
  };
}

const summary = (r: Omit<RevokeAllResult, 'runId'>) =>
  `${r.revoked} session(s), ${r.loginCodesSuperseded} unconsumed login code(s), ${r.claimTokensSuperseded} unconsumed claim token(s)`;

/** Only a short upper-case driver code is safe to print; never a message. */
function safeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
    ? ` (${code})`
    : '';
}

/** CLI body; returns the process exit code. Output never echoes driver text. */
export async function runCli(
  argv: readonly string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  io: { out: (line: string) => void; err: (line: string) => void } = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }
): Promise<number> {
  try {
    if (!argv.includes('--confirm')) {
      io.out(
        `Dry run: would revoke ${summary(await countAffected(db))}. Re-run with --confirm.`
      );
      return 0;
    }
    const result = await revokeAllSessions(db);
    io.out(
      `Revoked ${summary(result)}; every user must log in again. Run id: ${result.runId}`
    );
    return 0;
  } catch (error) {
    io.err(
      `revoke-all-sessions failed${safeCode(error)}; the transaction was rolled back, nothing was changed.`
    );
    return 1;
  }
}

/** Entry point shared by the compiled command and the scripts/ops wrapper. */
export async function main(argv: readonly string[]): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url || url === ':memory:' || process.env.NODE_ENV === 'test') {
    console.error(
      'revoke-all-sessions refused: set an explicit DATABASE_URL (an in-memory database, or NODE_ENV=test, would revoke nothing real).'
    );
    return 2;
  }
  try {
    const { getDb } = await import('../db/index.js');
    return await runCli(argv, await getDb());
  } catch (error) {
    console.error(
      `revoke-all-sessions failed${safeCode(error)} before running.`
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
