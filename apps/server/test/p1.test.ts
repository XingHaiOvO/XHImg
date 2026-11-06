import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { queueProcessing } from '../src/processing.js';
import { enqueueClassification } from '../src/organization.js';
import { recoverResumable, expireResumable } from '../src/resumable.js';
import { testVideo, videoToolsAvailable } from './video-fixture.js';

const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

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
async function fixture(root = tmpdir()) {
  const dir = await mkdtemp(join(root, 'xhimg-p1-'));
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

function animationFrames() {
  const width = 16;
  const pageHeight = 8;
  const frame = (color: number[]) =>
    Buffer.from(Array.from({ length: width * pageHeight }, () => color).flat());
  return sharp(Buffer.concat([frame([255, 0, 0]), frame([0, 0, 255])]), {
    raw: { width, height: pageHeight * 2, pageHeight, channels: 3 },
  });
}

test('static and animated GIF uploads preserve original bytes, serve GIF and generate a first-frame thumbnail', async () => {
  const f = await fixture();
  try {
    const folder = await f.folder();
    const processing = { enabled: true, targetFormat: 'jpg', maxWidth: 4, preserveOriginal: false };
    const staticGif = await sharp(f.png).gif().toBuffer();
    const still = await f.upload({ folderId: folder.id, processing }, staticGif);
    assert.equal(still.statusCode, 201, still.body);
    assert.equal(still.json().format, 'gif');
    assert.deepEqual((await f.req('GET', still.json().url)).rawPayload, staticGif);

    const gif = await animationFrames()
      .gif({ delay: [90, 170], loop: 2 })
      .toBuffer();
    // The fixture deliberately submits a .png filename and MIME type.
    const uploaded = await f.upload({ folderId: folder.id, visibility: 'public', processing }, gif);
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const image = uploaded.json();
    assert.equal(image.format, 'gif');
    assert.equal(image.mime, 'image/gif');
    assert.deepEqual([image.width, image.height], [16, 8]);
    assert.equal(image.processingStatus, 'skipped');
    const published = await f.req('GET', image.logicalUrl, undefined, {});
    assert.equal(published.headers['content-type'], 'image/gif');
    assert.match(published.headers['content-disposition']!, /photo\.gif/);
    assert.deepEqual(published.rawPayload, gif);
    const metadata = await sharp(published.rawPayload, { animated: true }).metadata();
    assert.deepEqual(
      [metadata.pages, metadata.pageHeight, metadata.delay, metadata.loop],
      [2, 8, [90, 170], 2],
    );
    assert.deepEqual(
      (await f.req('GET', `/api/v1/admin/images/${image.id}/original`)).rawPayload,
      gif,
    );
    const reprocess = await f.req('POST', `/api/v1/admin/images/${image.id}/reprocess`, {
      processing,
    });
    assert.equal(reprocess.statusCode, 409);
    assert.equal(reprocess.json().error.code, 'GIF_PROCESSING_UNSUPPORTED');
    assert.equal(f.ctx.db.one("SELECT COUNT(*) AS n FROM jobs WHERE kind='process'")!.n, 0);

    await f.worker.tick();
    await f.worker.tick();
    const thumb = await f.req('GET', image.logicalThumbnailUrl, undefined, {});
    assert.equal(thumb.statusCode, 200, thumb.body);
    assert.equal(thumb.headers['content-type'], 'image/webp');
    const first = await sharp(thumb.rawPayload, { animated: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([first.info.width, first.info.height], [16, 8]);
    assert(first.data[0]! > 240 && first.data[2]! < 15);

    const list = await f.req('GET', '/api/v1/public/images', undefined, {});
    assert.deepEqual(
      list.json().items.map((entry: any) => entry.format),
      ['gif'],
    );
    f.ctx.db.run("UPDATE random_endpoints SET enabled=1,visibility='public' WHERE id='global'");
    const random = await f.req('GET', '/api/v1/random?mode=image', undefined, {});
    assert.equal(random.headers['content-type'], 'image/gif');
    assert.deepEqual(random.rawPayload, gif);

    const url = await f.tusCreate(gif, {
      folderId: folder.id,
      filename: 'resume.gif',
      processing: JSON.stringify(processing),
    });
    const split = Math.floor(gif.length / 2);
    assert.equal((await f.tusPatch(url, gif.subarray(0, split))).statusCode, 204);
    assert.equal((await f.tusPatch(url, gif.subarray(split), split)).statusCode, 204);
    await f.worker.tick();
    const receipt = (await f.req('GET', `/api/v1/uploads/${url.split('/').at(-1)}`)).json();
    assert.equal(receipt.state, 'ready');
    assert.equal(receipt.image.processingStatus, 'skipped');
    assert.deepEqual((await f.req('GET', receipt.image.logicalUrl)).rawPayload, gif);
  } finally {
    await f.close();
  }
});

test('GIF validation rejects malformed later frames and enforces declared canvas and frame budgets', async () => {
  const f = await fixture();
  try {
    const gif = Buffer.from(
      '474946383961010001008000004c6971ff000021ff0b4e45545343415045322e30030101000021f90405090000002c00000000010001000002024c010021f90405110000002c0000000001000100804c69710000ff02024c01003b',
      'hex',
    );
    const brokenFrame = Buffer.from(gif);
    brokenFrame[brokenFrame.length - 4] = 0xff; // Invalid LZW code in the second frame.
    const largeCanvas = Buffer.from(gif);
    largeCanvas.writeUInt16LE(5000, 6);
    largeCanvas.writeUInt16LE(5000, 8);
    const tooManyFrames = await sharp(Buffer.alloc(501 * 3), {
      raw: { width: 1, height: 501, pageHeight: 1, channels: 3 },
    })
      .gif({ keepDuplicateFrames: true })
      .toBuffer();
    const webp = await animationFrames().webp().toBuffer();
    for (const [buffer, status, error] of [
      [gif.subarray(0, -5), 400, 'INVALID_IMAGE'],
      [brokenFrame, 400, 'INVALID_IMAGE'],
      [largeCanvas, 400, 'INVALID_IMAGE'],
      [tooManyFrames, 400, 'INVALID_IMAGE'],
      [webp, 415, 'ANIMATED_IMAGE'],
    ] as const) {
      const result = await f.upload({ visibility: 'public' }, buffer);
      assert.equal(result.statusCode, status, result.body);
      assert.equal(result.json().error.code, error);
    }
    const url = await f.tusCreate(brokenFrame, { filename: 'broken.gif', visibility: 'public' });
    assert.equal((await f.tusPatch(url, brokenFrame)).statusCode, 204);
    await f.worker.tick();
    const receipt = (await f.req('GET', `/api/v1/uploads/${url.split('/').at(-1)}`)).json();
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.image, null);
    assert.equal(f.ctx.db.one('SELECT COUNT(*) n FROM images')!.n, 0);
  } finally {
    await f.close();
  }
});

test('GIF AI classification receives a first-frame JPEG while publication keeps the animation', async () => {
  let target = '';
  let preview: Buffer | undefined;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const received = JSON.parse(Buffer.concat(chunks).toString());
    const url = received.messages[1].content[1].image_url.url as string;
    if (url.startsWith('data:image/jpeg;base64,'))
      preview = Buffer.from(url.split(',')[1]!, 'base64');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ folderId: target }) } }] }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const f = await fixture();
  try {
    target = (await f.folder('GIF category')).id;
    const configured = await f.req('PUT', '/api/v1/admin/ai', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: 'fixture',
      folderIds: [target],
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const gif = await animationFrames().gif().toBuffer();
    const uploaded = await f.upload(
      { visibility: 'public', processing: { enabled: true, targetFormat: 'png' } },
      gif,
    );
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const image = uploaded.json();
    assert.equal((await f.req('GET', image.logicalUrl, undefined, {})).statusCode, 404);
    await f.worker.aiTick();
    assert(preview);
    const first = await sharp(preview).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([first.info.width, first.info.height], [16, 8]);
    assert(first.data[0]! > 240 && first.data[2]! < 15);
    const receipt = (await f.req('GET', image.statusUrl)).json();
    assert.equal(receipt.state, 'ready');
    assert.equal(receipt.image.processingStatus, 'skipped');
    assert.deepEqual((await f.req('GET', image.logicalUrl, undefined, {})).rawPayload, gif);
  } finally {
    await f.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('MP4 upload and tus preserve original video, generate posters and support authorized ranges', async (t) => {
  if (!videoToolsAvailable()) return t.skip('FFmpeg and FFprobe are required');
  const f = await fixture(process.env.XHIMG_TEST_TMPDIR);
  try {
    const folder = await f.folder();
    const file = testVideo('libx264', true);
    const options = {
      mediaType: 'video',
      folderId: folder.id,
      visibility: 'public',
      classify: 'true',
      processing: { enabled: true, targetFormat: 'jpg' },
    };
    const upload = await f.upload(options, file);
    assert.equal(upload.statusCode, 201, upload.body);
    const image = upload.json();
    assert.deepEqual(
      [image.format, image.mime, image.width, image.height],
      ['mp4', 'video/mp4', 160, 90],
    );
    assert.deepEqual([image.processingStatus, image.classificationStatus], ['skipped', 'skipped']);
    const original = await f.req('GET', image.logicalUrl, undefined, {});
    assert.equal(original.statusCode, 200, original.body);
    assert.equal(original.headers['content-type'], 'video/mp4');
    assert.equal(original.headers['content-disposition'], 'inline');
    assert.deepEqual(original.rawPayload, file);
    const head = await f.req('HEAD', image.logicalUrl, undefined, {});
    assert.equal(head.statusCode, 200, head.body);
    assert.equal(head.headers['content-type'], 'video/mp4');
    assert.equal(head.headers['content-disposition'], 'inline');
    assert.equal(head.headers['content-length'], String(file.length));
    assert.equal(head.headers['accept-ranges'], 'bytes');
    assert.equal(head.rawPayload.length, 0);
    for (const [range, start, end] of [
      ['bytes=4-9', 4, 9],
      ['bytes=4-', 4, file.length - 1],
      ['bytes=-8', file.length - 8, file.length - 1],
    ] as const) {
      const partial = await f.req('GET', image.logicalUrl, undefined, { range });
      assert.equal(partial.statusCode, 206, partial.body);
      assert.equal(partial.headers['content-type'], 'video/mp4');
      assert.equal(partial.headers['content-disposition'], 'inline');
      assert.equal(partial.headers['content-range'], `bytes ${start}-${end}/${file.length}`);
      assert.deepEqual(partial.rawPayload, file.subarray(start, end + 1));
    }
    const invalid = await f.req('GET', image.logicalUrl, undefined, {
      range: `bytes=${file.length}-`,
    });
    assert.equal(invalid.statusCode, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${file.length}`);
    assert.equal(
      (await f.req('GET', image.logicalUrl, undefined, { range: 'bytes=0-9', 'if-range': '"old"' }))
        .statusCode,
      200,
    );
    const etag = original.headers.etag!;
    assert.equal(
      (await f.req('GET', image.logicalUrl, undefined, { 'if-none-match': etag })).statusCode,
      304,
    );

    // A failed poster does not block original playback, and can be retried.
    const stored = join(f.dir, 'objects', 'local', f.ctx.image(image.id).object_key);
    await writeFile(stored, Buffer.alloc(file.length));
    await f.worker.tick();
    assert.equal(f.ctx.image(image.id).thumbnail_state, 'failed');
    await writeFile(stored, file);
    assert.deepEqual((await f.req('GET', image.logicalUrl, undefined, {})).rawPayload, file);
    const job = f.ctx.db.one(
      "SELECT id FROM jobs WHERE image_id=? AND kind='thumbnail'",
      image.id,
    )!;
    assert.equal((await f.req('POST', `/api/v1/admin/jobs/${job.id}/retry`)).statusCode, 200);
    await f.worker.tick();
    const poster = await f.req('GET', image.logicalThumbnailUrl, undefined, {});
    assert.equal(poster.headers['content-type'], 'image/webp');
    const frame = await sharp(poster.rawPayload).metadata();
    assert.deepEqual([frame.width, frame.height], [160, 90]);

    assert.equal(
      (await f.req('GET', '/api/v1/public/images?mediaType=image', undefined, {})).json().total,
      0,
    );
    assert.equal(
      (await f.req('GET', '/api/v1/public/images?mediaType=video', undefined, {})).json().total,
      1,
    );
    f.ctx.db.run("UPDATE random_endpoints SET enabled=1,visibility='public' WHERE id='global'");
    const random = await f.req('GET', '/api/v1/random', undefined, {});
    assert.equal(random.json().error.code, 'NO_CANDIDATES');
    const configured = await f.req('PUT', '/api/v1/admin/random-services/global', {
      kind: 'global',
      name: '全站视频',
      mediaType: 'video',
      enabled: true,
      visibility: 'public',
      rateLimit: 0,
    });
    assert.equal(configured.statusCode, 200, configured.body);
    const json = await f.req('GET', '/api/v1/random?mode=json', undefined, {});
    assert.equal(json.statusCode, 200, json.body);
    assert.equal(json.json().url, image.logicalUrl);
    assert.equal(json.json().mime, 'video/mp4');
    const jump = await f.req('GET', '/api/v1/random', undefined, {});
    assert.equal(jump.statusCode, 302);
    assert.equal(jump.headers.location, json.json().url);
    const seek = await f.req('GET', jump.headers.location!, undefined, { range: 'bytes=4-19' });
    assert.equal(seek.statusCode, 206, seek.body);
    assert.deepEqual(seek.rawPayload, file.subarray(4, 20));
    assert.equal(
      (await f.req('POST', `/api/v1/admin/images/${image.id}/reprocess`)).json().error.code,
      'VIDEO_PROCESSING_UNSUPPORTED',
    );
    const ai = await f.req('PUT', '/api/v1/admin/ai', {
      enabled: true,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'fixture',
      folderIds: [folder.id],
    });
    assert.equal(ai.statusCode, 200, ai.body);
    assert.equal(
      (await f.req('POST', '/api/v1/admin/classification', { ids: [image.id] })).json().error.code,
      'VIDEO_CLASSIFICATION_UNSUPPORTED',
    );

    const url = await f.tusCreate(file, {
      filename: 'resume.mp4',
      folderId: folder.id,
      mediaType: 'video',
    });
    const split = Math.floor(file.length / 2);
    assert.equal((await f.tusPatch(url, file.subarray(0, split))).statusCode, 204);
    assert.equal((await f.tusPatch(url, file.subarray(split), split)).statusCode, 204);
    await f.worker.tick();
    const receipt = (await f.req('GET', `/api/v1/uploads/${url.split('/').at(-1)}`)).json();
    assert.equal(receipt.state, 'ready');
    assert.equal(receipt.image.format, 'mp4');
    assert.equal(
      (await f.req('GET', receipt.image.logicalUrl, undefined, { range: 'bytes=0-9' })).statusCode,
      404,
    );
    assert.deepEqual((await f.req('GET', receipt.image.logicalUrl)).rawPayload, file);

    assert.equal((await f.upload(options, f.png)).json().error.code, 'UNSUPPORTED_VIDEO_FORMAT');
    assert.equal(
      (await f.upload(options, testVideo('mpeg4'))).json().error.code,
      'UNSUPPORTED_VIDEO_CODEC',
    );
    f.ctx.db.set('maxVideoUploadMB', 1);
    assert.equal((await f.upload(options, Buffer.alloc(1024 ** 2 + 1))).statusCode, 413);
    assert.equal(f.ctx.db.one('SELECT COUNT(*) AS n FROM images')!.n, 2);
    assert.equal((await f.req('DELETE', `/api/v1/admin/images/${image.id}`)).statusCode, 200);
    assert.equal(
      (await f.req('GET', image.logicalUrl, undefined, { range: 'bytes=0-9' })).statusCode,
      404,
    );
    const trash = await f.req('GET', `/api/v1/admin/images/${image.id}/trash-preview`, undefined, {
      ...f.headers,
      range: 'bytes=0-9',
    });
    assert.equal(trash.statusCode, 206, trash.body);
    assert.deepEqual(trash.rawPayload, file.subarray(0, 10));
  } finally {
    await f.close();
  }
});

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
    f.ctx.db.set('site', {
      originWhitelistEnabled: true,
      allowedOrigins: ['https://external.example'],
    });
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
