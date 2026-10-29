// Opt-in local observation, not a 2GB VPS capacity assertion.
import { mkdtemp, rm, stat, open, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from '../src/image-processing.js';
import { createApp } from '../src/app.js';
import { fileHash } from '../src/policies.js';
const dir = await mkdtemp(join(tmpdir(), 'xhimg-resources-'));
const runtime = await createApp({
  dir,
  masterKey: 'ac'.repeat(32),
  publicUrl: 'http://127.0.0.1',
  workers: false,
});
try {
  const path = join(dir, '100mb.png');
  await sharp({ create: { width: 5900, height: 5900, channels: 3, background: '#4499cc' } })
    .png({ compressionLevel: 0 })
    .toFile(path);
  // Pad using a valid ancillary PNG chunk, retaining the real image's pixel count.
  const target = 100 * 1024 * 1024,
    size = (await stat(path)).size,
    padding = Buffer.alloc(target - size - 12);
  const type = Buffer.from('xhIM'),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(padding.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, padding])));
  const handle = await open(path, 'r+');
  const end = Buffer.alloc(12);
  await handle.read(end, 0, 12, size - 12);
  await handle.write(
    Buffer.concat([length, type, padding, crc, end]),
    0,
    target - size + 12,
    size - 12,
  );
  await handle.close();
  assert.equal((await stat(path)).size, target);
  const { app, ctx, worker } = runtime;
  await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: { token: runtime.setupToken, username: 'owner', password: 'resource-observation-123' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'owner', password: 'resource-observation-123' },
  });
  const auth = {
    cookie: login.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': login.json().csrf,
  };
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
  const start = performance.now(),
    cpu = process.cpuUsage();
  try {
    const hash = await fileHash(path),
      metadata = {
        filename: '100mb.png',
        sha256: hash,
        processing: JSON.stringify({ enabled: true, targetFormat: 'jpg', maxWidth: 1600 }),
      };
    const created = await fetch(base + '/api/v1/resumable', {
      method: 'POST',
      headers: {
        ...auth,
        'tus-resumable': '1.0.0',
        'upload-length': String(target),
        'upload-metadata': Object.entries(metadata)
          .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
          .join(','),
      },
    });
    assert.equal(created.status, 201, await created.text());
    const url = created.headers.get('location')!;
    let offset = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
      const response = await fetch(base + url, {
        method: 'PATCH',
        headers: {
          ...auth,
          'tus-resumable': '1.0.0',
          'upload-offset': String(offset),
          'x-chunk-sha256': createHash('sha256').update(chunk).digest('hex'),
          'content-type': 'application/offset+octet-stream',
        },
        body: chunk,
      });
      assert.equal(response.status, 204, await response.text());
      offset += chunk.length;
    }
    for (let i = 0; i < 4; i++) await worker.tick();
    const image = ctx.db.one('SELECT * FROM images')!;
    assert.equal(image.processing_status, 'completed');
    assert.equal(image.thumbnail_state, 'ready');
    assert.equal(image.width, 1600);
    const usage = process.cpuUsage(cpu);
    const report = {
      fileBytes: target,
      pixels: 5900 * 5900,
      chunkBytes: 4 * 1024 * 1024,
      elapsedSeconds: (performance.now() - start) / 1000,
      cpuSeconds: (usage.user + usage.system) / 1e6,
      baselineRssMiB: baseline / 1024 ** 2,
      observedPeakRssMiB: peak / 1024 ** 2,
      retainedOriginalBytes: image.source_size,
      resultBytes: image.size,
      node: process.version,
      platform: process.platform,
      scope:
        'single process, local disk, real HTTP, 100MiB PNG to 1600px JPG plus thumbnail; excludes fixture generation; not a 2GB VPS benchmark',
    };
    await mkdir(resolve('../../.cache'), { recursive: true });
    await writeFile(resolve('../../.cache/p1-resources.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(sampler);
  }
} finally {
  await runtime.app.close();
  await rm(dir, { recursive: true, force: true });
}
