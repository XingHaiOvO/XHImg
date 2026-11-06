import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { Store } from '../src/db.js';

test('an empty database initializes once and the installed site survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-init-'));
  const config = { dir, masterKey: 'ad'.repeat(32), publicUrl: 'http://localhost', workers: false };
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    runtime = await createApp(config);
    assert.equal((await runtime.app.inject('/health')).statusCode, 200);
    const credentials = { username: 'owner', password: 'test-password-12345' };
    assert.ok(runtime.setupToken);
    const installed = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { ...credentials, token: runtime.setupToken },
    });
    assert.equal(installed.statusCode, 201, installed.body);
    const history = runtime.ctx.db.all('SELECT name, applied_at FROM migrations ORDER BY name');
    assert.equal(history.length, 9);
    assert.equal(history.at(-1)?.name, '0009_mixed_random_default.sql');
    assert(history.every(({ applied_at }) => applied_at > 0));
    await runtime.app.close();
    runtime = undefined;

    runtime = await createApp(config);
    assert.equal(runtime.setupToken, undefined);
    assert.equal((await runtime.app.inject('/health')).statusCode, 200);
    assert.deepEqual(
      runtime.ctx.db.all('SELECT name, applied_at FROM migrations ORDER BY name'),
      history,
    );
    const login = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: credentials,
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(
      runtime.ctx.db.one("SELECT COUNT(*) AS n FROM random_endpoints WHERE id='global'")?.n,
      1,
    );
  } finally {
    await runtime?.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an existing database with the complete migration ledger retains data and timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-baseline-'));
  let store: Store | undefined;
  try {
    const sql = await readFile(new URL('../migrations/init.sql', import.meta.url), 'utf8');
    const database = new Database(join(dir, 'xhimg.sqlite'));
    try {
      database.exec(sql);
      database.exec(`
        UPDATE migrations SET applied_at=123;
        INSERT INTO random_endpoints (id,kind,name,slug,media_type,mode,calls)
        VALUES ('custom','custom','Mixed media','mixed-media','mixed','json',5);
        INSERT INTO random_rules (endpoint_id,kind,resource_id) VALUES ('custom','tag','landscape');
      `);
    } finally {
      database.close();
    }
    store = new Store(dir);
    assert.deepEqual(store.all('SELECT DISTINCT applied_at FROM migrations'), [
      { applied_at: 123 },
    ]);
    assert.deepEqual(
      store.one("SELECT slug, media_type, mode, calls FROM random_endpoints WHERE id='custom'"),
      { slug: 'mixed-media', media_type: 'mixed', mode: 'json', calls: 5 },
    );
    assert.equal(
      store.one("SELECT resource_id FROM random_rules WHERE endpoint_id='custom'")?.resource_id,
      'landscape',
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [kind, ledger] of [
  [
    'incompletely migrated',
    `
    CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO migrations VALUES ('0001.sql',1), ('0009_mixed_random_default.sql',2);
  `,
  ],
  ['unrecognized', ''],
] as const) {
  test(`an ${kind} database is refused without changing it`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhimg-reject-'));
    try {
      const path = join(dir, 'xhimg.sqlite');
      const database = new Database(path);
      try {
        database.exec(`
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO settings VALUES ('saved','original data');
          ${ledger}
        `);
      } finally {
        database.close();
      }
      const original = await readFile(path);
      assert.throws(() => new Store(dir), /先备份.*0001 至 0009/);
      assert.deepEqual(await readFile(path), original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
