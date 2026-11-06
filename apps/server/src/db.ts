import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { readFileSync, mkdirSync } from 'node:fs';
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

const baselineMigrations = [
  '0001.sql',
  '0002_p1.sql',
  '0003_image_filenames.sql',
  '0004_storage_migrations.sql',
  '0005_migration_counters.sql',
  '0006_migration_indexes.sql',
  '0007_random_slug.sql',
  '0008_random_media_type.sql',
  '0009_mixed_random_default.sql',
];

export class Store {
  sql: Database.Database;
  orm: ReturnType<typeof drizzle>;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    this.sql = new Database(join(dir, 'xhimg.sqlite'));
    try {
      this.sql.pragma('busy_timeout = 5000');
      this.sql.pragma('foreign_keys = ON');
      this.sql.transaction(() => this.initializeSchema()).immediate();
      this.sql.pragma('journal_mode = WAL');
    } catch (error) {
      this.sql.close();
      throw error;
    }
    this.orm = drizzle(this.sql);
  }
  private initializeSchema() {
    const objects = this.all("SELECT type, name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'");
    if (!objects.length) {
      this.sql.exec(readFileSync(new URL('../migrations/init.sql', import.meta.url), 'utf8'));
      return;
    }
    if (
      objects.some(({ type, name }) => type === 'table' && name === 'migrations') &&
      this.one("SELECT 1 FROM pragma_table_info('migrations') WHERE name='name'")
    ) {
      const applied = new Set(this.all('SELECT name FROM migrations').map(({ name }) => name));
      if (baselineMigrations.every((name) => applied.has(name))) return;
    }
    throw new Error(
      '数据库结构无法识别或迁移尚未完成。已有 XHImg 实例请先备份，再用包含 0001 至 0009 迁移的旧版本（如 1b4777d）完成升级。',
    );
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
