import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalObjects } from '../src/storage.js';
import { cleanupLocalDirectories, pruneObjectDirectories } from '../src/local-directories.js';
import { createApp } from '../src/app.js';

test('object deletion and failed writes prune empty ancestors while preserving siblings and root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-empty-'));
  try {
    const root = join(dir, 'objects', 'local');
    const objects = new LocalObjects(root);
    const source = join(dir, 'source');
    await writeFile(source, 'actual bytes');
    await objects.put('migrations/item/one', source);
    await objects.put('migrations/item/two', source);
    await objects.delete('migrations/item/one');
    assert.equal(await readFile(join(root, 'migrations/item/two'), 'utf8'), 'actual bytes');
    await objects.delete('migrations/item/two');
    await objects.delete('migrations/item/two');
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(objects.put('failed/nested/object', join(dir, 'missing')));
    assert.deepEqual(await readdir(root), []);
    assert.equal(await pruneObjectDirectories(root, dir), 0);
    assert((await stat(dir)).isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent sibling writes and empty-directory cleanup preserve every successful object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-empty-race-'));
  try {
    const root = join(dir, 'objects', 'local');
    const objects = new LocalObjects(root);
    const source = join(dir, 'source');
    await writeFile(source, 'concurrent bytes');
    for (let i = 0; i < 30; i++) {
      await objects.put(`shared/${i}/old`, source);
      await Promise.all([
        objects.delete(`shared/${i}/old`),
        objects.put(`shared/${i}/new`, source),
        cleanupLocalDirectories(dir),
      ]);
      assert.equal(await readFile(join(root, `shared/${i}/new`), 'utf8'), 'concurrent bytes');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup removes legacy empty directories, retains roots/work/files, and never follows junctions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-empty-start-'));
  const outside = await mkdtemp(join(tmpdir(), 'xhimg-empty-outside-'));
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const root = join(dir, 'objects', 'deleted-config');
    await mkdir(join(root, 'old', 'nested'), { recursive: true });
    await mkdir(join(root, 'keep'), { recursive: true });
    await writeFile(join(root, 'keep', 'image'), 'preserve');
    await mkdir(join(outside, 'empty'), { recursive: true });
    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(
      outside,
      join(dir, 'objects', 'linked-root'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const name of ['tmp', 'work', 'resumable', 'migration-work'])
      await mkdir(join(dir, name, 'keep-empty'), { recursive: true });
    assert.equal(await pruneObjectDirectories(root, join(root, 'link', 'empty')), 0);
    runtime = await createApp({ dir, masterKey: 'ab'.repeat(32), workers: false });
    await assert.rejects(stat(join(root, 'old')), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'keep', 'image'), 'utf8'), 'preserve');
    assert((await stat(join(outside, 'empty'))).isDirectory());
    assert((await stat(root)).isDirectory());
    for (const name of ['tmp', 'work', 'resumable', 'migration-work'])
      assert((await stat(join(dir, name, 'keep-empty'))).isDirectory());
    assert.equal(await cleanupLocalDirectories(dir), 0);
  } finally {
    await runtime?.app.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
