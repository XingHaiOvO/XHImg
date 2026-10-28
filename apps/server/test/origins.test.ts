import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

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
    const { app, setupToken } = await createApp({
      dir,
      masterKey: 'aa'.repeat(32),
      publicUrl: 'http://localhost:3801',
      workers: false,
      trustProxy,
    });
    try {
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
    ctx.db.set('site', { allowedOrigins: ['https://client.example'] });
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
