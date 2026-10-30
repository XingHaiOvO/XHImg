import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import sharp from 'sharp';

for (const [host, origin] of [
  ['localhost:9521', 'http://localhost:9521'],
  ['127.0.0.1:9521', 'http://127.0.0.1:9521'],
  ['localhost:3801', 'http://localhost:3801'],
]) {
  test(`setup and administrator writes accept the actual same origin ${origin}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhimg-origin-'));
    const { app, ctx, setupToken } = await createApp({
      dir,
      masterKey: 'aa'.repeat(32),
      publicUrl: 'http://localhost:3801',
      workers: false,
    });
    try {
      ctx.db.set('site', { originWhitelistEnabled: true });
      const credentials = { username: 'owner', password: 'origin-test-password-123' };
      const body = { ...credentials, token: setupToken };
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: body,
        headers: {
          host,
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        },
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.code, 'ORIGIN_FORBIDDEN');
      assert.equal(ctx.db.one('SELECT id FROM administrators'), undefined);
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: body,
        headers: { host, origin },
      });
      assert.equal(setup.statusCode, 201, setup.body);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: credentials,
        headers: { host, origin },
      });
      assert.equal(login.statusCode, 200, login.body);
      const headers = {
        host,
        origin,
        cookie: login.headers['set-cookie']!.toString().split(';')[0]!,
      };
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/folders',
            payload: { name: 'no CSRF' },
            headers,
          })
        ).statusCode,
        403,
      );
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/folders',
        payload: { name: 'same origin' },
        headers: { ...headers, 'x-csrf-token': login.json().csrf },
      });
      assert.equal(created.statusCode, 201, created.body);
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/setup',
        headers: { host, origin, 'access-control-request-method': 'POST' },
      });
      assert.equal(preflight.headers['access-control-allow-origin'], origin);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const trustProxy of [false, true]) {
  test(`forwarded origin is used only with explicit proxy trust: ${trustProxy}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xhimg-proxy-origin-'));
    const { app, ctx, setupToken } = await createApp({
      dir,
      masterKey: 'aa'.repeat(32),
      publicUrl: 'http://localhost:3801',
      workers: false,
      trustProxy,
    });
    try {
      ctx.db.set('site', { originWhitelistEnabled: true });
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        headers: {
          host: 'internal:9521',
          origin: 'https://images.example',
          'x-forwarded-host': 'images.example',
          'x-forwarded-proto': 'https',
        },
        payload: { token: setupToken, username: 'owner', password: 'origin-test-password-123' },
      });
      assert.equal(result.statusCode, trustProxy ? 201 : 403, result.body);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('configured and whitelisted cross origins work without reflecting arbitrary origins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-cors-origin-'));
  const { app, ctx } = await createApp({
    dir,
    masterKey: 'aa'.repeat(32),
    publicUrl: 'http://localhost:3801',
    workers: false,
  });
  try {
    ctx.db.set('site', {
      originWhitelistEnabled: true,
      allowedOrigins: ['https://client.example'],
    });
    for (const origin of ['http://localhost:3801', 'https://client.example']) {
      const result = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/upload',
        headers: { host: 'localhost:9521', origin, 'access-control-request-method': 'POST' },
      });
      assert.equal(result.headers['access-control-allow-origin'], origin);
      assert.equal(result.headers['access-control-allow-credentials'], undefined);
    }
    for (const origin of [
      'https://evil.example',
      'http://localhost:9999',
      'null',
      'http://localhost:9521/path',
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        headers: { host: 'localhost:9521', origin },
        payload: {},
      });
      assert.equal(result.statusCode, 403, result.body);
      assert.equal(result.headers['access-control-allow-origin'], undefined);
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CORS defaults open, whitelist is explicit and persistent, and authentication and CSRF stay enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-open-cors-'));
  const { app, ctx, setupToken } = await createApp({
    dir,
    masterKey: 'aa'.repeat(32),
    publicUrl: 'http://localhost:3801',
    workers: false,
  });
  const origin = 'https://external.example';
  const preflight = (url: string, value = origin) =>
    app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: value,
        'access-control-request-method': 'POST',
        'access-control-request-headers': url.includes('resumable')
          ? 'authorization,tus-resumable,upload-length,x-chunk-sha256'
          : 'authorization,content-type',
      },
    });
  try {
    // A legacy list does not opt in to the new whitelist switch.
    ctx.db.set('site', { allowedOrigins: ['https://previous.example'] });
    for (const url of ['/api/v1/upload', '/api/v1/resumable']) {
      const response = await preflight(url);
      assert.equal(response.statusCode, 204, response.body);
      assert.equal(response.headers['access-control-allow-origin'], origin);
      assert.notEqual(response.headers['access-control-allow-credentials'], 'true');
      const denied = await app.inject({
        method: 'POST',
        url,
        headers: {
          origin,
          ...(url.includes('resumable') ? { 'tus-resumable': '1.0.0', 'upload-length': '1' } : {}),
        },
      });
      assert.equal(denied.statusCode, 401, denied.body);
      assert.equal(denied.headers['access-control-allow-origin'], origin);
    }
    const credentials = { username: 'owner', password: 'cors-test-password-123' };
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { ...credentials, token: setupToken },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: credentials,
    });
    const headers = {
      cookie: login.headers['set-cookie']!.toString().split(';')[0],
      'x-csrf-token': login.json().csrf,
    };
    const req = (method: any, url: string, payload?: any) =>
      app.inject({ method, url, payload, headers });
    const defaults = (await req('GET', '/api/v1/admin/settings')).json();
    assert.equal(defaults.originWhitelistEnabled, false);
    assert.deepEqual(defaults.allowedOrigins, ['https://previous.example']);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/folders',
          payload: { name: 'CSRF denied' },
          headers: { cookie: headers.cookie, origin },
        })
      ).statusCode,
      403,
    );
    const folder = (await req('POST', '/api/v1/admin/folders', { name: 'upload scope' })).json();
    const key = (
      await req('POST', '/api/v1/admin/api-keys', {
        name: 'external uploader',
        permissions: ['upload'],
        grants: [{ kind: 'folder', resourceId: folder.id }],
      })
    ).json();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const boundary = 'cors-test';
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/upload?folderId=${folder.id}`,
      headers: {
        origin,
        authorization: 'Bearer ' + key.key,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cors.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(upload.statusCode, 201, upload.body);
    assert.equal(upload.headers['access-control-allow-origin'], origin);
    assert.equal(
      (await app.inject({ url: upload.json().url, headers: { origin } })).statusCode,
      404,
    );
    const update = {
      title: 'CORS fixture',
      description: '',
      allowedOrigins: ['https://allowed.example'],
      originWhitelistEnabled: true,
    };
    assert.equal((await req('PUT', '/api/v1/admin/settings', update)).statusCode, 200);
    for (const url of ['/api/v1/upload', '/api/v1/resumable']) {
      assert.equal((await preflight(url)).headers['access-control-allow-origin'], undefined);
      assert.equal(
        (await preflight(url, 'https://allowed.example')).headers['access-control-allow-origin'],
        'https://allowed.example',
      );
      assert.equal(
        (await preflight(url, 'http://localhost:3801')).headers['access-control-allow-origin'],
        'http://localhost:3801',
      );
    }
    // Updating with an old client must not silently turn a previously enabled whitelist off.
    const { originWhitelistEnabled, ...legacy } = update;
    await req('PUT', '/api/v1/admin/settings', legacy);
    assert.equal((await req('GET', '/api/v1/admin/settings')).json().originWhitelistEnabled, true);
    await req('PUT', '/api/v1/admin/settings', { ...update, originWhitelistEnabled: false });
    assert.equal(
      (await preflight('/api/v1/upload')).headers['access-control-allow-origin'],
      origin,
    );
    const stored = (await req('GET', '/api/v1/admin/settings')).json();
    assert.deepEqual(stored.allowedOrigins, update.allowedOrigins);
    const publicSettings = (
      await app.inject({ url: '/api/v1/public/settings', headers: { origin } })
    ).json();
    assert(!('allowedOrigins' in publicSettings));
    assert(!('originWhitelistEnabled' in publicSettings));
    for (const value of ['null', 'file://', 'https://example.com/path', 'https://example.com/'])
      assert.equal(
        (await preflight('/api/v1/upload', value)).headers['access-control-allow-origin'],
        undefined,
      );
    assert.equal(
      (await req('PUT', '/api/v1/admin/settings', { ...update, originWhitelistEnabled: 'false' }))
        .statusCode,
      400,
    );
    assert.equal(
      (await req('PUT', '/api/v1/admin/settings', { ...update, allowedOrigins: ['*'] })).statusCode,
      400,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
