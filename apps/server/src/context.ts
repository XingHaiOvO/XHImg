import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Store, Row } from './db.js';
import { Access, Limiter, Secrets, fail, hash, type Actor } from './security.js';
import { Storage } from './storage.js';
import { z } from 'zod';
export const visibility = z.enum(['public', 'private']);
export const name = z.string().trim().min(1).max(120);
export const resourceId = z.string().max(100);
export const params = (r: FastifyRequest) => r.params as Record<string, string>;
export const query = (r: FastifyRequest) => r.query as Record<string, string>;
export const paging = (r: FastifyRequest) => {
  const q = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    })
    .parse(r.query);
  return { ...q, offset: (q.page - 1) * q.limit };
};
export interface Config {
  dir: string;
  masterKey: string;
  publicUrl: string;
  secureCookie?: boolean;
  logger?: boolean;
  trustProxy?: boolean;
  workers?: boolean;
  webRoot?: string;
}
export class Context {
  access: Access;
  storage: Storage;
  secrets: Secrets;
  limiter = new Limiter();
  activeUploads = 0;
  countedRequests = new WeakSet<FastifyRequest>();
  candidates = new Map<string, { revision: number; ids: string[]; bytes: number }>();
  constructor(
    public db: Store,
    public config: Config,
  ) {
    this.secrets = new Secrets(config.masterKey);
    this.access = new Access(db);
    this.storage = new Storage(db, this.secrets, config.dir);
  }
  allowsOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const source = new URL(origin);
      if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false;
      // Fastify only uses forwarded host/protocol when trustProxy is enabled.
      // A same-origin UI request is valid even when PUBLIC_URL names a different
      // local port or host alias (for example Vite vs the built-in web server).
      const requestOrigin = new URL(`${request.protocol}://${request.host}`).origin;
      return (
        origin === requestOrigin ||
        origin === new URL(this.config.publicUrl).origin ||
        this.db
          .setting<{ allowedOrigins: string[] }>('site', { allowedOrigins: [] })
          .allowedOrigins.includes(origin)
      );
    } catch {
      return false;
    }
  }
  invalidate() {
    this.access.revision++;
    this.candidates.clear();
  }
  actor(request: FastifyRequest): Actor {
    const auth = request.headers.authorization;
    if (auth) {
      const match = /^Bearer (xh_[a-f0-9]{64})$/.exec(auth);
      if (!match) fail(401, 'INVALID_KEY', 'API Key 无效或已失效');
      const key = this.db.one('SELECT * FROM api_keys WHERE hash=? AND revoked=0', hash(match[1]!));
      if (!key || (key.expires && key.expires <= Date.now()))
        fail(401, 'INVALID_KEY', 'API Key 无效或已失效');
      if (!this.countedRequests.has(request)) {
        this.limiter.check(`key:${key.id}`, key.rate_limit);
        this.db.run('UPDATE api_keys SET last_used=? WHERE id=?', Date.now(), key.id);
        this.countedRequests.add(request);
      }
      return {
        type: 'key',
        key,
        permissions: JSON.parse(key.permissions),
        grants: this.db.all('SELECT * FROM api_grants WHERE key_id=?', key.id),
      };
    }
    const raw = request.cookies.session;
    if (raw) {
      const session = this.db.one(
        'SELECT * FROM sessions WHERE hash=? AND expires>?',
        hash(raw),
        Date.now(),
      );
      if (session) return { type: 'admin', session: session.hash };
    }
    return { type: 'anonymous' };
  }
  admin(request: FastifyRequest) {
    const actor = this.actor(request);
    if (actor.type !== 'admin') fail(401, 'LOGIN_REQUIRED', '请先登录管理员账号');
    return actor;
  }
  csrf(request: FastifyRequest, actor: Actor) {
    if (actor.type !== 'admin' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const session = this.db.one('SELECT csrf FROM sessions WHERE hash=?', actor.session);
    if (!session || request.headers['x-csrf-token'] !== session.csrf)
      fail(403, 'CSRF', '安全校验失败，请刷新页面');
  }
  folder(id: string) {
    const row = this.db.one('SELECT * FROM folders WHERE id=?', id);
    if (!row) fail(404, 'NOT_FOUND', '文件夹不存在');
    return row;
  }
  image(id: string) {
    const row = this.db.one('SELECT * FROM images WHERE id=?', id);
    if (!row) fail(404, 'NOT_FOUND', '图片不存在');
    return row;
  }
  imageInfo(row: Row) {
    return {
      id: row.id,
      name: row.name,
      folderId: row.folder_id,
      visibility: row.visibility,
      effectiveVisibility: row.effective_visibility,
      storageId: row.storage_id,
      format: row.format,
      mime: row.mime,
      size: row.size,
      width: row.width,
      height: row.height,
      tags: JSON.parse(row.tags),
      description: row.description,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
      state: row.state,
      thumbnailState: row.thumbnail_state,
      processingStatus: row.processing_status,
      classificationStatus: row.classification_status,
      hasOriginal: !!row.source_key,
      publicationHold: !!row.publication_hold,
      url: `/i/${row.id}`,
      thumbnailUrl: `/t/${row.id}`,
    };
  }
  folderInfo(row: Row) {
    return {
      ...row,
      count: this.db.one(
        'SELECT COUNT(*) n FROM images WHERE folder_id=? AND deleted_at IS NULL',
        row.id,
      )!.n,
      size: this.db.one(
        'SELECT COALESCE(SUM(size+CASE WHEN source_key IS NOT NULL AND source_key<>object_key THEN source_size ELSE 0 END),0) n FROM images WHERE folder_id=? AND deleted_at IS NULL',
        row.id,
      )!.n,
    };
  }
  signature(image: Row, actor: Actor, variant: 'original' | 'thumbnail', serviceId?: string) {
    if (actor.type === 'anonymous') fail(403, 'FORBIDDEN', '无法签发私有链接');
    return this.secrets.sign({
      imageId: image.id,
      version: image.access_version,
      variant,
      expires: Date.now() + 300_000,
      issuer: actor.type === 'key' ? actor.key.id : actor.session,
      actorType: actor.type,
      serviceId,
    });
  }
  signedActor(signature: string, image: Row, variant: string): Actor {
    const claim = this.secrets.verify(signature);
    if (
      !claim ||
      claim.imageId !== image.id ||
      claim.version !== image.access_version ||
      claim.variant !== variant
    )
      fail(404, 'NOT_FOUND', '图片不存在或链接已失效');
    let actor: Actor;
    if (claim.actorType === 'key') {
      const key = this.db.one('SELECT * FROM api_keys WHERE id=? AND revoked=0', claim.issuer);
      if (!key || (key.expires && key.expires <= Date.now())) fail(404, 'NOT_FOUND', '链接已失效');
      actor = {
        type: 'key',
        key,
        permissions: JSON.parse(key.permissions),
        grants: this.db.all('SELECT * FROM api_grants WHERE key_id=?', key.id),
      };
    } else {
      if (
        !this.db.one(
          'SELECT hash FROM sessions WHERE hash=? AND expires>?',
          claim.issuer,
          Date.now(),
        )
      )
        fail(404, 'NOT_FOUND', '链接已失效');
      actor = { type: 'admin', session: claim.issuer };
    }
    if (claim.serviceId) {
      const service = this.db.one(
        'SELECT * FROM random_endpoints WHERE id=? AND enabled=1',
        claim.serviceId,
      );
      if (!service || !this.access.service(actor, service) || !this.matches(service, image))
        fail(404, 'NOT_FOUND', '链接已失效');
    }
    return actor;
  }
  matches(endpoint: Row, image: Row): boolean {
    if (
      endpoint.folder_id &&
      !(
        endpoint.include_children
          ? this.access.descendants(endpoint.folder_id)
          : [endpoint.folder_id]
      ).includes(image.folder_id)
    )
      return false;
    for (const rule of this.db.all('SELECT * FROM random_rules WHERE endpoint_id=?', endpoint.id)) {
      if (rule.kind === 'exclude_image' && rule.resource_id === image.id) return false;
      if (
        rule.kind === 'exclude_folder' &&
        (rule.descendants
          ? this.access.descendants(rule.resource_id)
          : [rule.resource_id]
        ).includes(image.folder_id)
      )
        return false;
      if (rule.kind === 'tag' && !JSON.parse(image.tags).includes(rule.resource_id)) return false;
    }
    const sources = this.db.all(
      "SELECT * FROM random_rules WHERE endpoint_id=? AND kind='source_folder'",
      endpoint.id,
    );
    return (
      !sources.length ||
      sources.some((rule) =>
        (rule.descendants
          ? this.access.descendants(rule.resource_id)
          : [rule.resource_id]
        ).includes(image.folder_id),
      )
    );
  }
  urls(image: Row, actor: Actor, serviceId?: string) {
    const sign = (variant: 'original' | 'thumbnail') =>
      image.effective_visibility === 'public' && !image.publication_hold
        ? ''
        : `?sig=${this.signature(image, actor, variant, serviceId)}`;
    return {
      url: `/i/${image.id}${sign('original')}`,
      thumbnailUrl: `/t/${image.id}${sign('thumbnail')}`,
    };
  }
  cookie(reply: FastifyReply, raw: string) {
    reply.setCookie('session', raw, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.secureCookie ?? false,
      path: '/',
      maxAge: 7 * 86400,
    });
  }
}
