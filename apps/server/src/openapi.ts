import type { FastifyInstance } from 'fastify';
// Documentation is kept separate from runtime Zod validation. This augments the
// discovered route inventory with wire-level inputs, responses and auth semantics.
const string = { type: 'string' },
  boolean = { type: 'boolean' },
  nullable = { type: 'string', nullable: true };
const vis = { type: 'string', enum: ['public', 'private'] };
const object = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const grant = object(
  {
    kind: { type: 'string', enum: ['all', 'folder', 'service', 'storage'] },
    resourceId: string,
    descendants: boolean,
  },
  ['kind'],
);
const rule = object(
  {
    kind: { type: 'string', enum: ['source_folder', 'exclude_folder', 'exclude_image', 'tag'] },
    resourceId: string,
    descendants: boolean,
  },
  ['kind', 'resourceId'],
);
const folder = object({
  name: string,
  parentId: nullable,
  description: string,
  visibility: vis,
  storageId: nullable,
  sortOrder: { type: 'integer' },
  coverId: nullable,
});
const image = object({
  name: string,
  folderId: string,
  visibility: vis,
  tags: { type: 'array', items: string },
  description: string,
});
const storage = object({
  name: string,
  type: { type: 'string', enum: ['local', 's3'] },
  enabled: boolean,
  isDefault: boolean,
  config: object({
    endpoint: { type: 'string', format: 'uri' },
    region: string,
    bucket: string,
    accessKeyId: string,
    secretAccessKey: { type: 'string', writeOnly: true },
    forcePathStyle: boolean,
  }),
});
const service = object(
  {
    kind: { type: 'string', enum: ['global', 'folder', 'custom'] },
    folderId: nullable,
    name: string,
    description: string,
    visibility: vis,
    enabled: boolean,
    mode: { type: 'string', enum: ['image', 'redirect', 'json'] },
    includeChildren: boolean,
    rateLimit: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: '每分钟调用上限，0 表示不限制',
    },
    rules: { type: 'array', items: rule },
  },
  ['kind', 'name'],
);
const bodies: Record<string, any> = {
  'post /api/v1/setup': object(
    {
      token: { ...string, writeOnly: true },
      username: string,
      password: { ...string, minLength: 12, writeOnly: true },
    },
    ['token', 'username', 'password'],
  ),
  'post /api/v1/auth/login': object(
    { username: string, password: { ...string, writeOnly: true } },
    ['username', 'password'],
  ),
  'put /api/v1/admin/password': object(
    {
      currentPassword: { ...string, writeOnly: true },
      password: { ...string, minLength: 12, writeOnly: true },
    },
    ['currentPassword', 'password'],
  ),
  'post /api/v1/admin/folders': { ...folder, required: ['name'] },
  'patch /api/v1/admin/folders/{id}': folder,
  'patch /api/v1/admin/images/{id}': image,
  'post /api/v1/admin/images/batch': object(
    {
      ids: { type: 'array', items: string, minItems: 1, maxItems: 100 },
      action: { type: 'string', enum: ['delete', 'restore', 'move', 'visibility'] },
      folderId: string,
      visibility: vis,
    },
    ['ids', 'action'],
  ),
  'post /api/v1/admin/storage-backends': { ...storage, required: ['name', 'type'] },
  'patch /api/v1/admin/storage-backends/{id}': storage,
  'post /api/v1/admin/api-keys': object(
    {
      name: string,
      permissions: {
        type: 'array',
        items: { type: 'string', enum: ['read', 'upload', 'private:read', 'random'] },
      },
      grants: { type: 'array', items: grant },
      expires: { type: 'integer', nullable: true },
      rateLimit: {
        type: 'integer',
        minimum: 0,
        maximum: 10000,
        default: 120,
        description: '每分钟请求上限，0 表示不限制',
      },
    },
    ['name', 'permissions', 'grants'],
  ),
  'post /api/v1/admin/random-services': service,
  'put /api/v1/admin/random-services/{id}': service,
  'put /api/v1/admin/settings': object(
    {
      title: string,
      description: string,
      allowedOrigins: { type: 'array', items: { type: 'string', format: 'uri' } },
    },
    ['title', 'description', 'allowedOrigins'],
  ),
};
const parameter = (name: string, schema: any, description = '') => ({
  name,
  in: 'query',
  schema,
  description,
});
export function documentedApi(app: FastifyInstance) {
  const document = structuredClone(app.swagger()) as any;
  for (const [path, methods] of Object.entries(document.paths ?? {}) as [string, any][]) {
    for (const [method, op] of Object.entries(methods) as [string, any][]) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
      const body = bodies[`${method} ${path}`];
      if (body)
        op.requestBody = { required: true, content: { 'application/json': { schema: body } } };
      const parameters: any[] = [...(op.parameters ?? [])];
      if (method === 'get' && /\/images$/.test(path)) {
        parameters.push(
          parameter('page', { type: 'integer', minimum: 1, default: 1 }),
          parameter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 40 }),
          parameter('search', string),
          parameter('tag', string),
          parameter('sort', { type: 'string', enum: ['newest', 'oldest', 'name'] }),
        );
        if (!path.includes('{folderId}')) parameters.push(parameter('folderId', string));
        if (path.startsWith('/api/v1/admin')) parameters.push(parameter('trash', boolean));
      }
      if (method === 'get' && path.includes('/random') && !path.includes('/admin/'))
        parameters.push(
          parameter(
            'mode',
            { type: 'string', enum: ['image', 'redirect', 'json'] },
            '默认使用服务的响应模式；随机结果不可缓存。',
          ),
        );
      if (method === 'post' && path.endsWith('/upload')) {
        op.requestBody = {
          required: true,
          content: {
            'multipart/form-data': {
              schema: object({ file: { type: 'string', format: 'binary' } }, ['file']),
            },
          },
        };
        if (!path.includes('{folderId}')) parameters.push(parameter('folderId', string));
        parameters.push(
          parameter('visibility', { ...vis, default: 'private' }),
          parameter('storageId', string),
        );
        op.description =
          '单文件最大20MB，JPG/PNG/WebP，最多4000万像素，不接受动画。参数通过查询字符串传递。';
        op.responses = { '201': { description: '原图持久化并提交图片记录，缩略图后台生成。' } };
      }
      if (method !== 'get' && method !== 'head' && path.startsWith('/api/v1/admin'))
        parameters.push({ name: 'X-CSRF-Token', in: 'header', required: true, schema: string });
      if (parameters.length) op.parameters = parameters;
      op.responses ??= {};
      if (!Object.keys(op.responses).some((x) => x.startsWith('2')))
        op.responses['200'] = { description: '成功' };
      for (const code of ['400', '401', '403', '404', '409', '413', '415', '429', '503'])
        op.responses[code] = {
          description: code === '404' ? '资源不存在、无权发现或随机候选为空' : '请求失败',
          content: {
            'application/json': {
              schema: object(
                {
                  error: object({ code: string, message: string, requestId: string }, [
                    'code',
                    'message',
                    'requestId',
                  ]),
                },
                ['error'],
              ),
            },
          },
        };
    }
  }
  return document;
}
