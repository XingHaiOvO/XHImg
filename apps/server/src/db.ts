import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The typed query entry point is shared with maintenance tooling. Complex tree and
// authorization queries use parameterized SQLite statements in explicit transactions.
export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
export const administratorsTable = sqliteTable('administrators', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  password: text('password').notNull(),
  createdAt: integer('created_at').notNull(),
});
export type Row = Record<string, any>;
export class Store {
  sql: Database.Database;
  orm: ReturnType<typeof drizzle>;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    this.sql = new Database(join(dir, 'xhimg.sqlite'));
    this.sql.pragma('journal_mode = WAL');
    this.sql.pragma('foreign_keys = ON');
    this.sql.pragma('busy_timeout = 5000');
    this.orm = drizzle(this.sql);
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const file of readdirSync(migrationDir)
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      if (!this.one('SELECT name FROM migrations WHERE name=?', file))
        this.tx(() => {
          this.sql.exec(readFileSync(join(migrationDir, file), 'utf8'));
          this.run('INSERT INTO migrations VALUES (?,?)', file, Date.now());
        });
    }
  }
  one(query: string, ...args: any[]): Row | undefined {
    return this.sql.prepare(query).get(...args) as Row | undefined;
  }
  all(query: string, ...args: any[]): Row[] {
    return this.sql.prepare(query).all(...args) as Row[];
  }
  run(query: string, ...args: any[]) {
    return this.sql.prepare(query).run(...args);
  }
  tx<T>(fn: () => T): T {
    return this.sql.transaction(fn)();
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.orm.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown) {
    const serialized = JSON.stringify(value);
    this.orm
      .insert(settingsTable)
      .values({ key, value: serialized })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: serialized } })
      .run();
  }
  close() {
    this.sql.close();
  }
}
