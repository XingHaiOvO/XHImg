import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, stat, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { MigrationError } from '../src/migration-worker.js';
import { ObjectMissing } from '../src/storage.js';
import { enqueueClassification } from '../src/organization.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-p2-'));
  const runtime = await createApp({
    dir,
    masterKey: 'af'.repeat(32),
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
      password: 'migration-fixture-password',
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'owner', password: 'migration-fixture-password' },
  });
  const headers = {
    cookie: login.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': login.json().csrf,
  };
  const req = async (method: any, url: string, payload?: any, custom = headers) =>
    app.inject({ method, url, payload, headers: custom });
  const folder = (
    await req('POST', '/api/v1/admin/folders', { name: '迁移来源', visibility: 'public' })
  ).json();
  const png = await sharp({
    create: { width: 90, height: 50, channels: 4, background: '#44aabb88' },
  })
    .png()
    .toBuffer();
  const upload = async (options: Record<string, any> = {}) => {
    const q = new URLSearchParams({ folderId: folder.id, ...options });
    if (options.processing) q.set('processing', JSON.stringify(options.processing));
    const boundary = 'p2-fixture';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/upload?' + q,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert([201, 202].includes(response.statusCode), response.body);
    const image = response.json();
    for (
      let i = 0;
      i < 5 &&
      (ctx.image(image.id).thumbnail_state !== 'ready' || ctx.image(image.id).state !== 'ready');
      i++
    )
      await worker.tick();
    await worker.tick();
    return ctx.image(image.id);
  };
  const backend = async (name = '目标存储', type = 'local', config: any = {}) => {
    const response = await req('POST', '/api/v1/admin/storage-backends', { name, type, config });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const preview = async (target: string, ids: string[], extra = {}) => {
    const response = await req('POST', '/api/v1/admin/storage-migrations', {
      targetStorageId: target,
      imageIds: ids,
      ...extra,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const action = async (task: string, action: string) => {
    const response = await req('POST', `/api/v1/admin/storage-migrations/${task}/${action}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const task = (taskId: string) =>
    ctx.db.one('SELECT * FROM storage_migrations WHERE id=?', taskId)!;
  return {
    ...runtime,
    dir,
    req,
    headers,
    folder,
    png,
    upload,
    backend,
    preview,
    action,
    task,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test('migration switches originals, derived result and thumbnail together, keeps signatures and requires explicit source cleanup', async () => {
  const f = await fixture();
  try {
    const image = await f.upload({ processing: { enabled: true, targetFormat: 'webp' } }),
      before = { ...image },
      target = await f.backend();
    const signed = (await f.req('POST', `/api/v1/admin/images/${image.id}/sign`)).json();
    const original = (await f.req('GET', signed.url, undefined, {} as any)).rawPayload;
    const task = await f.preview(target.id, [image.id, image.id]);
    assert.equal(task.total_count, 1);
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    const after = f.ctx.image(image.id);
    assert.equal(after.storage_id, target.id);
    assert.equal(after.storage_version, before.storage_version + 1);
    for (const key of [
      'id',
      'name',
      'checksum',
      'visibility',
      'effective_visibility',
      'access_version',
      'content_version',
      'organization_version',
      'folder_id',
      'deleted_at',
    ])
      assert.equal(after[key], before[key], key);
    assert.equal(f.task(task.id).state, 'completed');
    assert.deepEqual((await f.req('GET', signed.url, undefined, {} as any)).rawPayload, original);
    assert.deepEqual(
      (await f.req('GET', `/api/v1/admin/images/${image.id}/original`)).rawPayload,
      f.png,
    );
    assert.equal((await f.req('GET', `/t/${image.id}`)).statusCode, 200);
    for (const key of [before.object_key, before.source_key, before.thumb_key])
      await f.ctx.storage.byId('local').head(key);
    await f.action(task.id, 'cleanup');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).cleanup_state, 'cleaned');
    for (const key of [before.object_key, before.source_key, before.thumb_key])
      await assert.rejects(f.ctx.storage.byId('local').head(key), ObjectMissing);
    for (const key of [before.object_key, before.source_key, before.thumb_key])
      await assert.rejects(stat(dirname(join(f.dir, 'objects', 'local', key))), { code: 'ENOENT' });
    assert.deepEqual((await f.req('GET', signed.url, undefined, {} as any)).rawPayload, original);
  } finally {
    await f.close();
  }
});
test('frozen filters, child folders, trash defaults, expired drafts and duplicate reservations are enforced', async () => {
  const f = await fixture();
  try {
    const one = await f.upload(),
      child = (
        await f.req('POST', '/api/v1/admin/folders', { name: '子目录', parentId: f.folder.id })
      ).json();
    const two = await f.upload({ folderId: child.id }),
      trash = await f.upload();
    await f.req('DELETE', `/api/v1/admin/images/${trash.id}`);
    const target = await f.backend();
    const response = await f.req('POST', '/api/v1/admin/storage-migrations', {
      sourceStorageId: 'local',
      folderId: f.folder.id,
      targetStorageId: target.id,
    });
    const draft = response.json();
    assert.equal(draft.total_count, 1);
    await f.upload();
    await f.action(draft.id, 'start');
    const duplicate = await f.preview(target.id, [one.id]);
    assert.equal(duplicate.skipped_count, 1);
    await f.worker.migrations.tick();
    assert.equal(f.task(draft.id).total_count, 1);
    const all = (
      await f.req('POST', '/api/v1/admin/storage-migrations', {
        sourceStorageId: 'local',
        folderId: f.folder.id,
        includeChildren: true,
        includeTrash: true,
        targetStorageId: target.id,
      })
    ).json();
    assert.equal(all.total_count, 3);
    await f.action(all.id, 'start');
    for (let i = 0; i < 3; i++) await f.worker.migrations.tick();
    assert.equal(f.ctx.image(two.id).storage_id, target.id);
    assert(f.ctx.image(trash.id).deleted_at);
    const expired = await f.preview(target.id, [one.id]);
    f.ctx.db.run('UPDATE storage_migrations SET expires_at=0 WHERE id=?', expired.id);
    assert.equal(
      (await f.req('POST', `/api/v1/admin/storage-migrations/${expired.id}/start`)).statusCode,
      409,
    );
    assert.equal(
      (
        await f.req(
          'POST',
          '/api/v1/admin/storage-migrations',
          { targetStorageId: target.id, imageIds: [one.id] },
          {} as any,
        )
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});
test('same-size target corruption and a switch transaction failure preserve original access and clean uncommitted targets', async () => {
  const f = await fixture();
  try {
    const image = await f.upload({ visibility: 'public' }),
      target = await f.backend(),
      raw = f.ctx.storage.byId(target.id);
    f.ctx.storage.instances.set(
      target.id,
      new Proxy(f.ctx.storage.instances.get(target.id)!, {
        get: (obj, key) =>
          key === 'get'
            ? async (key: string, signal?: AbortSignal) => {
                const size = await obj.head(key, signal);
                return { size, stream: Readable.from(Buffer.alloc(size, 1)) };
              }
            : Reflect.get(obj, key),
      }),
    );
    const task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).state, 'failed');
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
    assert.deepEqual(
      (await f.req('GET', `/i/${image.id}`, undefined, {} as any)).rawPayload,
      f.png,
    );
    f.ctx.storage.instances.set(target.id, raw);
    await f.action(task.id, 'retry');
    const item = f.ctx.db.one('SELECT * FROM migration_items WHERE task_id=?', task.id)!;
    f.ctx.db.run('UPDATE migration_items SET attempts=2 WHERE id=?', item.id);
    const run = f.ctx.db.run.bind(f.ctx.db);
    let rejected = false;
    f.ctx.db.run = (sql, ...args) => {
      if (sql.startsWith('UPDATE images SET storage_id=') && !rejected) {
        rejected = true;
        throw new Error('DB commit failed');
      }
      return run(sql, ...args);
    };
    await f.worker.migrations.tick();
    assert(rejected);
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
    assert.equal(f.task(task.id).state, 'failed');
    for (const o of f.ctx.db.all('SELECT * FROM migration_objects WHERE item_id=?', item.id))
      if (o.state === 'cleaned') {
        await assert.rejects(raw.head(o.target_key));
        await assert.rejects(stat(dirname(join(f.dir, 'objects', target.id, o.target_key))), {
          code: 'ENOENT',
        });
      }
  } finally {
    await f.close();
  }
});
test('pause/cancel abort I/O, reject reprocessing under the lock, and late completions cannot switch pointers', async () => {
  const f = await fixture();
  try {
    const image = await f.upload(),
      target = await f.backend(),
      raw = f.ctx.storage.byId(target.id);
    let entered: () => void = () => {},
      release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r)),
      waiting = new Promise<void>((r) => (entered = r));
    let copySignal: AbortSignal | undefined;
    f.ctx.storage.instances.set(
      target.id,
      new Proxy(f.ctx.storage.instances.get(target.id)!, {
        get: (obj, key) =>
          key === 'put'
            ? async (_key: string, _path: string, _mime: string, signal?: AbortSignal) => {
                copySignal = signal;
                entered();
                await gate;
              }
            : Reflect.get(obj, key),
      }),
    );
    const task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    const running = f.worker.migrations.tick();
    await waiting;
    const unrelated = await f.upload();
    assert.equal(unrelated.thumbnail_state, 'ready', 'migration I/O must not block CPU jobs');
    const invalidDelete = await f.req('POST', '/api/v1/admin/images/batch', {
      ids: [image.id, 'missing-image'],
      action: 'delete',
    });
    assert.equal(invalidDelete.statusCode, 404);
    assert.equal(f.ctx.image(image.id).deleted_at, null);
    assert.equal(copySignal?.aborted, false, 'rolled-back deletion must not abort migration I/O');
    assert.equal(
      (
        await f.req('POST', `/api/v1/admin/images/${image.id}/reprocess`, {
          processing: { targetFormat: 'jpg' },
        })
      ).statusCode,
      409,
    );
    await f.action(task.id, 'pause');
    assert.equal(f.task(task.id).state, 'pausing');
    release();
    await running;
    assert.equal(f.task(task.id).state, 'paused');
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
    assert.equal(f.ctx.image(image.id).migration_lock, null);
    await f.action(task.id, 'cancel');
    assert.equal(f.task(task.id).state, 'canceled');
    f.ctx.storage.instances.set(target.id, raw);
    await f.worker.migrations.tick();
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
  } finally {
    await f.close();
  }
});
test('insufficient disk pauses the task and held source reads postpone manual cleanup without losing copies', async () => {
  const f = await fixture();
  try {
    const image = await f.upload(),
      target = await f.backend(),
      task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    const disk = f.worker.migrations.disk.bind(f.worker.migrations);
    f.worker.migrations.disk = async () => {
      throw new MigrationError('磁盘不足', false, false, true);
    };
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).state, 'paused');
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
    f.worker.migrations.disk = disk;
    await f.action(task.id, 'resume');
    await f.worker.migrations.tick();
    const held = await f.ctx.storage.byId('local').get(image.object_key);
    await f.action(task.id, 'cleanup');
    await f.worker.migrations.tick();
    assert.notEqual(f.task(task.id).cleanup_state, 'cleaned');
    await f.ctx.storage.byId('local').head(image.object_key);
    held.stream.resume();
    await new Promise<void>((resolve, reject) =>
      held.stream.once('end', resolve).once('error', reject),
    );
    f.ctx.db.run('UPDATE migration_objects SET next_run=0');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).cleanup_state, 'cleaned');
  } finally {
    await f.close();
  }
});
test('missing target prevents source cleanup; purge deletes current variants and every retained migration copy', async () => {
  const f = await fixture();
  try {
    const image = await f.upload(),
      target = await f.backend(),
      task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    const current = f.ctx.image(image.id),
      raw = f.ctx.storage.byId(target.id),
      path = join(f.dir, 'replacement');
    await writeFile(path, f.png);
    await raw.delete(current.object_key);
    await f.action(task.id, 'cleanup');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).cleanup_state, 'partial_failed');
    await f.ctx.storage.byId('local').head(image.object_key);
    await raw.put(current.object_key, path, 'image/png');
    await f.req('DELETE', `/api/v1/admin/images/${image.id}`);
    await f.req('DELETE', `/api/v1/admin/images/${image.id}/permanent`);
    await f.worker.tick();
    assert(!f.ctx.db.one('SELECT id FROM images WHERE id=?', image.id));
    for (const [sid, key] of [
      ['local', image.object_key],
      ['local', image.thumb_key],
      [target.id, current.object_key],
      [target.id, current.thumb_key],
    ]) {
      await assert.rejects(f.ctx.storage.byId(sid).head(key));
      await assert.rejects(stat(dirname(join(f.dir, 'objects', sid, key))), { code: 'ENOENT' });
    }
  } finally {
    await f.close();
  }
});
test('local to S3, two configurations sharing a bucket, and S3 to local preserve actual bytes', async () => {
  const objects = new Map<string, Buffer>();
  const server = createServer(async (req, res) => {
    const key = new URL(req.url!, 'http://localhost').pathname;
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    const body = objects.get(key);
    if (!body) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f = await fixture();
  try {
    const config = {
      endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
      region: 'us-east-1',
      bucket: 'fixture',
      accessKeyId: 'fixture-key',
      secretAccessKey: 'fixture-secret',
      forcePathStyle: true,
    };
    const a = await f.backend('S3 A', 's3', config),
      b = await f.backend('S3 alias', 's3', config),
      local = await f.backend('本地 B'),
      image = await f.upload();
    const tasks = [];
    for (const target of [a, b, local]) {
      const task = await f.preview(target.id, [image.id]);
      tasks.push(task);
      await f.action(task.id, 'start');
      await f.worker.migrations.tick();
      assert.equal(f.task(task.id).state, 'completed');
      const response = await f.req('GET', `/i/${image.id}`);
      assert.deepEqual(
        response.statusCode === 302
          ? Buffer.from(await (await fetch(response.headers.location!)).arrayBuffer())
          : response.rawPayload,
        f.png,
      );
    }
    for (const task of tasks) {
      await f.action(task.id, 'cleanup');
      await f.worker.migrations.tick();
      assert.equal(f.task(task.id).cleanup_state, 'cleaned');
    }
    assert.equal(objects.size, 0);
    const response = await f.req('GET', `/i/${image.id}`);
    assert.deepEqual(
      response.statusCode === 302
        ? Buffer.from(await (await fetch(response.headers.location!)).arrayBuffer())
        : response.rawPayload,
      f.png,
    );
    await f.req('PATCH', `/api/v1/admin/storage-backends/${local.id}`, { isDefault: true });
    assert.equal((await f.req('DELETE', '/api/v1/admin/storage-backends/local')).statusCode, 200);
  } finally {
    await f.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('real S3 request abort and restart reuse verified bytes without double committing images', async () => {
  const objects = new Map<string, Buffer>();
  let writes = 0,
    release: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r)),
    waiting = new Promise<void>((r) => (entered = r));
  const server = createServer(async (req, res) => {
    try {
      const key = new URL(req.url!, 'http://localhost').pathname;
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        objects.set(key, Buffer.concat(chunks));
        writes++;
        if (writes === 1) {
          entered();
          await gate;
        }
        if (!res.destroyed) {
          res.writeHead(200);
          res.end();
        }
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const image = await f.upload(),
      target = await f.backend('真实中断', 's3', {
        endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
        region: 'us-east-1',
        bucket: 'fixture',
        accessKeyId: 'fixture',
        secretAccessKey: 'fixture',
        forcePathStyle: true,
      });
    const task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    const active = f.worker.migrations.tick();
    await waiting;
    await f.action(task.id, 'pause');
    await active;
    assert.equal(f.task(task.id).state, 'paused');
    assert.equal(f.ctx.image(image.id).migration_lock, null);
    release();
    const item = f.ctx.db.one('SELECT * FROM migration_items WHERE task_id=?', task.id)!;
    // Persist the state that an abrupt process exit would have left behind.
    f.ctx.db.run("UPDATE migration_items SET state='copying' WHERE id=?", item.id);
    f.ctx.db.run("UPDATE storage_migrations SET state='running' WHERE id=?", task.id);
    f.ctx.db.run('UPDATE images SET migration_lock=? WHERE id=?', item.id, image.id);
    await f.app.close();
    restarted = await createApp({
      dir: f.dir,
      masterKey: 'af'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    assert.equal(restarted.ctx.image(image.id).migration_lock, null);
    await restarted.worker.migrations.tick();
    const final = restarted.ctx.image(image.id);
    assert.equal(final.storage_id, target.id);
    assert.equal(final.storage_version, 2);
    assert.equal(
      restarted.ctx.db.one('SELECT success_count FROM storage_migrations WHERE id=?', task.id)!
        .success_count,
      1,
    );
    assert.equal(writes, 2);
    const restartedRead = await restarted.app.inject({ url: `/i/${image.id}`, headers: f.headers });
    assert.equal(restartedRead.statusCode, 302);
    assert.deepEqual(
      Buffer.from(await (await fetch(restartedRead.headers.location!)).arrayBuffer()),
      f.png,
    );
  } finally {
    release();
    await restarted?.app.close();
    await f.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('AI can finish a logical move after storage switches, preserving user permissions', async () => {
  let targetFolder = '',
    release: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r)),
    waiting = new Promise<void>((r) => (entered = r));
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    entered();
    await gate;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ folderId: targetFolder }) } }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f = await fixture();
  try {
    const image = await f.upload({ visibility: 'private' }),
      storage = await f.backend();
    targetFolder = (
      await f.req('POST', '/api/v1/admin/folders', { name: 'AI归档', visibility: 'public' })
    ).json().id;
    await f.req('PUT', '/api/v1/admin/ai', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: 'fixture',
      folderIds: [targetFolder],
    });
    enqueueClassification(f.ctx, image.id, { type: 'admin', session: '' });
    const ai = f.worker.aiTick();
    await waiting;
    const task = await f.preview(storage.id, [image.id]);
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    release();
    await ai;
    const current = f.ctx.image(image.id);
    assert.equal(current.folder_id, targetFolder);
    assert.equal(current.storage_id, storage.id);
    assert.equal(current.visibility, 'private');
    assert.equal(current.classification_status, 'completed');
  } finally {
    release();
    await f.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('soft delete during copying respects trash selection and source references block configuration removal until cleanup', async () => {
  const f = await fixture();
  try {
    for (const includeTrash of [false, true]) {
      const image = await f.upload(),
        target = await f.backend('归档' + includeTrash);
      const tracked = f.ctx.storage.byId(target.id),
        raw = f.ctx.storage.instances.get(target.id)!;
      let entered: () => void = () => {},
        release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r)),
        waiting = new Promise<void>((r) => (entered = r));
      let first = true;
      f.ctx.storage.instances.set(
        target.id,
        new Proxy(raw, {
          get: (obj, key) =>
            key === 'put'
              ? async (...args: Parameters<typeof obj.put>) => {
                  await obj.put(...args);
                  if (first) {
                    first = false;
                    entered();
                    await gate;
                  }
                }
              : Reflect.get(obj, key),
        }),
      );
      const task = await f.preview(target.id, [image.id], { includeTrash });
      await f.action(task.id, 'start');
      const active = f.worker.migrations.tick();
      await waiting;
      await f.req('DELETE', `/api/v1/admin/images/${image.id}`);
      release();
      await active;
      assert(f.ctx.image(image.id).deleted_at);
      assert.equal(f.ctx.image(image.id).storage_id, includeTrash ? target.id : 'local');
      f.ctx.storage.instances.set(target.id, tracked);
      if (includeTrash) {
        await f.req('PATCH', `/api/v1/admin/storage-backends/${target.id}`, { isDefault: true });
        assert.equal(
          (await f.req('DELETE', '/api/v1/admin/storage-backends/local')).statusCode,
          409,
        );
        const backend = f.ctx.storage.byId(target.id),
          key = f.ctx.image(image.id).object_key;
        await f.action(task.id, 'cleanup');
        await f.worker.migrations.tick();
        assert.equal(f.task(task.id).cleanup_state, 'cleaned');
        await backend.head(key);
      }
    }
  } finally {
    await f.close();
  }
});

test('transient copy and source-delete failures retain addresses and allow retry before releasing configuration references', async () => {
  const f = await fixture();
  try {
    const image = await f.upload(),
      target = await f.backend();
    f.ctx.storage.byId(target.id);
    const targetRaw = f.ctx.storage.instances.get(target.id)!;
    f.ctx.storage.instances.set(
      target.id,
      new Proxy(targetRaw, {
        get: (obj, key) =>
          key === 'put'
            ? async () => {
                throw Object.assign(new Error('offline'), { $metadata: { httpStatusCode: 503 } });
              }
            : Reflect.get(obj, key),
      }),
    );
    const task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    const item = f.ctx.db.one('SELECT * FROM migration_items WHERE task_id=?', task.id)!;
    assert.equal(item.state, 'pending');
    assert.equal(item.attempts, 1);
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
    assert.equal(
      (await f.req('DELETE', `/api/v1/admin/storage-backends/${target.id}`)).statusCode,
      409,
    );
    f.ctx.storage.instances.set(target.id, targetRaw);
    f.ctx.db.run('UPDATE migration_items SET next_run=0 WHERE id=?', item.id);
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).state, 'completed');
    await f.req('PATCH', `/api/v1/admin/storage-backends/${target.id}`, { isDefault: true });
    assert.equal((await f.req('DELETE', '/api/v1/admin/storage-backends/local')).statusCode, 409);
    const sourceRaw = f.ctx.storage.instances.get('local')!;
    f.ctx.storage.instances.set(
      'local',
      new Proxy(sourceRaw, {
        get: (obj, key) =>
          key === 'delete'
            ? async () => {
                throw new Error('delete offline');
              }
            : Reflect.get(obj, key),
      }),
    );
    await f.action(task.id, 'cleanup');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).cleanup_state, 'cleaning');
    await sourceRaw.head(image.object_key);
    f.ctx.storage.instances.set('local', sourceRaw);
    f.ctx.db.run('UPDATE migration_objects SET next_run=0');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).cleanup_state, 'cleaned');
    assert.equal((await f.req('DELETE', '/api/v1/admin/storage-backends/local')).statusCode, 200);
    assert.equal(
      f.ctx.db.one('SELECT source_name FROM migration_items WHERE id=?', item.id)!.source_name,
      '本地存储',
    );
  } finally {
    await f.close();
  }
});

test('source truncation never switches the image and recovery removes only owned inactive staging directories', async () => {
  const f = await fixture();
  try {
    const image = await f.upload(),
      target = await f.backend(),
      task = await f.preview(target.id, [image.id]);
    const short = join(f.dir, 'short');
    await writeFile(short, 'x');
    await f.ctx.storage.byId('local').put(image.object_key, short, 'image/png');
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    assert.equal(f.task(task.id).state, 'failed');
    assert.equal(f.ctx.image(image.id).storage_id, 'local');
    const item = f.ctx.db.one('SELECT id FROM migration_items WHERE task_id=?', task.id)!;
    const owned = join(f.dir, 'migration-work', item.id),
      other = join(f.dir, 'migration-work', 'keep');
    await mkdir(owned, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(owned, 'object'), 'leftover');
    await writeFile(join(other, 'object'), 'keep');
    await f.worker.migrations.tick();
    await assert.rejects(stat(owned));
    assert((await stat(join(other, 'object'))).isFile());
  } finally {
    await f.close();
  }
});

test('consistent database plus object backup restores migrated images and retained copies with manual cleanup still required', async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'xhimg-p2-restore-'));
  let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const image = await f.upload({ processing: { enabled: true, targetFormat: 'webp' } }),
      target = await f.backend(),
      task = await f.preview(target.id, [image.id]);
    await f.action(task.id, 'start');
    await f.worker.migrations.tick();
    const current = (await f.req('GET', `/i/${image.id}`)).rawPayload;
    await f.ctx.db.sql.backup(join(dir, 'xhimg.sqlite'));
    await cp(join(f.dir, 'objects'), join(dir, 'objects'), { recursive: true });
    restored = await createApp({
      dir,
      masterKey: 'af'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    assert.equal(restored.ctx.image(image.id).storage_id, target.id);
    await restored.worker.migrations.tick();
    assert.deepEqual(
      (await restored.app.inject({ url: `/i/${image.id}`, headers: f.headers })).rawPayload,
      current,
    );
    assert.deepEqual(
      (
        await restored.app.inject({
          url: `/api/v1/admin/images/${image.id}/original`,
          headers: f.headers,
        })
      ).rawPayload,
      f.png,
    );
    await restored.ctx.storage.byId('local').head(image.object_key);
    const cleanup = await restored.app.inject({
      method: 'POST',
      url: `/api/v1/admin/storage-migrations/${task.id}/cleanup`,
      headers: f.headers,
    });
    assert.equal(cleanup.statusCode, 200, cleanup.body);
    await restored.worker.migrations.tick();
    assert.equal(
      restored.ctx.db.one('SELECT cleanup_state FROM storage_migrations WHERE id=?', task.id)!
        .cleanup_state,
      'cleaned',
    );
    await assert.rejects(restored.ctx.storage.byId('local').head(image.object_key));
  } finally {
    await restored?.app.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
