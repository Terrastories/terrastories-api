/**
 * scripts/ops/post-restore.ts command line (#136): the SQLite form runs the
 * purge and the account replay; the PostgreSQL form takes its URL only from
 * DATABASE_URL, never from argv.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';

const CLI = path.join(process.cwd(), 'scripts/ops/post-restore.ts');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('npx', ['tsx', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

function makeDb(file: string, active: number) {
  const db = new Sqlite(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT);
    CREATE TABLE login_codes (used_at INTEGER, superseded_at INTEGER);
    CREATE TABLE claim_tokens (consumed_at INTEGER, superseded_at INTEGER);
    CREATE TABLE export_tokens (id INTEGER);
    CREATE TABLE audit_entries (id INTEGER PRIMARY KEY, action TEXT, actor_id INTEGER, resource_type TEXT, resource_ids TEXT, outcome TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, created_at INTEGER, is_active INTEGER, role TEXT, community_id INTEGER, password_hash TEXT, password_algorithm TEXT, password_salt TEXT, password_params TEXT, password_verifier TEXT, email TEXT, email_normalized TEXT, username TEXT, username_normalized TEXT, display_name TEXT, first_name TEXT, last_name TEXT);
    CREATE TABLE communities (id INTEGER PRIMARY KEY, slug TEXT, created_at INTEGER);
    INSERT INTO communities VALUES (1, 'a', 1);
    INSERT INTO audit_entries VALUES (1, 'auth.login', NULL, NULL, '[]', 'success');
    INSERT INTO sessions VALUES ('s');
    INSERT INTO users (id, is_active, role) VALUES (1, ${active}, 'viewer');
  `);
  return db;
}

describe('post-restore CLI', () => {
  it('sqlite: purges and replays account changes from the frozen database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsapi-drill-pr-'));
    const restored = makeDb(path.join(dir, 'restored.db'), 1);
    const frozen = makeDb(path.join(dir, 'frozen.db'), 0);
    frozen.exec(
      "INSERT INTO audit_entries VALUES (5, 'user.update', 9, 'user', '[1]', 'success')"
    );
    frozen.close();
    restored.close();
    const r = run([
      'sqlite',
      path.join(dir, 'restored.db'),
      '--replay-from',
      path.join(dir, 'frozen.db'),
      '--after-audit-id',
      '0',
    ]);
    expect(r.status, r.stderr).toBe(0);
    const check = new Sqlite(path.join(dir, 'restored.db'));
    expect(
      check.prepare('SELECT is_active FROM users WHERE id = 1').get()
    ).toEqual({
      is_active: 0,
    });
    expect(check.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
      n: 0,
    });
    check.close();
  });

  it('sqlite: an audit-empty restored database is refused and nothing changes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsapi-drill-pr-'));
    const restored = makeDb(path.join(dir, 'restored.db'), 1);
    restored.exec('DELETE FROM audit_entries');
    restored.close();
    makeDb(path.join(dir, 'frozen.db'), 0).close();
    const r = run([
      'sqlite',
      path.join(dir, 'restored.db'),
      '--replay-from',
      path.join(dir, 'frozen.db'),
      '--after-audit-id',
      '0',
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no audit entries');
    const check = new Sqlite(path.join(dir, 'restored.db'));
    expect(check.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
      n: 1,
    });
    check.close();
  });

  it.each(['abc', '-1', '1.5', '', '9'.repeat(309), '9007199254740992'])(
    'sqlite: rejects --after-audit-id %j instead of replaying nothing',
    (value) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'tsapi-drill-pr-'));
      makeDb(path.join(dir, 'restored.db'), 1).close();
      makeDb(path.join(dir, 'frozen.db'), 0).close();
      const r = run([
        'sqlite',
        path.join(dir, 'restored.db'),
        '--replay-from',
        path.join(dir, 'frozen.db'),
        '--after-audit-id',
        value,
      ]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('non-negative integer');
    }
  );

  it('postgres: refuses a URL on the command line and requires DATABASE_URL', () => {
    const viaArgv = run(['postgres', 'postgresql://u:p@localhost/db']);
    expect(viaArgv.status).toBe(2);
    expect(viaArgv.stderr).toContain('DATABASE_URL');
    expect(viaArgv.stderr).not.toContain(':p@');
    const noEnv = run(['postgres'], { DATABASE_URL: '' });
    expect(noEnv.status).toBe(2);
  });
});
