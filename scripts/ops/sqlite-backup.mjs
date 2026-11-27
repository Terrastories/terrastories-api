// Online SQLite backup (better-sqlite3 backup API): a consistent copy of a
// live database for scripts/field-kit-backup.sh. Usage: node sqlite-backup.mjs <src> <dest>
import Database from 'better-sqlite3';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: sqlite-backup.mjs <src> <dest>');
  process.exit(2);
}
const db = new Database(src, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}
