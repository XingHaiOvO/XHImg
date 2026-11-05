import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, mkdir, cp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { ObjectMissing, type Objects } from '../src/storage.js';

test('random service slugs normalize, validate, preserve omitted values and release old aliases', async () => {
  const f = await fixture();
  try {
    const body = {
      kind: 'custom',
      name: 'wallpapers',
      visibility: 'public',
      enabled: true,
      rateLimit: 0,
    };
    const created = await f.request('POST', '/api/v1/admin/random-services', {
      ...body,
      slug: ' Wallpaper ',
    });
    assert.equal(created.statusCode, 201, created.body);
    const service = created.json();
    const path = `/api/v1/admin/random-services/${service.id}`;
    assert.equal(service.slug, 'wallpaper');
    assert.equal(service.url, '/api/v1/random/wallpaper');
    for (const slug of ['WALLPAPER', 'global']) {
      const conflict = await f.request('POST', '/api/v1/admin/random-services', { ...body, slug });
      assert.equal(conflict.statusCode, 409, conflict.body);
    }
    for (const slug of ['-bad', 'bad-', 'bad_slug', 'a/b', 'a b', '中文', 'a'.repeat(65), 1]) {
      const invalid = await f.request('PUT', path, { ...body, slug });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    assert.equal((await f.request('PUT', path, body)).json().slug, 'wallpaper');
    assert.equal((await f.request('PUT', path, { ...body, slug: 'wallpaper' })).statusCode, 200);
    const other = await f.request('POST', '/api/v1/admin/random-services', {
      ...body,
      slug: 'other',
    });
    assert.equal(other.statusCode, 201, other.body);
    assert.equal((await f.request('PUT', path, { ...body, slug: 'other' })).statusCode, 409);
    assert.equal(
      f.ctx.db.one('SELECT slug FROM random_endpoints WHERE id=?', service.id)!.slug,
      'wallpaper',
    );
    const folder = await f.folder('slug images', 'public');
    assert.equal((await f.upload(folder.id, 'public')).statusCode, 201);
    assert.equal(
      (await f.request('PUT', path, { ...body, slug: 'new-wallpaper' })).statusCode,
      200,
    );
    assert.equal(
      (await f.request('GET', '/api/v1/random/wallpaper?mode=json', undefined, {})).statusCode,
      404,
    );
    assert.equal(
      (await f.request('GET', '/api/v1/random/new-wallpaper?mode=json', undefined, {})).statusCode,
      200,
    );
    assert.equal(
      (await f.request('GET', `/api/v1/random/${service.id}?mode=json`, undefined, {})).statusCode,
      200,
    );
    const listed = (await f.request('GET', '/api/v1/public/services', undefined, {}))
      .json()
      .items.find((s: any) => s.id === service.id);
    assert.equal(listed.slug, 'new-wallpaper');
    assert.equal(listed.url, '/api/v1/random/new-wallpaper');
    for (const slug of [null, '', '   ']) {
      const cleared = await f.request('PUT', path, { ...body, slug });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(cleared.json().slug, null);
      assert.equal(cleared.json().url, `/api/v1/random/${service.id}`);
      assert.equal(
        (await f.request('GET', '/api/v1/random/new-wallpaper?mode=json', undefined, {}))
          .statusCode,
        404,
      );
      assert.equal(
        (await f.request('GET', `/api/v1/random/${service.id}?mode=json`, undefined, {}))
          .statusCode,
        200,
      );
      assert.equal(
        (await f.request('PUT', path, { ...body, slug: 'new-wallpaper' })).statusCode,
        200,
      );
    }
    for (const slug of ['x', 'a'.repeat(64), 'wallpaper'])
      assert.equal((await f.request('PUT', path, { ...body, slug })).statusCode, 200);
    const adminList = (await f.request('GET', '/api/v1/admin/random-services')).json().items;
    assert.equal(adminList.find((s: any) => s.id === service.id).slug, 'wallpaper');
  } finally {
    await f.close();
  }
});

test('all random service kinds support aliases and retain original URLs and response modes', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('alias sources', 'public');
    assert.equal((await f.upload(folder.id, 'public')).statusCode, 201);
    const services = [
      { id: 'global', kind: 'global', folderId: null, original: '/api/v1/random' },
      {
        ...(await f.service(folder.id)),
        kind: 'folder',
        folderId: folder.id,
        original: `/api/v1/folders/${folder.id}/random`,
      },
      { ...(await f.service(null, 'public', [], 'custom')), kind: 'custom', folderId: null },
    ];
    for (const s of services) {
      const slug = `${s.kind}-images`;
      const updated = await f.request('PUT', `/api/v1/admin/random-services/${s.id}`, {
        kind: s.kind,
        folderId: s.folderId,
        name: slug,
        slug,
        visibility: 'public',
        enabled: true,
        rateLimit: 0,
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(updated.json().url, `/api/v1/random/${slug}`);
      for (const url of [
        s.original ?? `/api/v1/random/${s.id}`,
        `/api/v1/random/${s.id}`,
        updated.json().url,
      ]) {
        for (const mode of ['image', 'redirect', 'json']) {
          const response = await f.request('GET', `${url}?mode=${mode}`, undefined, {});
          assert.equal(response.statusCode, mode === 'redirect' ? 302 : 200, response.body);
          if (mode === 'image') assert.match(response.headers['content-type']!, /^image\//);
          if (mode === 'redirect') assert.ok(response.headers.location);
          if (mode === 'json') assert.ok(response.json().id);
        }
      }
      assert.equal(f.ctx.db.one('SELECT calls FROM random_endpoints WHERE id=?', s.id)!.calls, 9);
    }
  } finally {
    await f.close();
  }
});

test('random slugs share limits and ID-based grants and respect disabled services', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('private alias');
    assert.equal((await f.upload(folder.id)).statusCode, 201);
    const service = await f.service(
      null,
      'private',
      [{ kind: 'source_folder', resourceId: folder.id }],
      'custom',
    );
    const path = `/api/v1/admin/random-services/${service.id}`;
    const body = {
      kind: 'custom',
      folderId: null,
      name: 'private',
      slug: 'private-images',
      enabled: true,
      rateLimit: 1,
    };
    assert.equal((await f.request('PUT', path, body)).statusCode, 200);
    const url = '/api/v1/random/private-images?mode=json';
    assert.equal((await f.request('GET', url, undefined, {})).statusCode, 404);
    const invalidGrant = await f.request('POST', '/api/v1/admin/api-keys', {
      name: 'slug is not a grant ID',
      permissions: ['random'],
      grants: [{ kind: 'service', resourceId: 'private-images' }],
    });
    assert.equal(invalidGrant.statusCode, 400, invalidGrant.body);
    const unrelated = await f.key(
      ['random', 'read', 'private:read'],
      [
        { kind: 'service', resourceId: 'global' },
        { kind: 'folder', resourceId: folder.id },
      ],
    );
    assert.equal(
      (await f.request('GET', url, undefined, { authorization: `Bearer ${unrelated.key}` }))
        .statusCode,
      404,
    );
    const key = await f.key(
      ['random', 'read', 'private:read'],
      [
        { kind: 'service', resourceId: service.id },
        { kind: 'folder', resourceId: folder.id },
      ],
    );
    const headers = { authorization: `Bearer ${key.key}` };
    assert.equal((await f.request('GET', url, undefined, headers)).statusCode, 200);
    assert.equal(
      (await f.request('GET', `/api/v1/random/${service.id}?mode=json`, undefined, headers))
        .statusCode,
      429,
    );
    assert.equal(
      f.ctx.db.one('SELECT calls FROM random_endpoints WHERE id=?', service.id)!.calls,
      1,
    );
    assert.equal((await f.request('PUT', path, { ...body, enabled: false })).statusCode, 200);
    assert.equal((await f.request('GET', url, undefined, headers)).statusCode, 404);
    assert.equal(
      (await f.request('GET', `/api/v1/random/${service.id}?mode=json`, undefined, headers))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('zero call limits are unlimited for services and API keys, while positive limits still apply', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('unlimited', 'public');
    const uploaded = await f.upload(folder.id, 'public');
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const body = {
      kind: 'folder',
      folderId: folder.id,
      name: 'unlimited',
      visibility: 'public',
      enabled: true,
      rateLimit: 0,
    };
    const created = await f.request('POST', '/api/v1/admin/random-services', body);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().rate_limit, 0);
    const service = created.json();
    const keyBody = {
      name: 'unlimited key',
      permissions: ['random'],
      grants: [{ kind: 'all' }],
      rateLimit: 0,
    };
    const key = await f.request('POST', '/api/v1/admin/api-keys', keyBody);
    assert.equal(key.statusCode, 201, key.body);
    assert.equal(
      f.ctx.db.one('SELECT rate_limit FROM api_keys WHERE id=?', key.json().id)!.rate_limit,
      0,
    );
    const headers = { authorization: `Bearer ${key.json().key}` };
    for (let i = 0; i < 130; i++) {
      const result = await f.request('GET', service.url + '?mode=json', undefined, headers);
      assert.equal(result.statusCode, 200, result.body);
    }
    const limited = await f.request('PUT', `/api/v1/admin/random-services/${service.id}`, {
      ...body,
      rateLimit: 1,
    });
    assert.equal(limited.statusCode, 200, limited.body);
    assert.equal(
      (await f.request('GET', service.url + '?mode=json', undefined, headers)).statusCode,
      200,
    );
    assert.equal(
      (await f.request('GET', service.url + '?mode=json', undefined, headers)).statusCode,
      429,
    );
    const unlimited = await f.request('PUT', `/api/v1/admin/random-services/${service.id}`, body);
    assert.equal(unlimited.statusCode, 200, unlimited.body);
    assert.equal(unlimited.json().rate_limit, 0);
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await f.request('GET', service.url + '?mode=json', undefined, headers)).statusCode,
        200,
      );
    for (const rateLimit of [-1, 0.5]) {
      assert.equal(
        (
          await f.request('PUT', `/api/v1/admin/random-services/${service.id}`, {
            ...body,
            rateLimit,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await f.request('POST', '/api/v1/admin/api-keys', { ...keyBody, rateLimit })).statusCode,
        400,
      );
    }
  } finally {
    await f.close();
  }
});

test('large WebP thumbnails succeed and release all temporary files on Windows', async () => {
  const f = await fixture();
  try {
    const webp = await sharp(randomBytes(500 * 500 * 3), {
      raw: { width: 500, height: 500, channels: 3 },
    })
      .webp({ quality: 85 })
      .toBuffer();
    assert(webp.length > 65536, 'Exercise the memory-mapped WebP input path');
    const uploaded = await f.upload('uncategorized', 'private', webp);
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const image = uploaded.json();
    await f.worker.tick();
    assert.equal(f.ctx.image(image.id).thumbnail_state, 'ready');
    assert.equal(f.ctx.db.one('SELECT id FROM jobs WHERE image_id=?', image.id), undefined);
    const result = await f.request('GET', image.thumbnailUrl);
    assert.equal(result.statusCode, 200, result.body);
    const metadata = await sharp(result.rawPayload).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 500);
    assert.equal(metadata.height, 500);
    assert.deepEqual(await readdir(join(f.dir, 'tmp')), []);
  } finally {
    await f.close();
  }
});

test('SQLite online backup and object copy restore the actual image and session state', async () => {
  const f = await fixture();
  try {
    const image = (await f.upload('uncategorized')).json();
    await f.worker.tick();
    const target = join(f.dir, 'restore');
    await mkdir(target);
    await f.ctx.db.sql.backup(join(target, 'xhimg.sqlite'));
    await cp(join(f.dir, 'objects'), join(target, 'objects'), { recursive: true });
    const restored = await createApp({
      dir: target,
      masterKey: 'ab'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    try {
      assert.equal(restored.ctx.db.one('PRAGMA integrity_check')!.integrity_check, 'ok');
      const result = await restored.app.inject({ url: image.url, headers: f.headers });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.rawPayload, f.png);
      assert.equal(restored.ctx.image(image.id).thumbnail_state, 'ready');
    } finally {
      await restored.app.close();
    }
  } finally {
    await f.close();
  }
});

test('restart recovers running jobs and cleans objects from interrupted uncommitted uploads', async () => {
  const f = await fixture();
  try {
    const image = (await f.upload('uncategorized')).json(),
      temporary = join(f.dir, 'tmp', 'interrupted');
    await writeFile(temporary, f.png);
    await f.ctx.storage.byId('local').put('originals/interrupted.png', temporary, 'image/png');
    f.ctx.db.run(
      'INSERT INTO upload_operations VALUES (?,?,?,?,?,?,?)',
      'interrupted',
      'local',
      'originals/interrupted.png',
      'thumbnails/interrupted.webp',
      temporary,
      'writing',
      Date.now(),
    );
    f.ctx.db.run("UPDATE jobs SET state='running' WHERE image_id=?", image.id);
    await f.app.close();
    const restarted = await createApp({
      dir: f.dir,
      masterKey: 'ab'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    try {
      assert.equal(
        restarted.ctx.db.one("SELECT state FROM upload_operations WHERE id='interrupted'")!.state,
        'abandoned',
      );
      await restarted.worker.tick();
      assert.equal(restarted.ctx.image(image.id).thumbnail_state, 'ready');
      await assert.rejects(
        () => restarted.ctx.storage.byId('local').head('originals/interrupted.png'),
        ObjectMissing,
      );
      assert.equal(
        restarted.ctx.db.one("SELECT id FROM upload_operations WHERE id='interrupted'"),
        undefined,
      );
    } finally {
      await restarted.app.close();
    }
  } finally {
    if (f.ctx.db.sql.open) await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('aborted HTTP uploads leave no published image and release upload capacity', async () => {
  const f = await fixture();
  try {
    await f.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (f.app.server.address() as any).port;
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/v1/upload',
      method: 'POST',
      headers: {
        ...f.headers,
        'content-type': 'multipart/form-data; boundary=abort-boundary',
        'content-length': 100000,
      },
    });
    client.on('error', () => {});
    client.write(
      '--abort-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n',
    );
    client.write(f.png.subarray(0, 20));
    for (let i = 0; i < 100 && f.ctx.activeUploads === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.ctx.activeUploads, 1);
    client.destroy();
    for (let i = 0; i < 100 && f.ctx.activeUploads !== 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.ctx.activeUploads, 0);
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 0);
    assert.deepEqual(await readdir(join(f.dir, 'tmp')), []);
  } finally {
    await f.close();
  }
});

test('partial folder edits preserve unrelated fields; one request counts only once against Key limit; OpenAPI has input contracts', async () => {
  const f = await fixture();
  try {
    const parent = await f.folder('parent', 'public'),
      child = await f.folder('child', 'public', parent.id);
    await f.request('PATCH', `/api/v1/admin/folders/${child.id}`, { description: 'retained' });
    const row = f.ctx.folder(child.id);
    assert.equal(row.parent_id, parent.id);
    assert.equal(row.visibility, 'public');
    const key = await f.key(['upload'], [{ kind: 'folder', resourceId: child.id }]);
    f.ctx.db.run('UPDATE api_keys SET rate_limit=1 WHERE id=?', key.id);
    const headers = { authorization: `Bearer ${key.key}` };
    const first = await f.upload(child.id, 'private', f.png, headers);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((await f.upload(child.id, 'private', f.png, headers)).statusCode, 429);
    const spec = (await f.request('GET', '/api/v1/openapi.json', undefined, {})).json();
    assert(spec.paths['/api/v1/upload'].post.requestBody.content['multipart/form-data']);
    assert(
      spec.paths['/api/v1/admin/api-keys'].post.requestBody.content['application/json'].schema
        .properties.grants,
    );
    assert(spec.paths['/api/v1/random'].get.parameters.some((p: any) => p.name === 'mode'));
  } finally {
    await f.close();
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-test-'));
  const runtime = await createApp({
    dir,
    masterKey: 'ab'.repeat(32),
    publicUrl: 'http://localhost:9521',
    workers: false,
  });
  const { app } = runtime;
  const installed = await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: { token: runtime.setupToken, username: 'admin', password: 'test-password-12345' },
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'admin', password: 'test-password-12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const headers = {
    cookie: login.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': login.json().csrf,
  };
  async function request(method: any, url: string, payload?: any, customHeaders: any = headers) {
    const r = await app.inject({ method, url, payload, headers: customHeaders });
    return r;
  }
  async function folder(name: string, visibility = 'private', parentId: string | null = null) {
    const r = await request('POST', '/api/v1/admin/folders', { name, visibility, parentId });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  const png = await sharp({ create: { width: 20, height: 12, channels: 4, background: '#0088ff' } })
    .png()
    .toBuffer();
  async function upload(
    folderId: string,
    visibility = 'private',
    buffer = png,
    customHeaders: any = headers,
    extra = '',
  ) {
    const boundary = 'xhimg-test-boundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return request(
      'POST',
      `/api/v1/upload?folderId=${folderId}&visibility=${visibility}${extra}`,
      body,
      { ...customHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
    );
  }
  async function key(permissions: string[], grants: any[], expires?: number) {
    const r = await request('POST', '/api/v1/admin/api-keys', {
      name: 'test key',
      permissions,
      grants,
      expires: expires ?? null,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  async function service(
    folderId: string | null,
    visibility = 'public',
    rules: any[] = [],
    kind = 'folder',
  ) {
    const r = await request('POST', '/api/v1/admin/random-services', {
      name: 'test service',
      kind,
      folderId,
      visibility,
      enabled: true,
      rules,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  return {
    ...runtime,
    dir,
    headers,
    request,
    folder,
    upload,
    key,
    service,
    png,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('homepage background settings persist, validate URLs and allow only the selected image origin', async () => {
  const f = await fixture();
  try {
    const initial = (await f.request('GET', '/api/v1/admin/settings')).json();
    assert.equal(initial.homeBackgroundUrl, '');
    const homeBackgroundUrl = 'https://images.example.com/banner.jpg';
    const saved = await f.request('PUT', '/api/v1/admin/settings', {
      ...initial,
      homeBackgroundUrl,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(
      (await f.request('GET', '/api/v1/admin/settings')).json().homeBackgroundUrl,
      homeBackgroundUrl,
    );
    const publicSettings = await f.request('GET', '/api/v1/public/settings', undefined, {});
    assert.equal(publicSettings.json().homeBackgroundUrl, homeBackgroundUrl);
    assert.equal(publicSettings.json().allowedOrigins, undefined);
    assert.match(
      String(publicSettings.headers['content-security-policy']),
      /img-src[^;]*https:\/\/images\.example\.com/,
    );
    const { homeBackgroundUrl: omitted, ...legacy } = initial;
    assert.equal((await f.request('PUT', '/api/v1/admin/settings', legacy)).statusCode, 200);
    assert.equal(f.ctx.siteSettings().homeBackgroundUrl, homeBackgroundUrl);
    for (const invalid of [
      'javascript:alert(1)',
      'data:image/png;base64,abc',
      'ftp://images.example.com/a.jpg',
      '/relative.jpg',
    ]) {
      assert.equal(
        (
          await f.request('PUT', '/api/v1/admin/settings', {
            ...initial,
            homeBackgroundUrl: invalid,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (await f.request('PUT', '/api/v1/admin/settings', { ...initial, homeBackgroundUrl }, {}))
        .statusCode,
      401,
    );
    assert.equal((await f.request('PUT', '/api/v1/admin/settings', initial)).statusCode, 200);
    const cleared = await f.request('GET', '/api/v1/public/settings', undefined, {});
    assert.equal(cleared.json().homeBackgroundUrl, '');
    assert.doesNotMatch(String(cleared.headers['content-security-policy']), /images\.example\.com/);
  } finally {
    await f.close();
  }
});

test('first install is one-use; admin-only API, CSRF, origin, sessions and key hashes', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request('POST', '/api/v1/setup', {
          token: f.setupToken,
          username: 'other',
          password: 'test-password-999',
        })
      ).statusCode,
      409,
    );
    assert.equal((await f.request('GET', '/api/v1/admin/folders', undefined, {})).statusCode, 401);
    assert.equal(
      (
        await f.request(
          'POST',
          '/api/v1/admin/folders',
          { name: 'csrf' },
          { cookie: f.headers.cookie },
        )
      ).statusCode,
      403,
    );
    f.ctx.db.set('site', { ...f.ctx.siteSettings(), originWhitelistEnabled: true });
    assert.equal(
      (
        await f.request(
          'POST',
          '/api/v1/admin/folders',
          { name: 'origin' },
          { ...f.headers, origin: 'https://evil.example' },
        )
      ).statusCode,
      403,
    );
    const k = await f.key(['upload'], [{ kind: 'all' }]);
    const row = f.ctx.db.one('SELECT * FROM api_keys WHERE id=?', k.id)!;
    assert.notEqual(row.hash, k.key);
    assert(!JSON.stringify(row).includes(k.key));
    const list = await f.request('GET', '/api/v1/admin/api-keys');
    assert(!list.body.includes(k.key));
    assert(!list.body.includes(row.hash));
    assert.equal(
      (
        await f.request('GET', '/api/v1/admin/folders', undefined, {
          authorization: `Bearer ${k.key}`,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.request('PUT', '/api/v1/admin/password', {
          currentPassword: 'test-password-12345',
          password: 'new-password-12345',
        })
      ).statusCode,
      200,
    );
    assert.equal((await f.request('GET', '/api/v1/auth/me')).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('ancestor inheritance, stable bytes, conditional GET, thumbnails, moving and public metadata', async () => {
  const f = await fixture();
  try {
    const parent = await f.folder('parent', 'private'),
      child = await f.folder('child', 'public', parent.id),
      other = await f.folder('other', 'public');
    const up = await f.upload(child.id, 'public');
    assert.equal(up.statusCode, 201, up.body);
    const image = up.json();
    assert.equal(image.effectiveVisibility, 'private');
    assert.equal((await f.request('GET', image.url, undefined, {})).statusCode, 404);
    await f.worker.tick();
    const thumb = await f.request('GET', image.thumbnailUrl);
    assert.equal(thumb.statusCode, 200, thumb.body);
    assert.equal((await sharp(thumb.rawPayload).metadata()).format, 'webp');
    assert.equal((await f.request('GET', image.thumbnailUrl, undefined, {})).statusCode, 404);
    await f.request('PATCH', `/api/v1/admin/folders/${parent.id}`, { visibility: 'public' });
    const body = await f.request('GET', image.url, undefined, {});
    assert.equal(body.statusCode, 200, body.body);
    assert.deepEqual(body.rawPayload, f.png);
    assert.match(body.headers['cache-control']!, /no-cache/);
    assert.equal(
      (await f.request('GET', image.url, undefined, { 'if-none-match': body.headers.etag }))
        .statusCode,
      304,
    );
    const publicList = (await f.request('GET', '/api/v1/public/images', undefined, {})).json();
    assert.equal(publicList.total, 1);
    assert(!('storageId' in publicList.items[0]));
    await f.request('PATCH', `/api/v1/admin/images/${image.id}`, { visibility: 'private' });
    await f.request('PATCH', `/api/v1/admin/folders/${parent.id}`, { visibility: 'private' });
    await f.request('PATCH', `/api/v1/admin/folders/${parent.id}`, { visibility: 'public' });
    assert.equal((await f.request('GET', image.url, undefined, {})).statusCode, 404);
    await f.request('PATCH', `/api/v1/admin/images/${image.id}`, {
      visibility: 'public',
      folderId: other.id,
    });
    assert.equal((await f.request('GET', image.url, undefined, {})).statusCode, 200);
    assert.equal(
      (await f.request('PATCH', `/api/v1/admin/folders/${parent.id}`, { parentId: child.id }))
        .statusCode,
      400,
    );
    await f.request('PATCH', `/api/v1/admin/folders/${other.id}`, { visibility: 'private' });
    assert.equal(
      (await f.request('GET', image.url, undefined, { 'if-none-match': body.headers.etag }))
        .statusCode,
      404,
    );
    assert.equal((await f.request('GET', '/api/v1/public/images', undefined, {})).json().total, 0);
  } finally {
    await f.close();
  }
});

test('API operation scopes, non-inherited folders, expiry, revocation and signed variant isolation', async () => {
  const f = await fixture();
  try {
    const parent = await f.folder('parent'),
      child = await f.folder('child', 'private', parent.id),
      outside = await f.folder('outside');
    const k = await f.key(['upload'], [{ kind: 'folder', resourceId: parent.id }]),
      kh = { authorization: `Bearer ${k.key}` };
    assert.equal((await f.upload(parent.id, 'private', f.png, kh)).statusCode, 201);
    assert.equal((await f.upload(child.id, 'private', f.png, kh)).statusCode, 403);
    assert.equal((await f.upload(outside.id, 'private', f.png, kh)).statusCode, 403);
    const image = (await f.upload(child.id)).json();
    assert.equal((await f.request('GET', image.url, undefined, kh)).statusCode, 404);
    const reader = await f.key(
      ['read', 'private:read'],
      [{ kind: 'folder', resourceId: parent.id, descendants: true }],
    );
    assert.equal(
      (await f.request('GET', image.url, undefined, { authorization: `Bearer ${reader.key}` }))
        .statusCode,
      200,
    );
    const signed = f.ctx.urls(f.ctx.image(image.id), {
      type: 'key',
      key: f.ctx.db.one('SELECT * FROM api_keys WHERE id=?', reader.id)!,
      permissions: ['read', 'private:read'],
      grants: f.ctx.db.all('SELECT * FROM api_grants WHERE key_id=?', reader.id),
    });
    assert.equal((await f.request('GET', signed.url, undefined, {})).statusCode, 200);
    assert.equal(
      (await f.request('GET', signed.url.replace('/i/', '/t/'), undefined, {})).statusCode,
      404,
    );
    await f.request('DELETE', `/api/v1/admin/api-keys/${reader.id}`);
    assert.equal((await f.request('GET', signed.url, undefined, {})).statusCode, 404);
    f.ctx.db.run('UPDATE api_keys SET expires=? WHERE id=?', Date.now() - 1, k.id);
    assert.equal((await f.upload(parent.id, 'private', f.png, kh)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('random media pools isolate filters and revoke private video URLs when the pool changes', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('mixed media', 'public');
    const picture = (await f.upload(folder.id, 'public')).json();
    const video = (await f.upload(folder.id, 'public')).json();
    // Selection and transport use the stored format. Real MP4 bytes are covered in p1.test.ts.
    f.ctx.db.run("UPDATE images SET format='mp4',mime='video/mp4' WHERE id=?", video.id);
    const mixed = {
      name: 'Mixed media',
      kind: 'folder',
      folderId: folder.id,
      mediaType: 'mixed',
      slug: 'mixed-media',
      visibility: 'public',
      enabled: true,
      rateLimit: 0,
    };
    const created = await f.request('POST', '/api/v1/admin/random-services', mixed);
    assert.equal(created.statusCode, 201, created.body);
    const service = created.json();
    assert.equal(service.mediaType, 'mixed');
    assert.equal(service.mode, 'redirect');
    const read = (suffix: string) => f.request('GET', service.url + suffix, undefined, {});
    assert.equal((await read('?mode=json&mediaType=video')).json().id, video.id);
    assert.equal((await read('?mode=json&mediaType=image')).json().id, picture.id);
    const bare = await read('');
    assert.equal(bare.statusCode, 302, bare.body);
    assert([picture.url, video.url].includes(bare.headers.location));
    assert.equal((await read('?mediaType=video')).headers.location, video.url);
    assert.equal((await read('?mediaType=image')).headers.location, picture.url);
    const imageBytes = await read('?mode=image');
    assert.deepEqual(imageBytes.rawPayload, f.png);
    assert.equal(imageBytes.headers['content-type'], 'image/png');
    const random = (await read('?mode=json')).json();
    assert([picture.id, video.id].includes(random.id));
    assert.equal((await read('?mode=json&mediaType=video')).json().mime, 'video/mp4');
    assert.equal(
      (await read('?mode=image&mediaType=video')).json().error.code,
      'INVALID_MEDIA_SELECTION',
    );
    const update = `/api/v1/admin/random-services/${service.id}`;
    const invalid = await f.request('PUT', update, { ...mixed, mediaType: 'video', mode: 'image' });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal((await f.request('PUT', update, { ...mixed, mode: 'image' })).statusCode, 400);
    assert.equal(
      (await f.request('PUT', update, { ...mixed, mediaType: 'image', mode: 'image' })).json().mode,
      'image',
    );
    const narrowed = await f.request('PUT', update, {
      ...mixed,
      rules: [{ kind: 'exclude_image', resourceId: picture.id }],
    });
    assert.equal(narrowed.statusCode, 200, narrowed.body);
    assert.equal(narrowed.json().mode, 'redirect');
    for (const url of [service.url, `/api/v1/random/${service.id}`]) {
      const response = await f.request('GET', url, undefined, {});
      assert.equal(response.statusCode, 302, response.body);
      assert.equal(response.headers.location, video.url);
    }
    const { mediaType: _, ...originalBody } = mixed;
    assert.equal(
      (await f.request('PUT', update, { ...originalBody, mode: 'json' })).statusCode,
      200,
    );
    const saved = (await f.request('PUT', update, originalBody)).json();
    assert.equal(saved.mediaType, 'mixed');
    assert.equal(saved.mode, 'json');

    const videoOnly = {
      name: 'Video',
      slug: 'video-random',
      kind: 'custom',
      mediaType: 'video',
      visibility: 'private',
      enabled: true,
      rateLimit: 0,
    };
    const privateService = (
      await f.request('POST', '/api/v1/admin/random-services', videoOnly)
    ).json();
    assert.equal(privateService.mode, 'redirect');
    assert.equal(
      (await f.request('GET', privateService.url + '?mode=json', undefined, {})).statusCode,
      404,
    );
    assert.equal(
      (await f.request('PATCH', `/api/v1/admin/images/${video.id}`, { visibility: 'private' }))
        .statusCode,
      200,
    );
    assert.equal((await read('?mode=json&mediaType=video')).json().error.code, 'NO_CANDIDATES');
    const key = await f.key(
      ['random', 'read', 'private:read'],
      [
        { kind: 'service', resourceId: privateService.id },
        { kind: 'folder', resourceId: folder.id },
      ],
    );
    const headers = { authorization: `Bearer ${key.key}` };
    const response = await f.request('GET', privateService.url + '?mode=json', undefined, headers);
    assert.equal(response.statusCode, 200, response.body);
    const selected = response.json();
    assert.equal(selected.mediaType, 'video');
    assert.match(selected.url, /^\/i\/[^?]+\?sig=/);
    assert.equal(
      (await f.request('GET', selected.url, undefined, { range: 'bytes=0-3' })).statusCode,
      206,
    );
    const redirect = await f.request('GET', privateService.url, undefined, headers);
    assert.equal(redirect.statusCode, 302);
    assert.equal(
      (await f.request('GET', redirect.headers.location!, undefined, { range: 'bytes=4-7' }))
        .statusCode,
      206,
    );
    assert.equal(
      (
        await f.request(
          'GET',
          privateService.url + '?mode=json&mediaType=image',
          undefined,
          headers,
        )
      ).statusCode,
      400,
    );
    const restricted = await f.request(
      'PUT',
      `/api/v1/admin/random-services/${privateService.id}`,
      { ...videoOnly, mediaType: 'image' },
    );
    assert.equal(restricted.statusCode, 200, restricted.body);
    assert.equal(
      (await f.request('GET', selected.url, undefined, { range: 'bytes=0-3' })).statusCode,
      404,
    );
    assert.equal(
      (await f.request('GET', redirect.headers.location!, undefined, {})).statusCode,
      404,
    );
    const publicList = await f.request('GET', '/api/v1/public/services', undefined, {});
    assert.equal(
      publicList.json().items.find((item: any) => item.id === service.id).mediaType,
      'mixed',
    );
  } finally {
    await f.close();
  }
});

test('random filtering, three modes, public admin preview, empty sets and cache invalidation', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('public', 'public'),
      sub = await f.folder('sub', 'public', folder.id);
    const a = (await f.upload(folder.id, 'public')).json(),
      b = (await f.upload(sub.id, 'public')).json(),
      privateImage = (await f.upload(folder.id, 'private')).json();
    await f.request('PATCH', `/api/v1/admin/images/${a.id}`, { tags: ['landscape'] });
    const s = await f.service(folder.id, 'public', [{ kind: 'tag', resourceId: 'landscape' }]);
    const r = await f.request('GET', s.url + '?mode=json', undefined, {});
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().id, a.id);
    assert(!r.body.includes('object_key'));
    const binary = await f.request('GET', s.url, undefined, {});
    assert.deepEqual(binary.rawPayload, f.png);
    const redirect = await f.request('GET', s.url + '?mode=redirect', undefined, {});
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, a.url);
    await f.request('DELETE', `/api/v1/admin/images/${a.id}`);
    assert.equal((await f.request('GET', s.url + '?mode=json', undefined, {})).statusCode, 404);
    // Public services cannot reveal private images even in an administrator preview.
    assert.equal((await f.request('GET', s.url + '?mode=json')).statusCode, 404);
    const custom = await f.service(
      null,
      'public',
      [
        { kind: 'source_folder', resourceId: folder.id, descendants: true },
        { kind: 'exclude_image', resourceId: privateImage.id },
      ],
      'custom',
    );
    assert.equal(
      (await f.request('GET', custom.url + '?mode=json', undefined, {})).json().id,
      b.id,
    );
    await f.request('PATCH', `/api/v1/admin/folders/${folder.id}`, { visibility: 'private' });
    assert.equal((await f.request('GET', custom.url, undefined, {})).statusCode, 404);
    assert.equal(
      (await f.request('GET', '/api/v1/public/services', undefined, {}))
        .json()
        .items.some((x: any) => x.id === s.id),
      false,
    );
  } finally {
    await f.close();
  }
});

test('private service grant does not grant private image access; links revoke with service', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('secret'),
      image = (await f.upload(folder.id)).json(),
      s = await f.service(folder.id, 'private');
    const onlyService = await f.key(['random'], [{ kind: 'service', resourceId: s.id }]);
    assert.equal(
      (
        await f.request('GET', s.url + '?mode=json', undefined, {
          authorization: `Bearer ${onlyService.key}`,
        })
      ).statusCode,
      404,
    );
    const reader = await f.key(
      ['random', 'read', 'private:read'],
      [
        { kind: 'service', resourceId: s.id },
        { kind: 'folder', resourceId: folder.id },
      ],
    );
    const result = await f.request('GET', s.url + '?mode=json', undefined, {
      authorization: `Bearer ${reader.key}`,
    });
    assert.equal(result.statusCode, 200, result.body);
    const url = result.json().url;
    assert.match(url, /sig=/);
    assert.equal((await f.request('GET', url, undefined, {})).statusCode, 200);
    await f.request('PUT', `/api/v1/admin/random-services/${s.id}`, {
      kind: 'folder',
      folderId: folder.id,
      name: 'off',
      visibility: 'private',
      enabled: false,
    });
    assert.equal((await f.request('GET', url, undefined, {})).statusCode, 404);
    assert.equal(
      (await f.request('GET', '/api/v1/folders/' + folder.id + '/images', undefined, {}))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('upload rejects unsupported, corrupt, oversized and excessive pixels, without published rows', async () => {
  const f = await fixture();
  try {
    f.ctx.db.set('maxUploadMB', 20);
    assert.equal(
      (await f.upload('uncategorized', 'private', Buffer.from('<svg/>'))).statusCode,
      400,
    );
    const tiff = await sharp(f.png).tiff().toBuffer();
    assert.equal((await f.upload('uncategorized', 'private', tiff)).statusCode, 415);
    const huge = await sharp({
      create: { width: 7000, height: 6000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    assert.equal((await f.upload('uncategorized', 'private', huge)).statusCode, 400);
    assert.equal(
      (await f.upload('uncategorized', 'private', Buffer.alloc(20 * 1024 * 1024 + 1))).statusCode,
      413,
    );
    assert.equal((await f.upload('uncategorized', 'private', f.png, {})).statusCode, 401);
    f.ctx.activeUploads = 2;
    assert.equal((await f.upload('uncategorized')).statusCode, 429);
    f.ctx.activeUploads = 0;
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 0);
  } finally {
    await f.close();
  }
});

test('object failure and DB commit failure recover without published images; restart restores thumbnail jobs', async () => {
  const f = await fixture();
  try {
    const real = f.ctx.storage.byId('local');
    let deleted: string[] = [];
    const broken: Objects = {
      put: async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
      get: real.get.bind(real),
      head: real.head.bind(real),
      delete: async (key) => {
        deleted.push(key);
      },
      test: async () => {},
    };
    f.ctx.storage.instances.set('local', broken);
    const failed = await f.upload('uncategorized');
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 0);
    await f.worker.tick();
    assert.equal(deleted.length, 2);
    f.ctx.storage.instances.set('local', real);
    f.ctx.db.sql.exec(
      "CREATE TRIGGER fail_image BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    const dbFail = await f.upload('uncategorized');
    assert.equal(dbFail.statusCode, 409, dbFail.body);
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 0);
    await f.worker.tick();
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM cleanup_objects')!.n, 0);
    f.ctx.db.sql.exec('DROP TRIGGER fail_image');
    const image = (await f.upload('uncategorized')).json();
    await f.app.close();
    const restarted = await createApp({
      dir: f.dir,
      masterKey: 'ab'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    try {
      await restarted.worker.tick();
      assert.equal(restarted.ctx.image(image.id).thumbnail_state, 'ready');
      const object = await restarted.ctx.storage
        .byId('local')
        .get(restarted.ctx.image(image.id).object_key);
      const buffers = [];
      for await (const chunk of object.stream) buffers.push(chunk);
      assert.deepEqual(Buffer.concat(buffers), f.png);
    } finally {
      await restarted.app.close();
    }
  } finally {
    if (f.ctx.db.sql.open) await f.app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('missing random object is excluded, transient storage errors are 503, trash restores and purges actual files', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder('photos', 'public'),
      image = (await f.upload(folder.id, 'public')).json(),
      s = await f.service(folder.id);
    const row = f.ctx.image(image.id),
      real = f.ctx.storage.byId('local');
    f.ctx.storage.instances.set('local', {
      ...real,
      head: async () => {
        throw new Error('network down');
      },
      get: async () => {
        throw new Error('network down');
      },
    } as any);
    assert.equal((await f.request('GET', s.url, undefined, {})).statusCode, 503);
    f.ctx.storage.instances.set('local', real);
    await f.worker.tick();
    await f.request('DELETE', `/api/v1/admin/images/${image.id}`);
    assert.equal((await f.request('GET', image.url, undefined, {})).statusCode, 404);
    assert.equal((await f.request('GET', image.thumbnailUrl, undefined, {})).statusCode, 404);
    assert.equal((await f.request('DELETE', `/api/v1/admin/folders/${folder.id}`)).statusCode, 409);
    await f.request('POST', `/api/v1/admin/images/${image.id}/restore`);
    assert.equal((await f.request('GET', image.url, undefined, {})).statusCode, 200);
    await real.delete(row.object_key);
    assert.equal((await f.request('GET', s.url, undefined, {})).statusCode, 404);
    assert.equal(f.ctx.image(image.id).state, 'missing');
    await f.request('DELETE', `/api/v1/admin/images/${image.id}`);
    await f.request('DELETE', `/api/v1/admin/images/${image.id}/permanent`);
    await f.worker.tick();
    assert.equal(f.ctx.db.one('SELECT * FROM images WHERE id=?', image.id), undefined);
    await assert.rejects(() => real.head(row.thumb_key), ObjectMissing);
  } finally {
    await f.close();
  }
});

test('storage configs encrypt secrets, disabling preserves reads, referenced configs cannot be deleted', async () => {
  const f = await fixture();
  try {
    const r = await f.request('POST', '/api/v1/admin/storage-backends', {
      name: 'S3',
      type: 's3',
      config: {
        endpoint: 'http://localhost:9000',
        region: 'auto',
        bucket: 'images',
        accessKeyId: 'example-access',
        secretAccessKey: 'top-secret-password',
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const config = f.ctx.db.one(
      'SELECT config FROM storage_backends WHERE id=?',
      r.json().id,
    )!.config;
    assert(!config.includes('top-secret'));
    assert(!r.body.includes('top-secret'));
    assert(!r.body.includes('example-access'));
    const image = (await f.upload('uncategorized')).json();
    assert.equal(
      (await f.request('DELETE', '/api/v1/admin/storage-backends/local')).statusCode,
      409,
    );
    assert.equal(
      (await f.request('PATCH', '/api/v1/admin/storage-backends/local', { enabled: false }))
        .statusCode,
      400,
    );
    await f.request('PATCH', `/api/v1/admin/storage-backends/${r.json().id}`, { isDefault: true });
    await f.request('PATCH', '/api/v1/admin/storage-backends/local', { enabled: false });
    assert.equal((await f.request('GET', image.url)).statusCode, 200);
    assert.equal(
      (await f.upload('uncategorized', 'private', f.png, f.headers, '&storageId=local')).statusCode,
      503,
    );
  } finally {
    await f.close();
  }
});

test('site logo persists, keeps legacy updates compatible and scopes the image CSP', async () => {
  const f = await fixture();
  try {
    const initial = (await f.request('GET', '/api/v1/admin/settings')).json();
    assert.equal(initial.logoUrl, '');
    const logoUrl = 'https://logos.example.com/logo.png';
    const saved = await f.request('PUT', '/api/v1/admin/settings', { ...initial, logoUrl });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await f.request('GET', '/api/v1/admin/settings')).json().logoUrl, logoUrl);
    let publicSettings = await f.request('GET', '/api/v1/public/settings', undefined, {});
    assert.equal(publicSettings.json().logoUrl, logoUrl);
    assert.match(
      String(publicSettings.headers['content-security-policy']),
      /img-src[^;]*https:\/\/logos\.example\.com/,
    );
    const { logoUrl: omitted, ...legacy } = initial;
    assert.equal((await f.request('PUT', '/api/v1/admin/settings', legacy)).statusCode, 200);
    assert.equal(f.ctx.siteSettings().logoUrl, logoUrl);
    for (const invalid of ['javascript:alert(1)', 'data:image/png;base64,abc', '/logo.png']) {
      assert.equal(
        (await f.request('PUT', '/api/v1/admin/settings', { ...initial, logoUrl: invalid }))
          .statusCode,
        400,
      );
    }
    assert.equal((await f.request('PUT', '/api/v1/admin/settings', initial)).statusCode, 200);
    publicSettings = await f.request('GET', '/api/v1/public/settings', undefined, {});
    assert.equal(publicSettings.json().logoUrl, '');
    assert.doesNotMatch(
      String(publicSettings.headers['content-security-policy']),
      /logos\.example\.com/,
    );
  } finally {
    await f.close();
  }
});
