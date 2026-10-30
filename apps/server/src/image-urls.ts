import { basename } from 'node:path';
import type { Context } from './context.js';
import type { Row } from './db.js';
import { fail, HttpError, type Actor } from './security.js';
import { imageFilename } from './image-filename.js';
import type { DownloadLink } from './storage.js';
type ImageResponse = ReturnType<Context['imageInfo']> & {
  urlExpiresAt?: number;
  thumbnailUrlExpiresAt?: number;
};

export function currentActor(ctx: Context, actor: Actor): Actor {
  if (actor.type === 'admin') {
    if (
      !ctx.db.one('SELECT hash FROM sessions WHERE hash=? AND expires>?', actor.session, Date.now())
    )
      fail(401, 'LOGIN_REQUIRED', '管理员会话已失效');
  } else if (actor.type === 'key') {
    const key = ctx.db.one('SELECT * FROM api_keys WHERE id=? AND revoked=0', actor.key.id);
    if (!key || (key.expires && key.expires <= Date.now()))
      fail(401, 'INVALID_KEY', 'API Key 无效或已失效');
    return {
      type: 'key',
      key,
      permissions: JSON.parse(key.permissions),
      grants: ctx.db.all('SELECT * FROM api_grants WHERE key_id=?', key.id),
    };
  }
  return actor;
}

export function actorExpiresAt(ctx: Context, actor: Actor) {
  actor = currentActor(ctx, actor);
  return actor.type === 'admin'
    ? Number(ctx.db.one('SELECT expires FROM sessions WHERE hash=?', actor.session)!.expires)
    : actor.type === 'key' && actor.key.expires
      ? Number(actor.key.expires)
      : Infinity;
}

export function sameImageLocation(a: Row, b: Row) {
  return [
    'storage_id',
    'storage_version',
    'object_key',
    'source_key',
    'thumb_key',
    'content_version',
    'access_version',
    'folder_id',
    'state',
    'deleted_at',
    'publication_hold',
    'thumbnail_state',
  ].every((key) => a[key] === b[key]);
}

export async function signObject(
  ctx: Context,
  image: Row,
  actor: Actor,
  variant: 'image' | 'thumbnail' | 'source',
  expiresAt = Infinity,
): Promise<DownloadLink | undefined> {
  if (ctx.db.one('SELECT type FROM storage_backends WHERE id=?', image.storage_id)?.type !== 's3')
    return;
  const original = variant === 'source';
  const format =
    variant === 'thumbnail'
      ? 'webp'
      : original
        ? (image.source_format ?? image.format)
        : image.format;
  const filename = imageFilename(basename(image.name).replace(/[\r\n]/g, ''), format);
  const key =
    variant === 'thumbnail'
      ? image.thumb_key
      : original
        ? (image.source_key ?? image.object_key)
        : image.object_key;
  try {
    const adapter = ctx.storage.byId(image.storage_id);
    if (!adapter.presign) throw new Error('Signing unavailable');
    return await adapter.presign(key, {
      expiresAt: Math.min(Date.now() + 300_000, actorExpiresAt(ctx, actor), expiresAt),
      mime: format === 'jpg' ? 'image/jpeg' : `image/${format}`,
      disposition: `${original ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(503, 'STORAGE_UNAVAILABLE', '暂时无法生成存储下载地址');
  }
}

// Keep business commits and synchronous metadata independent of URL signing.
export async function imageResponse(
  ctx: Context,
  row: Row,
  actor: Actor,
  options: {
    serviceId?: string;
    allowUnreadable?: boolean;
    fallback?: boolean;
    signLocalLinks?: boolean;
  } = {},
): Promise<ImageResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    actor = currentActor(ctx, actor);
    const image = ctx.image(row.id);
    const readable = ctx.access.read(actor, image);
    if (!readable && actor.type !== 'admin' && !options.allowUnreadable)
      fail(404, 'NOT_FOUND', '图片不存在');
    if (options.serviceId) {
      const service = ctx.db.one(
        'SELECT * FROM random_endpoints WHERE id=? AND enabled=1',
        options.serviceId,
      );
      if (
        !service ||
        (service.visibility !== 'public' && !ctx.access.service(actor, service)) ||
        !ctx.matches(service, image) ||
        (service.visibility === 'public' && image.effective_visibility !== 'public')
      )
        fail(404, 'NOT_FOUND', '随机图服务或权限已变化');
    }
    const info = ctx.imageInfo(image);
    const s3 =
      ctx.db.one('SELECT type FROM storage_backends WHERE id=?', image.storage_id)?.type === 's3';
    const logical =
      readable && (s3 || options.signLocalLinks !== false)
        ? ctx.urls(image, actor, options.serviceId)
        : { url: info.url, thumbnailUrl: info.thumbnailUrl };
    const base = {
      ...info,
      ...logical,
      logicalUrl: logical.url,
      logicalThumbnailUrl: logical.thumbnailUrl,
    };
    if (!readable || image.publication_hold || image.state !== 'ready' || image.deleted_at || !s3)
      return base;
    let main: DownloadLink | undefined, thumbnail: DownloadLink | undefined;
    try {
      [main, thumbnail] = await Promise.all([
        signObject(ctx, image, actor, 'image'),
        image.thumbnail_state === 'ready' ? signObject(ctx, image, actor, 'thumbnail') : undefined,
      ]);
    } catch (error) {
      if (
        !options.fallback ||
        !(error instanceof HttpError) ||
        error.code !== 'STORAGE_UNAVAILABLE'
      )
        throw error;
      // The upload already committed. Never report it as failed solely because signing failed.
    }
    const latest = ctx.image(image.id),
      latestActor = currentActor(ctx, actor);
    if (!sameImageLocation(image, latest) || !ctx.access.read(latestActor, latest)) continue;
    if (options.serviceId) {
      const service = ctx.db.one(
        'SELECT * FROM random_endpoints WHERE id=? AND enabled=1',
        options.serviceId,
      );
      if (
        !service ||
        (service.visibility !== 'public' && !ctx.access.service(latestActor, service)) ||
        !ctx.matches(service, latest) ||
        (service.visibility === 'public' && latest.effective_visibility !== 'public')
      )
        fail(404, 'NOT_FOUND', '随机图服务或权限已变化');
    }
    return {
      ...base,
      ...(main ? { url: main.url, urlExpiresAt: main.expiresAt } : {}),
      ...(thumbnail
        ? { thumbnailUrl: thumbnail.url, thumbnailUrlExpiresAt: thumbnail.expiresAt }
        : {}),
    };
  }
  fail(409, 'IMAGE_CHANGED', '图片状态已变化，请重新获取');
}
