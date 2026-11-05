import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/db.js';

test('slug migration preserves existing endpoints and rules and allows multiple unset slugs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-slug-migration-'));
  let store: Store | undefined;
  try {
    const legacy = new Database(join(dir, 'xhimg.sqlite'));
    try {
      legacy.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const migrations = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(migrations))
        .filter((f) => f.endsWith('.sql') && f < '0007')
        .sort()) {
        legacy.exec(await readFile(new URL(file, migrations), 'utf8'));
        legacy.prepare('INSERT INTO migrations VALUES (?,0)').run(file);
      }
      legacy.exec(
        "INSERT INTO random_endpoints (id,kind,name,calls) VALUES ('global','global','all images',42),('rnd_legacy','custom','legacy',7)",
      );
      legacy.exec(
        "INSERT INTO random_rules (endpoint_id,kind,resource_id) VALUES ('rnd_legacy','tag','landscape')",
      );
    } finally {
      legacy.close();
    }
    store = new Store(dir);
    assert.deepEqual(
      store.all('SELECT id,slug,calls,media_type FROM random_endpoints ORDER BY id'),
      [
        { id: 'global', slug: null, calls: 42, media_type: 'image' },
        { id: 'rnd_legacy', slug: null, calls: 7, media_type: 'image' },
      ],
    );
    assert.equal(
      store.one("SELECT resource_id FROM random_rules WHERE endpoint_id='rnd_legacy'")!.resource_id,
      'landscape',
    );
    store.run("UPDATE random_endpoints SET slug='wallpaper' WHERE id='global'");
    assert.throws(
      () => store!.run("UPDATE random_endpoints SET slug='wallpaper' WHERE id='rnd_legacy'"),
      /UNIQUE/,
    );
    store.close();
    store = undefined;
    store = new Store(dir);
    assert.equal(
      store.one("SELECT slug FROM random_endpoints WHERE id='global'")!.slug,
      'wallpaper',
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
