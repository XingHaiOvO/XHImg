import { imageResponse, sameImageLocation } from './image-urls.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { Context, params, query, name, visibility } from './context.js';
import { fail, id, type Actor } from './security.js';
import { ObjectMissing, type Objects } from './storage.js';
import type { Row } from './db.js';
import { sendImageObject } from './uploads.js';
const mode = z.enum(['image', 'redirect', 'json']);
const rule = z.object({
  kind: z.enum(['source_folder', 'exclude_folder', 'exclude_image', 'tag']),
  resourceId: z.string().min(1).max(120),
  descendants: z.boolean().default(false),
});
const serviceSchema = z.object({
  kind: z.enum(['global', 'folder', 'custom']).default('custom'),
  folderId: z.string().nullable().default(null),
  name,
  description: z.string().max(1000).default(''),
  visibility: visibility.default('private'),
  enabled: z.boolean().default(false),
  mode: mode.default('image'),
  includeChildren: z.boolean().default(false),
  rateLimit: z.number().int().min(0).max(10000).default(60),
  rules: z.array(rule).max(100).default([]),
});
export function candidateIds(ctx: Context, endpoint: Row, actor: Actor) {
  const cacheKey =
    endpoint.id +
    ':' +
    (endpoint.visibility === 'public'
      ? 'public'
      : actor.type === 'key'
        ? actor.key.id
        : actor.type);
  const cached = ctx.candidates.get(cacheKey);
  if (cached?.revision === ctx.access.revision) {
    ctx.candidates.delete(cacheKey);
    ctx.candidates.set(cacheKey, cached);
    return cached.ids;
  }
  const where = ["state='ready'", 'deleted_at IS NULL', 'publication_hold=0'],
    args: any[] = [];
  const folderSet = (ids: string[], exclude = false) => {
    where.push(`folder_id ${exclude ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(ids));
  };
  if (endpoint.visibility === 'public') where.push("effective_visibility='public'");
  else if (actor.type !== 'admin') {
    if (!ctx.access.has(actor, 'read') || !ctx.access.has(actor, 'private:read'))
      where.push("effective_visibility='public'");
    else {
      const folders = ctx.db
        .all('SELECT id FROM folders')
        .filter((f) => ctx.access.scope(actor, f.id))
        .map((f) => f.id);
      where.push(
        "(effective_visibility='public' OR folder_id IN (SELECT value FROM json_each(?)))",
      );
      args.push(JSON.stringify(folders));
    }
  }
  if (endpoint.folder_id)
    folderSet(
      endpoint.include_children ? ctx.access.descendants(endpoint.folder_id) : [endpoint.folder_id],
    );
  const rules = ctx.db.all('SELECT * FROM random_rules WHERE endpoint_id=?', endpoint.id),
    sources = rules.filter((r) => r.kind === 'source_folder');
  if (sources.length)
    folderSet([
      ...new Set(
        sources.flatMap((r) =>
          r.descendants ? ctx.access.descendants(r.resource_id) : [r.resource_id],
        ),
      ),
    ]);
  for (const r of rules) {
    if (r.kind === 'exclude_folder')
      folderSet(r.descendants ? ctx.access.descendants(r.resource_id) : [r.resource_id], true);
    if (r.kind === 'exclude_image') {
      where.push('id<>?');
      args.push(r.resource_id);
    }
    if (r.kind === 'tag') {
      where.push('EXISTS (SELECT 1 FROM json_each(images.tags) WHERE value=?)');
      args.push(r.resource_id);
    }
  }
  const ids = ctx.db
    .all(`SELECT id FROM images WHERE ${where.join(' AND ')}`, ...args)
    .map((x) => x.id as string);
  const bytes = ids.length * 100;
  if (bytes <= 16 * 1024 * 1024) {
    let used = [...ctx.candidates.values()].reduce((n, x) => n + x.bytes, 0);
    while (ctx.candidates.size && (used + bytes > 16 * 1024 * 1024 || ctx.candidates.size >= 20)) {
      const first = ctx.candidates.keys().next().value!;
      used -= ctx.candidates.get(first)!.bytes;
      ctx.candidates.delete(first);
    }
    ctx.candidates.set(cacheKey, { revision: ctx.access.revision, ids, bytes });
  }
  return ids;
}

// A sparse Fisher-Yates shuffle: O(limit) space, without copying or mutating
// the shared candidate cache. Every remaining index has equal probability.
export function* sampleCandidates(ids: readonly string[], limit = 3) {
  const swaps = new Map<number, number>();
  let remaining = ids.length;
  for (let attempt = 0; attempt < limit && remaining; attempt++) {
    const index = randomInt(remaining);
    const selected = swaps.get(index) ?? index;
    remaining--;
    swaps.set(index, swaps.get(remaining) ?? remaining);
    swaps.delete(remaining);
    yield ids[selected]!;
  }
}
export function registerRandom(app: FastifyInstance, ctx: Context) {
  const info = (e: Row) => ({
    ...e,
    rules: ctx.db.all(
      'SELECT kind,resource_id,descendants FROM random_rules WHERE endpoint_id=?',
      e.id,
    ),
    url:
      e.kind === 'global'
        ? '/api/v1/random'
        : e.kind === 'folder'
          ? `/api/v1/folders/${e.folder_id}/random`
          : `/api/v1/random/${e.id}`,
  });
  const validate = (b: z.infer<typeof serviceSchema>) => {
    if (b.kind === 'folder' && !b.folderId)
      fail(400, 'FOLDER_REQUIRED', '文件夹服务必须指定文件夹');
    if (b.kind !== 'folder' && b.folderId)
      fail(400, 'INVALID_SOURCE', '请通过来源规则配置自定义服务');
    if (b.folderId) {
      const f = ctx.folder(b.folderId);
      if (b.visibility === 'public' && f.effective_visibility !== 'public')
        fail(400, 'PRIVATE_FOLDER', '私有文件夹不能配置公开服务');
    }
    for (const r of b.rules) {
      if (['source_folder', 'exclude_folder'].includes(r.kind)) ctx.folder(r.resourceId);
      if (r.kind === 'exclude_image') ctx.image(r.resourceId);
    }
  };
  const save = (sid: string, b: z.infer<typeof serviceSchema>, create: boolean) => {
    validate(b);
    ctx.db.tx(() => {
      if (create)
        ctx.db.run(
          'INSERT INTO random_endpoints (id,kind,folder_id,name,description,visibility,enabled,mode,include_children,rate_limit) VALUES (?,?,?,?,?,?,?,?,?,?)',
          sid,
          b.kind,
          b.folderId,
          b.name,
          b.description,
          b.visibility,
          +b.enabled,
          b.mode,
          +b.includeChildren,
          b.rateLimit,
        );
      else
        ctx.db.run(
          'UPDATE random_endpoints SET folder_id=?,name=?,description=?,visibility=?,enabled=?,mode=?,include_children=?,rate_limit=? WHERE id=?',
          b.folderId,
          b.name,
          b.description,
          b.visibility,
          +b.enabled,
          b.mode,
          +b.includeChildren,
          b.rateLimit,
          sid,
        );
      ctx.db.run('DELETE FROM random_rules WHERE endpoint_id=?', sid);
      for (const r of b.rules)
        ctx.db.run(
          'INSERT INTO random_rules (endpoint_id,kind,resource_id,descendants) VALUES (?,?,?,?)',
          sid,
          r.kind,
          r.resourceId,
          +r.descendants,
        );
    });
    ctx.invalidate();
    return info(ctx.db.one('SELECT * FROM random_endpoints WHERE id=?', sid)!);
  };
  app.get('/api/v1/admin/random-services', async () => ({
    items: ctx.db.all('SELECT * FROM random_endpoints ORDER BY kind,name').map(info),
  }));
  app.post('/api/v1/admin/random-services', async (req, reply) => {
    const b = serviceSchema.parse(req.body);
    if (b.kind === 'global') fail(409, 'GLOBAL_EXISTS', '请编辑内置全站服务');
    reply.code(201);
    return save(id('rnd'), b, true);
  });
  app.put('/api/v1/admin/random-services/:id', async (req) => {
    const old = ctx.db.one('SELECT * FROM random_endpoints WHERE id=?', params(req).id);
    if (!old) fail(404, 'NOT_FOUND', '服务不存在');
    const b = serviceSchema.parse(req.body);
    if (old.kind !== b.kind) fail(400, 'IMMUTABLE_KIND', '服务类型不可更改');
    return save(old.id, b, false);
  });
  app.delete('/api/v1/admin/random-services/:id', async (req) => {
    const endpoint = ctx.db.one('SELECT * FROM random_endpoints WHERE id=?', params(req).id);
    if (endpoint?.kind === 'global') fail(400, 'SYSTEM_SERVICE', '全站服务只能禁用');
    ctx.db.run('DELETE FROM random_endpoints WHERE id=?', params(req).id);
    ctx.invalidate();
    return { ok: true };
  });
  app.get('/api/v1/public/services', async () => ({
    items: ctx.db
      .all(
        "SELECT e.* FROM random_endpoints e LEFT JOIN folders f ON e.folder_id=f.id WHERE e.enabled=1 AND e.visibility='public' AND (e.folder_id IS NULL OR f.effective_visibility='public')",
      )
      .map((e) => {
        const out = info(e);
        return {
          id: e.id,
          name: e.name,
          description: e.description,
          kind: e.kind,
          url: out.url,
          folderId: e.folder_id,
        };
      }),
  }));
  const serve = async (
    req: FastifyRequest,
    reply: FastifyReply,
    sid?: string,
    folderId?: string,
  ) => {
    const endpoint = folderId
      ? ctx.db.one("SELECT * FROM random_endpoints WHERE folder_id=? AND kind='folder'", folderId)
      : ctx.db.one('SELECT * FROM random_endpoints WHERE id=?', sid ?? 'global');
    if (!endpoint || !endpoint.enabled) fail(404, 'NOT_FOUND', '随机图服务不存在或未启用');
    const actor = ctx.actor(req);
    if (endpoint.visibility !== 'public' && !ctx.access.service(actor, endpoint))
      fail(404, 'NOT_FOUND', '随机图服务不存在');
    if (
      endpoint.visibility === 'public' &&
      endpoint.folder_id &&
      ctx.folder(endpoint.folder_id).effective_visibility !== 'public'
    )
      fail(404, 'NOT_FOUND', '服务不可用');
    ctx.limiter.check(
      `random:${endpoint.id}:${actor.type === 'key' ? actor.key.id : req.ip}`,
      endpoint.rate_limit,
    );
    const responseMode = mode.parse(query(req).mode ?? endpoint.mode);
    reply.header('Cache-Control', 'private, no-store');
    ctx.db.run(
      'UPDATE random_endpoints SET calls=calls+1,last_called=? WHERE id=?',
      Date.now(),
      endpoint.id,
    );
    let object: Awaited<ReturnType<Objects['get']>> | undefined;
    try {
      const candidates = candidateIds(ctx, endpoint, actor);
      let image: Row | undefined;
      for (const imageId of sampleCandidates(candidates)) {
        const item = ctx.image(imageId);
        if (
          !ctx.access.read(actor, item) ||
          !ctx.matches(endpoint, item) ||
          (endpoint.visibility === 'public' && item.effective_visibility !== 'public')
        )
          continue;
        try {
          const storage = ctx.storage.byId(item.storage_id);
          if (responseMode === 'image') object = await storage.get(item.object_key);
          else await storage.head(item.object_key);
          image = item;
          break;
        } catch (e) {
          if (e instanceof ObjectMissing) {
            if (!sameImageLocation(item, ctx.image(item.id)))
              fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重试');
            ctx.db.run("UPDATE images SET state='missing' WHERE id=?", item.id);
            ctx.invalidate();
          } else fail(503, 'STORAGE_UNAVAILABLE', '存储暂不可用');
        }
      }
      if (!image) fail(404, 'NO_CANDIDATES', '没有符合条件的可用图片');
      // Refresh after storage I/O so a permission change cannot reuse an old row.
      const selectedImage = image;
      image = ctx.image(image.id);
      const latestActor = ctx.actor(req);
      const currentEndpoint = ctx.db.one(
        'SELECT * FROM random_endpoints WHERE id=? AND enabled=1',
        endpoint.id,
      );
      if (
        !currentEndpoint ||
        (currentEndpoint.visibility !== 'public' &&
          !ctx.access.service(latestActor, currentEndpoint))
      )
        fail(404, 'NOT_FOUND', '服务已变更');
      if (
        !ctx.access.read(latestActor, image) ||
        !ctx.matches(currentEndpoint, image) ||
        (currentEndpoint.visibility === 'public' && image.effective_visibility !== 'public')
      )
        fail(404, 'NO_CANDIDATES', '图片权限已变化，请重试');
      if (!sameImageLocation(selectedImage, image))
        fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重试');
      if (object) {
        reply.header('Vary', 'Cookie, Authorization');
        ctx.db.run('UPDATE random_endpoints SET successes=successes+1 WHERE id=?', endpoint.id);
        const response = sendImageObject(reply, image, object);
        object = undefined;
        return response;
      }
      const info = await imageResponse(ctx, image, latestActor, { serviceId: endpoint.id });
      const urls = {
        url: info.url,
        thumbnailUrl: info.thumbnailUrl,
        logicalUrl: info.logicalUrl,
        logicalThumbnailUrl: info.logicalThumbnailUrl,
        urlExpiresAt: info.urlExpiresAt,
        thumbnailUrlExpiresAt: info.thumbnailUrlExpiresAt,
      };
      ctx.db.run('UPDATE random_endpoints SET successes=successes+1 WHERE id=?', endpoint.id);
      if (responseMode === 'json')
        return {
          id: image.id,
          ...urls,
          width: image.width,
          height: image.height,
          format: image.format,
          size: image.size,
          thumbnailState: image.thumbnail_state,
        };
      return reply.code(302).header('Location', urls.url).send();
    } catch (e) {
      ctx.db.run('UPDATE random_endpoints SET failures=failures+1 WHERE id=?', endpoint.id);
      throw e;
    } finally {
      object?.stream.destroy();
    }
  };
  app.get('/api/v1/random', async (req, reply) => serve(req, reply));
  app.get('/api/v1/random/:serviceId', async (req, reply) =>
    serve(req, reply, params(req).serviceId),
  );
  app.get('/api/v1/folders/:folderId/random', async (req, reply) =>
    serve(req, reply, undefined, params(req).folderId),
  );
}
