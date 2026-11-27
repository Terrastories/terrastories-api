// Online SQLite backup (better-sqlite3 backup API): a consistent copy of a
// live database for scripts/field-kit-backup.sh.
//   node sqlite-backup.mjs <src> <dest>        copy
//   node sqlite-backup.mjs --storage-keys <db> print the active file storage keys
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
if (args[0] === '--storage-keys' && args[1]) {
  const db = new Database(args[1], { readonly: true, fileMustExist: true });
  try {
    const hasFiles = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'"
      )
      .get();
    if (hasFiles)
      for (const row of db
        .prepare(
          'SELECT storage_key AS k FROM files WHERE storage_key IS NOT NULL AND is_active = 1'
        )
        .all())
        console.log(row.k);
  } finally {
    db.close();
  }
} else {
  const [src, dest] = args;
  if (!src || !dest) {
    console.error(
      'usage: sqlite-backup.mjs <src> <dest> | --storage-keys <db>'
    );
    process.exit(2);
  }
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
}
