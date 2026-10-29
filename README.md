# XHImg

一次整理，随处调用。单管理员图片资源与随机图 API 服务。

在 P0 的授权上传、本地/S3、继承权限、随机服务和公共图库上，P1 增加图片压缩转换、原图保留、断点续传与 AI 归档。处理和 AI 默认关闭，不自动修改已有图片。存储迁移留待 P2。两个参考项目未修改，未复制 PixelPunk 源码。

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

实际同源请求始终允许，因此也可以从后端的 9521 端口或对应的 `127.0.0.1` 地址访问已构建页面。跨源调用仅允许 `PUBLIC_URL` 或设置中心白名单中的来源；反向代理的外部协议和域名仍应正确配置。

`DATA_DIR` 相对仓库根目录解析，默认 `data/`；支持绝对路径。原图位于 `data/objects/<storage-id>/originals/`，SQLite 为 `data/xhimg.sqlite`，临时上传位于 `data/tmp/`。不要将数据目录作为 Web 静态目录公开。

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

S3 支持 Endpoint、Region、Bucket、凭证和 Path Style。Bucket 必须关闭公共读取；应用通过 SDK 读写对象、由后端授权后传输。禁用存储不影响已存图片读取；已有图片或未完成上传的存储连接不允许直接更换。`originals/`、`processed/`、`thumbnails/` 前缀需由 XHImg 独占。所有续传先暂存本地，S3 部署也需预留本地磁盘。

## 检查命令

```sh
pnpm typecheck
pnpm test
pnpm test:scale
pnpm test:resources
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

后端用例使用隔离临时数据库和对象目录；S3 测试使用本机 HTTP 协议夹具，通过真实 AWS SDK 请求验证，不代表已经验证所有云服务商。端到端测试启动独立 9522 测试实例，不操作正式数据。

API 说明见 [docs/api.md](docs/api.md)，备份与恢复见 [docs/operations.md](docs/operations.md)，来源声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。应用源码的对外分发许可证留待所有者决定。
