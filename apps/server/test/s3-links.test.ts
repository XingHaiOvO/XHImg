import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { S3Objects } from '../src/storage.js';
import { s3Fixture } from './s3-fixture.js';

async function fixture() {
  const remote = await s3Fixture(),
    dir = await mkdtemp(join(tmpdir(), 'xhimg-links-'));
  const runtime = await createApp({
    dir,
    masterKey: 'bc'.repeat(32),
    publicUrl: 'http://localhost:9521',
    workers: false,
  });
  const { app, ctx, worker } = runtime;
  await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: {
      token: runtime.setupToken,
      username: 'owner',
      password: 'signed-link-fixture-password',
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'owner', password: 'signed-link-fixture-password' },
  });
  const headers = {
    cookie: login.headers['set-cookie']!.toString().split(';')[0],
    'x-csrf-token': login.json().csrf,
  };
  const req = (method: any, url: string, payload?: any, custom: any = headers) =>
    app.inject({ method, url, payload, headers: custom });
  const backend = (
    await req('POST', '/api/v1/admin/storage-backends', {
      name: '隔离 S3',
      type: 's3',
      config: remote.config,
    })
  ).json();
  const folder = (
    await req('POST', '/api/v1/admin/folders', { name: '来源', visibility: 'public' })
  ).json();
  const png = await sharp({
    create: { width: 48, height: 32, channels: 4, background: '#44aabb88' },
  })
    .png()
    .toBuffer();
  const upload = async (options: Record<string, any> = {}, custom: any = headers) => {
    const query = new URLSearchParams({ storageId: backend.id, folderId: folder.id, ...options });
    const boundary = 'presigned-test';
    return req(
      'POST',
      '/api/v1/upload?' + query,
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="中文 空格.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      { ...custom, 'content-type': `multipart/form-data; boundary=${boundary}` },
    );
  };
  const list = async () => (await req('GET', '/api/v1/admin/images')).json().items;
  return {
    ...runtime,
    remote,
    backend,
    folder,
    png,
    headers,
    req,
    upload,
    list,
    close: async () => {
      await app.close();
      await remote.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const expiry = (url: string) => Number(new URL(url).searchParams.get('X-Amz-Expires'));
const bytes = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());

test('S3 URLs verify real SigV4, bytes and response headers; lists do not read or HEAD every object', async () => {
  const f = await fixture();
  try {
    const response = await f.upload();
    assert.equal(response.statusCode, 201, response.body);
    const image = response.json();
    assert(image.url.startsWith(f.remote.endpoint + '/bucket/'));
    assert(image.logicalUrl.startsWith(`/i/${image.id}?sig=`));
    assert(!response.body.includes(f.remote.config.secretAccessKey));
    assert(expiry(image.url) <= 300);
    const direct = await fetch(image.url);
    assert.equal(direct.status, 200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), f.png);
    assert.equal(direct.headers.get('cache-control'), 'private, no-store');
    assert.equal(direct.headers.get('content-type'), 'image/png');
    assert(
      direct.headers.get('content-disposition')!.includes(encodeURIComponent('中文 空格.png')),
    );
    const changed = new URL(image.url);
    changed.searchParams.set('previewRetry', '1');
    assert.equal((await fetch(changed)).status, 403);
    assert.equal((await f.req('GET', `/i/${image.id}`, undefined, {})).statusCode, 404);
    const redirect = await f.req('GET', image.logicalUrl);
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers['cache-control'], 'private, no-store');
    const rowForEtag = f.ctx.image(image.id);
    assert.equal(
      (
        await f.req('GET', image.logicalUrl, undefined, {
          ...f.headers,
          'if-none-match': `"${rowForEtag.checksum}-${rowForEtag.access_version}-original"`,
        })
      ).statusCode,
      302,
    );
    await f.worker.tick();
    const before = { ...f.remote.counts };
    const items = await f.list();
    assert.equal(f.remote.counts.head, before.head);
    assert.equal(f.remote.counts.get, before.get);
    assert(items[0].thumbnailUrlExpiresAt);
    assert.equal((await sharp(await bytes(items[0].thumbnailUrl)).metadata()).format, 'webp');
    const source = await f.req('GET', `/api/v1/admin/images/${image.id}/original`);
    assert.equal(
      (await f.req('GET', `/api/v1/admin/images/${image.id}/original`, undefined, {})).statusCode,
      401,
    );
    assert.equal(source.statusCode, 302);
    assert.equal(
      (await fetch(source.headers.location!)).headers
        .get('content-disposition')!
        .startsWith('attachment;'),
      true,
    );
    await f.req('PATCH', `/api/v1/admin/storage-backends/${f.backend.id}`, { enabled: false });
    assert.equal((await f.req('GET', `/i/${image.id}`)).statusCode, 302);
    const special = await f.ctx.storage.byId(f.backend.id).presign!('folder/中文 空格+?#.png', {
      expiresAt: Date.now() + 300_000,
      mime: 'image/png',
      disposition: 'inline',
    });
    f.remote.objects.set(new URL(special.url).pathname, { bytes: f.png, mime: 'image/png' });
    assert.deepEqual(await bytes(special.url), f.png);
    f.remote.state.now = () => image.urlExpiresAt + 1;
    assert.equal((await fetch(image.url)).status, 403);
  } finally {
    await f.close();
  }
});

test('S3 video streams only the requested bytes and cancels upstream on disconnect', async () => {
  const f = await fixture();
  try {
    // Transport uses arbitrary bytes here to test exact slicing independently of FFmpeg.
    const uploaded = await f.upload({ visibility: 'public' });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const { id } = uploaded.json();
    f.ctx.db.run("UPDATE images SET format='mp4',mime='video/mp4' WHERE id=?", id);
    const video = (
      await f.req('GET', '/api/v1/public/images?mediaType=video', undefined, {})
    ).json().items[0];
    assert.equal(video.url, `/i/${id}`);
    assert.equal(video.urlExpiresAt, undefined);
    const service = await f.req('POST', '/api/v1/admin/random-services', {
      kind: 'folder',
      folderId: f.folder.id,
      name: 'S3 视频',
      enabled: true,
      visibility: 'public',
      mediaType: 'video',
    });
    assert.equal(service.statusCode, 201, service.body);
    const jump = await f.req('GET', service.json().url, undefined, {});
    assert.equal(jump.statusCode, 302);
    assert.equal(jump.headers.location, video.url);
    const partial = await f.req('GET', jump.headers.location!, undefined, { range: 'bytes=2-9' });
    assert.equal(partial.statusCode, 206, partial.body);
    assert.equal(partial.headers['content-type'], 'video/mp4');
    assert.equal(partial.headers['content-disposition'], 'inline');
    assert.equal(partial.headers['content-range'], `bytes 2-9/${f.png.length}`);
    assert.deepEqual(partial.rawPayload, f.png.subarray(2, 10));
    assert.equal(f.remote.counts.get, 1);

    const closed = Promise.withResolvers<void>();
    f.remote.state.holdRange = (responseClosed) => void responseClosed.then(closed.resolve);
    const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const streaming = await fetch(url + video.url, {
      headers: { Range: 'bytes=0-9' },
      signal: controller.signal,
    });
    assert.equal(streaming.status, 206);
    controller.abort();
    await closed.promise;
    await f.req('PATCH', `/api/v1/admin/images/${id}`, { visibility: 'private' });
    assert.equal(
      (await f.req('GET', video.url, undefined, { range: 'bytes=0-9' })).statusCode,
      404,
    );
    assert.equal(f.remote.counts.get, 2);
    await f.req('PATCH', `/api/v1/admin/images/${id}`, { visibility: 'public' });
    for (const method of ['GET', 'HEAD'] as const) {
      const full = await f.req(method, jump.headers.location!, undefined, {});
      assert.equal(full.statusCode, 200, full.body);
      assert.equal(full.headers['content-type'], 'video/mp4');
      assert.equal(full.headers['content-disposition'], 'inline');
      assert.equal(full.headers['content-length'], String(f.png.length));
      assert.deepEqual(full.rawPayload, method === 'GET' ? f.png : Buffer.alloc(0));
    }
  } finally {
    await f.close();
  }
});

test('S3 links require current read scopes and inherit ancestor privacy; already issued URLs outlive app revocation', async () => {
  const f = await fixture();
  try {
    const key = (
      await f.req('POST', '/api/v1/admin/api-keys', {
        name: '只上传',
        permissions: ['upload'],
        grants: [
          { kind: 'folder', resourceId: f.folder.id },
          { kind: 'storage', resourceId: f.backend.id },
        ],
      })
    ).json();
    const upload = await f.upload({}, { authorization: 'Bearer ' + key.key });
    assert.equal(upload.statusCode, 201, upload.body);
    assert(!upload.json().url.includes('X-Amz-Signature'));
    assert(!upload.json().urlExpiresAt);
    const image = (await f.upload({ visibility: 'public' })).json();
    const publicItems = (await f.req('GET', '/api/v1/public/images', undefined, {})).json().items;
    assert.equal(publicItems.length, 1);
    assert(publicItems[0].urlExpiresAt);
    assert(!('storageId' in publicItems[0]));
    await f.req('PATCH', `/api/v1/admin/folders/${f.folder.id}`, { visibility: 'private' });
    assert.equal(
      (await f.req('GET', '/api/v1/public/images', undefined, {})).json().items.length,
      0,
    );
    assert.equal((await f.req('GET', `/i/${image.id}`, undefined, {})).statusCode, 404);
    assert.deepEqual(await bytes(image.url), f.png);
    const reader = (
      await f.req('POST', '/api/v1/admin/api-keys', {
        name: '私有读取',
        permissions: ['read', 'private:read'],
        expires: Date.now() + 45_000,
        grants: [{ kind: 'folder', resourceId: f.folder.id }],
      })
    ).json();
    const custom = { authorization: 'Bearer ' + reader.key };
    const readable = (
      await f.req('GET', `/api/v1/folders/${f.folder.id}/images`, undefined, custom)
    ).json().items[0];
    assert(
      readable.urlExpiresAt <=
        f.ctx.db.one('SELECT expires FROM api_keys WHERE id=?', reader.id)!.expires,
    );
    assert(expiry(readable.url) <= 45);
    f.ctx.db.run('UPDATE api_keys SET expires=1 WHERE id=?', reader.id);
    assert.equal(
      (await f.req('GET', `/api/v1/folders/${f.folder.id}/images`, undefined, custom)).statusCode,
      401,
    );
    f.ctx.db.run('UPDATE api_keys SET expires=? WHERE id=?', Date.now() + 45_000, reader.id);
    await f.req('DELETE', `/api/v1/admin/api-keys/${reader.id}`);
    assert.equal((await f.req('GET', readable.logicalUrl, undefined, custom)).statusCode, 404);
    assert.equal(
      (await f.req('GET', `/api/v1/folders/${f.folder.id}/images`, undefined, custom)).statusCode,
      401,
    );
    assert.deepEqual(await bytes(readable.url), f.png);
  } finally {
    await f.close();
  }
});

test('S3 signing excludes trash, publication holds and pending thumbnails; committed uploads survive signing failure', async () => {
  const f = await fixture();
  try {
    const image = (await f.upload()).json();
    assert.equal(image.thumbnailUrlExpiresAt, undefined);
    f.ctx.db.run('UPDATE images SET publication_hold=1 WHERE id=?', image.id);
    const held = (await f.list())[0];
    assert.equal(held.urlExpiresAt, undefined);
    f.ctx.db.run('UPDATE images SET publication_hold=0 WHERE id=?', image.id);
    await f.req('DELETE', `/api/v1/admin/images/${image.id}`);
    const trash = (await f.req('GET', '/api/v1/admin/images?trash=true')).json().items[0];
    assert.equal(trash.urlExpiresAt, undefined);
    assert.equal((await f.req('GET', `/i/${image.id}`)).statusCode, 404);
    const raw = f.ctx.storage.instances.get(f.backend.id)!;
    const signing = raw.presign!.bind(raw);
    raw.presign = async () => {
      throw new Error('isolated failure');
    };
    const response = await f.upload();
    assert.equal(response.statusCode, 201, response.body);
    const fallback = response.json();
    assert.equal(fallback.urlExpiresAt, undefined);
    assert.equal(f.ctx.image(fallback.id).state, 'ready');
    assert.equal((await f.req('GET', `/i/${fallback.id}`)).statusCode, 503);
    assert.equal(f.ctx.image(fallback.id).state, 'ready');
    raw.presign = signing;
    f.remote.state.unavailable = true;
    assert.equal((await f.req('GET', `/i/${fallback.id}`)).statusCode, 503);
    assert.equal(f.ctx.image(fallback.id).state, 'ready');
    f.remote.state.unavailable = false;
    const row = f.ctx.image(fallback.id);
    f.remote.objects.delete('/bucket/' + row.object_key);
    assert.equal((await f.req('GET', `/i/${fallback.id}`)).statusCode, 404);
    assert.equal(f.ctx.image(fallback.id).state, 'missing');
  } finally {
    await f.close();
  }
});

test('S3 random json and redirect use direct links while image mode still streams actual bytes', async () => {
  const f = await fixture();
  try {
    const image = (await f.upload({ visibility: 'public' })).json();
    await f.worker.tick();
    await f.req('PUT', '/api/v1/admin/random-services/global', {
      kind: 'global',
      name: '全站',
      enabled: true,
      visibility: 'public',
      rateLimit: 0,
    });
    const beforeJson = { ...f.remote.counts };
    const json = await f.req('GET', '/api/v1/random?mode=json', undefined, {});
    assert.equal(json.statusCode, 200, json.body);
    assert.equal(f.remote.counts.head - beforeJson.head, 1);
    assert.equal(f.remote.counts.get - beforeJson.get, 0);
    assert(json.json().urlExpiresAt);
    assert.deepEqual(await bytes(json.json().url), f.png);
    const beforeRedirect = { ...f.remote.counts };
    const redirect = await f.req('GET', '/api/v1/random?mode=redirect', undefined, {});
    assert.equal(redirect.statusCode, 302);
    assert.equal(f.remote.counts.head - beforeRedirect.head, 1);
    assert.equal(f.remote.counts.get - beforeRedirect.get, 0);
    assert(redirect.headers.location!.startsWith(f.remote.endpoint));
    const beforeImage = { ...f.remote.counts };
    const stream = await f.req('GET', '/api/v1/random?mode=image', undefined, {});
    assert.equal(stream.statusCode, 200);
    assert.equal(f.remote.counts.head - beforeImage.head, 0);
    assert.equal(f.remote.counts.get - beforeImage.get, 1);
    assert.deepEqual(stream.rawPayload, f.png);
    assert.equal(stream.headers['cache-control'], 'private, no-store');
    const service = f.ctx.db.one('SELECT * FROM random_endpoints WHERE id=?', 'global')!;
    assert.equal(service.calls, 3);
    assert.equal(service.successes, 3);
    assert.equal(json.json().logicalUrl, `/i/${image.id}`);
  } finally {
    await f.close();
  }
});

test('S3 signing rechecks authorization after await and bounds app-signed redirects by issuer expiry', async () => {
  const f = await fixture();
  try {
    const image = (await f.upload({ visibility: 'public' })).json();
    const raw = f.ctx.storage.instances.get(f.backend.id)!;
    const signing = raw.presign!.bind(raw);
    let changed = false;
    raw.presign = async (key, options) => {
      const result = await signing(key, options);
      if (!changed) {
        changed = true;
        f.ctx.db.run("UPDATE images SET visibility='private' WHERE id=?", image.id);
        f.ctx.access.refresh();
      }
      return result;
    };
    const response = await f.req('GET', '/api/v1/public/images', undefined, {});
    assert.equal(response.statusCode, 404);
    raw.presign = signing;
    const actor = f.ctx.db.one('SELECT * FROM sessions')!;
    f.ctx.db.run('UPDATE sessions SET expires=? WHERE hash=?', Date.now() + 60_000, actor.hash);
    const row = f.ctx.image(image.id),
      until = Date.now() + 20_000;
    const sig = f.ctx.secrets.sign({
      imageId: image.id,
      version: row.access_version,
      variant: 'original',
      actorType: 'admin',
      issuer: actor.hash,
      expires: until,
    });
    const redirect = await f.req('GET', `/i/${image.id}?sig=${sig}`, undefined, {});
    assert.equal(redirect.statusCode, 302);
    assert(expiry(redirect.headers.location!) <= 20);
    const direct = (await f.list())[0];
    assert(
      direct.urlExpiresAt <=
        f.ctx.db.one('SELECT expires FROM sessions WHERE hash=?', actor.hash)!.expires,
    );
    f.ctx.db.run('UPDATE sessions SET expires=1 WHERE hash=?', actor.hash);
    assert.equal((await f.req('GET', `/i/${image.id}?sig=${sig}`, undefined, {})).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('S3 endpoint resolution supplies exact CSP origins for path and virtual-host styles', async () => {
  const f = await fixture();
  const virtual = new S3Objects({
    ...f.remote.config,
    endpoint: 'https://s3.example.test',
    forcePathStyle: false,
  });
  try {
    const link = await virtual.presign('folder/中文 空格.png', {
      expiresAt: Date.now() + 300_000,
      mime: 'image/png',
      disposition: 'inline',
    });
    assert.equal(new URL(link.url).origin, 'https://bucket.s3.example.test');
    const virtualRow = (
      await f.req('POST', '/api/v1/admin/storage-backends', {
        name: '虚拟主机',
        type: 's3',
        config: { ...f.remote.config, endpoint: 'https://s3.example.test', forcePathStyle: false },
      })
    ).json();
    assert(virtualRow.id);
    const headers = (await f.req('GET', '/health')).headers;
    assert(headers['content-security-policy']!.includes(f.remote.endpoint));
    assert(headers['content-security-policy']!.includes('https://bucket.s3.example.test'));
    assert(!headers['content-security-policy']!.includes('img-src *'));
    assert(!headers['content-security-policy']!.includes('X-Amz-Signature'));
  } finally {
    virtual.client.destroy();
    await f.close();
  }
});

test('S3 asynchronous receipts, classification, overview and edits decorate the current processed object after commit', async () => {
  const f = await fixture();
  try {
    const upload = await f.upload({
      processing: JSON.stringify({ enabled: true, targetFormat: 'webp' }),
    });
    assert.equal(upload.statusCode, 202, upload.body);
    const pending = upload.json();
    assert.equal(pending.urlExpiresAt, undefined);
    const initial = (await f.req('GET', pending.statusUrl)).json();
    assert.equal(initial.image.urlExpiresAt, undefined);
    for (let i = 0; i < 4 && f.ctx.image(pending.imageId).thumbnail_state !== 'ready'; i++)
      await f.worker.tick();
    const receipt = (await f.req('GET', pending.statusUrl)).json();
    assert.equal(receipt.state, 'ready');
    assert(receipt.image.urlExpiresAt);
    assert.equal((await sharp(await bytes(receipt.image.url)).metadata()).format, 'webp');
    const renamed = (
      await f.req('PATCH', `/api/v1/admin/images/${pending.imageId}`, { name: '更新后的名称.webp' })
    ).json();
    assert(renamed.urlExpiresAt);
    assert.equal(renamed.id, pending.imageId);
    assert(
      (await fetch(renamed.url)).headers
        .get('content-disposition')!
        .includes(encodeURIComponent(renamed.name)),
    );
    const original = await f.req('GET', `/api/v1/admin/images/${pending.imageId}/original`);
    assert.deepEqual(await bytes(original.headers.location!), f.png);
    f.ctx.db.run("UPDATE images SET classification_status='completed' WHERE id=?", pending.imageId);
    const classified = (await f.req('GET', '/api/v1/admin/classification')).json().items[0];
    assert(classified.urlExpiresAt);
    const overview = (await f.req('GET', '/api/v1/admin/overview')).json().recent[0];
    assert(overview.urlExpiresAt);
    assert.equal(overview.id, pending.imageId);
    assert.equal(overview.logicalUrl.split('?')[0], `/i/${pending.imageId}`);
  } finally {
    await f.close();
  }
});
