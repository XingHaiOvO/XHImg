import { imageResponse, sameImageLocation } from './image-urls.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Context, params, query, paging, name, visibility } from './context.js';
import { fail, id } from './security.js';
import { ObjectMissing, s3ConfigSchema } from './storage.js';
import { policyPatch } from './policies.js';
import { migrationStorageUsed, assertNotMigrating } from './migrations.js';

const folderBody = z.object({
  name,
  parentId: z.string().nullable().default(null),
  description: z.string().max(1000).default(''),
  visibility: visibility.default('private'),
  storageId: z.string().nullable().default(null),
  sortOrder: z.number().int().default(0),
  coverId: z.string().nullable().default(null),
});
const folderPatch = z.object({
  name: name.optional(),
  parentId: z.string().nullable().optional(),
  description: z.string().max(1000).optional(),
  visibility: visibility.optional(),
  storageId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  coverId: z.string().nullable().optional(),
  processingPolicy: policyPatch.nullable().optional(),
  aiEnabled: z.boolean().optional(),
});
const imagePatch = z.object({
  name: name.optional(),
  folderId: z.string().optional(),
  visibility: visibility.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  description: z.string().max(2000).optional(),
});
export function registerResources(app: FastifyInstance, ctx: Context) {
  app.get('/api/v1/admin/folders', async () => ({
    items: ctx.db
      .all('SELECT * FROM folders ORDER BY sort_order,name')
      .map((x) => ctx.folderInfo(x)),
  }));
  app.post('/api/v1/admin/folders', async (req, reply) => {
    const b = folderBody.parse(req.body);
    if (b.parentId) ctx.folder(b.parentId);
    if (
      b.storageId &&
      !ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND enabled=1', b.storageId)
    )
      fail(400, 'INVALID_STORAGE', '存储不可用');
    const folderId = id('fld');
    ctx.db.tx(() => {
      ctx.db.run(
        'INSERT INTO folders (id,parent_id,name,description,visibility,storage_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)',
        folderId,
        b.parentId,
        b.name,
        b.description,
        b.visibility,
        b.storageId,
        b.sortOrder,
        Date.now(),
      );
      ctx.access.refresh();
    });
    ctx.invalidate();
    reply.code(201);
    return ctx.folderInfo(ctx.folder(folderId));
  });
  app.patch('/api/v1/admin/folders/:id', async (req) => {
    const folder = ctx.folder(params(req).id!);
    const b = folderPatch.parse(req.body);
    if (
      folder.system &&
      (b.parentId !== undefined || b.visibility !== undefined || b.name !== undefined)
    )
      fail(400, 'SYSTEM_FOLDER', '未分类文件夹不可移动、改名或公开');
    if (folder.system && b.aiEnabled) fail(400, 'SYSTEM_FOLDER', '未分类文件夹不作为 AI 目标');
    if (b.parentId) {
      ctx.folder(b.parentId);
      if (ctx.access.descendants(folder.id).includes(b.parentId))
        fail(400, 'FOLDER_CYCLE', '文件夹不能移动到自身或其子文件夹');
    }
    if (
      b.storageId &&
      !ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND enabled=1', b.storageId)
    )
      fail(400, 'INVALID_STORAGE', '存储不可用');
    if (
      b.coverId &&
      !ctx.db.one(
        'SELECT id FROM images WHERE id=? AND folder_id=? AND deleted_at IS NULL',
        b.coverId,
        folder.id,
      )
    )
      fail(400, 'INVALID_COVER', '封面必须属于当前文件夹');
    const fields: Record<string, string> = {
      name: 'name',
      parentId: 'parent_id',
      description: 'description',
      visibility: 'visibility',
      storageId: 'storage_id',
      sortOrder: 'sort_order',
      coverId: 'cover_id',
      processingPolicy: 'processing_policy',
      aiEnabled: 'ai_enabled',
    };
    ctx.db.tx(() => {
      for (const [key, value] of Object.entries(b))
        ctx.db.run(
          `UPDATE folders SET ${fields[key]}=? WHERE id=?`,
          key === 'processingPolicy'
            ? value === null
              ? null
              : JSON.stringify(value)
            : key === 'aiEnabled'
              ? +!!value
              : value,
          folder.id,
        );
      ctx.access.refresh();
    });
    ctx.invalidate();
    return ctx.folderInfo(ctx.folder(folder.id));
  });
  app.delete('/api/v1/admin/folders/:id', async (req) => {
    const f = ctx.folder(params(req).id!);
    if (f.system) fail(400, 'SYSTEM_FOLDER', '未分类文件夹不可删除');
    if (
      ctx.db.one('SELECT id FROM images WHERE folder_id=? LIMIT 1', f.id) ||
      ctx.db.one('SELECT id FROM folders WHERE parent_id=? LIMIT 1', f.id)
    )
      fail(409, 'FOLDER_NOT_EMPTY', '请先移走或删除全部内容，包括回收站图片');
    if (
      ctx.db.one(
        "SELECT id FROM upload_sessions WHERE folder_id=? AND state NOT IN ('ready','expired','canceled') LIMIT 1",
        f.id,
      )
    )
      fail(409, 'UPLOAD_IN_PROGRESS', '文件夹仍有未完成上传，请先完成或取消');
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM upload_sessions WHERE folder_id=?', f.id);
      ctx.db.run('DELETE FROM folders WHERE id=?', f.id);
    });
    ctx.invalidate();
    return { ok: true };
  });

  const listImages = async (req: FastifyRequest, publicOnly = false, folderId?: string) => {
    const actor = publicOnly ? { type: 'anonymous' as const } : ctx.actor(req);
    const q = query(req);
    const p = paging(req);
    const conditions = [
      q.trash === 'true' && !publicOnly ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    const args: any[] = [];
    if (actor.type !== 'admin') {
      conditions.push("state='ready'", 'publication_hold=0');
      if (
        actor.type === 'anonymous' ||
        !ctx.access.has(actor, 'read') ||
        !ctx.access.has(actor, 'private:read')
      )
        conditions.push("effective_visibility='public'");
      else {
        const allowed = ctx.db
          .all('SELECT id FROM folders')
          .filter((f) => ctx.access.scope(actor, f.id))
          .map((f) => f.id);
        conditions.push(
          `(effective_visibility='public' OR folder_id IN (SELECT value FROM json_each(?)))`,
        );
        args.push(JSON.stringify(allowed));
      }
    }
    const folder = folderId || q.folderId;
    if (folder) {
      conditions.push('folder_id=?');
      args.push(folder);
    }
    if (q.search) {
      conditions.push(
        "(name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(images.tags) WHERE value LIKE ? ESCAPE '\\'))",
      );
      const search = '%' + q.search.slice(0, 120).replace(/[\\%_]/g, '\\$&') + '%';
      args.push(search, search);
    }
    if (q.tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(images.tags) WHERE value=?)');
      args.push(q.tag.slice(0, 60));
    }
    const where = conditions.join(' AND '),
      order =
        q.sort === 'oldest'
          ? 'created_at ASC,id ASC'
          : q.sort === 'name'
            ? 'name ASC,id ASC'
            : 'created_at DESC,id DESC';
    return {
      items: await Promise.all(
        ctx.db
          .all(
            `SELECT * FROM images WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
            ...args,
            p.limit,
            p.offset,
          )
          .map(async (x) => {
            const info = await imageResponse(ctx, x, actor);
            if (publicOnly) {
              const { storageId, visibility, effectiveVisibility, deletedAt, ...safe } = info;
              return safe;
            }
            return info;
          }),
      ),
      total: ctx.db.one(`SELECT COUNT(*) n FROM images WHERE ${where}`, ...args)!.n,
      page: p.page,
      limit: p.limit,
      ...(q.trash === 'true' && !publicOnly && actor.type === 'admin'
        ? {
            totalSize: ctx.db.one(
              'SELECT COALESCE(SUM(size),0) AS n FROM images WHERE deleted_at IS NOT NULL',
            )!.n,
          }
        : {}),
    };
  };
  app.get('/api/v1/admin/images', async (req) => listImages(req));
  app.get('/api/v1/public/images', async (req) => listImages(req, true));
  app.get('/api/v1/folders/:folderId/images', async (req) => {
    const f = ctx.folder(params(req).folderId!);
    const actor = ctx.actor(req);
    if (
      f.effective_visibility !== 'public' &&
      !(
        ctx.access.has(actor, 'read') &&
        ctx.access.has(actor, 'private:read') &&
        ctx.access.scope(actor, f.id)
      )
    )
      fail(404, 'NOT_FOUND', '文件夹不存在');
    return listImages(req, false, f.id);
  });
  app.get('/api/v1/public/folders', async () => ({
    items: ctx.db.all(
      "SELECT id,parent_id,name,description,sort_order FROM folders WHERE effective_visibility='public' ORDER BY sort_order,name",
    ),
  }));
  app.patch('/api/v1/admin/images/:id', async (req) => {
    const img = ctx.image(params(req).id!);
    const b = imagePatch.parse(req.body);
    if (b.folderId) ctx.folder(b.folderId);
    const fields: Record<string, string> = {
      name: 'name',
      folderId: 'folder_id',
      visibility: 'visibility',
      tags: 'tags',
      description: 'description',
    };
    ctx.db.tx(() => {
      for (const [k, v] of Object.entries(b))
        ctx.db.run(
          `UPDATE images SET ${fields[k]}=? WHERE id=?`,
          k === 'tags' ? JSON.stringify(v) : v,
          img.id,
        );
      if (b.folderId !== undefined)
        ctx.db.run(
          "UPDATE images SET organization_version=organization_version+1,classification_status=CASE WHEN classification_status IN ('pending','running') THEN 'canceled' ELSE classification_status END,publication_hold=CASE WHEN state='ready' THEN 0 ELSE publication_hold END WHERE id=?",
          img.id,
        );
      if (b.folderId !== undefined && img.state === 'ready')
        ctx.db.run("UPDATE upload_sessions SET state='ready',error=NULL WHERE image_id=?", img.id);
      ctx.access.refresh();
    });
    ctx.invalidate();
    return imageResponse(ctx, ctx.image(img.id), ctx.admin(req), { signLocalLinks: false });
  });
  app.post('/api/v1/admin/images/batch', async (req) => {
    const b = z
      .object({
        ids: z.array(z.string()).min(1).max(100),
        action: z.enum(['delete', 'restore', 'move', 'visibility', 'permanent']),
        folderId: z.string().optional(),
        visibility: visibility.optional(),
      })
      .parse(req.body);
    if (b.action === 'move') ctx.folder(z.string().parse(b.folderId));
    if (b.action === 'visibility') visibility.parse(b.visibility);
    let skipped = 0;
    const purging: string[] = [];
    ctx.db.tx(() => {
      for (const imageId of b.action === 'permanent' ? new Set(b.ids) : b.ids) {
        const img =
          b.action === 'permanent'
            ? ctx.db.one('SELECT * FROM images WHERE id=?', imageId)
            : ctx.image(imageId);
        if (!img) {
          skipped++;
          continue;
        }
        if (img.state === 'purging') fail(409, 'PURGING', '图片正在彻底删除');
        if (b.action === 'permanent') {
          if (!img.deleted_at) {
            skipped++;
            continue;
          }
          ctx.db.run("UPDATE images SET state='purging' WHERE id=?", imageId);
          if (!ctx.db.one("SELECT id FROM jobs WHERE image_id=? AND kind='purge'", imageId))
            ctx.db.run(
              'INSERT INTO jobs (id,image_id,kind,created_at) VALUES (?,?,?,?)',
              id('job'),
              imageId,
              'purge',
              Date.now(),
            );
          purging.push(imageId);
        }
        if (b.action === 'delete')
          ctx.db.run('UPDATE images SET deleted_at=? WHERE id=?', Date.now(), imageId);
        if (b.action === 'restore')
          ctx.db.run(
            "UPDATE images SET deleted_at=NULL,state=CASE WHEN state='missing' THEN state ELSE 'ready' END WHERE id=?",
            imageId,
          );
        if (b.action === 'move')
          ctx.db.run(
            "UPDATE images SET folder_id=?,organization_version=organization_version+1,classification_status=CASE WHEN classification_status IN ('pending','running') THEN 'canceled' ELSE classification_status END,publication_hold=CASE WHEN state='ready' THEN 0 ELSE publication_hold END WHERE id=?",
            b.folderId,
            imageId,
          );
        if (b.action === 'move' && img.state === 'ready')
          ctx.db.run(
            "UPDATE upload_sessions SET state='ready',error=NULL WHERE image_id=?",
            imageId,
          );
        if (b.action === 'visibility')
          ctx.db.run('UPDATE images SET visibility=? WHERE id=?', b.visibility, imageId);
      }
      ctx.access.refresh();
    });
    if (b.action === 'delete') for (const imageId of b.ids) ctx.migrationControl?.image(imageId);
    for (const imageId of purging) ctx.migrationControl?.image(imageId);
    ctx.invalidate();
    return b.action === 'permanent' ? { ok: true, skipped } : { ok: true };
  });
  app.get('/api/v1/admin/images/:id/trash-preview', async (req, reply) => {
    ctx.admin(req);
    const image = ctx.image(params(req).id!);
    if (!image.deleted_at || image.state === 'purging') fail(404, 'NOT_FOUND', '回收站图片不可用');
    let thumbnail = query(req).thumbnail === 'true' && image.thumbnail_state === 'ready';
    try {
      const storage = ctx.storage.byId(image.storage_id);
      const object = await storage
        .get(thumbnail ? image.thumb_key : image.object_key)
        .catch((error) => {
          if (!(error instanceof ObjectMissing) || !thumbnail) throw error;
          thumbnail = false;
          return storage.get(image.object_key);
        });
      try {
        ctx.admin(req);
        if (!sameImageLocation(image, ctx.image(image.id)))
          fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重试');
      } catch (error) {
        object.stream.destroy();
        throw error;
      }
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('Content-Type', thumbnail ? 'image/webp' : image.mime)
        .header('Content-Length', object.size)
        .header('Content-Disposition', 'inline')
        .send(object.stream);
    } catch (error) {
      if (error instanceof ObjectMissing) fail(404, 'OBJECT_MISSING', '文件暂时不可用');
      throw error;
    }
  });
  app.delete('/api/v1/admin/images/:id', async (req) => {
    const image = ctx.image(params(req).id!);
    ctx.db.run(
      'UPDATE images SET deleted_at=?,access_version=access_version+1 WHERE id=?',
      Date.now(),
      image.id,
    );
    ctx.migrationControl?.image(image.id);
    ctx.invalidate();
    return { ok: true };
  });
  app.post('/api/v1/admin/images/:id/restore', async (req) => {
    const image = ctx.image(params(req).id!);
    if (image.state === 'purging') fail(409, 'PURGING', '图片正在彻底删除');
    ctx.db.tx(() => {
      ctx.db.run('UPDATE images SET deleted_at=NULL WHERE id=?', image.id);
      ctx.access.refresh();
    });
    ctx.invalidate();
    return { ok: true };
  });
  app.delete('/api/v1/admin/images/:id/permanent', async (req) => {
    const image = ctx.image(params(req).id!);
    if (!image.deleted_at) fail(409, 'NOT_IN_TRASH', '请先将图片移入回收站');
    ctx.db.tx(() => {
      ctx.db.run("UPDATE images SET state='purging' WHERE id=?", image.id);
      if (!ctx.db.one("SELECT id FROM jobs WHERE image_id=? AND kind='purge'", image.id))
        ctx.db.run(
          'INSERT INTO jobs (id,image_id,kind,created_at) VALUES (?,?,?,?)',
          id('job'),
          image.id,
          'purge',
          Date.now(),
        );
    });
    ctx.migrationControl?.image(image.id);
    ctx.invalidate();
    return { ok: true, queued: true };
  });
  app.post('/api/v1/admin/images/:id/check', async (req) => {
    const image = ctx.image(params(req).id!);
    await ctx.storage.byId(image.storage_id).head(image.object_key);
    ctx.db.run("UPDATE images SET state='ready' WHERE id=? AND state='missing'", image.id);
    ctx.invalidate();
    return { ok: true };
  });
  app.post('/api/v1/admin/images/:id/sign', async (req) => {
    const image = ctx.image(params(req).id!);
    if (!ctx.access.read(ctx.admin(req), image)) fail(404, 'NOT_FOUND', '图片不存在');
    const info = await imageResponse(ctx, image, ctx.admin(req));
    return {
      url: info.url,
      thumbnailUrl: info.thumbnailUrl,
      logicalUrl: info.logicalUrl,
      logicalThumbnailUrl: info.logicalThumbnailUrl,
      urlExpiresAt: info.urlExpiresAt,
      thumbnailUrlExpiresAt: info.thumbnailUrlExpiresAt,
    };
  });

  app.get('/api/v1/admin/storage-backends', async () => ({
    items: ctx.db.all('SELECT * FROM storage_backends').map((row) => ({
      ...ctx.storage.safe(row),
      ...ctx.db.one(
        'SELECT COUNT(*) count,COALESCE(SUM(size+CASE WHEN source_key IS NOT NULL AND source_key<>object_key THEN source_size ELSE 0 END),0) size FROM images WHERE storage_id=?',
        row.id,
      ),
      ...ctx.db.one(
        "SELECT COUNT(*) retainedMigrationObjects,COALESCE(SUM(size),0) retainedMigrationBytes FROM (SELECT source_key,MAX(size) size FROM migration_objects WHERE source_id=? AND source_state IN ('retained','cleaning','failed') GROUP BY source_key)",
        row.id,
      ),
    })),
  }));
  const storageBody = z.object({
    name,
    type: z.enum(['local', 's3']),
    config: z.unknown().default({}),
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  });
  app.post('/api/v1/admin/storage-backends', async (req, reply) => {
    const b = storageBody.parse(req.body);
    const config = b.type === 's3' ? ctx.secrets.encrypt(s3ConfigSchema.parse(b.config)) : '{}';
    const storageId = id('sto');
    if (b.isDefault && !b.enabled) fail(400, 'DEFAULT_DISABLED', '默认存储必须启用');
    ctx.db.tx(() => {
      if (b.isDefault) ctx.db.run('UPDATE storage_backends SET is_default=0');
      ctx.db.run(
        'INSERT INTO storage_backends VALUES (?,?,?,?,?,?)',
        storageId,
        b.name,
        b.type,
        config,
        +b.enabled,
        +b.isDefault,
      );
    });
    reply.code(201);
    return ctx.storage.safe(ctx.db.one('SELECT * FROM storage_backends WHERE id=?', storageId)!);
  });
  app.patch('/api/v1/admin/storage-backends/:id', async (req) => {
    const row = ctx.db.one('SELECT * FROM storage_backends WHERE id=?', params(req).id);
    if (!row) fail(404, 'NOT_FOUND', '存储不存在');
    const b = z
      .object({
        name: name.optional(),
        config: z.unknown().optional(),
        enabled: z.boolean().optional(),
        isDefault: z.boolean().optional(),
      })
      .parse(req.body);
    if (
      (row.is_default && b.enabled === false && b.isDefault !== false) ||
      (b.isDefault && (b.enabled === false || (!row.enabled && b.enabled !== true)))
    )
      fail(400, 'DEFAULT_DISABLED', '默认存储必须启用');
    if (b.isDefault === false && row.is_default)
      fail(400, 'DEFAULT_REQUIRED', '请先将其他存储设为默认');
    if (
      b.config !== undefined &&
      (migrationStorageUsed(ctx, row.id) ||
        ctx.db.one('SELECT id FROM images WHERE storage_id=? LIMIT 1', row.id) ||
        ctx.db.one('SELECT id FROM upload_operations WHERE storage_id=? LIMIT 1', row.id) ||
        ctx.db.one('SELECT id FROM cleanup_objects WHERE storage_id=? LIMIT 1', row.id) ||
        ctx.db.one(
          "SELECT id FROM upload_sessions WHERE storage_id=? AND state NOT IN ('ready','expired','canceled') LIMIT 1",
          row.id,
        ))
    )
      fail(409, 'STORAGE_IN_USE', '存储连接已有图片或未完成操作，请新增存储');
    const config =
      b.config === undefined
        ? row.config
        : row.type === 's3'
          ? ctx.secrets.encrypt(s3ConfigSchema.parse(b.config))
          : '{}';
    ctx.db.tx(() => {
      if (b.isDefault) ctx.db.run('UPDATE storage_backends SET is_default=0');
      ctx.db.run(
        'UPDATE storage_backends SET name=?,config=?,enabled=?,is_default=? WHERE id=?',
        b.name ?? row.name,
        config,
        b.enabled === undefined ? row.enabled : +b.enabled,
        b.isDefault === undefined ? row.is_default : +b.isDefault,
        row.id,
      );
    });
    ctx.storage.instances.delete(row.id);
    return ctx.storage.safe(ctx.db.one('SELECT * FROM storage_backends WHERE id=?', row.id)!);
  });
  app.post('/api/v1/admin/storage-backends/:id/test', async (req) => {
    await ctx.storage.byId(params(req).id!).test();
    return { ok: true };
  });
  app.delete('/api/v1/admin/storage-backends/:id', async (req) => {
    const sid = params(req).id!;
    if (
      migrationStorageUsed(ctx, sid) ||
      ctx.db.one('SELECT id FROM images WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one('SELECT id FROM folders WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND is_default=1', sid) ||
      ctx.db.one('SELECT id FROM upload_operations WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one('SELECT id FROM cleanup_objects WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one(
        "SELECT id FROM upload_sessions WHERE storage_id=? AND state NOT IN ('ready','expired','canceled') LIMIT 1",
        sid,
      )
    )
      fail(409, 'STORAGE_IN_USE', '存储仍被引用或为默认存储');
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM upload_sessions WHERE storage_id=?', sid);
      ctx.db.run('DELETE FROM storage_backends WHERE id=?', sid);
    });
    ctx.storage.instances.delete(sid);
    return { ok: true };
  });
  app.get('/api/v1/admin/settings', async () => ctx.siteSettings());
  app.put('/api/v1/admin/settings', async (req) => {
    const body = z
      .object({
        title: name,
        description: z.string().max(500),
        homeBackgroundUrl: z
          .union([z.literal(''), z.url({ protocol: /^https?$/ })])
          .pipe(z.string().max(2048))
          .optional(),
        originWhitelistEnabled: z.boolean().optional(),
        allowedOrigins: z
          .array(
            z.url().refine((x) => {
              try {
                const u = new URL(x);
                return ['http:', 'https:'].includes(u.protocol) && u.origin === x;
              } catch {
                return false;
              }
            }),
          )
          .max(20),
      })
      .parse(req.body);
    const settings = {
      ...body,
      homeBackgroundUrl: body.homeBackgroundUrl ?? ctx.siteSettings().homeBackgroundUrl,
      originWhitelistEnabled:
        body.originWhitelistEnabled ?? ctx.siteSettings().originWhitelistEnabled,
    };
    ctx.db.set('site', settings);
    return settings;
  });
  app.get('/api/v1/public/settings', async () => {
    const { title, description, homeBackgroundUrl } = ctx.siteSettings();
    return { title, description, homeBackgroundUrl };
  });
  app.get('/api/v1/admin/overview', async (req) => ({
    images: ctx.db.one(
      "SELECT COUNT(*) total,COALESCE(SUM(size+CASE WHEN source_key IS NOT NULL AND source_key<>object_key THEN source_size ELSE 0 END),0) bytes,SUM(effective_visibility='public' AND publication_hold=0) publicCount,SUM(effective_visibility='private') privateCount FROM images WHERE deleted_at IS NULL",
    ),
    folders: ctx.db.one('SELECT COUNT(*) n FROM folders')!.n,
    services: ctx.db.one('SELECT COUNT(*) n,COALESCE(SUM(calls),0) calls FROM random_endpoints'),
    jobs: ctx.db.all(
      `SELECT j.id, j.image_id, j.kind, j.state, j.attempts, j.error,
              i.width, i.height, i.name AS image_name,
              (i.deleted_at IS NOT NULL) AS image_deleted
       FROM jobs j
       LEFT JOIN images i ON i.id = j.image_id
       ORDER BY j.created_at DESC
       LIMIT 20`,
    ),
    recent: await Promise.all(
      ctx.db
        .all('SELECT * FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 8')
        .map((x) => imageResponse(ctx, x, ctx.admin(req), { signLocalLinks: false })),
    ),
  }));
  app.post('/api/v1/admin/jobs/:id/retry', async (req) => {
    const job = ctx.db.one("SELECT * FROM jobs WHERE id=? AND state='failed'", params(req).id);
    if (!job) fail(404, 'NOT_FOUND', '失败任务不存在');
    if (job.image_id && ['process', 'thumbnail'].includes(job.kind))
      assertNotMigrating(ctx.image(job.image_id));
    const payload = JSON.parse(job.payload);
    ctx.db.tx(() => {
      ctx.db.run(
        "UPDATE jobs SET state='pending',attempts=0,next_run=0,error=NULL WHERE id=?",
        job.id,
      );
      if (job.kind === 'process')
        ctx.db.run(
          "UPDATE images SET processing_status='pending' WHERE id=? AND content_version=?",
          job.image_id,
          payload.version,
        );
      if (job.kind === 'classify')
        ctx.db.run(
          "UPDATE images SET classification_status='pending' WHERE id=? AND organization_version=?",
          job.image_id,
          payload.organizationVersion,
        );
      if (job.kind === 'thumbnail')
        ctx.db.run("UPDATE images SET thumbnail_state='pending' WHERE id=?", job.image_id);
      if (payload.sessionId)
        ctx.db.run(
          'UPDATE upload_sessions SET state=?,error=NULL WHERE id=?',
          job.kind === 'process'
            ? 'processing'
            : job.kind === 'classify'
              ? 'classifying'
              : 'validating',
          payload.sessionId,
        );
    });
    return { ok: true };
  });
}
