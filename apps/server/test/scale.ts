import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { candidateIds } from '../src/random.js';
const dir = await mkdtemp(join(tmpdir(), 'xhimg-scale-'));
const { app, ctx } = await createApp({
  dir,
  masterKey: 'cd'.repeat(32),
  publicUrl: 'http://localhost:9521',
  workers: false,
});
try {
  ctx.db.run(
    "UPDATE folders SET visibility='public',effective_visibility='public' WHERE id='uncategorized'",
  );
  const stmt = ctx.db.sql.prepare(
    "INSERT INTO images (id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,visibility,effective_visibility,created_at) VALUES (?,'uncategorized','local',?,'thumb','scale','jpg','image/jpeg',100,100,100,'hash','public','public',?)",
  );
  const start = performance.now();
  ctx.db.tx(() => {
    for (let i = 0; i < 100000; i++) stmt.run('img_' + i, 'object_' + i, i);
  });
  const insertMs = performance.now() - start;
  const endpoint = ctx.db.one("SELECT * FROM random_endpoints WHERE id='global'")!;
  const buildStart = performance.now();
  const ids = candidateIds(ctx, endpoint, { type: 'anonymous' });
  const buildMs = performance.now() - buildStart;
  assert.equal(ids.length, 100000);
  const cachedStart = performance.now();
  for (let i = 0; i < 1000; i++)
    assert.equal(candidateIds(ctx, endpoint, { type: 'anonymous' }).length, 100000);
  const cachedMs = performance.now() - cachedStart;
  const queryPlan = ctx.db.all(
    "EXPLAIN QUERY PLAN SELECT id FROM images WHERE effective_visibility='public' AND state='ready' AND deleted_at IS NULL ORDER BY id",
  );
  assert(queryPlan.some((x) => String(x.detail).includes('image_candidates')));
  assert(!queryPlan.some((x) => /SCAN images/.test(x.detail)));
  console.log(
    JSON.stringify(
      {
        images: ids.length,
        insertMs,
        buildMs,
        cached1000Ms: cachedMs,
        rssMB: process.memoryUsage().rss / 1024 ** 2,
        queryPlan,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
