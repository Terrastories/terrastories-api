/**
 * Emergency global session revocation (#137). Operator procedure, not an HTTP
 * route: use after a suspected session-token leak or a leaked database copy.
 *
 * Same semantics as per-account revocation: the session row is deleted, so the
 * presented cookie can never authenticate again (only the token digest was
 * ever stored; a deleted row cannot be revived). Every user must log in anew.
 * One content-free audit entry (`security.sessions.revoke_all`) records the run.
 *
 * Usage (Node, SQLite or PostgreSQL from DATABASE_URL):
 *   npx tsx scripts/ops/revoke-all-sessions.ts            # dry run: prints the count
 *   npx tsx scripts/ops/revoke-all-sessions.ts --confirm  # revokes
 *
 * Cloudflare D1: see docs/OPERATIONS-GOVERNANCE.md (R1a) for the equivalent SQL.
 */
import { pathToFileURL } from 'node:url';
import { count } from 'drizzle-orm';
import { tablesFor } from '../../src/db/dialect.js';
import { writeAuditEntry } from '../../src/repositories/audit-entry.repository.js';

export const REVOKE_ALL_AUDIT_ACTION = 'security.sessions.revoke_all';

/** Delete every session row and audit the run. Returns the revoked count. */
export async function revokeAllSessions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  now: Date = new Date()
): Promise<{ revoked: number }> {
  const { sessions } = tablesFor(db);
  const deleted = (await db
    .delete(sessions)
    .returning({ id: sessions.id })) as unknown[];
  // The sessions are already gone; a failed audit write must be visible but
  // cannot undo the revocation.
  await writeAuditEntry(
    db,
    { action: REVOKE_ALL_AUDIT_ACTION, outcome: 'success' },
    now
  );
  return { revoked: deleted.length };
}

/** Number of session rows a run would revoke. */
export async function countSessions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<number> {
  const { sessions } = tablesFor(db);
  const [row] = (await db.select({ n: count() }).from(sessions)) as Array<{
    n: number | string;
  }>;
  return Number(row?.n ?? 0);
}

async function main(): Promise<void> {
  const { getDb } = await import('../../src/db/index.js');
  const db = await getDb();
  if (!process.argv.includes('--confirm')) {
    console.log(
      `Dry run: ${await countSessions(db)} session(s) would be revoked. Re-run with --confirm.`
    );
    return;
  }
  const { revoked } = await revokeAllSessions(db);
  console.log(`Revoked ${revoked} session(s); every user must log in again.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(
        'revoke-all-sessions failed:',
        error instanceof Error ? error.message : 'unknown error'
      );
      process.exit(1);
    }
  );
}
