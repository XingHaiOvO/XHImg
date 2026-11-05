import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { candidateIds, sampleCandidates } from '../src/random.js';
import { ObjectMissing, type Objects } from '../src/storage.js';
import { hash } from '../src/security.js';

async function fixture(count = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-random-'));
  const { app, ctx } = await createApp({
    dir,
    masterKey: 'cd'.repeat(32),
    publicUrl: 'http://localhost:9521',
    workers: false,
  });
  ctx.db.run("UPDATE folders SET visibility='public',effective_visibility='public'");
  ctx.db.run("UPDATE random_endpoints SET enabled=1,rate_limit=0 WHERE id='global'");
  for (let i = 0; i < count; i++)
    ctx.db.run(
      "INSERT INTO images (id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,visibility,effective_visibility,created_at) VALUES (?,'uncategorized','local',?,'thumb','sample.png','png','image/png',5,1,1,'hash','public','public',0)",
      'img_' + i,
      'object_' + i,
    );
  const calls = { head: [] as string[], get: [] as string[] };
  const streams: Readable[] = [];
  const storage: Objects = {
    async head(key) {
      calls.head.push(key);
      return 5;
    },
    async get(key) {
      calls.get.push(key);
      const stream = Readable.from(Buffer.from('image'));
      streams.push(stream);
      return { stream, size: 5 };
    },
    async put() {},
    async delete() {},
    async test() {},
  };
  ctx.storage.instances.set('local', storage);
  return {
    app,
    ctx,
    storage,
    calls,
    streams,
    request: (mode = 'image') => app.inject(`/api/v1/random?mode=${mode}`),
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('sampling is bounded, distinct and does not iterate or mutate the cached array', () => {
  for (const size of [0, 1, 2, 3, 100000]) {
    const ids = Object.freeze(Array.from({ length: size }, (_, i) => 'img_' + i));
    let reads = 0;
    const guarded = new Proxy(ids, {
      get(target, property, receiver) {
        assert.notEqual(property, Symbol.iterator, 'must not copy the candidate array');
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    for (let i = 0; i < 100; i++) {
      const selected = [...sampleCandidates(guarded)];
      assert.equal(selected.length, Math.min(3, size));
      assert.equal(new Set(selected).size, selected.length);
      assert(selected.every((id) => ids.includes(id)));
    }
    assert.equal(reads, 100 * Math.min(3, size));
  }
});

test('image reads once; json and redirect each check existence on every request', async () => {
  const f = await fixture();
  try {
    for (const mode of ['image', 'json', 'redirect', 'json', 'redirect']) {
      const result = await f.request(mode);
      assert.equal(result.statusCode, mode === 'redirect' ? 302 : 200, result.body);
      assert.equal(result.headers['cache-control'], 'private, no-store');
      if (mode === 'image') {
        assert.equal(result.body, 'image');
        assert.equal(result.headers['etag'], '"hash-1-original"');
        assert.equal(result.headers['content-length'], '5');
        assert.equal(result.headers['vary'], 'Cookie, Authorization');
      }
    }
    assert.equal(f.calls.get.length, 1);
    assert.equal(f.calls.head.length, 4);
  } finally {
    await f.close();
  }
});

for (const mode of ['image', 'json', 'redirect']) {
  test(`${mode} retries distinct missing objects, invalidates cache and stops after three attempts`, async () => {
    const f = await fixture(4);
    try {
      const attempts: string[] = [];
      const missing = async (key: string): Promise<never> => {
        attempts.push(key);
        throw new ObjectMissing();
      };
      if (mode === 'image') f.storage.get = missing;
      else f.storage.head = missing;
      const result = await f.request(mode);
      assert.equal(result.statusCode, 404);
      assert.equal(result.json().error.code, 'NO_CANDIDATES');
      assert.equal(attempts.length, 3);
      assert.equal(new Set(attempts).size, 3);
      assert.equal(f.ctx.db.one("SELECT count(*) n FROM images WHERE state='missing'")!.n, 3);
      assert.equal(f.ctx.candidates.size, 0);
      const endpoint = f.ctx.db.one("SELECT * FROM random_endpoints WHERE id='global'")!;
      assert.equal(candidateIds(f.ctx, endpoint, { type: 'anonymous' }).length, 1);
      assert.equal(endpoint.calls, 1);
      assert.equal(endpoint.failures, 1);
      assert.equal(endpoint.successes, 0);
    } finally {
      await f.close();
    }
  });
}

test('image succeeds on the third distinct candidate after two missing objects', async () => {
  const f = await fixture(3);
  try {
    const get = f.storage.get;
    let failures = 0;
    f.storage.get = async (key) => {
      if (failures++ < 2) throw new ObjectMissing();
      return get(key);
    };
    assert.equal((await f.request()).body, 'image');
    assert.equal(f.ctx.db.one("SELECT count(*) n FROM images WHERE state='missing'")!.n, 2);
  } finally {
    await f.close();
  }
});

for (const mode of ['image', 'json', 'redirect']) {
  test(`${mode} reports transient storage failure without marking objects missing`, async () => {
    const f = await fixture(3);
    try {
      let attempts = 0;
      const unavailable = async (): Promise<never> => {
        attempts++;
        throw new Error('offline');
      };
      f.storage.get = unavailable;
      f.storage.head = unavailable;
      const result = await f.request(mode);
      assert.equal(result.statusCode, 503);
      assert.equal(attempts, 1);
      assert.equal(f.ctx.db.one("SELECT count(*) n FROM images WHERE state='missing'")!.n, 0);
    } finally {
      await f.close();
    }
  });
}

for (const change of [
  'permission',
  'disabled',
  'rule',
  'folder',
  'media type',
  'location',
  'deleted',
] as const) {
  test(`image rejects ${change} changes during get and releases the unread stream`, async () => {
    const f = await fixture();
    try {
      const get = f.storage.get;
      f.storage.get = async (key) => {
        const object = await get(key);
        switch (change) {
          case 'permission':
            f.ctx.db.run("UPDATE images SET effective_visibility='private'");
            break;
          case 'disabled':
            f.ctx.db.run('UPDATE random_endpoints SET enabled=0');
            break;
          case 'rule':
            f.ctx.db.run(
              "INSERT INTO random_rules (endpoint_id,kind,resource_id) VALUES ('global','tag','absent')",
            );
            break;
          case 'folder':
            f.ctx.db.run("INSERT INTO folders (id,name,created_at) VALUES ('other','other',0)");
            f.ctx.db.run("UPDATE random_endpoints SET folder_id='other'");
            break;
          case 'media type':
            f.ctx.db.run("UPDATE random_endpoints SET media_type='video',mode='redirect'");
            break;
          case 'location':
            f.ctx.db.run('UPDATE images SET storage_version=storage_version+1');
            break;
          case 'deleted':
            f.ctx.db.run('UPDATE images SET deleted_at=1');
            break;
        }
        f.ctx.invalidate();
        return object;
      };
      const result = await f.request();
      assert.equal(result.statusCode, change === 'location' ? 409 : 404, result.body);
      assert.equal(f.streams.length, 1);
      assert(f.streams[0]!.destroyed);
      await setImmediate();
      // Deletion is blocked while a tracked reader is held. Successful deletion
      // proves the rejected stream released its storage reference.
      await f.ctx.storage.byId('local').delete('object_0');
      assert.equal(
        f.ctx.db.one("SELECT successes FROM random_endpoints WHERE id='global'")!.successes,
        0,
      );
    } finally {
      await f.close();
    }
  });
}

for (const mode of ['image', 'json', 'redirect']) {
  test(`${mode} does not mark a migrated object missing after checking the old location`, async () => {
    const f = await fixture();
    try {
      const missing = async (): Promise<never> => {
        f.ctx.db.run("UPDATE images SET object_key='new-object',storage_version=storage_version+1");
        throw new ObjectMissing();
      };
      f.storage.get = missing;
      f.storage.head = missing;
      const result = await f.request(mode);
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(f.ctx.image('img_0').state, 'ready');
    } finally {
      await f.close();
    }
  });
}

for (const change of ['revoked', 'expired', 'read', 'scope'] as const) {
  test(`image rechecks a private caller after get when its key is ${change}`, async () => {
    const f = await fixture();
    try {
      const token = 'xh_' + 'ab'.repeat(32);
      f.ctx.db.run("UPDATE random_endpoints SET visibility='private'");
      f.ctx.db.run("UPDATE images SET visibility='private',effective_visibility='private'");
      f.ctx.db.run(
        "INSERT INTO api_keys (id,name,hash,prefix,permissions,rate_limit,created_at) VALUES ('key','reader',?,'xh_ab',?,0,0)",
        hash(token),
        JSON.stringify(['random', 'read', 'private:read']),
      );
      f.ctx.db.run("INSERT INTO api_grants (key_id,kind) VALUES ('key','all')");
      const get = f.storage.get;
      f.storage.get = async (key) => {
        const object = await get(key);
        if (change === 'revoked') f.ctx.db.run('UPDATE api_keys SET revoked=1');
        if (change === 'expired') f.ctx.db.run('UPDATE api_keys SET expires=1');
        if (change === 'read') f.ctx.db.run('UPDATE api_keys SET permissions=?', '["random"]');
        if (change === 'scope') f.ctx.db.run('DELETE FROM api_grants');
        f.ctx.invalidate();
        return object;
      };
      const result = await f.app.inject({
        url: '/api/v1/random?mode=image',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(
        result.statusCode,
        change === 'revoked' || change === 'expired' ? 401 : 404,
        result.body,
      );
      assert(f.streams[0]!.destroyed);
    } finally {
      await f.close();
    }
  });
}
