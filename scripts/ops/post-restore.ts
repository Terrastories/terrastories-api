/**
 * Post-restore step (docs/OPERATIONS-GOVERNANCE.md section 6.5).
 *
 * A restored backup carries the credential state of backup time. Run this
 * against the restored database BEFORE serving traffic:
 *   - delete every session (revocation is delete-based; a backup holds tokens
 *     the community may have revoked since);
 *   - supersede every unconsumed login code (recovery and admin_issued) and
 *     claim token, because consumption or supersession after the backup is
 *     rolled back by the restore;
 *   - delete export download tokens (short-lived, regenerable).
 * It does not and cannot restore account changes made after the backup:
 * password verifiers, roles, community membership and is_active revert to
 * backup time. Replay them from the audit log of the frozen pre-restore
 * database (replayAccountChanges).
 *
 * CLI: npx tsx scripts/ops/post-restore.ts <sqlite-file | postgresql-url>
 */
import Database from 'better-sqlite3';
import postgres from 'postgres';

/** Audit actions whose effects revert on restore and must be replayed. */
export const ACCOUNT_CHANGE_AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.password_reset',
  'user.session.revoke',
  'user.login_code_issue',
  'auth.password.change',
  'auth.identifier.change',
  'auth.recovery.redeem',
  'auth.recovery_codes.generate',
  'claim_token.issue',
  'claim_token.consume',
] as const;

/** Account-authority columns copied from the frozen database on replay. */
export const ACCOUNT_AUTHORITY_COLUMNS = [
  'is_active',
  'role',
  'community_id',
  'password_hash',
  'password_algorithm',
  'password_salt',
  'password_params',
  'password_verifier',
] as const;

export interface PostRestoreResult {
  sessionsDeleted: number;
  loginCodesSuperseded: number;
  claimTokensSuperseded: number;
  exportTokensDeleted: number;
}

function statements(nowMs: number): Array<[keyof PostRestoreResult, string]> {
  const now = Math.trunc(nowMs);
  if (!Number.isFinite(now)) throw new Error('post-restore: invalid time');
  return [
    ['sessionsDeleted', 'DELETE FROM sessions'],
    [
      'loginCodesSuperseded',
      `UPDATE login_codes SET superseded_at = ${now} WHERE used_at IS NULL AND superseded_at IS NULL`,
    ],
    [
      'claimTokensSuperseded',
      `UPDATE claim_tokens SET superseded_at = ${now} WHERE consumed_at IS NULL AND superseded_at IS NULL`,
    ],
    ['exportTokensDeleted', 'DELETE FROM export_tokens'],
  ];
}

export function applyPostRestoreSqlite(
  db: Database.Database,
  nowMs: number = Date.now()
): PostRestoreResult {
  const result = {} as PostRestoreResult;
  db.transaction(() => {
    for (const [key, sql] of statements(nowMs))
      result[key] = db.prepare(sql).run().changes;
  })();
  return result;
}

export async function applyPostRestorePostgres(
  client: postgres.Sql,
  nowMs: number = Date.now()
): Promise<PostRestoreResult> {
  const result = {} as PostRestoreResult;
  await client.begin(async (tx) => {
    for (const [key, sql] of statements(nowMs))
      result[key] = (await tx.unsafe(sql)).count;
  });
  return result;
}

/**
 * Replay account changes recorded after the backup: for every user touched by
 * an ACCOUNT_CHANGE_AUDIT_ACTIONS entry newer than `afterAuditId` in the
 * frozen pre-restore database, copy the authority columns onto the restored
 * row. Returns the user ids replayed. Review the list before serving.
 */
export function replayAccountChanges(
  frozen: Database.Database,
  restored: Database.Database,
  afterAuditId: number
): number[] {
  const placeholders = ACCOUNT_CHANGE_AUDIT_ACTIONS.map(() => '?').join(',');
  const entries = frozen
    .prepare(
      `SELECT resource_ids FROM audit_entries WHERE id > ? AND resource_type = 'user' AND action IN (${placeholders})`
    )
    .all(afterAuditId, ...ACCOUNT_CHANGE_AUDIT_ACTIONS) as Array<{
    resource_ids: string | null;
  }>;
  const userIds = new Set<number>();
  for (const entry of entries) {
    const parsed: unknown = entry.resource_ids
      ? JSON.parse(entry.resource_ids)
      : [];
    for (const id of Array.isArray(parsed) ? parsed : [parsed])
      if (Number.isInteger(Number(id))) userIds.add(Number(id));
  }
  const cols = ACCOUNT_AUTHORITY_COLUMNS.join(', ');
  const assign = ACCOUNT_AUTHORITY_COLUMNS.map((c) => `${c} = @${c}`).join(
    ', '
  );
  const update = restored.prepare(`UPDATE users SET ${assign} WHERE id = @id`);
  const replayed: number[] = [];
  restored.transaction(() => {
    for (const id of userIds) {
      const row = frozen
        .prepare(`SELECT ${cols} FROM users WHERE id = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (row && update.run({ ...row, id }).changes > 0) replayed.push(id);
    }
  })();
  return replayed;
}

async function main(target: string): Promise<void> {
  if (/^postgres(ql)?:\/\//.test(target)) {
    const client = postgres(target, { max: 1 });
    try {
      console.log(JSON.stringify(await applyPostRestorePostgres(client)));
    } finally {
      await client.end();
    }
    return;
  }
  const db = new Database(target, { fileMustExist: true });
  try {
    console.log(JSON.stringify(applyPostRestoreSqlite(db)));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('post-restore.ts')) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: post-restore.ts <sqlite-file | postgresql-url>');
    process.exit(2);
  }
  await main(target);
}
