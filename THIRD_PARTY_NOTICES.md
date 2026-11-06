# 来源与许可证声明

本文说明 XHImg 应用源码、功能参考项目及第三方依赖的来源与许可证边界。

[项目介绍](README.md) · [应用许可证](LICENSE) · [文档中心](docs/README.md)

## XHImg 应用源码

Copyright (C) 2026 XingHai

XHImg 应用源码采用 **GNU General Public License version 3 only**，SPDX 标识为 `GPL-3.0-only`，完整条款见 [LICENSE](LICENSE)。

XHImg 为独立实现。下述参考项目未作为源码或素材并入本项目；第三方依赖则通过包管理器引入，并保留各自许可证。

## 功能与架构参考

| 项目      | 参考内容                                 | 本地参考版本的许可证         | 使用情况                             |
| --------- | ---------------------------------------- | ---------------------------- | ------------------------------------ |
| EasyImg   | 轻量图床、图片处理与上传流程             | Apache-2.0                   | 作为功能参考，未复制源码或素材       |
| PixelPunk | 文件夹组织、服务层与存储适配器的模块划分 | PolyForm Noncommercial 1.0.0 | 作为功能与结构参考，未复制源码或素材 |

以上许可证信息来自开发时使用的参考项目副本，不代表上游后续版本的授权状态。参考项目的许可证不替代 XHImg 的许可证，也不因被列入本声明而适用于 XHImg 应用源码。

## 界面组件来源

Button、Dialog 等基础组件参考 shadcn/ui 的组合方式，使用 Radix UI、class-variance-authority、clsx 和 tailwind-merge 实现。应用样式由本项目编写。

shadcn/ui 在此表示组件组织方式的参考；实际通过包管理器引入的组件与工具列于下表。

## 直接运行依赖

下表按功能整理直接运行依赖。许可证标识依据本次核对时已安装包的 `package.json`；具体解析版本以 [pnpm-lock.yaml](pnpm-lock.yaml) 为准。

| 用途                | 包                                                    | 许可证标识 |
| ------------------- | ----------------------------------------------------- | ---------- |
| 页面渲染与路由      | `react`、`react-dom`、`react-router-dom`              | MIT        |
| 无障碍组件基础      | `@radix-ui/react-dialog`、`@radix-ui/react-slot`      | MIT        |
| 组件样式变体        | `class-variance-authority`                            | Apache-2.0 |
| 类名组合与合并      | `clsx`、`tailwind-merge`                              | MIT        |
| 图标                | `lucide-react`                                        | ISC        |
| 浏览器摘要计算      | `@noble/hashes`                                       | MIT        |
| 浏览器断点续传      | `tus-js-client`                                       | MIT        |
| HTTP 服务           | `fastify`                                             | MIT        |
| Cookie 与跨域       | `@fastify/cookie`、`@fastify/cors`                    | MIT        |
| 文件上传与静态资源  | `@fastify/multipart`、`@fastify/static`               | MIT        |
| 接口清单生成        | `@fastify/swagger`                                    | MIT        |
| 服务端断点续传      | `@tus/server`、`@tus/file-store`                      | MIT        |
| SQLite 访问         | `better-sqlite3`                                      | MIT        |
| 数据库查询          | `drizzle-orm`                                         | Apache-2.0 |
| S3 对象存储与预签名 | `@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner` | Apache-2.0 |
| 图片处理            | `sharp`                                               | Apache-2.0 |
| 数据校验            | `zod`                                                 | MIT        |

本表不包含开发工具、类型定义、传递依赖及原生组件的完整清单。尤其是图片处理与数据库相关的原生组件，其许可证不能仅由 JavaScript 包的标识推断。

Docker 运行镜像通过 Debian 的 `ffmpeg` 软件包提供 FFmpeg 和 FFprobe，分别用于视频封面生成和上传校验。该软件包独立于 pnpm 依赖清单，版权和许可信息见镜像内软件包随附文件。[Dockerfile](Dockerfile)

## 版本与许可文件

- 直接依赖声明位于根目录、`apps/web/`、`apps/server/` 和 `packages/shared/` 的 `package.json`。
- [pnpm-lock.yaml](pnpm-lock.yaml) 记录解析版本与依赖关系。
- 安装包内的 `LICENSE`、`COPYING`、`NOTICE` 等文件及版权声明保留各组件的具体许可信息。
- 应用的 GPL-3.0-only 许可不替代第三方组件的条款。本声明也不替代依赖及原生组件附带的完整许可文件。

## 品牌与素材

本声明不授予第三方项目名称、商标、Logo 或素材的额外使用权。用户上传的图片及自行配置的站点 Logo、背景图片不因存入 XHImg 而自动采用应用源码的许可证，其权利归属与使用授权由对应内容决定。
