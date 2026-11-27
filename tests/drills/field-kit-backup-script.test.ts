/**
 * field-kit-backup.sh portability and failure semantics (#136).
 *
 * The deployed backup container is Alpine (BusyBox ash, BusyBox cp/find), so
 * the script must be POSIX sh. These tests lint it as sh, run it under dash
 * and (when present) BusyBox ash, and prove a failed copy fails the backup.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';

const SCRIPT = path.join(process.cwd(), 'scripts/field-kit-backup.sh');
const HELPER = path.join(process.cwd(), 'scripts/ops/sqlite-backup.mjs');
const has = (tool: string) =>
  spawnSync(tool, ['--version']).error === undefined ||
  spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;

function tree() {
  const root = mkdtempSync(path.join(tmpdir(), 'tsapi-drill-script-'));
  const dirs = {
    root,
    data: path.join(root, 'data'),
    uploads: path.join(root, 'uploads'),
    backups: path.join(root, 'backups'),
  };
  for (const d of [dirs.data, dirs.uploads, dirs.backups])
    mkdirSync(d, { recursive: true });
  const db = new Sqlite(path.join(dirs.data, 'field-kit.db'));
  db.exec(
    "CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1); CREATE TABLE files (storage_key TEXT, is_active INTEGER); INSERT INTO files VALUES ('a.bin', 1);"
  );
  db.close();
  writeFileSync(path.join(dirs.uploads, 'a.bin'), 'bytes');
  return dirs;
}

function run(shell: string[], dirs: ReturnType<typeof tree>, extra = {}) {
  return spawnSync(shell[0]!, [...shell.slice(1), SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKUP_DIR: dirs.backups,
      DATA_DIR: dirs.data,
      UPLOADS_DIR: dirs.uploads,
      TILES_DIR: path.join(dirs.root, 'no-tiles'),
      SQLITE_BACKUP_HELPER: HELPER,
      ...extra,
    },
  });
}

const leftovers = (dirs: ReturnType<typeof tree>) =>
  readdirSync(dirs.backups).filter(
    (f) => f.startsWith('fieldkit_backup_') || f.startsWith('.partial')
  );

const archives = (dirs: ReturnType<typeof tree>) =>
  readdirSync(dirs.backups).filter((f) => f.endsWith('.tar.gz'));

describe('field-kit-backup.sh is POSIX sh (#136)', () => {
  it('has a sh shebang and no bash-only constructs', () => {
    const text = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    const code = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(
      /cp --parents|\[\[|<<<|\bfunction\b|\$\{[^}]*\/\/|&>/
    );
  });

  it('parses under dash', () => {
    expect(spawnSync('dash', ['-n', SCRIPT]).status).toBe(0);
  });

  it.skipIf(!has('shellcheck'))('passes shellcheck -s sh', () => {
    const r = spawnSync('shellcheck', ['-s', 'sh', SCRIPT], {
      encoding: 'utf8',
    });
    expect({ status: r.status, out: r.stdout }).toEqual({ status: 0, out: '' });
  });

  it('runs end to end under dash', () => {
    const dirs = tree();
    const r = run(['dash'], dirs);
    expect(r.status, r.stderr).toBe(0);
    expect(archives(dirs)).toHaveLength(1);
  });

  it.skipIf(!has('busybox'))('runs end to end under BusyBox ash', () => {
    const dirs = tree();
    const r = run(['busybox', 'sh'], dirs);
    expect(r.status, r.stderr).toBe(0);
    expect(archives(dirs)).toHaveLength(1);
  });

  it('fails, and writes no archive, when the database copy fails', () => {
    const dirs = tree();
    const r = run(['sh'], dirs, {
      SQLITE_BACKUP_HELPER: path.join(dirs.root, 'missing-helper.mjs'),
    });
    expect(r.status).not.toBe(0);
    expect(archives(dirs)).toHaveLength(0);
    expect(leftovers(dirs)).toEqual([]);
  });

  it('fails when a database row references a storage key that is not in the backup', () => {
    const dirs = tree();
    const db = new Sqlite(path.join(dirs.data, 'field-kit.db'));
    db.exec("INSERT INTO files VALUES ('deleted-after-snapshot.bin', 1)");
    db.close();
    const r = run(['sh'], dirs);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('deleted-after-snapshot.bin');
    expect(archives(dirs)).toHaveLength(0);
    expect(leftovers(dirs)).toEqual([]);
  });

  it('fails when the uploads directory is absent but the database references media', () => {
    const dirs = tree();
    const r = run(['sh'], dirs, {
      UPLOADS_DIR: path.join(dirs.root, 'no-such-uploads'),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('a.bin');
  });

  it('retention never touches payload files inside a completed backup', () => {
    const dirs = tree();
    const payload = path.join(
      dirs.uploads,
      '.partial-fieldkit_backup_payload.bin'
    );
    writeFileSync(payload, 'payload');
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(payload, old, old);
    const keep = { BACKUP_COMPRESSION: 'false' };
    expect(run(['sh'], dirs, keep).status).toBe(0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    expect(run(['sh'], dirs, keep).status).toBe(0);
    const backups = readdirSync(dirs.backups).filter((f) =>
      f.startsWith('fieldkit_backup_')
    );
    expect(backups).toHaveLength(2);
    for (const b of backups)
      expect(
        existsSync(
          path.join(
            dirs.backups,
            b,
            dirs.uploads,
            '.partial-fieldkit_backup_payload.bin'
          )
        )
      ).toBe(true);
  });

  it('removes stale hidden temp files at the top level', () => {
    const dirs = tree();
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const name of [
      '.fieldkit_backup_old.list',
      '.fieldkit_backup_old.keys',
    ]) {
      const f = path.join(dirs.backups, name);
      writeFileSync(f, 'x');
      utimesSync(f, old, old);
    }
    expect(run(['sh'], dirs).status).toBe(0);
    expect(
      readdirSync(dirs.backups).filter(
        (f) => f.endsWith('.list') || f.endsWith('.keys')
      )
    ).toEqual([]);
  });

  it('removes stale hidden .partial- leftovers on the retention pass', () => {
    const dirs = tree();
    const stale = path.join(
      dirs.backups,
      '.partial-fieldkit_backup_old.tar.gz'
    );
    writeFileSync(stale, 'x');
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(stale, old, old);
    const r = run(['sh'], dirs);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(stale)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails, and writes no archive, when an upload cannot be copied',
    () => {
      const dirs = tree();
      const locked = path.join(dirs.uploads, 'locked.bin');
      writeFileSync(locked, 'secret');
      chmodSync(locked, 0o000);
      try {
        const r = run(['sh'], dirs);
        expect(r.status).not.toBe(0);
        expect(archives(dirs)).toHaveLength(0);
        expect(leftovers(dirs)).toEqual([]);
        expect(existsSync(path.join(dirs.backups))).toBe(true);
      } finally {
        chmodSync(locked, 0o600);
      }
    }
  );
});
