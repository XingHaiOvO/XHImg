import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { Store } from './db.js';
import { Context, type Config } from './context.js';
import { HttpError, fail, token, hash } from './security.js';
import { ObjectMissing } from './storage.js';
import { registerAuth } from './auth.js';
import { registerResources } from './resources.js';
import { registerUploads } from './uploads.js';
import { registerRandom } from './random.js';
import { Worker } from './jobs.js';
import { documentedApi } from './openapi.js';
import { registerP1 } from './p1-routes.js';
import { registerResumable } from './resumable.js';
import { registerMigrations } from './migrations.js';
import { recoverMigrations } from './migration-worker.js';
import { cleanupLocalDirectories } from './local-directories.js';

export async function createApp(config: Config) {
  const db = new Store(config.dir),
    ctx = new Context(db, config);
  const app = Fastify({
    logger: config.logger
      ? {
          level: 'info',
          serializers: {
            req: (req: any) => ({
              method: req.method,
              url: req.url?.split('?')[0],
              remoteAddress: req.ip,
            }),
          },
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.query.sig',
            'body.password',
            'body.token',
            'body.key',
          ],
        }
      : false,
    trustProxy: config.trustProxy ?? false,
    bodyLimit: 128 * 1024,
    requestTimeout: 120_000,
  });
  if (!db.one('SELECT id FROM storage_backends'))
    db.run(
      'INSERT INTO storage_backends VALUES (?,?,?,?,?,?)',
      'local',
      '本地存储',
      'local',
      '{}',
      1,
      1,
    );
  if (!db.one('SELECT id FROM folders'))
    db.run(
      'INSERT INTO folders (id,name,system,created_at) VALUES (?,?,?,?)',
      'uncategorized',
      '未分类',
      1,
      Date.now(),
    );
  if (!db.one('SELECT id FROM random_endpoints WHERE id=?', 'global'))
    db.run(
      'INSERT INTO random_endpoints (id,kind,name,description,visibility) VALUES (?,?,?,?,?)',
      'global',
      'global',
      '全站随机图',
      '从全部符合条件的公开图片中随机选择',
      'public',
    );
  let setupToken: string | undefined;
  if (!db.one('SELECT id FROM administrators')) {
    setupToken = token();
    db.set('setupHash', hash(setupToken));
    app.log.warn(`XHImg installation token (one use): ${setupToken}`);
  }
  await app.register(cookie);
  await app.register(cors, {
    delegator: (req, cb) => {
      cb(null, {
        origin: req.headers.origin && ctx.allowsOrigin(req) ? req.headers.origin : false,
        credentials: false,
        allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'],
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      });
    },
  });
  await app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'XHImg API',
        version: '0.1.0',
        description: '上传必须授权，公开接口仅暴露有效公开资源。',
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer' },
          adminSession: { type: 'apiKey', in: 'cookie', name: 'session' },
        },
      },
    },
  });
  app.addHook('onRoute', (options) => {
    const url = options.url;
    if (!url.startsWith('/api/v1') || url.endsWith('/openapi.json')) return;
    const admin = url.startsWith('/api/v1/admin');
    const upload = options.method === 'POST' && url.endsWith('/upload');
    options.schema = {
      ...options.schema,
      tags: [admin ? '管理员' : upload ? '上传' : url.includes('random') ? '随机图' : '公开与认证'],
      summary: `${options.method} ${url}`,
      ...(admin
        ? { security: [{ adminSession: [] }] }
        : upload
          ? { security: [{ apiKey: [] }, { adminSession: [] }] }
          : {}),
    };
  });
  app.addHook('onRequest', async (req, reply) => {
    const origins = [...(await ctx.storage.imageOrigins())];
    const backgroundUrl = ctx.siteSettings().homeBackgroundUrl;
    if (backgroundUrl) origins.push(new URL(backgroundUrl).origin);
    const imageOrigins = origins.join(' ');
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; img-src 'self' blob: data: ${imageOrigins}; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
    if (req.url.startsWith('/api/v1')) reply.header('Cache-Control', 'no-store');
    if (req.url.startsWith('/api/v1/admin')) {
      const actor = ctx.admin(req);
      ctx.csrf(req, actor);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !ctx.allowsOrigin(req))
      fail(403, 'ORIGIN_FORBIDDEN', '请求来源未获允许，请检查来源格式或跨域白名单设置');
  });
  app.setErrorHandler((error, req, reply) => {
    let status = 500,
      code = 'INTERNAL_ERROR',
      message = '服务暂时不可用';
    if (error instanceof HttpError) {
      status = error.statusCode;
      code = error.code;
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'INVALID_INPUT';
      message = error.issues
        .map((x) => `${x.path.join('.')}: ${x.message}`)
        .join('；')
        .slice(0, 500);
    } else if (error instanceof ObjectMissing) {
      status = 404;
      code = 'OBJECT_MISSING';
      message = '存储对象不存在';
    } else if ((error as any).code?.startsWith('FST_')) {
      status = (error as any).statusCode ?? 400;
      code = (error as any).code;
      message = status === 413 ? '文件或请求超过限制' : '请求格式不正确';
    } else if ((error as any).code?.startsWith('SQLITE_CONSTRAINT')) {
      status = 409;
      code = 'CONFLICT';
      message = '操作与当前资源状态冲突';
    } else if (
      (error as any).$metadata ||
      (error as any).code === 'ECONNREFUSED' ||
      (error as any).code === 'ENOSPC'
    ) {
      status = 503;
      code = 'STORAGE_UNAVAILABLE';
      message = '存储暂不可用';
    }
    if (status === 500)
      app.log.error(
        { errorType: (error as any).name, requestId: req.id },
        'Unhandled request error',
      );
    reply.code(status).send({ error: { code, message, requestId: req.id } });
  });
  registerAuth(app, ctx);
  registerResources(app, ctx);
  registerUploads(app, ctx);
  registerRandom(app, ctx);
  registerP1(app, ctx);
  registerMigrations(app, ctx);
  await registerResumable(app, ctx);
  app.get('/health', async () => {
    db.one('SELECT 1');
    return { status: 'ok', version: '0.1.0' };
  });
  app.get('/api/v1/openapi.json', async () => documentedApi(app));
  const webRoot = config.webRoot ?? resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot, prefix: '/' });
  app.setNotFoundHandler(async (req, reply) => {
    if (
      req.method === 'GET' &&
      !req.url.startsWith('/api/') &&
      !/^\/(i|t)\//.test(req.url) &&
      existsSync(webRoot)
    )
      return reply.type('text/html').sendFile('index.html');
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: '资源不存在', requestId: req.id } });
  });
  db.run("UPDATE upload_operations SET state='abandoned' WHERE state='writing'");
  db.run("UPDATE jobs SET state='pending' WHERE state='running'");
  recoverMigrations(ctx);
  const emptyDirectories = await cleanupLocalDirectories(config.dir);
  if (emptyDirectories)
    app.log.info({ emptyDirectories }, 'Removed empty local object directories');
  const worker = new Worker(ctx);
  if (config.workers !== false) worker.start();
  app.addHook('onClose', async () => {
    await worker.stop();
    for (const adapter of ctx.storage.instances.values())
      if ('client' in adapter) (adapter as any).client.destroy();
    db.close();
  });
  await app.ready();
  return { app, ctx, worker, setupToken };
}
