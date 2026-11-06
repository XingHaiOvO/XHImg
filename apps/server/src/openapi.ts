import type { FastifyInstance } from 'fastify';
// Documentation is kept separate from runtime Zod validation. This augments the
// discovered route inventory with wire-level inputs, responses and auth semantics.
const string = { type: 'string' },
  boolean = { type: 'boolean' },
  nullable = { type: 'string', nullable: true };
const vis = { type: 'string', enum: ['public', 'private'] };
const processing = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false },
    compress: { type: 'boolean', default: true },
    targetFormat: { type: 'string', enum: ['keep', 'jpg', 'png', 'webp'] },
    quality: { type: 'integer', minimum: 1, maximum: 100, default: 80 },
    maxWidth: { type: 'integer', minimum: 1, maximum: 40000, nullable: true },
    maxHeight: { type: 'integer', minimum: 1, maximum: 40000, nullable: true },
    preserveOriginal: { type: 'boolean', default: true },
  },
};
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
    slug: {
      ...nullable,
      maxLength: 64,
      description:
        '可选接口别名，去除首尾空格并转为小写；仅字母、数字和中划线，首尾为字母或数字。省略保留原值，空字符串或 null 清除；重复或与服务 ID 冲突返回409。',
    },
    description: string,
    visibility: vis,
    enabled: boolean,
    mode: {
      type: 'string',
      enum: ['image', 'redirect', 'json'],
      description:
        '服务默认响应。新建仅图片服务默认 image，包含视频的服务默认 redirect，只能配置 redirect 或 json。更新省略时保留兼容的原响应模式。',
    },
    mediaType: {
      type: 'string',
      enum: ['image', 'video', 'mixed'],
      description: '新建默认 image，更新省略保留原值。mixed 无参数时从图片和视频中抽取。',
    },
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
  'patch /api/v1/admin/folders/{id}': {
    ...folder,
    properties: {
      ...folder.properties,
      processingPolicy: { ...processing, nullable: true },
      aiEnabled: boolean,
    },
  },
  'put /api/v1/admin/processing': object(
    {
      policy: processing,
      maxUploadMB: { type: 'integer', minimum: 1, maximum: 100 },
      maxVideoUploadMB: { type: 'integer', minimum: 1, maximum: 1024, default: 500 },
    },
    ['policy', 'maxUploadMB'],
  ),
  'post /api/v1/admin/images/{id}/reprocess': object({ processing }),
  'put /api/v1/admin/ai': object({
    enabled: boolean,
    baseUrl: string,
    model: string,
    apiKey: { ...string, writeOnly: true, description: '省略保留已有值；空字符串清除。' },
    prompt: string,
    rules: string,
    folderIds: { type: 'array', items: string, maxItems: 100 },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120, default: 60 },
    retries: { type: 'integer', minimum: 0, maximum: 2, default: 2 },
    jsonMode: boolean,
  }),
  'post /api/v1/admin/classification': object(
    {
      ids: { type: 'array', items: string, minItems: 1, maxItems: 100 },
      skipUnavailable: {
        type: 'boolean',
        default: false,
        description:
          '手动任务跳过已删除、不可用及正在处理或分类的图片；响应 queued、skipped。重复ID仅计一次。',
      },
    },
    ['ids'],
  ),
  'post /api/v1/admin/storage-migrations': object(
    {
      targetStorageId: string,
      imageIds: { type: 'array', items: string, minItems: 1, maxItems: 100 },
      sourceStorageId: string,
      folderId: string,
      includeChildren: { type: 'boolean', default: false },
      includeTrash: { type: 'boolean', default: false },
    },
    ['targetStorageId'],
  ),
  'patch /api/v1/admin/images/{id}': image,
  'post /api/v1/admin/images/batch': object(
    {
      ids: { type: 'array', items: string, minItems: 1, maxItems: 100 },
      action: { type: 'string', enum: ['delete', 'restore', 'move', 'visibility', 'permanent'] },
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
        items: {
          type: 'string',
          enum: ['read', 'upload', 'private:read', 'random', 'ai:classify'],
        },
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
      logoUrl: {
        type: 'string',
        maxLength: 2048,
        description: '站点图标（Logo）的HTTP(S)地址；空字符串使用内置图标，省略时保留当前值。',
      },
      homeBackgroundUrl: {
        type: 'string',
        maxLength: 2048,
        description: '首页背景图片的HTTP(S)地址；空字符串使用默认底色，省略时保留当前值。',
      },
      originWhitelistEnabled: {
        type: 'boolean',
        description:
          '默认false，允许任意HTTP(S)来源；开启后限制为同源、PUBLIC_URL或allowedOrigins。旧客户端不传此字段时保留当前开关。',
      },
      allowedOrigins: { type: 'array', items: { type: 'string', format: 'uri' } },
    },
    ['title', 'description', 'allowedOrigins'],
  ),
};
const responses: Record<string, any> = {
  'post /api/v1/admin/images/batch': {
    '200': {
      description:
        '批量操作成功；permanent只处理回收站图片，非回收站或不存在的ID计入skipped，已在删除中的图片返回409。',
      content: {
        'application/json': {
          schema: object(
            {
              ok: { type: 'boolean' },
              skipped: { type: 'integer', minimum: 0, description: '仅permanent返回的跳过数量。' },
            },
            ['ok'],
          ),
        },
      },
    },
  },
  'get /api/v1/admin/images': {
    '200': {
      description:
        '管理员图片列表；仅trash=true返回整个回收站的totalSize，包含正在删除的图片，不包含已被物理删除的记录。',
      content: {
        'application/json': {
          schema: object(
            {
              items: { type: 'array', items: { type: 'object' } },
              total: { type: 'integer' },
              page: { type: 'integer' },
              limit: { type: 'integer' },
              totalSize: {
                type: 'integer',
                minimum: 0,
                description: '回收站图片当前版本的合计字节数；仅trash=true返回。',
              },
            },
            ['items', 'total', 'page', 'limit'],
          ),
        },
      },
    },
  },
  'get /api/v1/admin/images/{id}/trash-preview': {
    '200': {
      description:
        '仅管理员读取回收站中的图片；thumbnail=true优先返回缩略图，未就绪时返回当前图片；private, no-store。',
      content: { 'image/*': { schema: { type: 'string', format: 'binary' } } },
    },
  },

  'get /api/v1/admin/classification/stats': {
    '200': {
      description:
        '未删除图片的七种整理状态计数；缺失状态为0，total排除skipped，与列表status=all一致。',
      content: {
        'application/json': {
          schema: object(
            {
              counts: object(
                Object.fromEntries(
                  [
                    'pending',
                    'running',
                    'completed',
                    'unmatched',
                    'failed',
                    'canceled',
                    'skipped',
                  ].map((status) => [status, { type: 'integer', minimum: 0 }]),
                ),
                ['pending', 'running', 'completed', 'unmatched', 'failed', 'canceled', 'skipped'],
              ),
              total: { type: 'integer', minimum: 0 },
            },
            ['counts', 'total'],
          ),
        },
      },
    },
  },
};
const parameter = (name: string, schema: any, description = '') => ({
  name,
  in: 'query',
  schema,
  description,
});
export function documentedApi(app: FastifyInstance) {
  const document = structuredClone(app.swagger()) as any;
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ImageUrls = object(
    {
      url: {
        type: 'string',
        description: '可用的 S3 图片使用 GET 预签名地址。MP4 使用站内播放地址。',
      },
      thumbnailUrl: string,
      logicalUrl: {
        type: 'string',
        description: '站内地址。私有资源可能带短期 sig，长期引用请保存站内路径并在访问时授权。',
      },
      logicalThumbnailUrl: string,
      urlExpiresAt: {
        type: 'integer',
        format: 'int64',
        description: 'S3 URL 到期 Unix 毫秒；最长5分钟，不超过签发身份有效期。',
      },
      thumbnailUrlExpiresAt: { type: 'integer', format: 'int64' },
    },
    ['url', 'thumbnailUrl', 'logicalUrl', 'logicalThumbnailUrl'],
  );
  for (const [path, methods] of Object.entries(document.paths ?? {}) as [string, any][]) {
    for (const [method, op] of Object.entries(methods) as [string, any][]) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
      const body = bodies[`${method} ${path}`];
      const response = responses[`${method} ${path}`];
      if (response) op.responses = response;
      if (body)
        op.requestBody = { required: true, content: { 'application/json': { schema: body } } };
      const parameters: any[] = [...(op.parameters ?? [])];
      if (method === 'get' && path === '/api/v1/random/{serviceId}')
        for (const p of parameters)
          if (p.in === 'path' && p.name === 'serviceId')
            p.description = '随机图服务 ID 或自定义 slug；鉴权、限流和统计均按服务 ID 执行。';
      if (method === 'get' && path.endsWith('/trash-preview'))
        parameters.push(
          parameter('thumbnail', boolean, '优先读取缩略图；缺少缩略图时读取当前图片。'),
        );
      if (method === 'get' && /\/images$/.test(path)) {
        parameters.push(
          parameter('page', { type: 'integer', minimum: 1, default: 1 }),
          parameter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 40 }),
          parameter('search', string),
          parameter('tag', string),
          parameter('sort', { type: 'string', enum: ['newest', 'oldest', 'name'] }),
          parameter(
            'mediaType',
            { type: 'string', enum: ['image', 'video'] },
            '省略时返回图片和视频。',
          ),
        );
        if (!path.includes('{folderId}')) parameters.push(parameter('folderId', string));
        if (path.startsWith('/api/v1/admin')) parameters.push(parameter('trash', boolean));
      }
      if (method === 'get' && path.includes('/random') && !path.includes('/admin/'))
        parameters.push(
          parameter(
            'mode',
            { type: 'string', enum: ['image', 'redirect', 'json'] },
            '默认使用服务的响应模式。混合服务无参数时从图片和视频中抽取；显式 image 只返回图片。视频通过 JSON 或 302 返回固定站内播放地址。随机结果不可缓存。',
          ),
          parameter(
            'mediaType',
            { type: 'string', enum: ['image', 'video'] },
            '按服务允许的范围筛选媒体。视频使用返回的固定站内地址播放。',
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
          parameter(
            'mediaType',
            { type: 'string', enum: ['image', 'video'], default: 'image' },
            '上传 MP4 时设为 video。',
          ),
          parameter('processing', string, 'JSON 对象，只覆盖提交字段；请求 > 文件夹 > 系统。'),
          parameter(
            'classify',
            boolean,
            '显式指定文件夹默认不自动分类；密钥需 ai:classify 和目标上传范围。',
          ),
        );
        op.description =
          '图片默认最大 100 MiB，支持静态 JPG、PNG、WebP 和静态或动态 GIF。GIF 最多 500 帧，合计最多 4000 万画布像素。mediaType=video 接收 H.264 / AAC MP4，默认 500 MiB。GIF 和视频原样保存，视频跳过图片处理和 AI 分类。';
        op.responses = {
          '201': { description: '未启用异步处理时，保留原响应。' },
          '202': {
            description:
              '处理或分类已排队；包含 uploadId、imageId、statusUrl。完成前隔离公开访问。',
          },
        };
      }
      if (path.startsWith('/api/v1/resumable')) {
        op.security = [{ apiKey: [] }, { adminSession: [] }];
        parameters.push({
          name: 'Tus-Resumable',
          in: 'header',
          required: true,
          schema: { type: 'string', enum: ['1.0.0'] },
        });
        if (method === 'post') {
          parameters.push(
            {
              name: 'Upload-Length',
              in: 'header',
              required: true,
              schema: { type: 'integer', minimum: 1, maximum: 1073741824 },
            },
            {
              name: 'Upload-Metadata',
              in: 'header',
              required: true,
              schema: string,
              description:
                'tus Base64 元数据：filename、sha256 必填；folderId、storageId、visibility、processing(JSON)、classify 可选；上传 MP4 时需设置 mediaType=video。',
            },
          );
          op.responses = { '201': { description: '已创建；Location 为续传资源地址。' } };
        }
        if (method === 'patch') {
          parameters.push(
            {
              name: 'Upload-Offset',
              in: 'header',
              required: true,
              schema: { type: 'integer', minimum: 0 },
            },
            {
              name: 'X-Chunk-SHA256',
              in: 'header',
              required: true,
              schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
            },
          );
          op.requestBody = {
            required: true,
            content: {
              'application/offset+octet-stream': {
                schema: {
                  type: 'string',
                  format: 'binary',
                  description: '每片最多4MiB；校验成功才追加并确认偏移。',
                },
              },
            },
          };
          op.responses = {
            '204': {
              description: '字节追加成功；Upload-Offset 为确认偏移。收齐后异步校验、处理、分类。',
            },
            '460': { description: '分片 SHA-256 不匹配，偏移不变。' },
          };
        }
        if (method === 'head')
          op.responses = {
            '200': { description: 'Upload-Offset / Upload-Length 为持久化偏移与总长度。' },
          };
        if (method === 'delete')
          op.responses = { '204': { description: '取消未完成传输。已发布图片请使用回收站。' } };
        op.description =
          '需当前上传权限、归属及范围；管理员写请求携带 CSRF。未宣称 tus Checksum 扩展；协议错误可能为纯文本。24小时有效。';
      }
      if (path.startsWith('/api/v1/uploads/')) {
        op.security = [{ apiKey: [] }, { adminSession: [] }];
        op.description =
          '仅上传归属者或管理员，仍校验当前授权。状态 created/uploading/validating/processing/classifying/ready/failed/expired/canceled；GET 包含 uploadId、imageId、offset、length、expiresAt、error、image。retry 重试校验、处理或分类；DELETE 取消未完成任务。';
      }
      if (path.startsWith('/api/v1/admin/storage-migrations')) {
        op.description =
          '仅管理员。创建返回201草稿，30分钟有效，imageIds与sourceStorageId二选一；筛选范围在创建时冻结。确认start后异步迁移，不改变ID、内容、权限和默认上传存储。源副本保留至显式cleanup；字节校验通过后逐图切换。';
        if (path.endsWith('/{action}')) {
          for (const item of parameters)
            if (item.in === 'path' && item.name === 'action')
              item.schema = {
                type: 'string',
                enum: ['start', 'pause', 'resume', 'cancel', 'retry', 'cleanup'],
              };
          op.description +=
            ' pause/cancel先中断I/O，再确认暂停/取消；retry只重试失败项。cleanup只用于终态任务，目标不可用时保留源副本。返回任务状态，不代表后台操作完成。';
        }
        if (method === 'get' && !path.endsWith('/{id}'))
          parameters.push(
            parameter('page', { type: 'integer', minimum: 1, default: 1 }),
            parameter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 40 }),
          );
        if (path.endsWith('/items'))
          parameters.push(
            parameter('state', {
              type: 'string',
              enum: [
                'draft',
                'pending',
                'copying',
                'paused',
                'committed',
                'failed',
                'skipped',
                'canceled',
              ],
            }),
          );
        if (method === 'post' && path === '/api/v1/admin/storage-migrations')
          op.responses = {
            '201': {
              description:
                '冻结清单草稿，包含id、state、total_count、success_count、failed_count、skipped_count、canceled_count、estimated_bytes、expires_at、skipReasons；容量估算不含缩略图。',
            },
          };
      }
      if (method !== 'get' && method !== 'head' && path.startsWith('/api/v1/admin'))
        parameters.push({ name: 'X-CSRF-Token', in: 'header', required: true, schema: string });
      if (parameters.length) op.parameters = parameters;
      op.responses ??= {};
      if (path.startsWith('/i/') || path.startsWith('/t/') || path.endsWith('/original')) {
        op.responses['302'] = {
          description:
            '可预签名的 S3 对象在完成鉴权及对象检查后跳转到短期 GET 地址。MP4 的站内播放由 /i/ 直接传输。',
          headers: { Location: { schema: { type: 'string', format: 'uri' } } },
        };
      }
      if (
        /\/images$/.test(path) ||
        path.endsWith('/upload') ||
        path.startsWith('/api/v1/random') ||
        path.startsWith('/api/v1/uploads/') ||
        path.endsWith('/classification')
      ) {
        op.description =
          (op.description ?? '') +
          ' 地址字段见 ImageUrls。S3 图片和就绪缩略图按当前读取权限签发最长 5 分钟的直链。回收站和发布隔离对象不签发。已签发的 S3 地址可在权限变更后继续有效至到期。MP4 播放使用站内地址。';
      }
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
