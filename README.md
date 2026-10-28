# XHImg

一次整理，随处调用。单管理员图片资源与随机图 API 服务。

这是独立的 P0 实现：授权上传、本地/S3 存储、文件夹与继承权限、直链与缩略图、API Key、随机图服务、公共图库及管理后台。**不包含 AI 分类、分片续传、图片压缩转换设置或存储迁移。** 两个参考项目未修改，未复制 PixelPunk 源码。

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

Compose 使用命名卷持久化数据，镜像以非 root 用户运行。公网部署放在 HTTPS 反向代理后，将 `PUBLIC_URL` 设置为真实 HTTPS 站点来源、`COOKIE_SECURE=true`。仅当后端端口不直接暴露给不可信客户端时设置 `TRUST_PROXY=true`，否则客户端可伪造代理 IP 干扰限流。反向代理请求体限制至少允许 21MB，上传超时至少 120 秒。不要在 CDN 为 `/i/`、`/t/`、随机接口启用忽略响应头的强制缓存。

升级前备份。启动会自动执行 `apps/server/migrations/` 中未应用的 SQL；不支持在同一数据目录启动多个 XHImg 实例。Docker 实际运行状态见 [验证记录](docs/validation.md)，不以存在 Dockerfile 代替运行验证。

## 使用顺序

1. 创建文件夹，设置自身权限；任意祖先为私有时，后代有效权限均为私有。
2. 选择文件夹上传 JPG/PNG/WebP。默认图片私有；需要公开时显式选择。每张最大 20MB、4000 万像素，不接受动画。
3. 在随机图服务中配置全站、文件夹或自定义服务并启用。公开服务自动出现在首页，仅选公开图片。
4. 外部上传创建具有 `upload` 与目标文件夹范围的 API Key；私有读取另授 `read`、`private:read`，私有随机调用还需 `random` 与服务范围。
5. 删除图片先进入回收站；彻底删除在后台执行，存储失败时保留记录并重试。

上传请求的文件夹、权限、存储参数放在查询字符串中，multipart 仅包含一个 `file`。前端批量上传使用最多两个独立请求。原图保留；最长边 640px 的 WebP 缩略图异步生成，失败可从概览的任务列表重试。

S3 支持 Endpoint、Region、Bucket、凭证和 Path Style。Bucket 必须关闭公共读取；应用通过 SDK 读写对象、由后端授权后传输。禁用存储不影响已存图片读取；已有图片的存储连接不允许直接更换，以免变成悬空引用。S3 中的 `originals/` 与 `thumbnails/` 前缀需由 XHImg 独占，不要手工覆盖对象。

## 检查命令

```sh
pnpm typecheck
pnpm test
pnpm test:scale
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

后端用例使用隔离临时数据库和对象目录；S3 测试使用本机 HTTP 协议夹具，通过真实 AWS SDK 请求验证，不代表已经验证所有云服务商。端到端测试启动独立 9522 测试实例，不操作正式数据。

API 说明见 [docs/api.md](docs/api.md)，备份与恢复见 [docs/operations.md](docs/operations.md)，来源声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。应用源码的对外分发许可证留待所有者决定。
