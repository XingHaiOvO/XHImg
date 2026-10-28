# API v1

基础路径 `/api/v1`。JSON 错误统一为 `{error:{code,message,requestId}}`。分页使用 `page`（从 1 开始）与 `limit`（默认 40，最大 100）。资源 ID 只用于定位，不代表授权。

## 授权

管理员：登录建立 HttpOnly、SameSite=Strict 会话；`GET /auth/me` 返回 CSRF token，所有管理写请求包含 `X-CSRF-Token`。`/admin/*` 不接受 API Key 替代管理员。

外部应用：`Authorization: Bearer xh_...`。权限为 `upload`、`read`、`private:read`、`random`；范围为 `all`、`folder`、`service`、`storage`。范围可授多条。文件夹授权默认只包含当前文件夹，`descendants:true` 才包含后代。图片上传权限不包含私有读取。存储范围只用于显式选择存储，不自动授予图片操作权限。

私有随机服务：需要 random 与服务范围（或对应文件夹服务的文件夹范围），读取私有候选还需 read、private:read 与图片文件夹范围。

## 上传

```sh
curl -X POST 'http://localhost:9521/api/v1/upload?folderId=fld_ID&visibility=public' \
  -H 'Authorization: Bearer xh_YOUR_KEY' -F 'file=@photo.png'
```

- `POST /upload`、`POST /folders/{folderId}/upload`：仅一个 multipart 文件。参数放在 URL：`folderId`、`visibility`、`storageId`。路径与查询文件夹冲突返回 400。默认未分类文件夹与 private；显式 storageId 还需存储授权。
- 响应 201：`{id,name,folderId,visibility,effectiveVisibility,storageId,format,mime,size,width,height,tags,description,createdAt,deletedAt,state,thumbnailState,url,thumbnailUrl}`。
- 原图地址为稳定逻辑地址。上传返回私有原图的裸地址不意味着可匿名访问；外部客户端可持 Key 请求，或在授权图片列表/随机 JSON 中取得短期签名 URL。

## 图片与文件夹查询

- `GET /folders/{id}/images`：有效公开文件夹可匿名访问，私有文件夹须授权。内部图片仍逐项过滤。支持分页、search、tag、sort（newest/oldest/name）。
- `GET /public/images`：仅公开图片，支持相同筛选，另有 folderId；不返回存储位置。
- `GET /public/folders`、`GET /public/services`、`GET /public/settings`：公开导航、服务卡片及站点名称描述。
- `GET /i/{id}`、`GET /t/{id}`：原图与缩略图。同样验证会话、Key 或 sig 查询参数。公开响应要求重新验证；私有响应 no-store。

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
