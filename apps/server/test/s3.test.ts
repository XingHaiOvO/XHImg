import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Objects, ObjectMissing } from '../src/storage.js';
import { createApp } from '../src/app.js';
import sharp from 'sharp';

test('real AWS SDK streams objects through an isolated S3 HTTP fixture and handles failures', async () => {
  const objects = new Map<string, Buffer>();
  let unavailable = false,
    authorized = false;
  const server = createServer(async (req, res) => {
    authorized ||= !!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256');
    if (unavailable) {
      res.writeHead(503, { 'content-type': 'application/xml' });
      res.end('<Error><Code>ServiceUnavailable</Code></Error>');
      return;
    }
    const key = new URL(req.url!, 'http://localhost').pathname;
    if (key === '/bucket/' || key === '/bucket') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"test-etag"' });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    const value = objects.get(key);
    if (!value) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    res.writeHead(200, { 'content-length': value.length, 'content-type': 'image/png' });
    res.end(req.method === 'HEAD' ? undefined : value);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-s3-')),
    file = join(dir, 'image');
  const payload = Buffer.from('streamed-content-'.repeat(10000));
  await writeFile(file, payload);
  const adapter = new S3Objects({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    bucket: 'bucket',
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
    forcePathStyle: true,
  });
  try {
    await adapter.test();
    await adapter.put('originals/test.png', file, 'image/png');
    assert(authorized);
    // AWS may use aws-chunked transfer with a trailing checksum; SDK transport must
    // preserve actual object bytes. Explicitly catch accidental chunk persistence.
    assert.equal(await adapter.head('originals/test.png'), payload.length);
    const result = await adapter.get('originals/test.png'),
      chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), payload);
    await adapter.delete('originals/test.png');
    await assert.rejects(() => adapter.head('originals/test.png'), ObjectMissing);
    unavailable = true;
    await assert.rejects(() => adapter.head('any'));
    unavailable = false;
    const runtime = await createApp({
      dir: join(dir, 'application'),
      masterKey: 'ef'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    try {
      const { app, ctx, worker } = runtime;
      await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: { token: runtime.setupToken, username: 'owner', password: 's3-test-password-123' },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'owner', password: 's3-test-password-123' },
      });
      const headers = {
        cookie: login.headers['set-cookie']!.toString().split(';')[0]!,
        'x-csrf-token': login.json().csrf,
      };
      const backend = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/storage-backends',
        headers,
        payload: { name: 'S3 fixture', type: 's3', config: adapter.config },
      });
      assert.equal(backend.statusCode, 201, backend.body);
      const png = await sharp({
        create: { width: 25, height: 15, channels: 3, background: 'blue' },
      })
        .png()
        .toBuffer();
      const boundary = 's3-upload-boundary';
      const upload = await app.inject({
        method: 'POST',
        url: `/api/v1/upload?storageId=${backend.json().id}`,
        headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s3.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          png,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const image = upload.json();
      assert(!upload.body.includes('test-secret'));
      assert(!upload.body.includes('http://127.0.0.1'));
      assert.equal((await app.inject({ url: image.url })).statusCode, 404);
      const bytes = await app.inject({ url: image.url, headers });
      assert.deepEqual(bytes.rawPayload, png);
      await worker.tick();
      assert.equal(ctx.image(image.id).thumbnail_state, 'ready');
      assert.equal((await app.inject({ url: image.thumbnailUrl, headers })).statusCode, 200);
      const processed = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/images/${image.id}/reprocess`,
        headers,
        payload: { processing: { targetFormat: 'webp' } },
      });
      assert.equal(processed.statusCode, 200, processed.body);
      await worker.tick();
      await worker.tick();
      assert.equal(ctx.image(image.id).format, 'webp');
      assert.equal(
        (await sharp((await app.inject({ url: image.url, headers })).rawPayload).metadata()).format,
        'webp',
      );
      assert.deepEqual(
        (await app.inject({ url: `/api/v1/admin/images/${image.id}/original`, headers }))
          .rawPayload,
        png,
      );
      unavailable = true;
      const failure = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/storage-backends/${backend.json().id}/test`,
        headers,
      });
      assert.equal(failure.statusCode, 503, failure.body);
      unavailable = false;
      await app.inject({ method: 'DELETE', url: `/api/v1/admin/images/${image.id}`, headers });
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/images/${image.id}/permanent`,
        headers,
      });
      await worker.tick();
      assert.equal(ctx.db.one('SELECT id FROM images WHERE id=?', image.id), undefined);
      assert(![...objects.keys()].some((key) => key.includes(image.id)));
    } finally {
      await runtime.app.close();
    }
  } finally {
    adapter.client.destroy();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  }
});
