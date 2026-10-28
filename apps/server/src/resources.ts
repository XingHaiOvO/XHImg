import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Context, params, query, paging, name, visibility } from './context.js';
import { fail, id } from './security.js';
import { s3ConfigSchema } from './storage.js';

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
    };
    ctx.db.tx(() => {
      for (const [key, value] of Object.entries(b))
        ctx.db.run(`UPDATE folders SET ${fields[key]}=? WHERE id=?`, value, folder.id);
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
    ctx.db.run('DELETE FROM folders WHERE id=?', f.id);
    ctx.invalidate();
    return { ok: true };
  });

  const listImages = (req: FastifyRequest, publicOnly = false, folderId?: string) => {
    const actor = publicOnly ? { type: 'anonymous' as const } : ctx.actor(req);
    const q = query(req);
    const p = paging(req);
    const conditions = [
      q.trash === 'true' && !publicOnly ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL',
    ];
    const args: any[] = [];
    if (actor.type !== 'admin') {
      conditions.push("state='ready'");
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
      items: ctx.db
        .all(
          `SELECT * FROM images WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
          ...args,
          p.limit,
          p.offset,
        )
        .map((x) => {
          const info = ctx.imageInfo(x);
          if (publicOnly) {
            const { storageId, visibility, effectiveVisibility, deletedAt, ...safe } = info;
            return safe;
          }
          return { ...info, ...ctx.urls(x, actor) };
        }),
      total: ctx.db.one(`SELECT COUNT(*) n FROM images WHERE ${where}`, ...args)!.n,
      page: p.page,
      limit: p.limit,
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
      ctx.access.refresh();
    });
    ctx.invalidate();
    return ctx.imageInfo(ctx.image(img.id));
  });
  app.post('/api/v1/admin/images/batch', async (req) => {
    const b = z
      .object({
        ids: z.array(z.string()).min(1).max(100),
        action: z.enum(['delete', 'restore', 'move', 'visibility']),
        folderId: z.string().optional(),
        visibility: visibility.optional(),
      })
      .parse(req.body);
    if (b.action === 'move') ctx.folder(z.string().parse(b.folderId));
    if (b.action === 'visibility') visibility.parse(b.visibility);
    ctx.db.tx(() => {
      for (const imageId of b.ids) {
        const img = ctx.image(imageId);
        if (img.state === 'purging') fail(409, 'PURGING', '图片正在彻底删除');
        if (b.action === 'delete')
          ctx.db.run('UPDATE images SET deleted_at=? WHERE id=?', Date.now(), imageId);
        if (b.action === 'restore')
          ctx.db.run(
            "UPDATE images SET deleted_at=NULL,state=CASE WHEN state='missing' THEN state ELSE 'ready' END WHERE id=?",
            imageId,
          );
        if (b.action === 'move')
          ctx.db.run('UPDATE images SET folder_id=? WHERE id=?', b.folderId, imageId);
        if (b.action === 'visibility')
          ctx.db.run('UPDATE images SET visibility=? WHERE id=?', b.visibility, imageId);
      }
      ctx.access.refresh();
    });
    ctx.invalidate();
    return { ok: true };
  });
  app.delete('/api/v1/admin/images/:id', async (req) => {
    const image = ctx.image(params(req).id!);
    ctx.db.run(
      'UPDATE images SET deleted_at=?,access_version=access_version+1 WHERE id=?',
      Date.now(),
      image.id,
    );
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
    return ctx.urls(image, ctx.admin(req));
  });

  app.get('/api/v1/admin/storage-backends', async () => ({
    items: ctx.db.all('SELECT * FROM storage_backends').map((row) => ({
      ...ctx.storage.safe(row),
      ...ctx.db.one(
        'SELECT COUNT(*) count,COALESCE(SUM(size),0) size FROM images WHERE storage_id=?',
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
      (ctx.db.one('SELECT id FROM images WHERE storage_id=? LIMIT 1', row.id) ||
        ctx.db.one('SELECT id FROM upload_operations WHERE storage_id=? LIMIT 1', row.id) ||
        ctx.db.one('SELECT id FROM cleanup_objects WHERE storage_id=? LIMIT 1', row.id))
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
      ctx.db.one('SELECT id FROM images WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one('SELECT id FROM folders WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one('SELECT id FROM storage_backends WHERE id=? AND is_default=1', sid) ||
      ctx.db.one('SELECT id FROM upload_operations WHERE storage_id=? LIMIT 1', sid) ||
      ctx.db.one('SELECT id FROM cleanup_objects WHERE storage_id=? LIMIT 1', sid)
    )
      fail(409, 'STORAGE_IN_USE', '存储仍被引用或为默认存储');
    ctx.db.run('DELETE FROM storage_backends WHERE id=?', sid);
    ctx.storage.instances.delete(sid);
    return { ok: true };
  });
  app.get('/api/v1/admin/settings', async () =>
    ctx.db.setting('site', {
      title: 'XHImg',
      description: '一次整理，随处调用。',
      allowedOrigins: [],
    }),
  );
  app.put('/api/v1/admin/settings', async (req) => {
    const body = z
      .object({
        title: name,
        description: z.string().max(500),
        allowedOrigins: z
          .array(
            z.url().refine((x) => {
              const u = new URL(x);
              return ['http:', 'https:'].includes(u.protocol) && u.origin === x;
            }),
          )
          .max(20),
      })
      .parse(req.body);
    ctx.db.set('site', body);
    return body;
  });
  app.get('/api/v1/public/settings', async () => {
    const { allowedOrigins, ...safe } = ctx.db.setting('site', {
      title: 'XHImg',
      description: '一次整理，随处调用。',
      allowedOrigins: [],
    });
    return safe;
  });
  app.get('/api/v1/admin/overview', async () => ({
    images: ctx.db.one(
      "SELECT COUNT(*) total,COALESCE(SUM(size),0) bytes,SUM(effective_visibility='public') publicCount,SUM(effective_visibility='private') privateCount FROM images WHERE deleted_at IS NULL",
    ),
    folders: ctx.db.one('SELECT COUNT(*) n FROM folders')!.n,
    services: ctx.db.one('SELECT COUNT(*) n,COALESCE(SUM(calls),0) calls FROM random_endpoints'),
    jobs: ctx.db.all(
      'SELECT id,image_id,kind,state,attempts,error FROM jobs ORDER BY created_at DESC LIMIT 20',
    ),
    recent: ctx.db
      .all('SELECT * FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 8')
      .map((x) => ctx.imageInfo(x)),
  }));
  app.post('/api/v1/admin/jobs/:id/retry', async (req) => {
    ctx.db.run(
      "UPDATE jobs SET state='pending',attempts=0,next_run=0,error=NULL WHERE id=? AND state='failed'",
      params(req).id,
    );
    return { ok: true };
  });
}
