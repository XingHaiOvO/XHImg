import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { candidateIds } from '../src/random.js';
import { Readable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
const dir = await mkdtemp(join(tmpdir(), 'xhimg-scale-'));
const { app, ctx } = await createApp({
  dir,
  masterKey: 'cd'.repeat(32),
  publicUrl: 'http://localhost:9521',
  workers: false,
});
try {
  // Isolate API work from disk/network variance. This is simulated storage,
  // not an S3 latency estimate; real S3 request counts are covered separately.
  const calls = { head: 0, get: 0 };
  ctx.storage.instances.set('local', {
    async head() {
      calls.head++;
      await setTimeout(1);
      return 100;
    },
    async get() {
      calls.get++;
      await setTimeout(1);
      return { stream: Readable.from(Buffer.alloc(100)), size: 100 };
    },
    async put() {},
    async delete() {},
    async test() {},
  });
  ctx.db.run("UPDATE random_endpoints SET enabled=1,rate_limit=0 WHERE id='global'");
  ctx.db.run(
    "UPDATE folders SET visibility='public',effective_visibility='public' WHERE id='uncategorized'",
  );
  const stmt = ctx.db.sql.prepare(
    "INSERT INTO images (id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,visibility,effective_visibility,created_at) VALUES (?,'uncategorized','local',?,'thumb','scale','jpg','image/jpeg',100,100,100,'hash','public','public',?)",
  );
  const endpoint = ctx.db.one("SELECT * FROM random_endpoints WHERE id='global'")!;
  const apiResults = [];
  for (const images of [1000, 100000]) {
    ctx.db.tx(() => {
      for (let i = images === 1000 ? 0 : 1000; i < images; i++)
        stmt.run('img_' + i, 'object_' + i, i);
    });
    for (const mode of ['json', 'redirect', 'image']) {
      ctx.invalidate();
      const request = async () => {
        const result = await app.inject(`/api/v1/random?mode=${mode}`);
        assert.equal(result.statusCode, mode === 'redirect' ? 302 : 200, result.body);
        if (mode === 'image') assert.equal(result.rawPayload.length, 100);
      };
      const coldStart = performance.now();
      await request();
      const coldMs = performance.now() - coldStart;
      for (let i = 0; i < 20; i++) await request();
      calls.head = calls.get = 0;
      const samples = [];
      const start = performance.now();
      for (let i = 0; i < 200; i++) {
        const before = performance.now();
        await request();
        samples.push(performance.now() - before);
      }
      const elapsed = performance.now() - start;
      assert.equal(calls.head, mode === 'image' ? 0 : 200);
      assert.equal(calls.get, mode === 'image' ? 200 : 0);
      samples.sort((a, b) => a - b);
      apiResults.push({
        images,
        mode,
        coldMs,
        p50Ms: samples[99],
        p95Ms: samples[189],
        requestsPerSecond: 200000 / elapsed,
        storageCalls: { ...calls },
      });
    }
  }
  ctx.invalidate();
  const buildStart = performance.now();
  const ids = candidateIds(ctx, endpoint, { type: 'anonymous' });
  const buildMs = performance.now() - buildStart;
  assert.equal(ids.length, 100000);
  const cachedStart = performance.now();
  for (let i = 0; i < 1000; i++)
    assert.equal(candidateIds(ctx, endpoint, { type: 'anonymous' }).length, 100000);
  const cachedMs = performance.now() - cachedStart;
  const queryPlan = ctx.db.all(
    "EXPLAIN QUERY PLAN SELECT id FROM images WHERE effective_visibility='public' AND state='ready' AND deleted_at IS NULL AND publication_hold=0",
  );
  assert(queryPlan.some((x) => String(x.detail).includes('image_candidates')));
  assert(!queryPlan.some((x) => /SCAN images/.test(x.detail)));
  assert(!queryPlan.some((x) => /TEMP B-TREE/.test(x.detail)));
  console.log(
    JSON.stringify(
      {
        images: ids.length,
        buildMs,
        cached1000Ms: cachedMs,
        rssMB: process.memoryUsage().rss / 1024 ** 2,
        queryPlan,
        apiResults,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
