import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/db.js';

async function legacyDatabase(dir: string, before: string, seed: string) {
  const legacy = new Database(join(dir, 'xhimg.sqlite'));
  try {
    legacy.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql') && f < before)
      .sort()) {
      legacy.exec(await readFile(new URL(file, migrations), 'utf8'));
      legacy.prepare('INSERT INTO migrations VALUES (?,0)').run(file);
    }
    legacy.exec(seed);
  } finally {
    legacy.close();
  }
}

test('slug migration preserves existing endpoints and rules and allows multiple unset slugs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-slug-migration-'));
  let store: Store | undefined;
  try {
    await legacyDatabase(
      dir,
      '0007',
      `INSERT INTO random_endpoints (id,kind,name,calls) VALUES
        ('global','global','all images',42),('rnd_legacy','custom','legacy',7);
       INSERT INTO random_rules (endpoint_id,kind,resource_id) VALUES ('rnd_legacy','tag','landscape');`,
    );
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

test('mixed media migration replaces only image defaults and preserves service identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-mixed-migration-'));
  let store: Store | undefined;
  try {
    await legacyDatabase(
      dir,
      '0009',
      `INSERT INTO random_endpoints (id,kind,name,slug,media_type,mode,calls) VALUES
        ('a','global','images',NULL,'image','image',3),
        ('b','custom','legacy mixed','mixed-media','mixed','image',5),
        ('c','custom','mixed JSON',NULL,'mixed','json',7),
        ('d','custom','mixed redirect',NULL,'mixed','redirect',9);
       INSERT INTO random_rules (endpoint_id,kind,resource_id) VALUES ('b','tag','landscape');`,
    );
    store = new Store(dir);
    assert.deepEqual(store.all('SELECT id,slug,mode,calls FROM random_endpoints ORDER BY id'), [
      { id: 'a', slug: null, mode: 'image', calls: 3 },
      { id: 'b', slug: 'mixed-media', mode: 'redirect', calls: 5 },
      { id: 'c', slug: null, mode: 'json', calls: 7 },
      { id: 'd', slug: null, mode: 'redirect', calls: 9 },
    ]);
    assert.equal(
      store.one("SELECT resource_id FROM random_rules WHERE endpoint_id='b'")!.resource_id,
      'landscape',
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
