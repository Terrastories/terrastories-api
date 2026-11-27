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
 * CLI (a PostgreSQL URL is never an argument; it is read from DATABASE_URL):
 *   npx tsx scripts/ops/post-restore.ts sqlite <restored-file> [--replay-from <frozen-db> --after-audit-id <n>]
 *   DATABASE_URL=postgresql://... npx tsx scripts/ops/post-restore.ts postgres
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import postgres from 'postgres';

/**
 * Audit actions that change a user row (so the change reverts on restore) and
 * how each writer stores the affected user: `user.*` entries list the target
 * in resource_ids (resource_type 'user'); `auth.*` entries are self-service,
 * resource_type 'auth' / 'login_code' / 'recovery_codes', with the account in
 * resource_ids and actor_id. Claim-token actions touch no user row and are
 * covered by the post-restore supersede; `user.session.revoke` is covered by
 * the session purge.
 */
export const ACCOUNT_CHANGE_AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.password_reset',
  'user.login_code_issue',
  'auth.password.change',
  'auth.identifier.change',
  'auth.recovery.redeem',
  'auth.recovery_codes.generate',
] as const;

/** Account columns copied from the frozen database on replay. */
export const ACCOUNT_AUTHORITY_COLUMNS = [
  'is_active',
  'role',
  'community_id',
  'password_hash',
  'password_algorithm',
  'password_salt',
  'password_params',
  'password_verifier',
  'email',
  'email_normalized',
  'username',
  'username_normalized',
  'display_name',
  'first_name',
  'last_name',
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

export interface ReplayResult {
  /** Users whose authority/identity columns were copied onto the restored DB. */
  replayed: number[];
  /** Users changed or created after the backup with no restored row: re-create them. */
  missing: number[];
}

/**
 * Replay account changes recorded after the backup: for every user named by a
 * successful ACCOUNT_CHANGE_AUDIT_ACTIONS entry newer than `afterAuditId` in
 * the frozen pre-restore database (selected by action only, the user resolved
 * per writer: resource_ids, else actor_id), copy the columns onto the
 * restored row. Users with no restored row (created after the backup) are
 * returned and printed; re-create them from the frozen database by hand.
 */
export function replayAccountChanges(
  frozen: Database.Database,
  restored: Database.Database,
  afterAuditId: number
): ReplayResult {
  const placeholders = ACCOUNT_CHANGE_AUDIT_ACTIONS.map(() => '?').join(',');
  const entries = frozen
    .prepare(
      `SELECT action, actor_id, resource_ids FROM audit_entries WHERE id > ? AND outcome = 'success' AND action IN (${placeholders})`
    )
    .all(afterAuditId, ...ACCOUNT_CHANGE_AUDIT_ACTIONS) as Array<{
    action: string;
    actor_id: number | null;
    resource_ids: string | null;
  }>;
  const userIds = new Set<number>();
  for (const entry of entries) {
    const parsed: unknown = entry.resource_ids
      ? JSON.parse(entry.resource_ids)
      : [];
    const ids = (Array.isArray(parsed) ? parsed : [parsed])
      .map(Number)
      .filter((id) => Number.isInteger(id));
    if (ids.length === 0 && entry.action.startsWith('auth.') && entry.actor_id)
      ids.push(entry.actor_id);
    for (const id of ids) userIds.add(id);
  }
  const cols = ACCOUNT_AUTHORITY_COLUMNS.join(', ');
  const assign = ACCOUNT_AUTHORITY_COLUMNS.map((c) => `${c} = @${c}`).join(
    ', '
  );
  const update = restored.prepare(`UPDATE users SET ${assign} WHERE id = @id`);
  const result: ReplayResult = { replayed: [], missing: [] };
  // Unique identifiers (email/username and their normalized forms) can be
  // swapped between users after the backup; applying finals one user at a time
  // would hit a unique conflict mid-replay. Stage every affected user onto
  // unique temporary values first, in the same transaction, then apply finals.
  // Temporaries carry a per-run random token and spaces, which no valid
  // username or email contains, so they cannot equal a stored or final value.
  const token = randomUUID();
  const tmp = (id: number) => `replay tmp ${token} ${id}`;
  const stage = restored.prepare(
    'UPDATE users SET username = @t, username_normalized = @t, email = @e, email_normalized = @e WHERE id = @id'
  );
  restored.transaction(() => {
    const rows: Array<{ id: number; row: Record<string, unknown> }> = [];
    for (const id of userIds) {
      const row = frozen
        .prepare(`SELECT ${cols} FROM users WHERE id = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (!row) continue;
      if (
        stage.run({ id, t: tmp(id), e: `${tmp(id)}@replay.invalid` })
          .changes === 0
      )
        result.missing.push(id);
      else rows.push({ id, row });
    }
    for (const { id, row } of rows) {
      update.run({ ...row, id });
      result.replayed.push(id);
    }
  })();
  if (result.missing.length > 0)
    console.warn(
      `post-restore: users with no restored row (created after the backup): ${result.missing.join(', ')}`
    );
  return result;
}

function parseArgs(argv: string[]): {
  profile: 'sqlite' | 'postgres';
  file?: string;
  replayFrom?: string;
  afterAuditId?: number;
} {
  const [profile, ...rest] = argv;
  if (profile === 'postgres') {
    // The credential must never ride in argv (process list, shell history).
    if (rest.length > 0)
      throw new Error(
        'postgres takes no arguments: set DATABASE_URL in the environment'
      );
    return { profile };
  }
  if (profile !== 'sqlite' || !rest[0])
    throw new Error(
      'usage: post-restore.ts sqlite <restored-file> [--replay-from <frozen-db> --after-audit-id <n>] | postgres (DATABASE_URL env)'
    );
  const out: ReturnType<typeof parseArgs> = { profile, file: rest[0] };
  for (let i = 1; i < rest.length; i += 2) {
    if (rest[i] === '--replay-from') out.replayFrom = rest[i + 1];
    else if (rest[i] === '--after-audit-id') {
      // NaN would bind as NULL and silently replay nothing.
      if (
        !/^\d+$/.test(rest[i + 1] ?? '') ||
        !Number.isSafeInteger(Number(rest[i + 1]))
      )
        throw new Error('--after-audit-id must be a non-negative integer');
      out.afterAuditId = Number(rest[i + 1]);
    } else throw new Error(`unknown argument ${rest[i]}`);
  }
  if ((out.replayFrom === undefined) !== (out.afterAuditId === undefined))
    throw new Error('--replay-from and --after-audit-id go together');
  return out;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.profile === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url || !/^postgres(ql)?:\/\//.test(url))
      throw new Error('DATABASE_URL must be a postgresql:// URL');
    const client = postgres(url, { max: 1 });
    try {
      console.log(JSON.stringify(await applyPostRestorePostgres(client)));
    } finally {
      await client.end();
    }
    return;
  }
  const db = new Database(args.file!, { fileMustExist: true });
  try {
    const purge = applyPostRestoreSqlite(db);
    let replay: ReplayResult | undefined;
    if (args.replayFrom !== undefined) {
      const frozen = new Database(args.replayFrom, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        replay = replayAccountChanges(frozen, db, args.afterAuditId!);
      } finally {
        frozen.close();
      }
      // Replay may restore credential material: purge sessions again.
      applyPostRestoreSqlite(db);
    }
    console.log(JSON.stringify({ purge, replay }));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('post-restore.ts')) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
