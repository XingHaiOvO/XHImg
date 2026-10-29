import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Context, params, query, visibility } from './context.js';
import { fail, id } from './security.js';
import { ObjectMissing } from './storage.js';
import { acceptFile, prepareUpload } from './pipeline.js';
import { uploadLimit } from './policies.js';
import { imageFilename } from './image-filename.js';

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
      `inline; filename*=UTF-8''${encodeURIComponent(imageFilename(basename(image.name).replace(/[\r\n]/g, ''), thumbnail ? 'webp' : image.format))}`,
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
      });
      await mkdir(join(ctx.config.dir, 'tmp'), { recursive: true });
      let name = '';
      for await (const part of req.parts({
        limits: { files: 1, fileSize: uploadLimit(ctx), fields: 0, parts: 1 },
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
      });
      if (result.async) {
        reply.code(202).header('Location', `/api/v1/uploads/${result.uploadId}`);
        return {
          ...result.image,
          uploadId: result.uploadId,
          imageId: result.image.id,
          statusUrl: `/api/v1/uploads/${result.uploadId}`,
        };
      }
      reply.code(201);
      return result.image;
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
