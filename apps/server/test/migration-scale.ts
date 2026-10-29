import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMigration, migrationAction } from '../src/migrations.js';
const dir = await mkdtemp(join(tmpdir(), 'xhimg-migration-scale-'));
const runtime = await createApp({
  dir,
  masterKey: 'bf'.repeat(32),
  publicUrl: 'http://localhost',
  workers: false,
});
try {
  const { db } = runtime.ctx;
  db.run("INSERT INTO storage_backends VALUES ('destination','Destination','local','{}',1,0)");
  const insert = db.sql.prepare(
    "INSERT INTO images(id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,thumbnail_state,created_at) VALUES (?,'uncategorized','local',? ,?,'scale.png','png','image/png',100,10,10,'fixture','ready',?)",
  );
  db.tx(() => {
    for (let i = 0; i < 100000; i++) insert.run('img_' + i, 'objects/' + i, 'thumbnails/' + i, i);
  });
  const started = performance.now(),
    task = createMigration(runtime.ctx, {
      targetStorageId: 'destination',
      sourceStorageId: 'local',
    }),
    previewMs = performance.now() - started;
  assert.equal(task.total_count, 100000);
  assert.equal(task.skipped_count, 0);
  const begin = performance.now();
  migrationAction(runtime.ctx, task.id, 'start');
  const startMs = performance.now() - begin;
  const plan = db.all(
    "EXPLAIN QUERY PLAN SELECT * FROM migration_items INDEXED BY migration_items_task WHERE task_id=? AND state='pending' AND next_run<=? ORDER BY created_at,id LIMIT 1",
    task.id,
    Date.now(),
  );
  assert(plan.some((row) => String(row.detail).includes('migration_items_task')));
  assert(!plan.some((row) => String(row.detail).includes('TEMP B-TREE')));
  const pagePlan = db.all(
    'EXPLAIN QUERY PLAN SELECT * FROM migration_items WHERE task_id=? ORDER BY created_at,id LIMIT 40 OFFSET 40000',
    task.id,
  );
  assert(pagePlan.some((row) => String(row.detail).includes('migration_items_pages')));
  const queryStart = performance.now();
  for (let i = 0; i < 1000; i++)
    assert(
      db.one(
        "SELECT id FROM migration_items INDEXED BY migration_items_task WHERE task_id=? AND state='pending' AND next_run<=? ORDER BY created_at,id LIMIT 1",
        task.id,
        Date.now(),
      ),
    );
  const report = {
    images: 100000,
    previewMs,
    startMs,
    queue1000Ms: performance.now() - queryStart,
    rssMiB: process.memoryUsage().rss / 1024 ** 2,
    plan,
    pagePlan,
  };
  await mkdir(resolve('../../.cache'), { recursive: true });
  await writeFile(resolve('../../.cache/p2-scale.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.app.close();
  await rm(dir, { recursive: true, force: true });
}
