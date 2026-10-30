# XHImg

一次整理，随处调用。单管理员图片资源与随机图 API 服务。

在 P0 的授权上传、本地/S3、继承权限、随机服务和公共图库上，P1 增加图片压缩转换、原图保留、断点续传与 AI 归档，P2 增加存储迁移。处理和 AI 默认关闭，不自动修改已有图片；迁移必须由管理员预览后确认。两个参考项目未修改，未复制 PixelPunk 源码。

## 本地运行

需要 Node.js 24、pnpm 12.8.1。Windows 上 better-sqlite3 优先下载匹配 Node ABI 的预编译模块；若无对应预编译模块，需要本地编译工具。

```sh
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 将输出填入 .env 的 MASTER_KEY，永久保留；勿每次启动更换。
pnpm install
pnpm build
pnpm start
```

访问 `http://localhost:9521/setup`。在启动日志中找到一次性安装令牌，创建管理员（密码至少 12 字符）。没有默认账号或密码。未安装时重启会生成新令牌，旧令牌失效。

开发模式：将 `.env` 的 `PUBLIC_URL` 设为 `http://localhost:3801`，运行 `pnpm dev`，访问 3801；前端开发代理将 API、原图和缩略图请求发往 9521。开发代理不会改变生产同源策略。

实际同源请求始终允许，因此也可以从后端的 9521 端口或对应的 `127.0.0.1` 地址访问已构建页面。默认允许任意HTTP(S)来源跨域访问；管理员可在“设置中心 → 站点设置”手动开启“启用跨域来源白名单”，开启后仅允许实际同源、`PUBLIC_URL`及名单中的来源。普通API与断点续传共用此规则，跨域管理员Cookie不开放，上传和私有读取仍需授权。反向代理的外部协议和域名仍应正确配置。

`DATA_DIR` 相对仓库根目录解析，默认 `data/`；支持绝对路径。本地对象位于 `data/objects/<storage-id>/`，包含 originals、processed、thumbnails 和 migrations 前缀；SQLite 为 `data/xhimg.sqlite`，临时上传位于 `data/tmp/`。不要将数据目录作为 Web 静态目录公开。

## Docker

```sh
# 按上述步骤创建 .env 并设置 MASTER_KEY / PUBLIC_URL
docker compose up -d --build
docker compose logs xhimg
```

Compose 使用命名卷持久化数据，镜像以非 root 用户运行。公网部署放在 HTTPS 反向代理后，将 `PUBLIC_URL` 设置为真实 HTTPS 站点来源、`COOKIE_SECURE=true`。仅当后端端口不直接暴露给不可信客户端时设置 `TRUST_PROXY=true`，否则客户端可伪造代理 IP 干扰限流。反向代理请求体限制建议 `110m`，上传超时至少 120 秒，续传 PATCH 不应被代理改写。不要在 CDN 为 `/i/`、`/t/`、随机接口启用忽略响应头的强制缓存。

升级前备份。启动会自动执行 `apps/server/migrations/` 中未应用的 SQL；不支持在同一数据目录启动多个 XHImg 实例。Docker 实际运行状态见 [验证记录](docs/validation.md)，不以存在 Dockerfile 代替运行验证。

## 使用顺序

1. 创建文件夹，设置自身权限；任意祖先为私有时，后代有效权限均为私有。
2. 选择文件夹上传 JPG/PNG/WebP。默认图片私有；需要公开时显式选择。默认最大 100MB、4000 万像素，不接受动画，后台可调低大小上限。
3. 在随机图服务中配置全站、文件夹或自定义服务并启用。公开服务自动出现在首页，仅选公开图片。
4. 外部上传创建具有 `upload` 与目标文件夹范围的 API Key；私有读取另授 `read`、`private:read`，私有随机调用还需 `random` 与服务范围。
5. 删除图片先进入回收站；彻底删除在后台执行，存储失败时保留记录并重试。

上传中心使用 4MiB 分片、两个文件并发、整文件与分片 SHA-256 校验。暂停后可继续；刷新后重新选择原文件恢复。浏览器只保存恢复元数据，不保存文件或长期 Key。原 multipart 接口保留。最长边 640px 的缩略图异步生成。

在设置中心启用处理策略，可调整格式、质量、最大宽高和原图保留；PNG 无损、透明图转 JPG 填白，不放大。策略按请求、文件夹、系统逐字段合并。重新处理成功前旧直链继续提供当前版本；失败的新图保留原文件并暂停公开，可在上传中心重试或在图片编辑中明确发布原图。

在设置中心填写视觉模型 Base URL、模型名与密钥，选择参与分类的文件夹。只发送不超过1024px的去元数据预览。未指定文件夹的新上传可自动分类；指定文件夹默认保留归属。API 调用需额外授予 `ai:classify`，已有密钥不自动获得此权限。智能整理工作区提供任务状态、批量重分类和人工归档。模型等待使用独立队列。

整理旧图：进入“智能整理 → 手动任务”，选择来源文件夹，搜索并勾选图片，点击“执行整理”。每次最多100张，支持跨页勾选；重复、正在处理/分类或已删除的图片会跳过。执行后进入待分类队列，可在“已完成／无法匹配／失败任务”查看结果。

S3 支持 Endpoint、Region、Bucket、凭证和 Path Style。Bucket 必须关闭公共读取；后端鉴权后签发最长5分钟的 GET 临时直链，由浏览器直接读取。Endpoint 必须可被图片访问者访问，HTTPS站点使用HTTPS Endpoint；保存新的S3连接会重新加载页面应用精确图片来源CSP。本地存储及随机图 `image` 模式仍由后端传输。禁用存储不影响已有图片读取；已有图片或未完成上传的存储连接不允许直接更换。`originals/`、`processed/`、`thumbnails/` 前缀需由 XHImg 独占。所有续传先暂存本地，S3 部署也需预留本地磁盘。

S3图片的 `url`、`thumbnailUrl` 是临时地址，`urlExpiresAt`、`thumbnailUrlExpiresAt` 为到期Unix毫秒。长期引用请使用 `logicalUrl`、`logicalThumbnailUrl`，旧 `/i/`、`/t/` 鉴权后跳转到当前S3对象；私有站内分享仍需当前身份或站内签名。已经签发的S3地址不随站内权限修改、密钥撤销立即失效，最多可能继续使用至到期；对象删除、重新处理或迁移源副本清理可能使其提前失效。详情与验证范围见[直链验证记录](docs/s3-links-validation.md)。

## 存储迁移

在“设置中心 → 存储迁移”创建任务，按来源存储、文件夹筛选；也可在资源列表勾选最多100张图片，使用“迁移存储”。预览冻结图片清单，30分钟内确认执行。默认不含子目录和回收站，可分别勾选。迁移不改变系统或文件夹的新上传目标，迁空旧存储前请先手动调整上传配置。

每张图片的当前结果、保留原图及缩略图去重复制，经目标回读与SHA-256验证后一起切换。ID、直链、有效签名、内容、名称、权限和删除状态保持；复制失败继续使用原位置。目标对象使用独立 `migrations/` 前缀，也由 XHImg 独占。任务支持暂停、继续、取消及仅重试失败项，取消不回滚已完成项。

迁移成功后源副本继续占用原存储空间，由管理员在任务详情中确认清理。清理前验证当前对象，目标缺失或不可用时保留源副本；失败可重试。永久删除图片会同时删除迁移副本，不保留可恢复源副本。源副本不替代一致性备份，云存储复制和回读可能产生流量费用。

## 检查命令

```sh
pnpm typecheck
pnpm test
pnpm test:scale
pnpm test:resources
pnpm test:migration-scale
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

后端用例使用隔离临时数据库和对象目录；S3 测试使用本机 HTTP 协议夹具，通过真实 AWS SDK 请求验证，不代表已经验证所有云服务商。端到端测试启动独立 9522 测试实例，不操作正式数据。

API 说明见 [docs/api.md](docs/api.md)，备份与恢复见 [docs/operations.md](docs/operations.md)，来源声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。应用源码的对外分发许可证留待所有者决定。
