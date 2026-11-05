# API 参考

[文档首页](README.md) · [部署与运维](operations.md) · [架构与实现](design.md)

## 通用约定

- 基础路径为 `/api/v1`，下文接口短路径均相对该路径；`/i/{id}`、`/t/{id}` 位于站点根路径。
- JSON 请求使用 `Content-Type: application/json`；上传和续传按各自协议设置。
- 分页使用 `page`（从 1 开始）和 `limit`（默认 40，最大 100）。资源 ID 只用于定位，不代表授权。
- 时间戳使用 Unix 毫秒；上传限制使用 MiB、GiB。
- 运行中的服务提供 `GET /api/v1/openapi.json` 接口清单与 `/docs` 浏览器示例；本文补充权限、状态与兼容性规则。
- shell 示例使用 POSIX 语法，ID、Key 和文件名需替换；PowerShell 使用 `curl.exe` 并调整续行方式。

[鉴权与权限](#鉴权与权限) · [跨域来源](#跨域来源) · [上传](#上传) · [断点续传](#断点续传) · [图片与文件夹查询](#图片与文件夹查询) · [图片地址与有效期](#图片地址与有效期) · [随机图](#随机图) · [管理接口](#管理接口) · [图片处理与 AI 归档](#图片处理与-ai-归档) · [存储迁移](#存储迁移) · [错误响应](#错误响应)

## 鉴权与权限

### 管理员会话

管理员：登录建立 HttpOnly、SameSite=Strict 会话；`GET /auth/me` 返回 CSRF token，所有管理写请求包含 `X-CSRF-Token`。`/admin/*` 不接受 API Key 替代管理员。

### API Key

外部应用：`Authorization: Bearer xh_...`。权限为 `upload`、`read`、`private:read`、`random`、`ai:classify`；范围为 `all`、`folder`、`service`、`storage`。范围可授多条。文件夹授权默认只包含当前文件夹，`descendants:true` 才包含后代。图片上传权限不包含私有读取。存储范围只用于显式选择存储，不自动授予图片操作权限。AI 还要求当前及候选目标文件夹的上传范围，旧密钥不自动增加权限。

私有随机服务：需要 random 与服务范围（或对应文件夹服务的文件夹范围），读取私有候选还需 read、private:read 与图片文件夹范围。

### 安装与会话接口

| 接口                | 用途                                                          |
| ------------------- | ------------------------------------------------------------- |
| `GET /setup`        | 查询是否已安装                                                |
| `POST /setup`       | 提交 `{token,username,password}` 创建管理员，密码 12–256 字符 |
| `POST /auth/login`  | 提交 `{username,password}`，设置会话 Cookie 并返回 `csrf`     |
| `GET /auth/me`      | 获取当前管理员与 CSRF token                                   |
| `POST /auth/logout` | 注销当前会话，需 CSRF token                                   |

未安装时的启动日志提供一次性令牌；安装完成前重启会使旧令牌失效。会话有效期为 7 天，修改密码会注销全部会话。

## 跨域来源

跨域默认允许任意规范的 HTTP(S)来源，响应回显允许的 Origin 且不开放跨域 Cookie 凭证；普通 API 和 tus 使用同一策略。管理员通过 `PUT /admin/settings` 的 `originWhitelistEnabled` 手动开启白名单，开启后仅允许实际同源、PUBLIC_URL 及 `allowedOrigins` 中的来源。`null`、file 来源、含路径/尾斜杠的非规范 Origin 不接受。无 Origin 的服务端请求保持原有行为。

新增开关缺失的旧配置按 false 处理，已有白名单保留但不自动启用。旧客户端 PUT 不传开关时保留当前开关，避免保存名称等字段时意外关闭已启用的白名单。公共设置接口不返回开关或名单。跨域策略不授予接口权限，也不修改 S3 桶自身 CORS。

## 上传

```sh
curl -X POST 'http://localhost:9521/api/v1/upload?folderId=fld_ID&visibility=public' \
  -H 'Authorization: Bearer xh_YOUR_KEY' -F 'file=@photo.png'
```

- `POST /upload`、`POST /folders/{folderId}/upload`：仅一个 multipart 文件。参数放在 URL：`folderId`、`visibility`、`storageId`。路径与查询文件夹冲突返回 400。默认未分类文件夹与 private；显式 storageId 还需存储授权。
- 响应 201：返回图片信息，包括 ID、名称、文件夹、权限、格式、尺寸、处理状态和访问地址；地址字段见[图片地址与有效期](#图片地址与有效期)。
- 默认上限 100 MiB，可由管理员调低。支持静态 JPG、PNG、WebP，以及静态和动态 GIF，最多 4000 万像素。GIF 最多 500 帧，像素按所有帧的画布合计，超限返回 `400 INVALID_IMAGE`。按文件内容识别格式，GIF 的 MIME 为 `image/gif`。
- 上传 MP4 时在 URL 加 `mediaType=video`。接受 8 位 4:2:0 H.264 视频和可选的 AAC 音轨，最高 4096×2160，支持横竖方向。视频默认限额 500 MiB，管理员可在 1–1024 MiB 调整。服务器按内容校验后原样保存，返回 `201`、`format: "mp4"`、`mime: "video/mp4"`。视频跳过图片处理和 AI 分类，WebP 封面在后台生成。工具缺失返回 `503 VIDEO_TOOLS_UNAVAILABLE`，不支持的容器或编码返回 `415`。
- 可选查询 `processing` 为 JSON 策略，`classify=true|false`。策略字段包括 enabled、compress、targetFormat（keep/jpg/png/webp）、quality（1–100，默认 80）、maxWidth/maxHeight（null 不限制）和 preserveOriginal（默认 true）。只覆盖提交字段，优先级请求 > 文件夹 > 系统。GIF 原样保存，缩略图和 AI 预览使用首帧。普通 GIF 上传在无需 AI 分类时返回 `201`，需要分类时返回 `202`。手动重新处理 GIF 返回 `409 GIF_PROCESSING_UNSUPPORTED`。
- 启用处理或分类时响应 202，保留图片字段并增加 `uploadId`、`imageId`、`statusUrl`。传输成功不代表已发布；查询状态至 ready。处理或新图分类未完成时，非管理员原图、缩略图、查询与随机访问均隔离。
- 当前图片的站内逻辑地址保持稳定。上传返回私有图片的裸地址不意味着可匿名访问；外部客户端可持 Key 请求，或在授权图片列表/随机 JSON 中取得短期签名 URL。

## 断点续传

`POST /resumable` 创建，`HEAD/PATCH/DELETE /resumable/{uploadId}` 查询偏移、追加、取消。每次检查身份、归属及当前授权；管理员写入仍需 CSRF。协议版本 `Tus-Resumable: 1.0.0`。声明 `Upload-Length`，元数据 `filename`、`sha256` 必填，各值按 tus Base64 编码；可选 folderId、storageId、visibility、processing(JSON)、classify。

续传 MP4 时加入 `mediaType dmlkZW8=`。声明的媒体类型决定创建时的文件大小上限，完整文件仍需通过相应格式校验。`GET /public/upload-config` 返回 `maxUploadMB` 和 `maxVideoUploadMB`。

每片最多 4MiB，同一文件顺序上传。PATCH 使用 `application/offset+octet-stream`、`Upload-Offset` 和自定义 `X-Chunk-SHA256`（本片 SHA-256 十六进制）。校验不符 460，偏移不推进；偏移冲突 409。**未实现 tus Checksum 扩展**，分片校验使用上述自定义请求头。 tus 协议错误可能为纯文本；业务 JSON 接口沿用统一错误格式。

```sh
# 先准备 photo.png、首个分片 chunk.bin，并设置 FILE_SIZE、FILE_SHA256、CHUNK_SHA256。
# FILE_SIZE 为完整文件字节数，两个 SHA256 变量分别为整文件与本片的十六进制摘要。
# 下面命令通过 stdin 生成 Base64 元数据。
FILE_NAME_B64=$(printf '%s' 'photo.png' | base64 | tr -d '\n')
FILE_HASH_B64=$(printf '%s' "$FILE_SHA256" | base64 | tr -d '\n')
curl -i -X POST 'http://localhost:9521/api/v1/resumable' \
  -H 'Authorization: Bearer xh_YOUR_KEY' -H 'Tus-Resumable: 1.0.0' \
  -H "Upload-Length: $FILE_SIZE" \
  -H "Upload-Metadata: filename $FILE_NAME_B64,sha256 $FILE_HASH_B64"
# 使用响应 Location；offset 为服务端 HEAD 返回的确认偏移。
curl -i -X PATCH 'http://localhost:9521/api/v1/resumable/upl_ID' \
  -H 'Authorization: Bearer xh_YOUR_KEY' -H 'Tus-Resumable: 1.0.0' \
  -H 'Upload-Offset: 0' -H "X-Chunk-SHA256: $CHUNK_SHA256" \
  -H 'Content-Type: application/offset+octet-stream' --data-binary @chunk.bin
```

创建返回 201+Location，PATCH 返回 204+Upload-Offset。完整文件收齐后异步校验与处理；重复完成不会创建第二张图片。`GET /uploads/{uploadId}` 返回 uploadId、imageId、state、offset、length、expiresAt、error、image，仅归属者或管理员。`DELETE /uploads/{uploadId}` 取消未发布任务；`POST /uploads/{uploadId}/retry` 重试已收齐文件的失败校验、处理或分类。已发布图片使用回收站。

浏览器采用 tus-js-client，自定义 HttpStack 在每片发送前增量计算摘要。Worker 计算整文件指纹，IndexedDB 保存恢复 URL、指纹、大小及选项；刷新需重新选择原文件。默认 24 小时过期、20 个未完成传输、2GiB 声明量，磁盘不足 507。默认允许跨域调用；管理员开启来源白名单后，外部来源须在名单中。授权、归属和范围检查不变。

## 图片与文件夹查询

- `GET /folders/{id}/images`：有效公开文件夹可匿名访问，私有文件夹须授权。内部图片仍逐项过滤。支持分页、search、tag、sort（newest/oldest/name）。
- `GET /public/images`：公开图片和视频，支持相同筛选，另有 folderId。公开、文件夹和管理列表均可用 `mediaType=image|video` 筛选。公开列表省略存储位置。
- `GET /public/folders`、`GET /public/services`、`GET /public/settings`：公开导航、服务卡片及站点名称、描述和首页背景图片地址。

图片传输使用站点根路径 `GET /i/{id}`、`GET /t/{id}`，不加 `/api/v1` 前缀。访问时验证会话、Key 或 `sig` 查询参数；源文件仅允许管理员从专用下载接口获取。缓存与跳转规则见下节。

MP4 通过 `GET /i/{id}` 在站内播放。本地和 S3 视频均支持 `HEAD` 和单段 `Range: bytes=起点-终点`，也可省略起点或终点。成功的分段请求返回 `206`、`Content-Range` 和 `Content-Length`，无法满足的范围返回 `416` 和 `Content-Range: bytes */文件大小`。每个请求独立检查权限，S3 播放字节经由站点服务器。`/t/{id}` 提供 WebP 封面。

## 图片地址与有效期

| 字段                                    | 含义                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| `url`、`thumbnailUrl`                   | 当前可用地址；已发布且有读取权限的 S3 图片为临时预签名地址 |
| `logicalUrl`、`logicalThumbnailUrl`     | 站内逻辑地址，适合长期保存引用；私有资源仍需授权           |
| `urlExpiresAt`、`thumbnailUrlExpiresAt` | 可选，到期 Unix 毫秒，本地图片不提供                       |

图片响应包含 `logicalUrl`、`logicalThumbnailUrl`。有当前读取权限且已发布的 S3 图片，其 `url`、就绪的 `thumbnailUrl` 为 GET 预签名地址；可选 `urlExpiresAt`、`thumbnailUrlExpiresAt` 为到期 Unix 毫秒。默认最长 300 秒，不超过会话、API Key 或站内签名的剩余有效期。无读取权限的上传者仍可得到上传成功元数据，但不会得到私有对象的 S3 地址；异步处理/分类未发布、回收站及未就绪缩略图不签发。

站内 `GET /i/{imageId}`、`GET /t/{imageId}` 当前鉴权并检查对象后，对 S3 返回 302 及 `Location`，跳转响应为 `private, no-store`，不返回 304；本地仍返回字节。管理员原图下载对 S3 也返回 302，目标使用附件文件名。随机 `json` 返回地址及到期字段，`redirect` 直接跳转 S3，`image` 仍返回图片字节。

S3 签名 URL 不可追加或改写参数（包括缓存刷新参数），也不能替换域名。客户端应按到期时间重新获取地址，或使用站内逻辑地址重新鉴权。已提交上传遇到临时签发故障仍返回成功及逻辑地址，不重复创建图片；直接读取签发故障返回 503。

站内逻辑地址定位当前对象，不受存储迁移和重新处理位置变化影响；私有资源仍需当前授权或有效站内签名。站内签名分享本身也有有效期，不是永久匿名授权。S3 已经签发的地址无法随应用权限变更、密钥撤销立即撤回，可能继续访问到期；物理对象删除或清理也可能提前使旧地址失效。

```js
const response = await fetch('/api/v1/random?mode=json');
if (!response.ok) throw new Error('没有可用图片');
const image = await response.json();
document.querySelector('img').src = image.url; // 临时直链；原样使用
console.log(image.urlExpiresAt); // S3有效期，Unix毫秒；本地未提供
console.log(image.logicalUrl); // 站内地址，适合保存引用；私有地址仍需授权
```

本地公开图片要求重新验证缓存，私有图片和随机响应使用 `no-store`；授权检查先于条件请求的 304 处理。S3 跳转不返回 304。

注意：`/i/{id}` 中的“原图”变体指当前发布版本，可能已处理；保留的源文件通过管理员下载接口获取。

## 随机图

- 全站：`GET /random`
- 文件夹：`GET /folders/{id}/random`
- 自定义：`GET /random/{serviceId}`
- 自定义别名（任意类型服务）：`GET /random/{slug}`

创建或更新 `/admin/random-services` 时可传可选字段 `slug`，例如 `wallpaper`，调用地址为 `/api/v1/random/wallpaper`。slug 去除首尾空格并转为小写，长度 1–64，只允许字母、数字和中划线，首尾必须是字母或数字；格式错误返回 400，与其他服务 slug 或任何已有服务 ID 重名返回 409。省略字段保留已有值，传空字符串或 `null` 清除。

管理和公开服务列表均返回 `slug`（未配置为 `null`）；配置后 `url` 优先使用 slug 地址。原有全站、文件夹和服务 ID 地址继续有效；更改或清除 slug 后旧别名失效。别名与原地址共享权限、限流和统计，API Key 授权仍使用服务 ID。

服务配置的 `mediaType` 可为 `image`（默认）、`video` 或 `mixed`。管理和公开服务列表均返回该字段，更新时省略则保留原配置。已有服务升级后为 `image`。仅视频服务默认使用 `redirect`，并支持 `json`。混合服务的 `mode=image` 只返回图片二进制。

`mode=json` 和 `mode=redirect` 可用查询参数 `mediaType=image|video` 缩小候选范围。混合服务省略筛选时，从所有符合规则的图片与视频中抽取。请求类型与服务配置或模式冲突时返回 `400 INVALID_MEDIA_SELECTION`。

例如 `GET /api/v1/random/wallpaper?mode=json&mediaType=video` 返回选中资源的 `mediaType`、`mime`、`url` 和原有信息字段。MP4 的 JSON `url` 与 302 `Location` 都是固定的站内播放地址。播放器应使用这次返回的地址发送后续分段请求，避免重新抽取。

私有站内链接默认签名五分钟，原资源与封面分别授权。读取时检查资源权限、签发会话或 Key、服务启用状态、当前媒体类型及来源规则。密钥撤销或权限变化会使站内签名立即失效。已经签发的 S3 图片地址仍可能使用至到期，见[图片地址与有效期](#图片地址与有效期)。

公开服务即使使用管理员会话调用，也只选公开资源。筛选先于随机，无候选时返回 `404 NO_CANDIDATES`。对象暂时不可用时返回 503，缺失对象标为 missing，并最多尝试三个候选。随机响应 no-store，可连续重复。

## 管理接口

| 资源                                | 操作                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `/admin/folders`                    | GET 列表含统计、POST 创建                                                                     |
| `/admin/folders/{id}`               | PATCH 编辑/移动/权限/封面/排序，DELETE 删除空文件夹                                           |
| `/admin/images`                     | GET 列表，trash=true 查询回收站                                                               |
| `/admin/images/{id}`                | PATCH 名称/归属/自身权限/标签/描述，DELETE 软删除                                             |
| `/admin/images/batch`               | POST `{ids,action,folderId?,visibility?}`，action=delete/restore/move/visibility，最多 100 项 |
| `/admin/images/{id}/trash-preview`  | GET 管理员读取回收站预览                                                                      |
| `/admin/images/{id}/restore`        | POST 恢复                                                                                     |
| `/admin/images/{id}/permanent`      | DELETE 排队彻底删除，需先软删除                                                               |
| `/admin/images/{id}/check`          | POST 检查恢复缺失对象                                                                         |
| `/admin/images/{id}/sign`           | POST 获取原图及缩略图临时链接                                                                 |
| `/admin/storage-backends`           | GET 脱敏配置/统计、POST 创建                                                                  |
| `/admin/storage-backends/{id}`      | PATCH 修改状态/默认值/连接，DELETE 无引用配置                                                 |
| `/admin/storage-backends/{id}/test` | POST 测试存储连接                                                                             |
| `/admin/api-keys`                   | GET 脱敏列表、POST 创建并仅一次返回完整密钥                                                   |
| `/admin/api-keys/{id}`              | DELETE 撤销                                                                                   |
| `/admin/random-services`            | GET 配置/统计、POST 创建                                                                      |
| `/admin/random-services/{id}`       | PUT 完整更新、DELETE 删除非全站服务                                                           |
| `/admin/settings`                   | GET/PUT 站点名称、描述、Logo、背景与跨域策略                                                  |
| `/admin/password`                   | PUT `{currentPassword,password}` 并注销全部会话                                               |
| `/admin/overview`                   | GET 基本统计、近期图片与后台任务                                                              |
| `/admin/jobs/{id}/retry`            | POST 重试失败任务                                                                             |

### 站点设置

`PUT /admin/settings` 需提交 `title`、`description` 和 `allowedOrigins`。可选字段：

| 字段                     | 规则                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `logoUrl`                | HTTP(S) 图片地址，最多 2048 字符；空字符串恢复默认图标                   |
| `homeBackgroundUrl`      | HTTP(S) 图片地址，最多 2048 字符；空字符串使用默认底色，不自动选图库图片 |
| `originWhitelistEnabled` | 默认 `false`，是否启用跨域来源白名单                                     |

可选字段省略时保留当前值。`allowedOrigins` 最多 20 项，每项为规范 HTTP(S) 来源，不含路径或尾斜杠。公共设置仅返回 `title`、`description`、`logoUrl` 和 `homeBackgroundUrl`。

### 资源配置

文件夹创建字段：name、parentId、description、visibility、storageId、sortOrder、coverId。PATCH 仅修改显式提交字段。

创建密钥：`{name,permissions:[...],grants:[{kind,resourceId,descendants}],expires:null或毫秒时间戳,rateLimit:120}`。

密钥和随机图服务的 `rateLimit` 均接受 0–10000 的整数，`0` 表示不限制对应层级的每分钟请求次数；正数按原规则限流。两者独立生效，例如服务设为 0，但使用的密钥设为 120，仍受该密钥上限约束。默认值不变：密钥 120、服务 60。

随机服务：`{kind:'folder'|'custom',folderId:null或ID,name,description,visibility,enabled,mode,includeChildren,rateLimit,rules:[{kind,resourceId,descendants}]}`。规则种类 source_folder、exclude_folder、exclude_image、tag。多个来源取并集，排除条件及全部标签条件取交集。全站配置通过更新内置 global 服务，不重复创建。

S3：`{name,type:'s3',config:{endpoint,region,bucket,accessKeyId,secretAccessKey,forcePathStyle},enabled,isDefault}`。local 不接受客户端绝对路径，统一位于持久化目录下。

## 图片处理与 AI 归档

| 接口                                   | 用途                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET/PUT /admin/processing`            | `{policy,maxUploadMB}`；大小 1–100MiB，策略只影响后续任务                                     |
| `GET /public/upload-config`            | 当前最大上传大小                                                                              |
| `POST /admin/images/{id}/reprocess`    | `{processing?:策略}`，既有当前版本继续可用，成功后切换                                        |
| `GET /admin/images/{id}/original`      | 下载保留的源文件；未保留时下载当前文件；仅管理员、no-store                                    |
| `POST /admin/images/{id}/use-original` | 处理失败新图使用原文件结束任务；已处理但分类未完成时使用当前版本结束整理                      |
| `GET/PUT /admin/ai`                    | 配置启用、baseUrl、model、apiKey、prompt、rules、folderIds、timeoutSeconds、retries、jsonMode |
| `POST /admin/ai/test`                  | 内置蓝色测试图验证视觉输入和分类输出；使用已保存配置                                          |
| `GET /admin/classification`            | 分页；status=all/pending/running/completed/unmatched/failed/canceled                          |
| `POST /admin/classification`           | `{ids:[...],skipUnavailable?:false}`，最多 100 张，返回 queued、skipped，重复 ID 仅计一次     |

### 处理策略

`processing` 查询参数为下表字段组成的 JSON；系统与文件夹策略使用相同字段。仅覆盖显式提交的字段，按请求、文件夹、系统、内置默认值逐级取值。

| 字段                    | 内置默认值 | 规则                                        |
| ----------------------- | ---------- | ------------------------------------------- |
| `enabled`               | `false`    | 是否启用处理                                |
| `compress`              | `true`     | 是否压缩                                    |
| `targetFormat`          | `keep`     | `keep`、`jpg`、`png`、`webp`                |
| `quality`               | `80`       | 1–100 的整数                                |
| `maxWidth`、`maxHeight` | `null`     | 1–40000 的整数，`null` 为不限制，不放大图片 |
| `preserveOriginal`      | `true`     | 是否保留源文件                              |

### 分类与任务行为

文件夹 PATCH 支持 `processingPolicy`（null 继承）、`aiEnabled`。AI 密钥省略保持、空字符串清除，读取只返回 hasKey；加密存储。默认 60 秒超时、最多额外重试 2 次，默认不发送 response_format。模型仅返回 `{"folderId":"候选ID"}` 或 `{"folderId":null}`；无效/越权结果失败，永不执行模型指令。分类不迁移物理对象。

图片 DTO 包含 processingStatus、classificationStatus、hasOriginal、publicationHold。处理或 AI 失败可重试，人工移动会撤销旧整理版本。存储统计计入不同的当前结果与保留原图，不含缩略图。

手动整理在智能整理的“手动任务”页签中选择来源文件夹与已有图片，支持名称/标签搜索、分页勾选和每批 100 张；来源不包含子文件夹。执行时发送 `skipUnavailable:true`，跳过提交时已删除、已彻底删除、正在处理/分类或不可用的图片，并返回实际排队和跳过数量。既有公开图片排队期间保持当前访问，归档后仍按自身和目标文件夹权限判定。

## 存储迁移

仅接受管理员会话，写请求必须携带 `X-CSRF-Token`，不接受 API Key 替代管理员。分页默认 40 条、上限 100 条。创建 201 返回冻结清单草稿，30 分钟有效；确认 start 后才复制，不自动处理随后上传的图片。

| 接口                                           | 行为                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| `POST /admin/storage-migrations`               | 创建预览草稿                                      |
| `GET /admin/storage-migrations`                | 分页查询任务                                      |
| `GET /admin/storage-migrations/{id}`           | 任务摘要与累计进度                                |
| `GET /admin/storage-migrations/{id}/items`     | 分页明细；可按 state 筛选                         |
| `POST /admin/storage-migrations/{id}/{action}` | start / pause / resume / cancel / retry / cleanup |

### 创建任务

勾选图片与按来源筛选二选一。按图片 ID：

```json
{ "targetStorageId": "sto_DEST", "imageIds": ["img_A", "img_B"], "includeTrash": false }
```

按来源筛选：

```json
{
  "targetStorageId": "sto_DEST",
  "sourceStorageId": "local",
  "folderId": "fld_SOURCE",
  "includeChildren": false,
  "includeTrash": false
}
```

imageIds 每批最多 100 个，重复 ID 去重；筛选模式不受 100 张限制，使用数据库批量清单。文件夹筛选默认不含后代；回收站默认排除，包含时保留删除状态。目标须启用，来源可停用；已经在目标、正在处理、缩略图未就绪或被其他迁移占用的图片显示跳过原因。

### 响应与状态

摘要字段：id、target_id、target_name、state、selection、expires_at、created_at、total_count、success_count、failed_count、skipped_count、canceled_count、estimated_bytes、skipReasons、cleanup_state、retained_count、retained_bytes、error。estimated_bytes 为可迁移图片的当前结果加不同保留原图估算，不含缩略图；retained_bytes 为源副本实际对象大小，包含缩略图。明细字段包含 image_id、name、source_name、state、phase、estimated_bytes、attempts、error，不返回凭证。

任务状态：draft、queued、running、pausing、paused、canceling、canceled、completed、completed_with_errors、failed、expired。明细状态：draft、pending、copying、paused、committed、failed、skipped、canceled；phase 显示 copying/verifying/switching 等阶段。累计进度按已处理图片统计，不把临时字节算作成功。

### 确认与控制

以下示例假定已登录并保存 Cookie 到 `cookies.txt`，`CSRF` 为当前会话 token。将任务 ID 与存储 ID 替换为实际值。

```sh
curl -X POST 'http://localhost:9521/api/v1/admin/storage-migrations' \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"sourceStorageId":"local","targetStorageId":"sto_DEST"}'
# 检查返回的冻结清单和跳过原因，再确认执行。
curl -X POST 'http://localhost:9521/api/v1/admin/storage-migrations/mig_ID/start' \
  -b cookies.txt -H "X-CSRF-Token: $CSRF"
```

控制请求 200 仅确认状态或排队，不表示后台完成。pause/cancel 先中断 I/O，再进入 paused/canceled；取消不回滚已完成项，retry 只重试 failed 项。source 副本默认保留，只有终态任务可以 cleanup；cleanup_state 为 retained/cleaning/partial_failed/cleaned。清理会重新验证当前对象，目标不可用时保留源副本，活跃读取时延后删除；部分失败可再次 cleanup。

迁移只改变 storageId、对象位置及内部 storage_version；图片 ID、URL、内容、名称、权限、内容/整理/访问版本不变，因此原有效签名继续可用。图片 DTO 的 migrating 标记正在持锁；同图重新处理返回 409 IMAGE_MIGRATING。草稿过期、目标连接变化或状态冲突也返回 409。逻辑移动、AI 归档和权限修改不被迁移覆盖；彻底删除同时删除迁移副本。默认上传配置必须另行手动调整。

## 错误响应

JSON 错误使用统一结构，tus 协议错误可能为纯文本：

```json
{ "error": { "code": "ERROR_CODE", "message": "错误说明", "requestId": "请求 ID" } }
```

| HTTP 状态 | 常见含义                                 |
| --------- | ---------------------------------------- |
| 400       | 参数错误、循环目录、图片损坏或超像素限制 |
| 401       | 会话或 Key 缺失、失效                    |
| 403       | 操作范围不足、CSRF 或来源校验失败        |
| 404       | 不存在、无权发现或无随机候选             |
| 409       | 状态冲突、资源仍被引用、续传偏移冲突     |
| 413       | 文件大小超限                             |
| 415       | 不支持的格式或动画                       |
| 429       | 请求限流                                 |
| 460       | 分片摘要不符，确认偏移不推进             |
| 503       | 存储或签发暂时故障                       |
| 507       | 本地暂存空间不足                         |
