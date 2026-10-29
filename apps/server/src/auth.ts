import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Context, name, params } from './context.js';
import { fail, hash, token, id, passwordHash, passwordVerify } from './security.js';
const credentials = z.object({ username: name, password: z.string().min(12).max(256) });
const grant = z.object({
  kind: z.enum(['all', 'folder', 'service', 'storage']),
  resourceId: z.string().max(100).default(''),
  descendants: z.boolean().default(false),
});
export function registerAuth(app: FastifyInstance, ctx: Context) {
  app.get('/api/v1/setup', async () => ({
    installed: !!ctx.db.one('SELECT id FROM administrators'),
  }));
  app.post('/api/v1/setup', async (req, reply) => {
    ctx.limiter.check(`setup:${req.ip}`, 5);
    const body = credentials.extend({ token: z.string() }).parse(req.body);
    if (ctx.db.one('SELECT id FROM administrators')) fail(409, 'INSTALLED', '安装已完成');
    if (hash(body.token) !== ctx.db.setting('setupHash', ''))
      fail(403, 'INVALID_SETUP_TOKEN', '安装令牌无效');
    const password = await passwordHash(body.password);
    ctx.db.tx(() => {
      if (ctx.db.one('SELECT id FROM administrators')) fail(409, 'INSTALLED', '安装已完成');
      ctx.db.run(
        'INSERT INTO administrators VALUES (?,?,?,?)',
        'admin',
        body.username,
        password,
        Date.now(),
      );
      ctx.db.run("DELETE FROM settings WHERE key='setupHash'");
    });
    reply.code(201);
    return { installed: true };
  });
  app.post('/api/v1/auth/login', async (req, reply) => {
    ctx.limiter.check(`login:${req.ip}`, 5);
    const body = z.object({ username: name, password: z.string().min(1).max(256) }).parse(req.body);
    const user = ctx.db.one('SELECT * FROM administrators WHERE id=?', 'admin');
    if (
      !user ||
      !(await passwordVerify(body.password, user.password)) ||
      user.username !== body.username
    )
      fail(401, 'LOGIN_FAILED', '用户名或密码错误');
    const raw = token(),
      csrf = token();
    ctx.db.run('INSERT INTO sessions VALUES (?,?,?)', hash(raw), csrf, Date.now() + 7 * 86400_000);
    ctx.cookie(reply, raw);
    reply.header('Cache-Control', 'no-store');
    return { username: user.username, csrf };
  });
  app.get('/api/v1/auth/me', async (req) => {
    const actor = ctx.admin(req);
    return {
      username: ctx.db.one('SELECT username FROM administrators')!.username,
      csrf: ctx.db.one('SELECT csrf FROM sessions WHERE hash=?', actor.session)!.csrf,
    };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    const actor = ctx.admin(req);
    ctx.csrf(req, actor);
    ctx.db.run('DELETE FROM sessions WHERE hash=?', actor.session);
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });
  app.put('/api/v1/admin/password', async (req) => {
    const body = z
      .object({ currentPassword: z.string().max(256), password: z.string().min(12).max(256) })
      .parse(req.body);
    const user = ctx.db.one('SELECT * FROM administrators')!;
    if (!(await passwordVerify(body.currentPassword, user.password)))
      fail(403, 'PASSWORD_MISMATCH', '当前密码错误');
    const next = await passwordHash(body.password);
    ctx.db.tx(() => {
      ctx.db.run('UPDATE administrators SET password=?', next);
      ctx.db.run('DELETE FROM sessions');
    });
    return { ok: true };
  });
  app.get('/api/v1/admin/api-keys', async () => ({
    items: ctx.db
      .all(
        'SELECT id,name,prefix,permissions,expires,revoked,last_used,rate_limit,created_at FROM api_keys ORDER BY created_at DESC',
      )
      .map((x) => ({
        ...x,
        permissions: JSON.parse(x.permissions),
        grants: ctx.db.all(
          'SELECT kind,resource_id,descendants FROM api_grants WHERE key_id=?',
          x.id,
        ),
      })),
  }));
  app.post('/api/v1/admin/api-keys', async (req, reply) => {
    const body = z
      .object({
        name,
        permissions: z
          .array(z.enum(['read', 'upload', 'private:read', 'random', 'ai:classify']))
          .min(1),
        grants: z.array(grant).min(1).max(100),
        expires: z.number().int().positive().nullable().default(null),
        rateLimit: z.number().int().min(0).max(10000).default(120),
      })
      .parse(req.body);
    if (body.expires && body.expires <= Date.now())
      fail(400, 'INVALID_EXPIRY', '到期时间必须在将来');
    for (const g of body.grants) {
      if (g.kind === 'folder') ctx.folder(g.resourceId);
      if (
        g.kind === 'service' &&
        !ctx.db.one('SELECT id FROM random_endpoints WHERE id=?', g.resourceId)
      )
        fail(400, 'INVALID_GRANT', '随机服务不存在');
      if (
        g.kind === 'storage' &&
        !ctx.db.one('SELECT id FROM storage_backends WHERE id=?', g.resourceId)
      )
        fail(400, 'INVALID_GRANT', '存储不存在');
    }
    const key = 'xh_' + token(),
      keyId = id('key');
    ctx.db.tx(() => {
      ctx.db.run(
        'INSERT INTO api_keys (id,name,hash,prefix,permissions,expires,rate_limit,created_at) VALUES (?,?,?,?,?,?,?,?)',
        keyId,
        body.name,
        hash(key),
        key.slice(0, 11),
        JSON.stringify(body.permissions),
        body.expires,
        body.rateLimit,
        Date.now(),
      );
      for (const g of body.grants)
        ctx.db.run(
          'INSERT INTO api_grants (key_id,kind,resource_id,descendants) VALUES (?,?,?,?)',
          keyId,
          g.kind,
          g.resourceId,
          +g.descendants,
        );
    });
    reply.code(201).header('Cache-Control', 'no-store');
    return { id: keyId, key };
  });
  app.delete('/api/v1/admin/api-keys/:id', async (req) => {
    ctx.db.run('UPDATE api_keys SET revoked=1 WHERE id=?', params(req).id);
    ctx.invalidate();
    return { ok: true };
  });
}
