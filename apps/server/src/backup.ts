import { resolve } from 'node:path';
import Database from 'better-sqlite3';
const target = process.argv[2];
if (!target) throw new Error('Usage: pnpm backup <absolute-destination.sqlite>');
// Backing up an older installation must not apply the new application's migrations.
const db = new Database(
  resolve(import.meta.dirname, '../../..', process.env.DATA_DIR ?? 'data', 'xhimg.sqlite'),
  { readonly: true, fileMustExist: true },
);
try {
  await db.backup(resolve(target));
  console.log('SQLite backup completed:', resolve(target));
} finally {
  db.close();
}
