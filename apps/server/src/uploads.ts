import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { Context, params, query, visibility } from './context.js';
import { fail, id } from './security.js';
import { ObjectMissing, type ObjectRange, type Objects } from './storage.js';
import type { Row } from './db.js';
import { acceptFile, prepareUpload } from './pipeline.js';
import { mediaTypeSchema, uploadLimit } from './policies.js';
import { imageFilename } from './image-filename.js';
import { imageResponse, signObject, sameImageLocation } from './image-urls.js';

function mediaHeaders(reply: FastifyReply, image: Row, size: number, thumbnail: boolean) {
  const variant = thumbnail ? 'thumbnail' : 'original';
  reply
    .header('ETag', `"${image.checksum}-${image.access_version}-${variant}"`)
    .header('Content-Type', thumbnail ? 'image/webp' : image.mime)
    .header('Content-Length', size);
  reply.header(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(imageFilename(basename(image.name).replace(/[\r\n]/g, ''), thumbnail ? 'webp' : image.format))}`,
  );
}

// The caller owns authorization and the object stream until it is handed off here.
export function sendImageObject(
  reply: FastifyReply,
  image: Row,
  object: Awaited<ReturnType<Objects['get']>>,
  thumbnail = false,
) {
  mediaHeaders(reply, image, object.size, thumbnail);
  return reply.send(object.stream);
}

function videoRange(header: string, size: number): ObjectRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ([first, last].some((value) => value !== undefined && !Number.isSafeInteger(value))) return;
  const start = first ?? Math.max(0, size - last!);
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start > end) return;
  return { start, end, total: size };
}

export async function sendVideo(
  ctx: Context,
  req: FastifyRequest,
  reply: FastifyReply,
  image: Row,
  authorize: (latest: Row) => void,
) {
  const storage = ctx.storage.byId(image.storage_id);
  const etag = `"${image.checksum}-${image.access_version}-original"`;
  const recheck = () => {
    const latest = ctx.image(image.id);
    authorize(latest);
    if (!sameImageLocation(image, latest, false)) fail(409, 'IMAGE_CHANGED', '视频已变化，请重试');
  };
  reply.header('Accept-Ranges', 'bytes').header('ETag', etag);
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  const abort = new AbortController();
  reply.raw.once('close', () => abort.abort());
  if (req.method === 'HEAD') {
    const size = await storage.head(image.object_key, abort.signal);
    recheck();
    if (size !== image.size) fail(409, 'IMAGE_CHANGED', '视频已变化，请重试');
    mediaHeaders(reply, image, size, false);
    // Fastify's generated HEAD handler preserves Content-Length for stream payloads.
    return reply.send(Readable.from([]));
  }
  let range: ObjectRange | undefined;
  if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    range = videoRange(req.headers.range, image.size);
    if (!range) return reply.code(416).header('Content-Range', `bytes */${image.size}`).send();
  }
  const object = await storage.get(image.object_key, abort.signal, range);
  try {
    recheck();
    abort.signal.throwIfAborted();
    if (object.size !== (range ? range.end - range.start + 1 : image.size))
      fail(409, 'IMAGE_CHANGED', '视频已变化，请重试');
    if (range)
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${range.total}`);
    reply.raw.once('close', () => object.stream.destroy());
    return sendImageObject(reply, image, object);
  } catch (error) {
    object.stream.destroy();
    throw error;
  }
}

export async function sendImage(
  ctx: Context,
  req: FastifyRequest,
  reply: FastifyReply,
  imageId: string,
  thumbnail = false,
  random = false,
) {
  const image = ctx.image(imageId),
    variant = thumbnail ? 'thumbnail' : 'original';
  const sig = query(req).sig;
  const actor = sig ? ctx.signedActor(sig, image, variant) : ctx.actor(req);
  if (!ctx.access.read(actor, image)) fail(404, 'NOT_FOUND', '图片不存在');
  if (thumbnail && image.thumbnail_state !== 'ready')
    fail(404, 'THUMBNAIL_PENDING', '缩略图暂未就绪');
  reply.header(
    'Cache-Control',
    random || image.publication_hold || image.effective_visibility !== 'public'
      ? 'private, no-store'
      : 'public, no-cache, must-revalidate',
  );
  reply.header('Vary', 'Cookie, Authorization');
  const isDirect =
    !random &&
    !image.publication_hold &&
    ctx.db.one('SELECT type FROM storage_backends WHERE id=?', image.storage_id)?.type === 's3';
  const etag = `"${image.checksum}-${image.access_version}-${variant}"`;
  // Authorization precedes conditional cache handling, even for a previously public URL.
  try {
    if (!thumbnail && image.format === 'mp4') {
      return await sendVideo(ctx, req, reply, image, (latest) => {
        const latestActor = sig ? ctx.signedActor(sig, latest, 'original') : ctx.actor(req);
        if (!ctx.access.read(latestActor, latest)) fail(404, 'NOT_FOUND', '视频不存在');
      });
    }
    if (!random && !isDirect && req.headers['if-none-match'] === etag)
      return reply.code(304).send();
    if (isDirect) {
      reply.header('Cache-Control', 'private, no-store');
      await ctx.storage.byId(image.storage_id).head(thumbnail ? image.thumb_key : image.object_key);
      const latest = ctx.image(image.id);
      const latestActor = sig ? ctx.signedActor(sig, latest, variant) : ctx.actor(req);
      if (!ctx.access.read(latestActor, latest)) fail(404, 'NOT_FOUND', '图片不存在');
      if (!sameImageLocation(image, latest)) fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重试');
      const link = await signObject(
        ctx,
        latest,
        latestActor,
        thumbnail ? 'thumbnail' : 'image',
        sig ? ctx.secrets.verify(sig)?.expires : undefined,
      );
      const final = ctx.image(image.id);
      const finalActor = sig ? ctx.signedActor(sig, final, variant) : ctx.actor(req);
      if (!ctx.access.read(finalActor, final)) fail(404, 'NOT_FOUND', '图片不存在');
      if (!sameImageLocation(latest, final)) fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重试');
      if (!link) fail(503, 'STORAGE_UNAVAILABLE', '存储暂不可用');
      return reply.code(302).header('Location', link.url).send();
    }
    const object = await ctx.storage
      .byId(image.storage_id)
      .get(thumbnail ? image.thumb_key : image.object_key);
    return sendImageObject(reply, image, object, thumbnail);
  } catch (e) {
    if (e instanceof ObjectMissing) {
      if (!sameImageLocation(image, ctx.image(image.id)))
        fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重试');
      if (!thumbnail) ctx.db.run("UPDATE images SET state='missing' WHERE id=?", image.id);
      else ctx.db.run("UPDATE images SET thumbnail_state='failed' WHERE id=?", image.id);
      ctx.invalidate();
      fail(404, 'OBJECT_MISSING', '文件暂时不可用');
    }
    throw e;
  }
}
export function registerUploads(app: FastifyInstance, ctx: Context) {
  const upload = async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = ctx.actor(req);
    ctx.csrf(req, actor);
    if (!ctx.access.has(actor, 'upload'))
      fail(401, 'UPLOAD_AUTH_REQUIRED', '上传需要管理员或授权 API Key');
    if (ctx.activeUploads >= 2) fail(429, 'UPLOAD_BUSY', '同时最多上传两个文件');
    ctx.activeUploads++;
    const temp = join(ctx.config.dir, 'tmp', id('incoming'));
    try {
      const q = z
        .object({
          folderId: z.string().optional(),
          visibility: visibility.default('private'),
          storageId: z.string().optional(),
          processing: z.string().optional(),
          classify: z.enum(['true', 'false']).optional(),
          mediaType: mediaTypeSchema.default('image'),
        })
        .parse(req.query);
      if (params(req).folderId && q.folderId && params(req).folderId !== q.folderId)
        fail(400, 'FOLDER_MISMATCH', '目标文件夹不一致');
      let processing: unknown;
      if (q.processing) {
        try {
          processing = JSON.parse(q.processing);
        } catch {
          fail(400, 'INVALID_POLICY', '处理参数必须是 JSON');
        }
      }
      prepareUpload(ctx, actor, {
        folderId: params(req).folderId || q.folderId,
        visibility: q.visibility,
        storageId: q.storageId,
        processing,
        classify: q.classify === undefined ? undefined : q.classify === 'true',
        mediaType: q.mediaType,
      });
      await mkdir(join(ctx.config.dir, 'tmp'), { recursive: true });
      let name = '';
      for await (const part of req.parts({
        limits: { files: 1, fileSize: uploadLimit(ctx, q.mediaType), fields: 0, parts: 1 },
      })) {
        if (part.type !== 'file') fail(400, 'INVALID_MULTIPART', '上传参数请通过查询字符串传递');
        name = part.filename || 'image';
        await pipeline(part.file, createWriteStream(temp, { flags: 'wx' }));
        if (part.file.truncated) fail(413, 'FILE_TOO_LARGE', '文件超过当前上传上限');
      }
      if (!name) fail(400, 'FILE_REQUIRED', '请选择图片');
      const result = await acceptFile(ctx, temp, name, actor, {
        folderId: params(req).folderId || q.folderId,
        visibility: q.visibility,
        storageId: q.storageId,
        processing,
        classify: q.classify === undefined ? undefined : q.classify === 'true',
        mediaType: q.mediaType,
      });
      const responseImage = await imageResponse(ctx, ctx.image(result.image.id), actor, {
        allowUnreadable: true,
        fallback: true,
        signLocalLinks: false,
      });
      if (result.async) {
        reply.code(202).header('Location', `/api/v1/uploads/${result.uploadId}`);
        return {
          ...responseImage,
          uploadId: result.uploadId,
          imageId: result.image.id,
          statusUrl: `/api/v1/uploads/${result.uploadId}`,
        };
      }
      reply.code(201);
      return responseImage;
    } finally {
      ctx.activeUploads--;
      await rm(temp, { force: true }).catch(() => {});
    }
  };
  app.post('/api/v1/upload', upload);
  app.post('/api/v1/folders/:folderId/upload', upload);
  app.get('/i/:imageId', async (req, reply) => sendImage(ctx, req, reply, params(req).imageId!));
  app.get('/t/:imageId', async (req, reply) =>
    sendImage(ctx, req, reply, params(req).imageId!, true),
  );
}
