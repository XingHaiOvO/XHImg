import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { basename } from 'node:path';
import sharp from './image-processing.js';
import { Context, params, paging } from './context.js';
import { policyPatch, defaultPolicy, imageWork } from './policies.js';
import { queueProcessing } from './processing.js';
import {
  aiConfig,
  safeAIConfig,
  saveAIConfig,
  enqueueClassification,
  modelClassify,
  AIError,
} from './organization.js';
import { fail, id } from './security.js';
import { imageFilename } from './image-filename.js';

export function registerP1(app: FastifyInstance, ctx: Context) {
  app.get('/api/v1/admin/processing', async () => ({
    policy: { ...defaultPolicy, ...ctx.db.setting('processing', {}) },
    maxUploadMB: ctx.db.setting('maxUploadMB', 100),
  }));
  app.put('/api/v1/admin/processing', async (req) => {
    const b = z
      .object({ policy: policyPatch, maxUploadMB: z.number().int().min(1).max(100) })
      .parse(req.body);
    ctx.db.tx(() => {
      ctx.db.set('processing', { ...defaultPolicy, ...b.policy });
      ctx.db.set('maxUploadMB', b.maxUploadMB);
    });
    return { ok: true };
  });
  app.get('/api/v1/public/upload-config', async () => ({
    maxUploadMB: ctx.db.setting('maxUploadMB', 100),
  }));
  app.post('/api/v1/admin/images/:id/reprocess', async (req) => {
    const image = ctx.image(params(req).id!),
      b = z.object({ processing: policyPatch.optional() }).parse(req.body ?? {});
    queueProcessing(ctx, image, ctx.admin(req), b.processing);
    return { queued: true };
  });
  app.get('/api/v1/admin/images/:id/original', async (req, reply) => {
    const image = ctx.image(params(req).id!);
    if (image.deleted_at || image.state === 'purging') fail(404, 'NOT_FOUND', '图片已删除');
    const file = await ctx.storage.byId(image.storage_id).get(image.source_key ?? image.object_key);
    reply
      .header('Cache-Control', 'private, no-store')
      .header(
        'Content-Type',
        image.source_format === 'jpg'
          ? 'image/jpeg'
          : image.source_format
            ? `image/${image.source_format}`
            : image.mime,
      )
      .header('Content-Length', file.size)
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(imageFilename(basename(image.name).replace(/[\r\n]/g, ''), image.source_format ?? image.format))}`,
      );
    return reply.send(file.stream);
  });
  app.post('/api/v1/admin/images/:id/use-original', async (req) => {
    const image = ctx.image(params(req).id!);
    if (image.deleted_at || image.state === 'purging') fail(404, 'NOT_FOUND', '图片已删除');
    if (image.state !== 'processing' && image.publication_hold !== 1)
      fail(409, 'ALREADY_AVAILABLE', '图片已可用');
    await ctx.storage.byId(image.storage_id).head(image.object_key);
    ctx.db.tx(() => {
      ctx.db.run("DELETE FROM jobs WHERE image_id=? AND kind IN ('process','classify')", image.id);
      ctx.db.run(
        "UPDATE images SET state='ready',publication_hold=0,processing_status='skipped',classification_status='skipped',content_version=content_version+1,organization_version=organization_version+1,access_version=access_version+1 WHERE id=?",
        image.id,
      );
      ctx.db.run("UPDATE upload_sessions SET state='ready',error=NULL WHERE image_id=?", image.id);
      ctx.db.run(
        "INSERT INTO jobs (id,image_id,kind,created_at) VALUES (?,?,?,?) ON CONFLICT(image_id,kind) DO UPDATE SET state='pending',attempts=0,next_run=0",
        id('job'),
        image.id,
        'thumbnail',
        Date.now(),
      );
    });
    ctx.invalidate();
    return { ok: true };
  });
  app.get('/api/v1/admin/ai', async () => safeAIConfig(ctx));
  app.put('/api/v1/admin/ai', async (req) => saveAIConfig(ctx, req.body));
  app.post('/api/v1/admin/ai/test', async () => {
    const config = aiConfig(ctx),
      jpeg = await imageWork(() =>
        sharp({ create: { width: 8, height: 8, channels: 3, background: '#0088ff' } })
          .jpeg()
          .toBuffer(),
      );
    try {
      const result = await modelClassify(config, jpeg, [
        { id: 'test', name: '测试图片', description: '用于测试配置的蓝色图片' },
      ]);
      return { ok: true, folderId: result };
    } catch (error) {
      fail(400, 'AI_TEST_FAILED', error instanceof AIError ? error.safeMessage : '模型测试失败');
    }
  });
  app.post('/api/v1/admin/classification', async (req) => {
    if (!aiConfig(ctx).enabled) fail(400, 'AI_DISABLED', '请先配置并启用 AI');
    const b = z
      .object({
        ids: z.array(z.string()).min(1).max(100),
        skipUnavailable: z.boolean().default(false),
      })
      .parse(req.body);
    let queued = 0,
      skipped = 0;
    ctx.db.tx(() => {
      for (const imageId of new Set(b.ids)) {
        const image = ctx.db.one('SELECT * FROM images WHERE id=?', imageId);
        if (
          b.skipUnavailable &&
          (!image ||
            image.deleted_at ||
            image.state !== 'ready' ||
            ['pending', 'processing'].includes(image.processing_status) ||
            ['pending', 'running'].includes(image.classification_status))
        ) {
          skipped++;
          continue;
        }
        enqueueClassification(
          ctx,
          imageId,
          ctx.admin(req),
          !!ctx.image(imageId).publication_hold,
          ctx.db.one('SELECT id FROM upload_sessions WHERE image_id=?', imageId)?.id,
        );
        queued++;
      }
    });
    return { queued, skipped };
  });
  app.get('/api/v1/admin/classification', async (req) => {
    const p = paging(req),
      status = z
        .enum(['pending', 'running', 'completed', 'unmatched', 'failed', 'canceled', 'all'])
        .parse((req.query as any).status ?? 'all');
    const filter =
        status === 'all' ? "classification_status<>'skipped'" : 'classification_status=?',
      args = status === 'all' ? [] : [status];
    return {
      items: ctx.db
        .all(
          `SELECT * FROM images WHERE deleted_at IS NULL AND ${filter} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ...args,
          p.limit,
          p.offset,
        )
        .map((image) => ({
          ...ctx.imageInfo(image),
          error: ctx.db.one("SELECT error FROM jobs WHERE image_id=? AND kind='classify'", image.id)
            ?.error,
        })),
      total: ctx.db.one(
        `SELECT COUNT(*) n FROM images WHERE deleted_at IS NULL AND ${filter}`,
        ...args,
      )!.n,
      page: p.page,
      limit: p.limit,
    };
  });
}
