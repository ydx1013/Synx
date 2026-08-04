# GitHub 图床与孤儿图片清理设计

## 1. 目标

为 Synx 增加独立于笔记同步存储的 GitHub 图床。用户在 Synx 网页后台维护多个图库，在 Obsidian 插件中开启图床并固定选择默认图库。粘贴或拖入图片时，插件把图片交给 Worker，Worker 使用加密保存的 GitHub Token 上传，并返回可写入 Markdown 的链接。

首版同时提供保守的孤儿图片检查：只报告疑似未引用图片，用户勾选并二次确认后才删除，不做无人值守自动删除。

## 2. 范围与非目标

### 范围

- 网页后台创建、编辑、测试和移除多个 GitHub 图库。
- Worker 加密保存 GitHub Token，不向网页读取接口或插件返回 Token。
- 插件提供图床开关和默认图库下拉选择。
- 插件拦截 Markdown 编辑器中的图片粘贴和拖入。
- 公共仓库返回 GitHub Raw URL。
- 私有仓库写入稳定的 `synx-image://` 标识，由已登录的 Obsidian 和 Synx 网页鉴权渲染。
- 临时上传错误最多自动尝试 3 次；失败后保存本地附件并加入本机待上传队列。
- 下次启动重试成功后替换 Markdown 链接，在确认无其他引用后删除本地附件。
- 网页后台显示疑似孤儿图片并支持人工确认删除。

### 非目标

- 不把 GitHub 作为完整笔记同步存储。
- 不让图片先进入 Synx 正式 S3/WebDAV/OneDrive 提交历史再转存。
- 不提供公开访问私有图片的永久链接。
- 不自动删除疑似孤儿图片。
- 不迁移现有本地图片；首版只处理新粘贴和新拖入的图片。
- 不复制 NotePix 的 CDN 转换、批量迁移、右键删除等扩展功能。

## 3. 数据模型

新增 migration，建立 `image_galleries`：

| 字段 | 含义 |
|---|---|
| `id` | 图库 UUID |
| `user_id` | Synx 用户 ID |
| `name` | 用户可见名称 |
| `provider` | 首版固定为 `github` |
| `config` | AES 加密 JSON |
| `is_private` | 连接测试时由 GitHub API 确认 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

加密配置包含：

```ts
interface GitHubGalleryConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  folder: string;
}
```

列表接口只返回 `id/name/provider/owner/repo/branch/folder/isPrivate/createdAt`。详情接口同样不返回 Token，只返回 `hasToken: true`。编辑时 Token 留空代表沿用原 Token。

插件设置新增：

```ts
imageHostingEnabled: boolean;
imageGalleryId: string | null;
imageGalleryName: string | null;
```

插件本机状态新增 `pendingImageUploads`。该队列写入 `synx-state.json`，不进入可同步的 `data.json`：

```ts
interface PendingImageUpload {
  id: string;
  localPath: string;
  notePath: string;
  originalEmbed: string;
  galleryId: string;
  createdAt: number;
  startupAttempts: number;
  lastError?: string;
}
```

## 4. Worker API

### 图库管理

- `GET /api/image-galleries`
- `POST /api/image-galleries/test`
- `POST /api/image-galleries`
- `GET /api/image-galleries/:id`
- `PATCH /api/image-galleries/:id`
- `DELETE /api/image-galleries/:id`

测试和保存前，Worker 调用 GitHub 仓库接口验证：

- Token 有效；
- Token 对目标仓库至少有 Contents 读写权限；
- 分支存在；
- 仓库公开性可确认。

推荐使用 GitHub fine-grained PAT，仅授权目标仓库的 Contents Read and write。图库删除只移除 Synx 配置，不删除 GitHub 文件。

### 上传

`POST /api/image-galleries/:id/images`

请求为二进制图片，文件名和 MIME 类型通过受控请求头传递。Worker 必须：

1. 校验当前用户拥有图库；
2. 限制 MIME 为 PNG/JPEG/GIF/WebP/SVG/AVIF；
3. 首版限制单图不超过 20 MiB；
4. 生成服务端文件名，格式为 `YYYY/MM/<uuid>.<ext>`；
5. 将完整目标路径限制在配置的 `folder` 下；
6. Base64 编码后调用 GitHub Contents API；
7. 返回图片引用。

公共仓库响应：

```json
{
  "image": {
    "galleryId": "...",
    "path": "images/2026/08/id.png",
    "visibility": "public",
    "markdownUrl": "https://raw.githubusercontent.com/owner/repo/branch/images/2026/08/id.png"
  }
}
```

私有仓库响应中的 `markdownUrl` 为：

```text
synx-image://<gallery-id>/<percent-encoded-path>
```

### 私有图片读取

`GET /api/image-galleries/:id/images/content?path=...`

请求必须携带 Synx JWT。Worker 校验图库归属并限定路径位于图库目录内，再用 GitHub Token读取内容。响应转发正确的 `Content-Type`，使用短期私有缓存或 `Cache-Control: private`，不得把 GitHub Token、上游鉴权头或完整 GitHub API URL写入日志。

### 孤儿列表与删除

- `POST /api/image-galleries/:id/orphans/scan`
- `POST /api/image-galleries/:id/orphans/delete`

扫描请求包含当前 Vault 中解析到的该图库引用路径集合。Worker 只列出配置目录下由 Synx 命名规则创建的图片，排除 30 天内上传的文件，再计算差集。响应明确命名为“疑似未使用图片”。

删除请求包含用户勾选的路径和扫描得到的 SHA。Worker重新读取最新 SHA，确保路径仍位于图库目录且仍符合 Synx 命名规则，然后通过 GitHub Contents API 创建删除提交。SHA 已变化时拒绝删除，要求重新扫描。

图库可能被外部网页或其他 Vault 引用，因此删除始终需要网页端二次确认。

## 5. 插件上传与降级流程

### 正常流程

1. 仅在 `imageHostingEnabled=true`、用户已登录且已选择图库时拦截图片粘贴/拖入。
2. 阻止 Obsidian 默认附件插入。
3. 在光标位置插入临时占位文本。
4. 调用 Worker 上传接口。
5. 成功后用标准 Markdown 图片语法替换占位文本。
6. 公共图库写入 Raw URL；私有图库写入 `synx-image://`。

关闭开关、未登录或未选择图库时，不拦截事件，完全沿用 Obsidian 默认附件行为。

### 三次尝试

一次用户操作最多执行 3 次总尝试，采用短退避。仅以下临时错误重试：

- 网络失败或超时；
- HTTP 429；
- GitHub/Worker 5xx。

401、403、404 图库不存在、文件类型不支持、文件过大等确定性错误不做连续重试。

### 本地降级

三次仍失败或遇到确定性错误时：

1. 使用 Obsidian 附件 API 把原始图片保存到 Vault；
2. 把占位文本替换为本地附件链接；
3. 把本地路径、笔记路径、精确嵌入文本和图库 ID 写入本机待上传队列；
4. 显示“已暂存本地，将在下次启动重试”。

必须先确认本地附件写入和 Markdown 替换成功，才能移除内存中的原始图片数据。

### 启动重试

布局就绪且用户登录后处理队列。每项再次最多尝试 3 次：

- 成功：仅当目标笔记仍包含记录的本地嵌入文本时，替换为远程链接；保存成功后扫描整个 Vault 对该本地路径的引用，无其他引用才删除本地附件；随后移除队列项。
- 笔记或嵌入文本已改变：保留本地文件和队列项，提示用户手动处理，不做模糊替换。
- 再次失败：停止自动重试，保留本地图片和链接，在 Notice 与同步详情中显示原因并提供手动重试入口。

队列按 `localPath + notePath` 去重，避免同一设备重复上传。

## 6. 私有图片渲染

### Obsidian

- Reading View：Markdown post processor 识别 `synx-image://`。
- Live Preview：CodeMirror 装饰器识别同一标识。
- 插件使用当前 Synx JWT 请求 Worker 内容接口，响应转换为内存 Blob URL。
- Blob URL 按图库 ID 和路径缓存，插件卸载时统一 revoke。
- 未登录、无权限或图库失效时显示带错误说明的占位元素，不把错误响应当图片。

### Synx 网页

网页 Markdown 渲染器识别 `synx-image://`，通过现有 API Client 携 JWT 获取 Blob，并创建临时 Object URL。组件卸载时释放 URL。

普通浏览器 `<img src>` 不直接使用鉴权接口，因为它无法可靠添加 `Authorization` 头。

## 7. 网页与插件交互

### 网页后台

设置侧栏新增“图片图库”：

- 图库列表；
- 添加、编辑、测试、移除；
- 显示公开/私有状态；
- “检查未使用图片”入口；
- 扫描结果表格与二次确认删除。

Token 输入框仅在创建或轮换时填写，保存后永不回显。

### Obsidian 设置

新增“图片图床”区域：

- `自动上传粘贴/拖入图片` 开关；
- `默认图库` 下拉框，行为与当前主存储下拉框一致；
- 待上传数量；
- `立即重试待上传图片` 按钮。

图库切换只影响后续新图片及新建的失败队列项，不改写已有远程链接。

## 8. 安全边界

- GitHub Token 使用现有 `ENCRYPTION_KEY` 和 AES-GCM 加密后存 D1。
- Token 永不返回插件、网页读取接口或日志。
- 所有图库、上传、读取、扫描和删除接口都校验 Synx 用户归属。
- 服务端生成文件路径；客户端不能指定任意仓库路径。
- 私有图片读取必须限制在配置目录中。
- 上传限制 MIME、扩展名和 20 MiB 大小。
- SVG 响应使用安全的图片 Content-Type；网页不得把 SVG 文本注入 DOM。
- GitHub 限流信息转换为稳定错误码，插件据此决定是否重试。
- 公共 Raw URL 本质公开，设置页必须明确提示。

## 9. 错误码

| HTTP | code | 处理 |
|---:|---|---|
| 400 | `INVALID_GALLERY_CONFIG` | 用户修正配置 |
| 400 | `UNSUPPORTED_IMAGE_TYPE` | 本地降级，不重试 |
| 401 | `UNAUTHORIZED` | 本地降级并提示登录 |
| 403 | `GITHUB_FORBIDDEN` | 本地降级并提示权限 |
| 404 | `GALLERY_NOT_FOUND` | 本地降级并提示重新选择 |
| 409 | `IMAGE_CHANGED` | 重新扫描后再删除 |
| 413 | `IMAGE_TOO_LARGE` | 本地降级，不重试 |
| 429 | `GITHUB_RATE_LIMITED` | 计入临时重试 |
| 502 | `GITHUB_UPSTREAM_FAILED` | 计入临时重试 |

## 10. 测试与验收

### Worker

- 图库 CRUD 不泄露 Token，跨用户访问返回 403/404。
- 创建和测试可识别公开/私有仓库、错误 Token、无写权限与不存在分支。
- 上传只允许受支持图片和配置目录，公共/私有返回正确链接格式。
- 私有读取必须鉴权且不能跨图库、跨目录读取。
- 孤儿扫描只处理 Synx 命名图片并排除 30 天保护期。
- 删除对路径和 SHA 做二次校验。
- GitHub 429/5xx 映射为稳定错误码。

### 插件

- 开关关闭、未登录或无图库时不拦截 Obsidian 默认行为。
- 公共与私有上传成功后正确替换占位文本。
- 临时错误总共尝试 3 次，确定性错误不重试。
- 失败后本地附件、Markdown 链接和队列三者一致。
- 启动重试成功后先改链接，再检查引用并删除本地文件。
- 文本已改变时不做模糊替换、不删除文件。
- 队列不会写入可同步的插件设置。
- Reading View 与 Live Preview 可显示私有图片并释放 Blob URL。

### 网页

- 多图库列表、创建、编辑、测试和移除流程正常。
- Token 保存后不回显。
- 私有图片携 JWT 获取并显示，退出登录后不可获取。
- 孤儿列表默认不选中，删除需要二次确认。

### 端到端验收

1. 配置一个公共仓库和一个私有仓库。
2. 插件分别选择并粘贴图片，确认公共 Raw URL 和私有 `synx-image://` 正确。
3. 私有图片在 Obsidian Reading View、Live Preview 和 Synx 网页均可显示。
4. 模拟连续网络失败，确认三次后本地降级；重启恢复网络后确认自动替换且安全删除本地附件。
5. 扫描孤儿图片，确认 30 天内图片不出现，人工删除后 GitHub 产生删除提交。

## 11. 实施拆分

为降低三端同时变更风险，按以下顺序交付：

1. 共享契约、D1 migration、Worker 图库 CRUD/测试/上传/私有读取。
2. 网页图库管理界面。
3. 插件开关、图库选择、粘贴/拖入、重试与本地降级队列。
4. Obsidian 与网页私有图片渲染。
5. 孤儿扫描和人工删除。

每一步完成类型检查与相关单元测试，最终执行全仓 `npm run typecheck`、`npm test` 和 `npm run build`。