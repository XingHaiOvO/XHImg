import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from './image-processing.js';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Context, params, query, visibility } from './context.js';
import { fail, id } from './security.js';
import { ObjectMissing } from './storage.js';

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
    random || image.effective_visibility !== 'public'
      ? 'private, no-store'
      : 'public, no-cache, must-revalidate',
  );
  reply.header('Vary', 'Cookie, Authorization');
  const etag = `"${image.checksum}-${image.access_version}-${variant}"`;
  // Authorization precedes conditional cache handling, even for a previously public URL.
  if (!random && req.headers['if-none-match'] === etag) return reply.code(304).send();
  try {
    const object = await ctx.storage
      .byId(image.storage_id)
      .get(thumbnail ? image.thumb_key : image.object_key);
    reply
      .header('ETag', etag)
      .header('Content-Type', thumbnail ? 'image/webp' : image.mime)
      .header('Content-Length', object.size);
    reply.header(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(basename(image.name).replace(/[\r\n]/g, ''))}`,
    );
    return reply.send(object.stream);
  } catch (e) {
    if (e instanceof ObjectMissing) {
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
    if (ctx.activeUploads >= 2) fail(429, 'UPLOAD_BUSY', '同时最多上传两个文件，请稍后重试');
    ctx.activeUploads++;
    const operationId = id('upl'),
      temp = join(ctx.config.dir, 'tmp', operationId);
    let journaled = false;
    try {
      const q = z
        .object({
          folderId: z.string().optional(),
          visibility: visibility.default('private'),
          storageId: z.string().optional(),
        })
        .parse(req.query);
      const folderId = params(req).folderId || q.folderId || 'uncategorized';
      if (params(req).folderId && q.folderId && params(req).folderId !== q.folderId)
        fail(400, 'FOLDER_MISMATCH', '目标文件夹不一致');
      const folder = ctx.folder(folderId);
      if (!ctx.access.scope(actor, folder.id))
        fail(403, 'FOLDER_FORBIDDEN', '没有目标文件夹的上传权限');
      const storageId =
        q.storageId ||
        folder.storage_id ||
        ctx.db.one('SELECT id FROM storage_backends WHERE is_default=1')?.id;
      if (!storageId) fail(503, 'NO_STORAGE', '尚未配置存储');
      if (q.storageId && !ctx.access.storage(actor, storageId))
        fail(403, 'STORAGE_FORBIDDEN', '没有指定存储的使用权限');
      const storageRow = ctx.db.one(
        'SELECT * FROM storage_backends WHERE id=? AND enabled=1',
        storageId,
      );
      if (!storageRow) fail(503, 'STORAGE_DISABLED', '目标存储已禁用');
      await mkdir(join(ctx.config.dir, 'tmp'), { recursive: true });
      const parts = req.parts({
        limits: { files: 1, fileSize: 20 * 1024 * 1024, fields: 0, parts: 1 },
      });
      let fileName = '',
        received = false;
      for await (const part of parts) {
        if (part.type !== 'file') fail(400, 'INVALID_MULTIPART', '上传参数请通过查询字符串传递');
        if (received) fail(400, 'TOO_MANY_FILES', '每次请求仅接受一个文件');
        received = true;
        fileName = basename(part.filename || 'image').slice(0, 120);
        await pipeline(part.file, createWriteStream(temp, { flags: 'wx' }));
        if (part.file.truncated) fail(413, 'FILE_TOO_LARGE', '文件不能超过 20MB');
      }
      if (!received) fail(400, 'FILE_REQUIRED', '请选择图片');
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(temp, {
          limitInputPixels: 40_000_000,
          animated: true,
          failOn: 'warning',
        }).metadata();
      } catch {
        fail(400, 'INVALID_IMAGE', '图片无效、损坏或超过 4000 万像素');
      }
      if (!['jpeg', 'png', 'webp'].includes(metadata.format!))
        fail(415, 'UNSUPPORTED_FORMAT', '仅支持 JPG、PNG 和 WebP');
      if ((metadata.pages ?? 1) > 1) fail(415, 'ANIMATED_IMAGE', 'P0 暂不接受动画图片');
      try {
        await sharp(temp, { limitInputPixels: 40_000_000, failOn: 'warning' }).stats();
      } catch {
        fail(400, 'INVALID_IMAGE', '图片内容损坏，无法完整解码');
      }
      const format = metadata.format === 'jpeg' ? 'jpg' : metadata.format!,
        mime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
      const imageId = id('img'),
        objectKey = `originals/${imageId}.${format}`,
        thumbKey = `thumbnails/${imageId}.webp`;
      const checksum = createHash('sha256');
      for await (const chunk of createReadStream(temp)) checksum.update(chunk);
      const digest = checksum.digest('hex');
      const { stat } = await import('node:fs/promises');
      const size = (await stat(temp)).size;
      ctx.db.run(
        'INSERT INTO upload_operations VALUES (?,?,?,?,?,?,?)',
        operationId,
        storageId,
        objectKey,
        thumbKey,
        temp,
        'writing',
        Date.now(),
      );
      journaled = true;
      const adapter = ctx.storage.adapter(storageRow);
      await adapter.put(objectKey, temp, mime);
      if ((await adapter.head(objectKey)) !== size)
        fail(503, 'STORAGE_VERIFY_FAILED', '存储对象大小校验失败');
      // Recheck permissions and configuration after the external I/O boundary.
      const currentActor = ctx.actor(req),
        currentFolder = ctx.folder(folderId);
      if (!ctx.access.has(currentActor, 'upload') || !ctx.access.scope(currentActor, folderId))
        fail(403, 'AUTH_CHANGED', '上传期间授权已变更');
      if (!ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND enabled=1', storageId))
        fail(503, 'STORAGE_DISABLED', '上传期间存储已禁用');
      ctx.db.tx(() => {
        ctx.db.run(
          'INSERT INTO images (id,folder_id,storage_id,object_key,thumb_key,name,format,mime,size,width,height,checksum,visibility,effective_visibility,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          imageId,
          folderId,
          storageId,
          objectKey,
          thumbKey,
          fileName,
          format,
          mime,
          size,
          metadata.width ?? 0,
          metadata.height ?? 0,
          digest,
          q.visibility,
          q.visibility === 'public' && currentFolder.effective_visibility === 'public'
            ? 'public'
            : 'private',
          Date.now(),
        );
        ctx.db.run(
          'INSERT INTO jobs (id,image_id,kind,created_at) VALUES (?,?,?,?)',
          id('job'),
          imageId,
          'thumbnail',
          Date.now(),
        );
        ctx.db.run("UPDATE upload_operations SET state='committed' WHERE id=?", operationId);
      });
      ctx.invalidate();
      reply.code(201);
      return ctx.imageInfo(ctx.image(imageId));
    } finally {
      ctx.activeUploads--;
      await rm(temp, { force: true }).catch(() => {});
      if (journaled)
        ctx.db.run(
          "UPDATE upload_operations SET state='abandoned' WHERE id=? AND state='writing'",
          operationId,
        );
    }
  };
  app.post('/api/v1/upload', upload);
  app.post('/api/v1/folders/:folderId/upload', upload);
  app.get('/i/:imageId', async (req, reply) => sendImage(ctx, req, reply, params(req).imageId!));
  app.get('/t/:imageId', async (req, reply) =>
    sendImage(ctx, req, reply, params(req).imageId!, true),
  );
}
