# API v1

基础路径 `/api/v1`。JSON 错误统一为 `{error:{code,message,requestId}}`。分页使用 `page`（从 1 开始）与 `limit`（默认 40，最大 100）。资源 ID 只用于定位，不代表授权。

## 授权

管理员：登录建立 HttpOnly、SameSite=Strict 会话；`GET /auth/me` 返回 CSRF token，所有管理写请求包含 `X-CSRF-Token`。`/admin/*` 不接受 API Key 替代管理员。

外部应用：`Authorization: Bearer xh_...`。权限为 `upload`、`read`、`private:read`、`random`、`ai:classify`；范围为 `all`、`folder`、`service`、`storage`。范围可授多条。文件夹授权默认只包含当前文件夹，`descendants:true` 才包含后代。图片上传权限不包含私有读取。存储范围只用于显式选择存储，不自动授予图片操作权限。AI 还要求当前及候选目标文件夹的上传范围，旧密钥不自动增加权限。

私有随机服务：需要 random 与服务范围（或对应文件夹服务的文件夹范围），读取私有候选还需 read、private:read 与图片文件夹范围。

## 上传

```sh
curl -X POST 'http://localhost:9521/api/v1/upload?folderId=fld_ID&visibility=public' \
  -H 'Authorization: Bearer xh_YOUR_KEY' -F 'file=@photo.png'
```

- `POST /upload`、`POST /folders/{folderId}/upload`：仅一个 multipart 文件。参数放在 URL：`folderId`、`visibility`、`storageId`。路径与查询文件夹冲突返回 400。默认未分类文件夹与 private；显式 storageId 还需存储授权。
- 响应 201：`{id,name,folderId,visibility,effectiveVisibility,storageId,format,mime,size,width,height,tags,description,createdAt,deletedAt,state,thumbnailState,url,thumbnailUrl}`。
- 默认上限100MiB，可由管理员调低；4000万像素，仅静态 JPG/PNG/WebP。可选查询 `processing` 为 JSON 策略，`classify=true|false`。策略字段：enabled、compress、targetFormat（keep/jpg/png/webp）、quality（1–100，默认80）、maxWidth/maxHeight（null不限制）、preserveOriginal（默认true）。只覆盖提交字段，优先级请求 > 文件夹 > 系统。
- 启用处理或分类时响应202，保留图片字段并增加 `uploadId`、`imageId`、`statusUrl`。传输成功不代表已发布；查询状态至ready。处理或新图分类未完成时，非管理员原图、缩略图、查询与随机访问均隔离。
- 原图地址为稳定逻辑地址。上传返回私有原图的裸地址不意味着可匿名访问；外部客户端可持 Key 请求，或在授权图片列表/随机 JSON 中取得短期签名 URL。

## 图片与文件夹查询

- `GET /folders/{id}/images`：有效公开文件夹可匿名访问，私有文件夹须授权。内部图片仍逐项过滤。支持分页、search、tag、sort（newest/oldest/name）。
- `GET /public/images`：仅公开图片，支持相同筛选，另有 folderId；不返回存储位置。
- `GET /public/folders`、`GET /public/services`、`GET /public/settings`：公开导航、服务卡片及站点名称描述。
- `GET /i/{id}`、`GET /t/{id}`：当前版本与缩略图。同样验证会话、Key 或 sig 查询参数。公开响应要求重新验证；私有响应 no-store。源文件只允许管理员从专用下载接口获取。

## 随机图

- 全站：`GET /random`
- 文件夹：`GET /folders/{id}/random`
- 自定义：`GET /random/{serviceId}`

`mode=image|redirect|json`，默认采用服务配置（初始为 image）。image 返回实际二进制；redirect 为 302；json 返回 `{id,url,thumbnailUrl,width,height,format,size}`。私有 URL 签名默认五分钟、原图缩略图分开授权，检查当前图片权限、签发会话/Key、服务启用状态及来源规则。密钥撤销或图片权限版本改变立即失效。

公开服务即使使用管理员会话调用，也只选公开图片。筛选先于随机，无候选时 404；对象暂时不可用时 503；缺失对象标为 missing，并最多三次重选。随机响应 no-store，可连续重复。

## 管理操作

| 资源                                | 操作                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `/admin/folders`                    | GET 列表含统计、POST 创建                                                                   |
| `/admin/folders/{id}`               | PATCH 编辑/移动/权限/封面/排序，DELETE 删除空文件夹                                         |
| `/admin/images`                     | GET 列表，trash=true 查询回收站                                                             |
| `/admin/images/{id}`                | PATCH 名称/归属/自身权限/标签/描述，DELETE 软删除                                           |
| `/admin/images/batch`               | POST `{ids,action,folderId?,visibility?}`，action=delete/restore/move/visibility，最多100项 |
| `/admin/images/{id}/restore`        | POST 恢复                                                                                   |
| `/admin/images/{id}/permanent`      | DELETE 排队彻底删除，需先软删除                                                             |
| `/admin/images/{id}/check`          | POST 检查恢复缺失对象                                                                       |
| `/admin/images/{id}/sign`           | POST 获取原图及缩略图临时链接                                                               |
| `/admin/storage-backends`           | GET 脱敏配置/统计、POST 创建                                                                |
| `/admin/storage-backends/{id}`      | PATCH 修改状态/默认值/连接，DELETE 无引用配置                                               |
| `/admin/storage-backends/{id}/test` | POST 测试存储连接                                                                           |
| `/admin/api-keys`                   | GET 脱敏列表、POST 创建并仅一次返回完整密钥                                                 |
| `/admin/api-keys/{id}`              | DELETE 撤销                                                                                 |
| `/admin/random-services`            | GET 配置/统计、POST 创建                                                                    |
| `/admin/random-services/{id}`       | PUT 完整更新、DELETE 删除非全站服务                                                         |
| `/admin/settings`                   | GET/PUT title、description、allowedOrigins                                                  |
| `/admin/password`                   | PUT `{currentPassword,password}` 并注销全部会话                                             |
| `/admin/overview`                   | GET 基本统计、近期图片与后台任务                                                            |
| `/admin/jobs/{id}/retry`            | POST 重试失败任务                                                                           |

文件夹创建字段：name、parentId、description、visibility、storageId、sortOrder、coverId。PATCH 仅修改显式提交字段。

创建密钥：`{name,permissions:[...],grants:[{kind,resourceId,descendants}],expires:null或毫秒时间戳,rateLimit:120}`。

密钥和随机图服务的 `rateLimit` 均接受 0–10000 的整数，`0` 表示不限制对应层级的每分钟请求次数；正数按原规则限流。两者独立生效，例如服务设为0，但使用的密钥设为120，仍受该密钥上限约束。默认值不变：密钥120、服务60。

随机服务：`{kind:'folder'|'custom',folderId:null或ID,name,description,visibility,enabled,mode,includeChildren,rateLimit,rules:[{kind,resourceId,descendants}]}`。规则种类 source_folder、exclude_folder、exclude_image、tag。多个来源取并集，排除条件及全部标签条件取交集。全站配置通过更新内置 global 服务，不重复创建。

S3：`{name,type:'s3',config:{endpoint,region,bucket,accessKeyId,secretAccessKey,forcePathStyle},enabled,isDefault}`。local 不接受客户端绝对路径，统一位于持久化目录下。

## 常见错误

400 参数错误或循环目录；401 会话/Key 缺失或失效；403 缺少操作范围或 CSRF 校验失败；404 不存在、无权发现或无随机候选；409 非空目录/仍被引用/状态冲突；413 超限；415 非支持格式或动画；429 限流；503 存储故障。

机器可读的接口清单：`GET /api/v1/openapi.json`。浏览器调用示例也位于 `/docs`。

## 断点续传

`POST /resumable` 创建，`HEAD/PATCH/DELETE /resumable/{uploadId}` 查询偏移、追加、取消。每次检查身份、归属及当前授权；管理员写入仍需 CSRF。协议版本 `Tus-Resumable: 1.0.0`。声明 `Upload-Length`，元数据 `filename`、`sha256` 必填，各值按 tus Base64 编码；可选 folderId、storageId、visibility、processing(JSON)、classify。

每片最多4MiB，同一文件顺序上传。PATCH 使用 `application/offset+octet-stream`、`Upload-Offset` 和自定义 `X-Chunk-SHA256`（本片SHA-256十六进制）。校验不符460，偏移不推进；偏移冲突409。**未实现或宣称 tus Checksum 扩展。** tus 协议错误可能为纯文本；业务 JSON 接口沿用统一错误格式。

```sh
# FILE_SHA256 是完整文件摘要，下面命令通过 stdin 生成 Base64 元数据。
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

创建返回201+Location，PATCH返回204+Upload-Offset。完整文件收齐后异步校验与处理；重复完成不会创建第二张图片。`GET /uploads/{uploadId}` 返回 uploadId、imageId、state、offset、length、expiresAt、error、image，仅归属者或管理员。`DELETE /uploads/{uploadId}` 取消未发布任务；`POST /uploads/{uploadId}/retry` 重试已收齐文件的失败校验、处理或分类。已发布图片使用回收站。

浏览器采用 tus-js-client，自定义 HttpStack 在每片发送前增量计算摘要。Worker 计算整文件指纹，IndexedDB 保存恢复 URL、指纹、大小及选项；刷新需重新选择原文件。默认24小时过期、20个未完成传输、2GiB声明量，磁盘不足507。跨域调用须先配置来源白名单。

## P1 管理接口

| 接口                                   | 用途                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET/PUT /admin/processing`            | `{policy,maxUploadMB}`；大小1–100MiB，策略只影响后续任务                                      |
| `GET /public/upload-config`            | 当前最大上传大小                                                                              |
| `POST /admin/images/{id}/reprocess`    | `{processing?:策略}`，既有当前版本继续可用，成功后切换                                        |
| `GET /admin/images/{id}/original`      | 下载保留的源文件；未保留时下载当前文件；仅管理员、no-store                                    |
| `POST /admin/images/{id}/use-original` | 处理失败新图使用原文件结束任务；已处理但分类未完成时使用当前版本结束整理                      |
| `GET/PUT /admin/ai`                    | 配置启用、baseUrl、model、apiKey、prompt、rules、folderIds、timeoutSeconds、retries、jsonMode |
| `POST /admin/ai/test`                  | 内置蓝色测试图验证视觉输入和分类输出；使用已保存配置                                          |
| `GET /admin/classification`            | 分页；status=all/pending/running/completed/unmatched/failed/canceled                          |
| `POST /admin/classification`           | `{ids:[...],skipUnavailable?:false}`，最多100张，返回queued、skipped，重复ID仅计一次          |

文件夹 PATCH 增加 `processingPolicy`（null 继承）、`aiEnabled`。AI 密钥省略保持、空字符串清除，读取只返回hasKey；加密存储。默认60秒超时、最多额外重试2次，默认不发送response_format。模型仅返回 `{"folderId":"候选ID"}` 或 `{"folderId":null}`；无效/越权结果失败，永不执行模型指令。分类不迁移物理对象。

图片 DTO 增加 processingStatus、classificationStatus、hasOriginal、publicationHold。处理或 AI 失败可重试，人工移动会撤销旧整理版本。存储统计计入不同的当前结果与保留原图，不含缩略图。

手动整理在智能整理的“手动任务”页签中选择来源文件夹与已有图片，支持名称/标签搜索、分页勾选和每批100张；来源不包含子文件夹。执行时发送 `skipUnavailable:true`，跳过提交时已删除、已彻底删除、正在处理/分类或不可用的图片，并返回实际排队和跳过数量。既有公开图片排队期间保持当前访问，归档后仍按自身和目标文件夹权限判定。

适配依据：[tus FileStore 文档](https://raw.githubusercontent.com/tus/tus-node-server/main/packages/file-store/README.md)、[noble-hashes 增量接口](https://github.com/paulmillr/noble-hashes)、[Sharp 输出参数](https://sharp.pixelplumbing.com/api-output/)。
