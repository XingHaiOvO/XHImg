import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import { queueProcessing } from '../src/processing.js';
import { enqueueClassification } from '../src/organization.js';
import { recoverResumable, expireResumable } from '../src/resumable.js';

const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

test('filename repair migration fixes converted names once and preserves unprocessed or matching names', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE images(name TEXT,format TEXT,processing_status TEXT,access_version INTEGER DEFAULT 1)',
    );
    const cases = [
      ['旅行.回忆.png', 'webp', 'completed', '旅行.回忆.webp'],
      ['无后缀', 'jpg', 'completed', '无后缀.jpg'],
      ['.hidden', 'png', 'completed', '.hidden.png'],
      ['PHOTO.JPEG', 'jpg', 'completed', 'PHOTO.JPEG'],
      ['custom.png', 'webp', 'failed', 'custom.png'],
      ['photo.png', 'png', 'skipped', 'photo.png'],
      ['strange.gif', 'webp', 'completed', 'strange.webp'],
    ];
    for (const [name, format, status] of cases)
      db.prepare('INSERT INTO images(name,format,processing_status) VALUES (?,?,?)').run(
        name,
        format,
        status,
      );
    const sql = await readFile(
      new URL('../migrations/0003_image_filenames.sql', import.meta.url),
      'utf8',
    );
    db.exec(sql);
    const rows = db.prepare('SELECT name,access_version FROM images ORDER BY rowid').all() as {
      name: string;
      access_version: number;
    }[];
    assert.deepEqual(
      rows.map((row) => row.name),
      cases.map((row) => row[3]),
    );
    assert.deepEqual(
      rows.map((row) => row.access_version),
      [2, 2, 2, 1, 1, 1, 2],
    );
    db.exec(sql);
    assert.deepEqual(
      db.prepare('SELECT name,access_version FROM images ORDER BY rowid').all(),
      rows,
    );
  } finally {
    db.close();
  }
});

test('P0 migration retains stable IDs, objects and permissions without automatic jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-upgrade-'));
  let runtime: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const database = new Database(join(dir, 'xhimg.sqlite'));
    database.exec(await readFile(new URL('../migrations/0001.sql', import.meta.url), 'utf8'));
    database.exec(
      "CREATE TABLE migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL); INSERT INTO migrations VALUES ('0001.sql',0); INSERT INTO storage_backends VALUES ('local','Local','local','{}',1,1); INSERT INTO folders(id,name,visibility,effective_visibility,created_at) VALUES ('old','Old','public','public',0);",
    );
    database
      .prepare(
        "INSERT INTO images(id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,visibility,effective_visibility,created_at) VALUES ('stable','old','local','originals/stable.png','thumbnails/stable.webp','old.png','png','image/png',1,1,1,'unchanged','public','public',0)",
      )
      .run();
    const backup = join(dir, 'p0.sqlite');
    await database.backup(backup);
    database.close();
    runtime = await createApp({
      dir,
      masterKey: 'ad'.repeat(32),
      publicUrl: 'http://localhost',
      workers: false,
    });
    const old = runtime.ctx.image('stable');
    assert.equal(old.object_key, 'originals/stable.png');
    assert.equal(old.effective_visibility, 'public');
    assert.equal(old.checksum, 'unchanged');
    assert.equal(old.publication_hold, 0);
    assert.equal(old.processing_status, 'skipped');
    assert.equal(old.classification_status, 'skipped');
    assert.equal(runtime.ctx.db.one('SELECT COUNT(*) n FROM jobs')!.n, 0);
    const snapshot = new Database(backup, { readonly: true });
    assert(
      !snapshot
        .prepare('PRAGMA table_info(images)')
        .all()
        .some((column: any) => column.name === 'source_key'),
    );
    snapshot.close();
  } finally {
    await runtime?.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a processing switch transaction failure preserves old bytes and cleans the uncommitted new object', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder(),
      image = (await f.upload({ folderId: folder.id, visibility: 'public' })).json();
    await f.worker.tick();
    queueProcessing(
      f.ctx,
      f.ctx.image(image.id),
      { type: 'admin', session: '' },
      { targetFormat: 'webp' },
    );
    const run = f.ctx.db.run.bind(f.ctx.db);
    let failed = false;
    f.ctx.db.run = (query, ...args) => {
      if (!failed && query.startsWith('UPDATE images SET name=?,object_key=')) {
        failed = true;
        throw new Error('injected commit failure');
      }
      return run(query, ...args);
    };
    await f.worker.tick();
    assert(failed);
    assert.deepEqual((await f.req('GET', image.url, undefined, {} as any)).rawPayload, f.png);
    assert.equal(f.ctx.image(image.id).format, 'png');
    assert.equal(f.ctx.image(image.id).name, 'photo.png');
    const generated = f.ctx.db.one("SELECT * FROM jobs WHERE kind='process'")!;
    await assert.rejects(
      f.ctx.storage.byId('local').head(`processed/${image.id}/${generated.id}.webp`),
    );
  } finally {
    await f.close();
  }
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'xhimg-p1-'));
  const runtime = await createApp({
    dir,
    masterKey: 'ab'.repeat(32),
    publicUrl: 'http://localhost:9521',
    workers: false,
  });
  const { app } = runtime;
  await app.inject({
    method: 'POST',
    url: '/api/v1/setup',
    payload: { token: runtime.setupToken, username: 'owner', password: 'p1-test-password-123' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'owner', password: 'p1-test-password-123' },
  });
  const headers = {
    cookie: login.headers['set-cookie']!.toString().split(';')[0]!,
    'x-csrf-token': login.json().csrf,
  };
  const req = async (method: any, url: string, payload?: any, custom = headers) =>
    app.inject({ method, url, payload, headers: custom });
  const folder = async (name = 'public', visibility = 'public') => {
    const result = await req('POST', '/api/v1/admin/folders', { name, visibility });
    assert.equal(result.statusCode, 201, result.body);
    return result.json();
  };
  const png = await sharp({
    create: { width: 80, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const upload = async (options: any = {}, buffer = png) => {
    const boundary = 'p1boundary',
      query = new URLSearchParams();
    for (const [k, v] of Object.entries(options))
      query.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    return app.inject({
      method: 'POST',
      url: '/api/v1/upload?' + query,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  };
  const tusCreate = async (
    buffer: Buffer,
    options: Record<string, string> = {},
    custom: Record<string, string> = headers,
  ) => {
    const metadata = { filename: 'resume.png', sha256: digest(buffer), ...options };
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/resumable',
      headers: {
        ...custom,
        'tus-resumable': '1.0.0',
        'upload-length': String(buffer.length),
        'upload-metadata': Object.entries(metadata)
          .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
          .join(','),
      },
    });
    assert.equal(result.statusCode, 201, result.body);
    return result.headers.location!;
  };
  const tusPatch = async (
    url: string,
    buffer: Buffer,
    offset = 0,
    checksum = digest(buffer),
    custom: Record<string, string> = headers,
  ) =>
    app.inject({
      method: 'PATCH',
      url,
      headers: {
        ...custom,
        'tus-resumable': '1.0.0',
        'upload-offset': String(offset),
        'x-chunk-sha256': checksum,
        'content-type': 'application/offset+octet-stream',
      },
      payload: buffer,
    });
  return {
    ...runtime,
    dir,
    headers,
    req,
    folder,
    upload,
    png,
    tusCreate,
    tusPatch,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('processing is asynchronous, keeps original, resizes without enlargement and JPEG flattens transparency', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder();
    const response = await f.upload({
      folderId: folder.id,
      visibility: 'public',
      processing: { enabled: true, targetFormat: 'jpg', maxWidth: 40 },
    });
    assert.equal(response.statusCode, 202, response.body);
    const image = response.json();
    assert.equal((await f.req('GET', image.url, undefined, {} as any)).statusCode, 404);
    await f.worker.tick();
    const row = f.ctx.image(image.id);
    assert.equal(row.processing_status, 'completed');
    assert.equal(row.format, 'jpg');
    assert.equal(row.name, 'photo.jpg');
    assert.equal(row.width, 40);
    assert.equal(row.height, 20);
    assert.equal(row.source_size, f.png.length);
    const result = await f.req('GET', image.url, undefined, {} as any);
    assert.equal(result.headers['content-disposition'], "inline; filename*=UTF-8''photo.jpg");
    assert.equal(result.statusCode, 200, result.body);
    assert.equal((await sharp(result.rawPayload).metadata()).format, 'jpeg');
    const pixel = await sharp(result.rawPayload).raw().toBuffer();
    assert(pixel[0]! > 240 && pixel[1]! > 240 && pixel[2]! > 240);
    const original = await f.req('GET', `/api/v1/admin/images/${image.id}/original`);
    assert.deepEqual(original.rawPayload, f.png);
    assert.equal(original.headers['content-disposition'], "attachment; filename*=UTF-8''photo.png");
    assert.equal((await f.req('GET', `/api/v1/uploads/${image.uploadId}`)).json().state, 'ready');
    assert.equal(
      (await f.req('GET', `/api/v1/admin/images/${image.id}/original`, undefined, {} as any))
        .statusCode,
      401,
    );
    await f.worker.tick();
    assert.equal((await f.req('GET', `/t/${image.id}`, undefined, {} as any)).statusCode, 200);
    assert.equal(
      (await f.req('GET', `/t/${image.id}`, undefined, {} as any)).headers['content-disposition'],
      "inline; filename*=UTF-8''photo.webp",
    );
  } finally {
    await f.close();
  }
});

test('trash pauses unpublished processing, restore continues it, and canceled uploads remain manually recoverable', async () => {
  const f = await fixture();
  try {
    const image = (await f.upload({ processing: { enabled: true, targetFormat: 'webp' } })).json();
    await f.req('DELETE', `/api/v1/admin/images/${image.id}`);
    await f.worker.tick();
    assert.equal(f.ctx.image(image.id).processing_status, 'pending');
    assert(f.ctx.db.one("SELECT id FROM jobs WHERE image_id=? AND kind='process'", image.id));
    await f.req('POST', `/api/v1/admin/images/${image.id}/restore`);
    await f.worker.tick();
    assert.equal(f.ctx.image(image.id).processing_status, 'completed');
    const canceled = (await f.upload({ processing: { enabled: true } })).json();
    await f.req('DELETE', `/api/v1/uploads/${canceled.uploadId}`);
    await f.req('POST', `/api/v1/admin/images/${canceled.id}/restore`);
    const retry = await f.req('POST', `/api/v1/admin/images/${canceled.id}/reprocess`, {
      processing: { targetFormat: 'webp' },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    for (let i = 0; i < 5 && f.ctx.image(canceled.id).processing_status !== 'completed'; i++)
      await f.worker.tick();
    assert.equal(f.ctx.image(canceled.id).processing_status, 'completed');
  } finally {
    await f.close();
  }
});

test('manual classification queues existing images once, skips unavailable work and keeps published access', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder();
    const image = (await f.upload({ folderId: folder.id, visibility: 'public' })).json(),
      active = (await f.upload()).json(),
      processing = (await f.upload({ processing: { enabled: true } })).json(),
      deleted = (await f.upload()).json();
    await f.req('DELETE', `/api/v1/admin/images/${deleted.id}`);
    await f.req('PUT', '/api/v1/admin/ai', {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'not-called',
      folderIds: [folder.id],
    });
    await f.req('POST', '/api/v1/admin/classification', { ids: [active.id] });
    const oldVersion = f.ctx.image(active.id).organization_version;
    const queued = await f.req('POST', '/api/v1/admin/classification', {
      ids: [image.id, image.id, active.id, processing.id, deleted.id, 'already-purged'],
      skipUnavailable: true,
    });
    assert.equal(queued.statusCode, 200, queued.body);
    assert.deepEqual(queued.json(), { queued: 1, skipped: 4 });
    assert.equal(f.ctx.image(image.id).classification_status, 'pending');
    assert.equal(f.ctx.image(active.id).organization_version, oldVersion);
    assert.deepEqual((await f.req('GET', image.url, undefined, {} as any)).rawPayload, f.png);
    const again = await f.req('POST', '/api/v1/admin/classification', {
      ids: [image.id],
      skipUnavailable: true,
    });
    assert.deepEqual(again.json(), { queued: 0, skipped: 1 });
    assert.equal(
      f.ctx.db.one("SELECT COUNT(*) n FROM jobs WHERE image_id=? AND kind='classify'", image.id)!.n,
      1,
    );
    assert.equal(
      (
        await f.req(
          'POST',
          '/api/v1/admin/classification',
          { ids: [image.id], skipUnavailable: true },
          {} as any,
        )
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test('policies merge only supplied fields, normalize EXIF, strip metadata and purge every distinct object', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder();
    f.ctx.db.set('processing', { enabled: true, targetFormat: 'jpg', quality: 73, maxWidth: 1000 });
    await f.req('PATCH', `/api/v1/admin/folders/${folder.id}`, {
      processingPolicy: { targetFormat: 'png' },
    });
    const oriented = await sharp({
      create: { width: 30, height: 50, channels: 3, background: '#4488ff' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const response = await f.upload(
      { folderId: folder.id, processing: { compress: false } },
      oriented,
    );
    assert.equal(response.statusCode, 202, response.body);
    const image = response.json();
    await f.worker.tick();
    await f.worker.tick();
    const row = f.ctx.image(image.id);
    assert.equal(row.format, 'png');
    assert.equal(row.width, 50);
    assert.equal(row.height, 30);
    const info = JSON.parse(row.processing_info);
    assert.equal(info.quality, 73);
    assert.equal(info.compress, false);
    const result = (await f.req('GET', `/i/${image.id}`)).rawPayload;
    const meta = await sharp(result).metadata();
    assert(!meta.exif);
    assert(!meta.icc);
    assert(!meta.orientation);
    const keys = [row.object_key, row.source_key, row.thumb_key];
    assert.equal(new Set(keys).size, 3);
    await f.req('DELETE', `/api/v1/admin/images/${image.id}`);
    await f.req('DELETE', `/api/v1/admin/images/${image.id}/permanent`);
    await f.worker.tick();
    assert(!f.ctx.db.one('SELECT id FROM images WHERE id=?', image.id));
    for (const key of keys) await assert.rejects(f.ctx.storage.byId('local').head(key));
    assert.equal((await f.req('DELETE', `/api/v1/admin/folders/${folder.id}`)).statusCode, 200);
  } finally {
    await f.close();
  }
});

test('confirmed offsets survive recovery, unconfirmed tails are truncated, quotas and expiry preserve valid sessions', async () => {
  const f = await fixture();
  try {
    const url = await f.tusCreate(f.png),
      uploadId = url.split('/').pop()!,
      half = Math.floor(f.png.length / 2);
    assert.equal((await f.tusPatch(url, f.png.subarray(0, half))).statusCode, 204);
    const path = join(f.dir, 'resumable', uploadId);
    await appendFile(path, Buffer.from('uncommitted tail'));
    await recoverResumable(f.ctx);
    assert.equal((await stat(path)).size, half);
    await expireResumable(f.ctx);
    assert.equal((await stat(path)).size, half);
    assert.equal((await f.tusPatch(url, f.png.subarray(half), half)).statusCode, 204);
    await f.worker.tick();
    assert.equal((await f.req('GET', `/api/v1/uploads/${uploadId}`)).json().state, 'ready');
    const expired = await f.tusCreate(f.png);
    f.ctx.db.run('UPDATE upload_sessions SET expires_at=0 WHERE id=?', expired.split('/').pop());
    await expireResumable(f.ctx);
    await assert.rejects(stat(join(f.dir, 'resumable', expired.split('/').pop()!)));
    for (let i = 0; i < 20; i++) await f.tusCreate(f.png);
    const quota = await f.app.inject({
      method: 'POST',
      url: '/api/v1/resumable',
      headers: {
        ...f.headers,
        'tus-resumable': '1.0.0',
        'upload-length': String(f.png.length),
        'upload-metadata': `filename ${Buffer.from('quota.png').toString('base64')},sha256 ${Buffer.from(digest(f.png)).toString('base64')}`,
      },
    });
    assert.equal(quota.statusCode, 429, quota.body);
  } finally {
    await f.close();
  }
});

test('failed new processing can retry through its upload receipt without duplicate images', async () => {
  const f = await fixture();
  try {
    const response = await f.upload({ processing: { enabled: true, targetFormat: 'webp' } });
    const image = response.json();
    const real = f.ctx.storage.byId('local');
    f.ctx.storage.instances.set('local', {
      get: async () => {
        throw new Error('offline');
      },
    } as any);
    await f.worker.tick();
    assert.equal(f.ctx.image(image.id).processing_status, 'failed');
    f.ctx.storage.instances.set('local', real);
    const retry = await f.req('POST', `/api/v1/uploads/${image.uploadId}/retry`);
    assert.equal(retry.statusCode, 200, retry.body);
    await f.worker.tick();
    assert.equal((await f.req('GET', `/api/v1/uploads/${image.uploadId}`)).json().state, 'ready');
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 1);
  } finally {
    await f.close();
  }
});

test('real interrupted HTTP chunk leaves offset unchanged and a restarted server resumes persisted bytes', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await f.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (f.app.server.address() as any).port;
    const url = await f.tusCreate(f.png),
      uploadId = url.split('/').pop()!,
      half = Math.floor(f.png.length / 2);
    await new Promise<void>((resolve) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: url,
          method: 'PATCH',
          headers: {
            ...f.headers,
            'tus-resumable': '1.0.0',
            'upload-offset': '0',
            'content-type': 'application/offset+octet-stream',
            'x-chunk-sha256': digest(f.png),
            'content-length': String(f.png.length),
          },
        },
        () => {},
      );
      request.on('error', () => resolve());
      request.write(f.png.subarray(0, half));
      setTimeout(() => request.destroy(new Error('network interrupted')), 25);
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      f.ctx.db.one('SELECT confirmed_offset FROM upload_sessions WHERE id=?', uploadId)!
        .confirmed_offset,
      0,
    );
    assert.equal((await f.tusPatch(url, f.png.subarray(0, half))).statusCode, 204);
    await appendFile(join(f.dir, 'resumable', uploadId), Buffer.from('crash tail'));
    await f.app.close();
    restarted = await createApp({
      dir: f.dir,
      masterKey: 'ab'.repeat(32),
      publicUrl: 'http://localhost:9521',
      workers: false,
    });
    const head = await restarted.app.inject({
      method: 'HEAD',
      url,
      headers: { ...f.headers, 'tus-resumable': '1.0.0' },
    });
    assert.equal(head.headers['upload-offset'], String(half));
    const patched = await restarted.app.inject({
      method: 'PATCH',
      url,
      headers: {
        ...f.headers,
        'tus-resumable': '1.0.0',
        'upload-offset': String(half),
        'x-chunk-sha256': digest(f.png.subarray(half)),
        'content-type': 'application/offset+octet-stream',
      },
      payload: f.png.subarray(half),
    });
    assert.equal(patched.statusCode, 204, patched.body);
    await restarted.worker.tick();
    assert.equal(restarted.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 1);
  } finally {
    if (restarted) await restarted.app.close();
    await f.close();
  }
});

test('AI checks key scopes, retries transient failures and ignores in-flight results after manual moves while CPU work continues', async () => {
  let mode = 'scope',
    target = '',
    release: (() => void) | undefined,
    entered: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    if (mode === 'wait') {
      entered?.();
      await new Promise<void>((r) => (release = r));
    }
    if (mode === '429') {
      res.writeHead(429);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ folderId: mode === 'none' ? null : target }) } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f = await fixture();
  try {
    const a = await f.folder('allowed'),
      b = await f.folder('outside');
    target = b.id;
    await f.req('PUT', '/api/v1/admin/ai', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: 'fixture',
      folderIds: [a.id, b.id],
    });
    const key = (
      await f.req('POST', '/api/v1/admin/api-keys', {
        name: 'AI limited',
        permissions: ['upload', 'ai:classify'],
        grants: [{ kind: 'folder', resourceId: a.id }],
      })
    ).json();
    const url = await f.tusCreate(
      f.png,
      { folderId: a.id, classify: 'true' },
      { authorization: `Bearer ${key.key}` },
    );
    assert.equal(
      (await f.tusPatch(url, f.png, 0, digest(f.png), { authorization: `Bearer ${key.key}` }))
        .statusCode,
      204,
    );
    await f.worker.tick();
    await f.worker.aiTick();
    const uploaded = f.ctx.db.one('SELECT * FROM images')!;
    assert.equal(uploaded.classification_status, 'failed');
    assert.equal(uploaded.folder_id, a.id);
    assert.equal(uploaded.publication_hold, 1);
    const noAI = (
      await f.req('POST', '/api/v1/admin/api-keys', {
        name: 'no AI',
        permissions: ['upload'],
        grants: [{ kind: 'all' }],
      })
    ).json();
    const denied = await f.app.inject({
      method: 'POST',
      url: '/api/v1/upload?classify=true',
      headers: { authorization: `Bearer ${noAI.key}` },
    });
    assert.equal(denied.statusCode, 403);
    mode = '429';
    await f.req('POST', `/api/v1/uploads/${url.split('/').pop()}/retry`);
    await f.worker.aiTick();
    const job = f.ctx.db.one("SELECT * FROM jobs WHERE kind='classify'")!;
    assert.equal(job.state, 'pending');
    assert.equal(job.attempts, 1);
    mode = 'none';
    f.ctx.db.run('UPDATE jobs SET next_run=0 WHERE id=?', job.id);
    await f.worker.aiTick();
    assert.equal(f.ctx.image(uploaded.id).classification_status, 'unmatched');
    assert.equal(f.ctx.image(uploaded.id).folder_id, 'uncategorized');
    const other = (await f.upload({ folderId: a.id })).json();
    await f.worker.tick();
    const start = new Promise<void>((r) => (entered = r));
    mode = 'wait';
    target = a.id;
    enqueueClassification(f.ctx, other.id, { type: 'admin', session: '' });
    const running = f.worker.aiTick();
    await start;
    const pending = (
      await f.upload({ folderId: a.id, processing: { enabled: true, targetFormat: 'webp' } })
    ).json();
    for (let i = 0; i < 5 && f.ctx.image(pending.id).processing_status !== 'completed'; i++)
      await f.worker.tick();
    assert.equal(f.ctx.image(pending.id).processing_status, 'completed');
    await f.req('PATCH', `/api/v1/admin/images/${other.id}`, { folderId: b.id });
    release!();
    await running;
    assert.equal(f.ctx.image(other.id).folder_id, b.id);
    assert.equal(f.ctx.image(other.id).classification_status, 'canceled');
  } finally {
    release?.();
    await f.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('reprocessing keeps the old public bytes until commit and failures preserve the last good version', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder(),
      image = (await f.upload({ folderId: folder.id, visibility: 'public' })).json();
    await f.worker.tick();
    queueProcessing(
      f.ctx,
      f.ctx.image(image.id),
      { type: 'admin', session: '' },
      { targetFormat: 'webp', maxWidth: 1000 },
    );
    assert.deepEqual((await f.req('GET', image.url, undefined, {} as any)).rawPayload, f.png);
    await f.worker.tick();
    const row = f.ctx.image(image.id);
    assert.equal(row.width, 80);
    assert.equal(row.format, 'webp');
    const current = (await f.req('GET', image.url, undefined, {} as any)).rawPayload;
    await f.worker.tick();
    const real = f.ctx.storage.byId('local');
    f.ctx.storage.instances.set('local', {
      ...real,
      get: async () => {
        throw new Error('offline');
      },
    } as any);
    queueProcessing(
      f.ctx,
      f.ctx.image(image.id),
      { type: 'admin', session: '' },
      { targetFormat: 'jpg' },
    );
    await f.worker.tick();
    assert.equal(f.ctx.image(image.id).processing_status, 'failed');
    f.ctx.storage.instances.set('local', real);
    assert.deepEqual((await f.req('GET', image.url, undefined, {} as any)).rawPayload, current);
  } finally {
    await f.close();
  }
});

test('tus validates each chunk, rejects conflicting offsets and finalizes exactly once', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder(),
      url = await f.tusCreate(f.png, { folderId: folder.id, visibility: 'public' }),
      half = Math.floor(f.png.length / 2),
      first = f.png.subarray(0, half),
      second = f.png.subarray(half);
    const wrong = await f.tusPatch(url, first, 0, '0'.repeat(64));
    assert.equal(wrong.statusCode, 460, wrong.body);
    assert.equal(
      (
        await f.app.inject({
          url,
          method: 'HEAD',
          headers: { ...f.headers, 'tus-resumable': '1.0.0' },
        })
      ).headers['upload-offset'],
      '0',
    );
    const concurrent = await Promise.all([f.tusPatch(url, first), f.tusPatch(url, first)]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [204, 409]);
    assert.equal((await f.tusPatch(url, second, 0)).statusCode, 409);
    const b = await f.tusPatch(url, second, half);
    assert.equal(b.statusCode, 204, b.body);
    const uploadId = url.split('/').pop()!;
    assert.equal((await f.req('GET', `/api/v1/uploads/${uploadId}`)).json().state, 'validating');
    await f.worker.tick();
    const receipt = (await f.req('GET', `/api/v1/uploads/${uploadId}`)).json();
    assert.equal(receipt.state, 'ready');
    assert.deepEqual(
      (await f.req('GET', receipt.image.url, undefined, {} as any)).rawPayload,
      f.png,
    );
    const again = await f.tusPatch(url, Buffer.alloc(0), f.png.length);
    assert.equal(again.statusCode, 204, again.body);
    await f.worker.tick();
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 1);
  } finally {
    await f.close();
  }
});

test('tus rejects incorrect whole-file hash, expired sessions and revoked upload keys', async () => {
  const f = await fixture();
  try {
    const url = await f.tusCreate(f.png, { sha256: '0'.repeat(64) });
    assert.equal((await f.tusPatch(url, f.png)).statusCode, 204);
    await f.worker.tick();
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 0);
    assert.equal(
      (await f.req('GET', '/api/v1/uploads/' + url.split('/').pop())).json().state,
      'failed',
    );
    const expired = await f.tusCreate(f.png);
    f.ctx.db.run('UPDATE upload_sessions SET expires_at=0 WHERE id=?', expired.split('/').pop());
    assert.equal((await f.tusPatch(expired, f.png)).statusCode, 410);
    const key = await f.req('POST', '/api/v1/admin/api-keys', {
      name: 'uploader',
      permissions: ['upload'],
      grants: [{ kind: 'all' }],
    });
    const headers = { authorization: `Bearer ${key.json().key}` };
    const keyed = await f.tusCreate(f.png, {}, headers);
    await f.req('DELETE', `/api/v1/admin/api-keys/${key.json().id}`);
    assert.equal((await f.tusPatch(keyed, f.png, 0, digest(f.png), headers)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test('tus CORS preflight permits whitelisted external clients without weakening resource authorization', async () => {
  const f = await fixture();
  try {
    f.ctx.db.set('site', { allowedOrigins: ['https://external.example'] });
    const preflight = await f.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/resumable',
      headers: {
        origin: 'https://external.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'authorization,tus-resumable,upload-length,upload-metadata,x-chunk-sha256',
      },
    });
    assert.equal(preflight.statusCode, 204, preflight.body);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://external.example');
    assert(
      String(preflight.headers['access-control-allow-headers'])
        .toLowerCase()
        .includes('x-chunk-sha256'),
    );
    assert(!String(preflight.headers['tus-extension']).includes('checksum'));
    const denied = await f.app.inject({
      method: 'POST',
      url: '/api/v1/resumable',
      headers: {
        origin: 'https://external.example',
        'tus-resumable': '1.0.0',
        'upload-length': '1',
      },
    });
    assert.equal(denied.statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: 'OPTIONS',
          url: '/api/v1/resumable',
          headers: { origin: 'https://unknown.example', 'access-control-request-method': 'POST' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test('AI isolates new public uploads, validates folder IDs, preserves manual moves and redacts credentials', async () => {
  let target: string | null = null,
    invalid = false;
  let received: any;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: invalid ? 'not JSON' : JSON.stringify({ folderId: target }) } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const f = await fixture();
  try {
    const folder = await f.folder('AI target');
    target = folder.id;
    const configured = await f.req('PUT', '/api/v1/admin/ai', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: 'fixture',
      apiKey: 'private-provider-key',
      folderIds: [folder.id],
    });
    assert.equal(configured.statusCode, 200, configured.body);
    assert(!configured.body.includes('private-provider-key'));
    const uploaded = await f.upload({ visibility: 'public' });
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const image = uploaded.json();
    assert.equal((await f.req('GET', image.url, undefined, {} as any)).statusCode, 404);
    assert.equal(
      (await f.req('GET', '/api/v1/public/images', undefined, {} as any)).json().total,
      0,
    );
    queueProcessing(
      f.ctx,
      f.ctx.image(image.id),
      { type: 'admin', session: '' },
      { targetFormat: 'webp' },
    );
    for (let i = 0; i < 5 && f.ctx.image(image.id).processing_status !== 'completed'; i++)
      await f.worker.tick();
    assert.equal(
      f.ctx.image(image.id).publication_hold,
      1,
      'reprocessing must not release an unclassified new image',
    );
    assert.equal((await f.req('GET', image.url, undefined, {} as any)).statusCode, 404);
    await f.worker.aiTick();
    assert.equal(f.ctx.image(image.id).folder_id, folder.id);
    assert.equal(f.ctx.image(image.id).classification_status, 'completed');
    assert.equal((await f.req('GET', image.url, undefined, {} as any)).statusCode, 200);
    assert(received.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    assert(!received.response_format);
    const manual = await f.folder('manual', 'private');
    enqueueClassification(f.ctx, image.id, { type: 'admin', session: '' });
    await f.req('PATCH', `/api/v1/admin/images/${image.id}`, { folderId: manual.id });
    await f.worker.aiTick();
    assert.equal(f.ctx.image(image.id).folder_id, manual.id);
    invalid = true;
    enqueueClassification(f.ctx, image.id, { type: 'admin', session: '' });
    await f.worker.aiTick();
    assert.equal(f.ctx.image(image.id).classification_status, 'failed');
    assert.equal(f.ctx.image(image.id).folder_id, manual.id);
    assert(
      !f.ctx.db
        .one("SELECT value FROM settings WHERE key='ai'")!
        .value.includes('private-provider-key'),
    );
    await f.req('PUT', '/api/v1/admin/ai', { prompt: 'new prompt' });
    assert.equal((await f.req('GET', '/api/v1/admin/ai')).json().hasKey, true);
  } finally {
    await f.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
