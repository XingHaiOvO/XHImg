import { imageResponse } from './image-urls.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Server, Upload } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, truncate, open, statfs, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Context } from './context.js';
import { fail, id, HttpError } from './security.js';
import { prepareUpload, acceptFile } from './pipeline.js';
import { fileHash, persistedActor, uploadLimit } from './policies.js';
import { queueProcessing } from './processing.js';
import { enqueueClassification } from './organization.js';
declare module 'fastify' {
  interface FastifyContextConfig {
    cors?: boolean;
  }
}

export const CHUNK_SIZE = 4 * 1024 * 1024;
const pathFor = (ctx: Context, uploadId: string) => join(ctx.config.dir, 'resumable', uploadId);
export function uploadOwner(ctx: Context, req: FastifyRequest, uploadId: string) {
  const session = ctx.db.one('SELECT * FROM upload_sessions WHERE id=?', uploadId);
  if (!session) fail(404, 'NOT_FOUND', '上传记录不存在');
  const actor = ctx.actor(req);
  if (
    actor.type !== 'admin' &&
    !(actor.type === 'key' && session.actor_kind === 'key' && actor.key.id === session.actor_id)
  )
    fail(404, 'NOT_FOUND', '上传记录不存在');
  if (
    actor.type === 'key' &&
    (!ctx.access.has(actor, 'upload') || !ctx.access.scope(actor, session.folder_id))
  )
    fail(403, 'UPLOAD_FORBIDDEN', '上传范围已变更');
  return { session, actor };
}
export function queueFinalization(ctx: Context, uploadId: string) {
  const session = ctx.db.one('SELECT * FROM upload_sessions WHERE id=?', uploadId);
  if (
    !session ||
    session.confirmed_offset !== session.length ||
    !['received', 'uploading'].includes(session.state)
  )
    return;
  ctx.db.tx(() => {
    ctx.db.run("UPDATE upload_sessions SET state='validating' WHERE id=?", uploadId);
    if (
      !ctx.db.one(
        "SELECT id FROM jobs WHERE kind='finalize' AND json_extract(payload,'$.sessionId')=?",
        uploadId,
      )
    )
      ctx.db.run(
        'INSERT INTO jobs (id,kind,payload,created_at) VALUES (?,?,?,?)',
        id('job'),
        'finalize',
        JSON.stringify({ sessionId: uploadId }),
        Date.now(),
      );
  });
}
export async function finalizeUpload(ctx: Context, uploadId: string) {
  const session = ctx.db.one('SELECT * FROM upload_sessions WHERE id=?', uploadId);
  if (!session || ['canceled', 'expired', 'ready'].includes(session.state)) return;
  const actor = persistedActor(ctx, session.actor_kind, session.actor_id),
    path = pathFor(ctx, uploadId);
  const options = {
    folderId: session.folder_id,
    visibility: session.visibility as 'public' | 'private',
    storageId: session.explicit_storage ? session.storage_id : undefined,
    processing: JSON.parse(session.policy),
    classify: !!session.classify,
  };
  await acceptFile(ctx, path, session.name, actor, options, uploadId);
  await rm(path, { force: true });
}
export async function recoverResumable(ctx: Context) {
  await mkdir(join(ctx.config.dir, 'resumable'), { recursive: true });
  await mkdir(join(ctx.config.dir, 'chunks'), { recursive: true });
  for (const row of ctx.db.all(
    "SELECT * FROM upload_sessions WHERE tus_metadata IS NOT NULL AND state IN ('created','uploading','received','validating')",
  )) {
    try {
      const path = pathFor(ctx, row.id),
        size = (await stat(path)).size;
      if (size > row.confirmed_offset) await truncate(path, row.confirmed_offset);
      if (size < row.confirmed_offset) {
        ctx.db.run(
          "UPDATE upload_sessions SET state='failed',error='上传文件不完整，请重新上传' WHERE id=?",
          row.id,
        );
        continue;
      }
      if (row.confirmed_offset === row.length && row.state !== 'validating')
        queueFinalization(ctx, row.id);
    } catch {
      ctx.db.run(
        "UPDATE upload_sessions SET state='failed',error='续传临时文件不存在，请重新上传' WHERE id=?",
        row.id,
      );
    }
  }
}
export async function expireResumable(ctx: Context) {
  for (const row of ctx.db.all(
    "SELECT * FROM upload_sessions WHERE (expires_at<? AND (state IN ('created','uploading','received') OR (state='failed' AND NOT EXISTS(SELECT 1 FROM images WHERE id=upload_sessions.image_id)))) OR state IN ('expired','canceled')",
    Date.now(),
  )) {
    await rm(pathFor(ctx, row.id), { force: true }).catch(() => {});
    ctx.db.run(
      "UPDATE upload_sessions SET state=CASE WHEN state='canceled' THEN state ELSE 'expired' END WHERE id=?",
      row.id,
    );
  }
  for (const directory of ['chunks', 'work']) {
    const root = join(ctx.config.dir, directory);
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (
        (await stat(path)).mtimeMs < Date.now() - 86400_000 &&
        !ctx.db.one("SELECT id FROM jobs WHERE id=? AND state='running'", entry.name)
      )
        await rm(path, { recursive: entry.isDirectory(), force: true }).catch(() => {});
    }
  }
  const resumableRoot = join(ctx.config.dir, 'resumable');
  for (const entry of await readdir(resumableRoot, { withFileTypes: true })) {
    if (entry.isFile() && !ctx.db.one('SELECT id FROM upload_sessions WHERE id=?', entry.name)) {
      const path = join(resumableRoot, entry.name);
      if ((await stat(path)).mtimeMs < Date.now() - 86400_000)
        await rm(path, { force: true }).catch(() => {});
    }
  }
}
export async function registerResumable(app: FastifyInstance, ctx: Context) {
  await recoverResumable(ctx);
  const scope = new AsyncLocalStorage<{ req: FastifyRequest; checksum?: string }>();
  const configstore = {
    get: async (uploadId: string) => {
      const row = ctx.db.one('SELECT tus_metadata FROM upload_sessions WHERE id=?', uploadId);
      return row?.tus_metadata ? new Upload(JSON.parse(row.tus_metadata)) : undefined;
    },
    set: async (uploadId: string, value: Upload) => {
      ctx.db.run(
        'UPDATE upload_sessions SET tus_metadata=? WHERE id=?',
        JSON.stringify(value),
        uploadId,
      );
    },
    delete: async (uploadId: string) => {
      ctx.db.run(
        "UPDATE upload_sessions SET state='canceled',tus_metadata=NULL WHERE id=?",
        uploadId,
      );
    },
    list: async () =>
      ctx.db
        .all('SELECT id FROM upload_sessions WHERE tus_metadata IS NOT NULL')
        .map((x) => x.id as string),
  };
  class CheckedStore extends FileStore {
    constructor() {
      super({
        directory: join(ctx.config.dir, 'resumable'),
        configstore,
        expirationPeriodInMilliseconds: 86400_000,
      });
      this.extensions = ['creation', 'expiration', 'termination'];
    }
    override async getUpload(uploadId: string) {
      const row = ctx.db.one('SELECT * FROM upload_sessions WHERE id=?', uploadId);
      if (!row) throw { status_code: 404, body: 'Upload not found' };
      if (
        ['expired', 'canceled'].includes(row.state) ||
        (row.expires_at < Date.now() && ['created', 'uploading'].includes(row.state))
      )
        throw { status_code: 410, body: 'Upload expired' };
      const upload =
        row.confirmed_offset === row.length && row.tus_metadata
          ? new Upload(JSON.parse(row.tus_metadata))
          : await super.getUpload(uploadId);
      upload.offset = row.confirmed_offset;
      return upload;
    }
    override async write(body: Readable, uploadId: string, offset: number) {
      const current = scope.getStore();
      if (!current) throw { status_code: 500, body: 'Missing request context' };
      if (!current.checksum || !/^[a-f\d]{64}$/i.test(current.checksum))
        throw { status_code: 400, body: 'X-Chunk-SHA256 is required' };
      if (ctx.activeUploads >= 2)
        throw { status_code: 429, body: 'Two uploads may run concurrently' };
      ctx.activeUploads++;
      const part = join(ctx.config.dir, 'chunks', id('part'));
      try {
        let length = 0;
        const limiter = new Transform({
          transform(chunk, _encoding, done) {
            length += chunk.length;
            if (length > CHUNK_SIZE) done(new Error('CHUNK_TOO_LARGE'));
            else done(null, chunk);
          },
        });
        await pipeline(body, limiter, createWriteStream(part, { flags: 'wx' }));
        if ((await fileHash(part)) !== current.checksum.toLowerCase())
          throw { status_code: 460, body: 'Chunk checksum mismatch' };
        const { session } = uploadOwner(ctx, current.req, uploadId);
        if (!['created', 'uploading'].includes(session.state) || session.expires_at < Date.now())
          throw { status_code: 410, body: 'Upload is no longer writable' };
        if (session.confirmed_offset !== offset)
          throw { status_code: 409, body: 'Offset mismatch' };
        if (offset + length > session.length)
          throw { status_code: 413, body: 'Upload length exceeded' };
        let next: number;
        try {
          next = await super.write(createReadStream(part), uploadId, offset);
          const handle = await open(pathFor(ctx, uploadId), 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          ctx.db.run(
            'UPDATE upload_sessions SET confirmed_offset=?,state=? WHERE id=?',
            next,
            next === session.length ? 'received' : 'uploading',
            uploadId,
          );
        } catch (error) {
          await truncate(pathFor(ctx, uploadId), offset).catch(() => {});
          throw error;
        }
        return next;
      } catch (error) {
        if (error instanceof HttpError)
          throw { status_code: error.statusCode, body: error.message };
        if (error instanceof Error && error.message === 'CHUNK_TOO_LARGE')
          throw { status_code: 413, body: 'Chunk exceeds 4MB' };
        throw error;
      } finally {
        ctx.activeUploads--;
        await rm(part, { force: true }).catch(() => {});
      }
    }
  }
  const tus = new Server({
    path: '/api/v1/resumable',
    datastore: new CheckedStore(),
    relativeLocation: true,
    maxSize: () => uploadLimit(ctx),
    disableTerminationForFinishedUploads: true,
    allowedOrigins: () => {
      const request = scope.getStore()?.req;
      return !!request && ctx.allowsOrigin(request);
    },
    allowedHeaders: ['Authorization', 'X-CSRF-Token', 'X-Chunk-SHA256'],
    exposedHeaders: [
      'Location',
      'Upload-Offset',
      'Upload-Length',
      'Upload-Expires',
      'Tus-Resumable',
      'Tus-Max-Size',
    ],
    namingFunction: () => id('upl'),
    onUploadCreate: async (_req, upload) => {
      try {
        const request = scope.getStore()!.req,
          actor = ctx.actor(request),
          meta = upload.metadata ?? {};
        if (!upload.size || upload.size < 1 || upload.size > uploadLimit(ctx))
          fail(413, 'FILE_TOO_LARGE', '文件超过上传上限');
        const expected = z
          .string()
          .regex(/^[a-f0-9]{64}$/i)
          .parse(meta.sha256)
          .toLowerCase();
        const options = {
          folderId: meta.folderId || undefined,
          storageId: meta.storageId || undefined,
          visibility: z.enum(['private', 'public']).parse(meta.visibility ?? 'private'),
          processing: meta.processing ? JSON.parse(meta.processing) : undefined,
          classify:
            meta.classify == null
              ? undefined
              : z.enum(['true', 'false']).parse(meta.classify) === 'true',
        };
        const prepared = prepareUpload(ctx, actor, options);
        const space = await statfs(ctx.config.dir);
        // Recheck after the asynchronous disk query so concurrent creations cannot
        // both reserve the last available session or bytes.
        const quota = ctx.db.one(
          "SELECT COUNT(*) n,COALESCE(SUM(length),0) bytes,COALESCE(SUM(length-confirmed_offset),0) remaining FROM upload_sessions WHERE tus_metadata IS NOT NULL AND (state IN ('created','uploading','received','validating') OR (state='failed' AND NOT EXISTS(SELECT 1 FROM images WHERE id=upload_sessions.image_id)))",
        )!;
        if (quota.n >= 20 || quota.bytes + upload.size > 2 * 1024 ** 3)
          fail(429, 'UPLOAD_QUOTA', '未完成上传过多，请先完成或取消');
        if (space.bavail * space.bsize < quota.remaining + upload.size + 512 * 1024 ** 2)
          fail(507, 'DISK_SPACE', '磁盘空间不足，无法开始上传');
        ctx.db.run(
          'INSERT INTO upload_sessions (id,image_id,actor_kind,actor_id,folder_id,storage_id,name,visibility,length,expected_hash,policy,classify,explicit_folder,explicit_storage,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          upload.id,
          id('img'),
          prepared.kind,
          prepared.actorId,
          prepared.folderId,
          prepared.storageId,
          z.string().min(1).max(120).parse(meta.filename),
          prepared.visibility,
          upload.size,
          expected,
          JSON.stringify(prepared.policy),
          +prepared.classify,
          +!!options.folderId,
          +!!options.storageId,
          Date.now(),
          Date.now() + 86400_000,
        );
        return {};
      } catch (error) {
        throw {
          status_code: error instanceof HttpError ? error.statusCode : 400,
          body: error instanceof HttpError ? error.message : 'Invalid upload metadata',
        };
      }
    },
    onUploadFinish: async (_request, upload) => {
      queueFinalization(ctx, upload.id);
      return {};
    },
  });
  app.addContentTypeParser('application/offset+octet-stream', (_req, _body, done) => done(null));
  const tusHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.origin && ctx.allowsOrigin(req))
      reply.header('Access-Control-Allow-Origin', req.headers.origin).header('Vary', 'Origin');
    const uploadId = (req.params as { uploadId?: string }).uploadId;
    if (req.method === 'OPTIONS') {
      if (!ctx.allowsOrigin(req)) fail(403, 'ORIGIN_FORBIDDEN', '请求来源未获允许');
    } else {
      const actor = ctx.actor(req);
      ctx.csrf(req, actor);
      if (!ctx.access.has(actor, 'upload')) fail(401, 'UPLOAD_AUTH_REQUIRED', '续传需要授权');
      if (uploadId) {
        uploadOwner(ctx, req, uploadId);
        if (!/^upl_[a-f\d]{24}$/.test(uploadId)) fail(404, 'NOT_FOUND', '上传不存在');
      }
    }
    if (uploadId && req.method === 'PATCH') {
      const row = ctx.db.one('SELECT * FROM upload_sessions WHERE id=?', uploadId)!;
      if (
        !['canceled', 'expired'].includes(row.state) &&
        row.confirmed_offset === row.length &&
        req.headers['upload-offset'] === String(row.length) &&
        req.headers['content-length'] === '0'
      )
        return reply
          .code(204)
          .header('Tus-Resumable', '1.0.0')
          .header('Upload-Offset', row.length)
          .send();
    }
    if (req.method === 'GET') fail(405, 'METHOD_NOT_ALLOWED', '请通过上传状态接口查询');
    if (
      req.method === 'POST' &&
      (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['upload-defer-length'])
    )
      fail(400, 'INVALID_TUS_CREATE', '创建请求不能包含文件内容或延迟长度');
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    const request = new Request(`${req.protocol}://${req.host}${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === 'PATCH'
        ? { body: Readable.toWeb(req.raw) as ReadableStream, duplex: 'half' }
        : {}),
    } as RequestInit);
    const response = await scope.run(
      { req, checksum: req.headers['x-chunk-sha256'] as string | undefined },
      () => tus.handleWeb(request),
    );
    for (const [key, value] of response.headers) reply.header(key, value);
    reply.code(response.status);
    return reply.send(response.body ? Readable.fromWeb(response.body as any) : undefined);
  };
  app.all('/api/v1/resumable', { config: { cors: false } }, tusHandler);
  app.all('/api/v1/resumable/:uploadId', { config: { cors: false } }, tusHandler);
  app.get('/api/v1/uploads/:uploadId', async (req) => {
    const { session, actor } = uploadOwner(ctx, req, (req.params as any).uploadId);
    if (session.expires_at < Date.now() && ['created', 'uploading'].includes(session.state))
      return {
        uploadId: session.id,
        imageId: session.image_id,
        state: 'expired',
        offset: session.confirmed_offset,
        length: session.length,
        error: '上传已过期',
      };
    const image = ctx.db.one('SELECT * FROM images WHERE id=?', session.image_id);
    return {
      uploadId: session.id,
      imageId: session.image_id,
      state: session.state,
      offset: session.confirmed_offset,
      length: session.length,
      expiresAt: session.expires_at,
      error: session.error,
      image: image
        ? await imageResponse(ctx, image, actor, {
            allowUnreadable: true,
            fallback: true,
            signLocalLinks: false,
          })
        : null,
    };
  });
  app.delete('/api/v1/uploads/:uploadId', async (req) => {
    const { session, actor } = uploadOwner(ctx, req, (req.params as any).uploadId);
    ctx.csrf(req, actor);
    if (session.state === 'ready') fail(409, 'ALREADY_READY', '图片已发布，请使用回收站');
    ctx.db.tx(() => {
      ctx.db.run("UPDATE upload_sessions SET state='canceled' WHERE id=?", session.id);
      ctx.db.run(
        'UPDATE images SET deleted_at=?,content_version=content_version+1,organization_version=organization_version+1 WHERE id=? AND publication_hold=1',
        Date.now(),
        session.image_id,
      );
      ctx.db.run(
        "UPDATE images SET processing_status=CASE WHEN state='processing' THEN 'failed' ELSE processing_status END,classification_status=CASE WHEN classification_status IN ('pending','running') THEN 'canceled' ELSE classification_status END WHERE id=? AND publication_hold=1",
        session.image_id,
      );
      ctx.db.run(
        "UPDATE jobs SET state='failed',error='上传已取消' WHERE image_id=? AND kind IN ('process','classify')",
        session.image_id,
      );
    });
    ctx.invalidate();
    return { ok: true };
  });
  app.post('/api/v1/uploads/:uploadId/retry', async (req) => {
    const { session, actor } = uploadOwner(ctx, req, (req.params as any).uploadId);
    ctx.csrf(req, actor);
    if (session.state !== 'failed') fail(409, 'NOT_FAILED', '上传任务尚未失败');
    const image = ctx.db.one('SELECT * FROM images WHERE id=?', session.image_id);
    if (image) {
      if (image.processing_status === 'failed')
        queueProcessing(ctx, image, actor, JSON.parse(session.policy));
      else if (image.classification_status === 'failed')
        enqueueClassification(ctx, image.id, actor, !!image.publication_hold, session.id);
      else fail(409, 'NOT_RETRYABLE', '图片状态已变化，请刷新后重试');
    } else {
      if (session.confirmed_offset !== session.length || session.expires_at < Date.now())
        fail(409, 'NOT_RETRYABLE', '文件未收齐或已过期，请重新上传');
      ctx.db.tx(() => {
        ctx.db.run(
          "DELETE FROM jobs WHERE kind='finalize' AND json_extract(payload,'$.sessionId')=?",
          session.id,
        );
        ctx.db.run("UPDATE upload_sessions SET state='received',error=NULL WHERE id=?", session.id);
        queueFinalization(ctx, session.id);
      });
    }
    return { queued: true };
  });
}
