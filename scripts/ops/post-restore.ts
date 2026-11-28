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
  resetTokensCleared: number;
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
    [
      'resetTokensCleared',
      'UPDATE users SET reset_password_token = NULL, reset_password_sent_at = NULL, remember_created_at = NULL WHERE reset_password_token IS NOT NULL OR reset_password_sent_at IS NOT NULL OR remember_created_at IS NOT NULL',
    ],
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
  /** Users deleted after the backup (restored row, none in the frozen DB): deactivated, review. */
  removed: number[];
  /** Identifiers a restored account holds that a missing (post-backup) account also holds. */
  conflicts: Array<{ id: number; column: string; heldBy: number }>;
  /** 'verified': the restored backup is an ancestor of the frozen DB; 'skipped': --allow-unrelated-lineage. */
  lineage: 'verified' | 'skipped';
  /** Authority tables replaced from the frozen database: rows copied / skipped (they reference users with no restored row). */
  reconciled: Record<string, { copied: number; skipped: number }>;
  /** Communities whose enable/withdrawal flags were copied from the frozen database. */
  communitiesUpdated: number[];
}

/**
 * Tables that grant authority and are replaced wholesale from the frozen
 * database (the frozen state is the newer one), with the columns that
 * reference users: a row naming a user that has no restored row is skipped
 * and counted. Credential tables (sessions, login_codes, claim_tokens,
 * export_tokens, users reset/remember tokens) are purged instead, never
 * reconciled. See docs/OPERATIONS-GOVERNANCE.md 6.5 for the full rule list.
 */
export const RECONCILED_TABLES: Array<{ name: string; userColumns: string[] }> =
  [
    // A removed steward must not regain withdrawal/erasure authority.
    { name: 'community_stewards', userColumns: ['user_id', 'designated_by'] },
    // Withdrawal/erasure notices and their cancellation/completion state.
    {
      name: 'community_sovereignty_requests',
      userColumns: ['initiated_by', 'cancelled_by'],
    },
    // Archive custody holder and destruction state.
    {
      name: 'community_archive_custody',
      userColumns: ['custodian_user_id'],
    },
    // Installation bootstrap (setup done, first administrator).
    { name: 'installation_bootstrap', userColumns: ['admin_user_id'] },
    // Brute-force counters and blocks must not reset on restore.
    { name: 'auth_throttle', userColumns: [] },
  ];

/** Community flags that enable, hide or withdraw a community. */
export const COMMUNITY_AUTHORITY_COLUMNS = [
  'is_active',
  'deprovisioned_at',
  'public_stories',
  'beta',
] as const;

/** Audit columns the scheduled network-metadata scrub may null. */
const AUDIT_SCRUBBED = ['ip_address', 'user_agent'];

const canon = (row: unknown, exclude: string[] = []): string =>
  JSON.stringify(
    Object.entries(row as Record<string, unknown>)
      .filter(([k]) => !exclude.includes(k))
      .map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  );

/**
 * Lineage check (fail closed, before any write): the restored backup must be
 * an ancestor of the frozen database. Matching on id/created_at alone is not
 * enough: a frozen database of a different lineage (for example Rails-derived,
 * keeping source ids and created_at) can reuse the same tuples. Requires the
 * restored database's newest audit row to exist identically (all columns) in
 * the frozen one, its newest user (id, created_at) to exist there, and every
 * restored community (id, slug, created_at) to exist there. Without audit rows
 * only the users/communities checks run.
 */
function checkLineage(
  frozen: Database.Database,
  restored: Database.Database
): 'verified' {
  const diverged: string[] = [];
  const newestAudit = restored
    .prepare('SELECT * FROM audit_entries ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  if (!newestAudit) {
    // Nothing anchors the lineage: users and communities alone can collide
    // across lineages, so refuse unless the operator overrides.
    diverged.push(
      'restored database has no audit entries, so lineage cannot be anchored'
    );
  } else {
    const same = frozen
      .prepare('SELECT * FROM audit_entries WHERE id = ?')
      .get(newestAudit.id);
    // The only permitted mutation of an audit entry is the scheduled scrub of
    // ip_address/user_agent (scrubExpiredAuditNetworkMetadata in
    // audit-entry.repository.ts), so compare the immutable columns only.
    if (
      !same ||
      canon(same, AUDIT_SCRUBBED) !== canon(newestAudit, AUDIT_SCRUBBED)
    )
      diverged.push(
        `newest restored audit entry ${newestAudit.id} is absent or different in the frozen database`
      );
  }
  const newestUser = restored
    .prepare(
      'SELECT id, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT 1'
    )
    .get() as { id: number; created_at: unknown } | undefined;
  if (newestUser) {
    const same = frozen
      .prepare('SELECT id, created_at FROM users WHERE id = ?')
      .get(newestUser.id);
    if (!same || canon(same) !== canon(newestUser))
      diverged.push(
        `newest restored user ${newestUser.id} (id, created_at) differs in the frozen database`
      );
  }
  const communities = restored
    .prepare('SELECT id, slug, created_at FROM communities')
    .all();
  const frozenCommunity = frozen.prepare(
    'SELECT id, slug, created_at FROM communities WHERE id = ?'
  );
  for (const c of communities) {
    const same = frozenCommunity.get((c as { id: number }).id);
    if (!same || canon(same) !== canon(c))
      diverged.push(
        `community ${(c as { id: number }).id} (id, slug, created_at) differs in the frozen database`
      );
  }
  if (diverged.length > 0)
    throw new Error(
      `post-restore: the frozen database is not a descendant of the restored backup (unrelated lineage): ${diverged.join('; ')}. No account rows were changed. Use --allow-unrelated-lineage only after verifying by hand.`
    );
  return 'verified';
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
  afterAuditId: number,
  options: { tempSource?: () => string; allowUnrelatedLineage?: boolean } = {}
): ReplayResult {
  const lineage = options.allowUnrelatedLineage
    ? 'skipped'
    : checkLineage(frozen, restored);
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
  // The audit log is only an extra signal: password changes and user updates
  // commit before their audit write, and audit failures are swallowed
  // (hono-auth.service.ts auditAuthEvent, user-management.service.ts audit),
  // so an unaudited change would never be replayed. Compare the frozen and
  // restored account rows directly, on every security-relevant column.
  const cols0 = ACCOUNT_AUTHORITY_COLUMNS.join(', ');
  const selectAll = `SELECT id, created_at, ${cols0} FROM users`;
  const frozenRows = frozen.prepare(selectAll).all() as Array<
    Record<string, unknown>
  >;
  const frozenIds = new Set(frozenRows.map((r) => Number(r.id)));
  const restoredById = new Map(
    (restored.prepare(selectAll).all() as Array<Record<string, unknown>>).map(
      (r) => [Number(r.id), r]
    )
  );
  // Fail closed on a reused id: an earlier restore can roll the sequence back,
  // so the same id may name different people in the two databases. Match on id
  // plus the immutable identity (created_at, community_id) and abort before
  // changing anything.
  const ambiguous = frozenRows
    .filter((fr) => {
      const rr = restoredById.get(Number(fr.id));
      return (
        rr !== undefined &&
        (!Object.is(fr.created_at, rr.created_at) ||
          !Object.is(fr.community_id, rr.community_id))
      );
    })
    .map((fr) => Number(fr.id));
  if (ambiguous.length > 0)
    throw new Error(
      `post-restore: user ids ${ambiguous.join(', ')} name different accounts in the frozen and restored databases (created_at/community_id differ); no account rows were changed. Resolve by hand (a legitimate community move needs the restored row aligned first).`
    );
  for (const fr of frozenRows) {
    const rr = restoredById.get(Number(fr.id));
    if (!rr)
      userIds.add(Number(fr.id)); // created after the backup: reported missing
    else if (ACCOUNT_AUTHORITY_COLUMNS.some((c) => !Object.is(fr[c], rr[c])))
      userIds.add(Number(fr.id));
  }
  const assign = ACCOUNT_AUTHORITY_COLUMNS.map((c) => `${c} = @${c}`).join(
    ', '
  );
  const update = restored.prepare(`UPDATE users SET ${assign} WHERE id = @id`);
  const result: ReplayResult = {
    replayed: [],
    missing: [],
    removed: [],
    conflicts: [],
    lineage,
    reconciled: {},
    communitiesUpdated: [],
  };
  // Unique identifiers (email/username and their normalized forms) can be
  // swapped between users after the backup, or still held by an account that
  // was deleted afterwards; applying finals one user at a time would hit a
  // unique conflict mid-replay. In ONE transaction: reserve every final value,
  // deactivate deleted-after-backup accounts and release their identifiers
  // (tombstone values), stage every affected user onto temporaries, then apply
  // finals. Tombstones and temporaries are protected by an explicit
  // disjointness check, not by their shape (usernames may contain spaces):
  // each candidate carries a random token and must equal no stored identifier,
  // no final value to be applied and no other generated value; a collision
  // regenerates it. Any remaining unique conflict aborts and rolls back all.
  const nextToken = options.tempSource ?? randomUUID;
  const stage = restored.prepare(
    'UPDATE users SET username = @t, username_normalized = @t, email = @e, email_normalized = @e WHERE id = @id'
  );
  const tombstone = restored.prepare(
    'UPDATE users SET is_active = 0, username = @t, username_normalized = @t, email = @e, email_normalized = @e WHERE id = @id'
  );
  const exists = restored.prepare('SELECT 1 FROM users WHERE id = ?');
  const taken = restored.prepare(
    'SELECT 1 FROM users WHERE username = @t OR username_normalized = @t OR email = @e OR email_normalized = @e LIMIT 1'
  );
  const holder = restored.prepare(
    'SELECT id FROM users WHERE username = @v OR username_normalized = @v OR email = @v OR email_normalized = @v LIMIT 1'
  );
  restored.transaction(() => {
    const rows: Array<{ id: number; row: Record<string, unknown> }> = [];
    const reserved = new Set<string>(); // final values and generated values
    for (const id of userIds) {
      const row = frozenRows.find((r) => Number(r.id) === id);
      if (!row) continue;
      if (!exists.get(id)) {
        result.missing.push(id);
        continue;
      }
      rows.push({ id, row });
      for (const c of [
        'username',
        'username_normalized',
        'email',
        'email_normalized',
      ])
        if (typeof row[c] === 'string') reserved.add(row[c] as string);
    }
    const generate = (prefix: string, id: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const t = `${prefix} ${nextToken()} ${id}`;
        const e = `${t}@replay.invalid`;
        if (reserved.has(t) || reserved.has(e) || taken.get({ t, e })) continue;
        reserved.add(t);
        reserved.add(e);
        return { t, e };
      }
      throw new Error('post-restore: no collision-free temporary found');
    };
    // Deleted after the backup: deactivate and release the identifiers.
    for (const id of restoredById.keys())
      if (!frozenIds.has(id)) {
        tombstone.run({ id, ...generate('restore-removed', id) });
        result.removed.push(id);
      }
    for (const { id } of rows) stage.run({ id, ...generate('replay tmp', id) });
    for (const { id, row } of rows) {
      update.run({ ...row, id });
      result.replayed.push(id);
    }
    // Authority tables, replaced from the frozen database after the account
    // replay (same transaction, lineage already proven).
    const userIdsNow = new Set(
      (
        restored.prepare('SELECT id FROM users').all() as Array<{ id: number }>
      ).map((r) => Number(r.id))
    );
    const hasTable = (db: Database.Database, name: string) =>
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name) !== undefined;
    const columnsOf = (db: Database.Database, name: string) =>
      (
        db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
    const communityIdsNow = new Set(
      (
        restored.prepare('SELECT id FROM communities').all() as Array<{
          id: number;
        }>
      ).map((r) => Number(r.id))
    );
    for (const spec of RECONCILED_TABLES) {
      if (!hasTable(frozen, spec.name) || !hasTable(restored, spec.name))
        continue;
      const shared = columnsOf(frozen, spec.name).filter((c) =>
        columnsOf(restored, spec.name).includes(c)
      );
      const rowsF = frozen
        .prepare(`SELECT ${shared.join(', ')} FROM ${spec.name}`)
        .all() as Array<Record<string, unknown>>;
      restored.prepare(`DELETE FROM ${spec.name}`).run();
      const insert = restored.prepare(
        `INSERT INTO ${spec.name} (${shared.join(', ')}) VALUES (${shared.map((c) => '@' + c).join(', ')})`
      );
      const tally = { copied: 0, skipped: 0 };
      for (const r of rowsF) {
        // Skip (and count) rows naming a user or a community that has no
        // restored row (created after the backup): inserting them would fail
        // the foreign key and roll back the whole replay.
        const dangling =
          spec.userColumns.some(
            (c) =>
              r[c] !== null &&
              r[c] !== undefined &&
              !userIdsNow.has(Number(r[c]))
          ) ||
          (r.community_id !== null &&
            r.community_id !== undefined &&
            !communityIdsNow.has(Number(r.community_id)));
        if (dangling) tally.skipped++;
        else {
          insert.run(r);
          tally.copied++;
        }
      }
      result.reconciled[spec.name] = tally;
    }
    // Community enable/withdrawal flags.
    const cc = COMMUNITY_AUTHORITY_COLUMNS.join(', ');
    const setC = restored.prepare(
      `UPDATE communities SET ${COMMUNITY_AUTHORITY_COLUMNS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`
    );
    const restoredCommunities = new Map(
      (
        restored.prepare(`SELECT id, ${cc} FROM communities`).all() as Array<
          Record<string, unknown>
        >
      ).map((r) => [Number(r.id), r])
    );
    for (const fc of frozen
      .prepare(`SELECT id, ${cc} FROM communities`)
      .all() as Array<Record<string, unknown>>) {
      const rc = restoredCommunities.get(Number(fc.id));
      if (
        rc &&
        COMMUNITY_AUTHORITY_COLUMNS.some((c) => !Object.is(fc[c], rc[c]))
      ) {
        setC.run(fc);
        result.communitiesUpdated.push(Number(fc.id));
      }
    }
    // Accounts created after the backup cannot be re-created here; report any
    // identifier a restored account still holds so the re-creation will not fail.
    for (const id of result.missing) {
      const row = frozenRows.find((r) => Number(r.id) === id)!;
      for (const c of [
        'username',
        'username_normalized',
        'email',
        'email_normalized',
      ]) {
        const v = row[c];
        const held =
          typeof v === 'string'
            ? (holder.get({ v }) as { id: number } | undefined)
            : undefined;
        if (held) result.conflicts.push({ id, column: c, heldBy: held.id });
      }
    }
  })();
  if (result.conflicts.length > 0)
    console.warn(
      `post-restore: accounts created after the backup conflict with restored identifiers: ${JSON.stringify(result.conflicts)}`
    );
  if (result.removed.length > 0)
    console.warn(
      `post-restore: users deleted after the backup were restored and deactivated: ${result.removed.join(', ')}`
    );
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
  allowUnrelatedLineage?: boolean;
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
    else if (rest[i] === '--allow-unrelated-lineage') {
      // DANGEROUS: skips the ancestry check; ids may name different people.
      out.allowUnrelatedLineage = true;
      i -= 1; // flag takes no value
    } else if (rest[i] === '--after-audit-id') {
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
    // Always purge first: backup-era sessions, login codes and claim tokens must
    // never survive, even when the replay is refused. The replay's lineage and
    // identity checks run before any ACCOUNT write.
    const purge = applyPostRestoreSqlite(db);
    let replay: ReplayResult | undefined;
    if (args.replayFrom !== undefined) {
      const frozen = new Database(args.replayFrom, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        replay = replayAccountChanges(frozen, db, args.afterAuditId!, {
          allowUnrelatedLineage: args.allowUnrelatedLineage,
        });
        // The replay may restore credential material: purge sessions again.
        applyPostRestoreSqlite(db);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Sessions, login codes and claim tokens were purged.`
        );
      } finally {
        frozen.close();
      }
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
