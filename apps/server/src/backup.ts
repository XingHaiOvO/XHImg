import { resolve } from 'node:path';
import { Store } from './db.js';
const target = process.argv[2];
if (!target) throw new Error('Usage: pnpm backup <absolute-destination.sqlite>');
const db = new Store(resolve(import.meta.dirname, '../../..', process.env.DATA_DIR ?? 'data'));
try {
  await db.sql.backup(resolve(target));
  console.log('SQLite backup completed:', resolve(target));
} finally {
  db.close();
}
