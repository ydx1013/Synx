# 实施计划：GitHub 图床与孤儿图片清理

## 概览

在现有 Synx Worker、网页和 Obsidian 插件中增加独立 GitHub 图床。GitHub Token 只在 Worker 加密保存；插件按设置中的默认图库上传新粘贴/拖入图片。公共仓库写入 Raw URL，私有仓库写入 `synx-image://` 并由登录客户端鉴权渲染。失败最多尝试 3 次，随后安全保存本地并在下次启动重传。孤儿清理只报告疑似未引用图片并由用户确认删除。

设计依据：[GitHub 图床设计](../docs/superpowers/specs/2026-08-04-github-image-hosting-design.md)。

## 架构决策

- 图库与笔记同步存储分离，不把 GitHub 接入 `WorkerFs`。
- 先固定共享契约，再按 Worker → 网页 → 插件 → 私有渲染 → 孤儿清理交付。
- Token 复用 Worker 的 AES-GCM 加密能力，读取接口永不回显。
- 插件失败队列只存 `synx-state.json`，避免多设备重复上传。
- 不做自动孤儿删除；30 天保护期后仍需人工勾选和二次确认。

## 依赖关系

```text
共享契约 + D1 migration
  └─ Worker 图库 CRUD/测试
       └─ Worker 上传/私有读取
            ├─ 网页图库管理
            ├─ 插件图库选择/上传
            │    └─ 失败队列/启动重试
            └─ 私有图片双端渲染
                 └─ 孤儿扫描/人工删除
```

## Phase 1：Worker 基础与上传闭环

### 任务 1：共享契约与图库表

**说明：** 定义图库 DTO、请求响应、错误码和 API 路径，新增 `image_galleries` migration。

**验收标准：**
- 图库 summary/detail 不包含明文 Token。
- migration 包含用户外键和用户索引。
- shared 类型检查通过。

**验证：** `npm run typecheck -w @synx/shared`

**依赖：** 无

**可能涉及：**
- `packages/shared/src/api.ts`
- `packages/shared/src/types.ts`
- `packages/shared/src/index.ts`
- `packages/worker/migrations/0005_image_galleries.sql`

### 任务 2：GitHub 客户端与配置校验

**说明：** 新建小型 GitHub 图库客户端，封装仓库检查、Contents 上传/读取、目录树和删除；先写失败测试。

**验收标准：**
- 正确编码 owner/repo/branch/path，映射 401/403/404/429/5xx。
- 可识别仓库公开性、分支存在性和 push 权限。
- 日志和错误不包含 Token。

**验证：** `npm test -w @synx/worker -- githubGallery.test.ts`

**依赖：** 任务 1

**可能涉及：**
- `packages/worker/src/services/githubGallery.ts`
- `packages/worker/src/services/githubGallery.test.ts`

### 任务 3：图库 CRUD 与连接测试

**说明：** 实现用户隔离的图库管理路由，配置加密保存，编辑留空 Token 时沿用旧值。

**验收标准：**
- 支持列表、详情、创建、编辑、测试、移除。
- 跨用户读取和修改被拒绝。
- Token 保存后永不回显；删除配置不删除 GitHub 文件。

**验证：** `npm test -w @synx/worker -- imageGalleries.test.ts`

**依赖：** 任务 2

**可能涉及：**
- `packages/worker/src/routes/imageGalleries.ts`
- `packages/worker/src/routes/imageGalleries.test.ts`
- `packages/worker/src/index.ts`

### 任务 4：图片上传与私有内容读取

**说明：** 实现二进制上传、服务端路径生成、公共/私有引用返回和私有图片代理读取。

**验收标准：**
- 仅接受规定图片类型且不超过 20 MiB。
- 公共仓库返回 Raw URL；私有仓库返回 `synx-image://`。
- 私有读取必须鉴权、校验图库归属并限制在配置目录。

**验证：** `npm test -w @synx/worker -- imageGalleries.test.ts`

**依赖：** 任务 3

**可能涉及：**
- `packages/worker/src/routes/imageGalleries.ts`
- `packages/worker/src/routes/imageGalleries.test.ts`
- `packages/worker/src/index.ts`

### Checkpoint 1

- `npm run typecheck -w @synx/shared`
- `npm run typecheck -w @synx/worker`
- `npm test -w @synx/worker`

## Phase 2：图库管理网页

### 任务 5：网页图库 API Client

**说明：** 接入共享契约，实现图库 CRUD、测试和后续二进制读取方法。

**验收标准：**
- API Client 覆盖图库管理全部接口。
- 私有图片读取携带 JWT 并返回 Blob。
- API Client 单元测试通过。

**验证：** `npm test -w @synx/web -- client.test.ts`

**依赖：** 任务 4

**可能涉及：**
- `packages/web/src/api/queries.ts`
- `packages/web/src/api/client.ts`
- `packages/web/src/api/client.test.ts`

### 任务 6：图库列表和配置表单

**说明：** 在设置中新增“图片图库”导航、列表、添加/编辑/测试/移除页面，遵循现有存储管理样式。

**验收标准：**
- 可管理多个图库并展示公开/私有状态。
- Token 编辑时留空表示不轮换，已保存值不回显。
- 公共图库风险和 fine-grained PAT 权限说明清晰。

**验证：** `npm test -w @synx/web`、`npm run typecheck -w @synx/web`

**依赖：** 任务 5

**可能涉及：**
- `packages/web/src/settings/SettingsPage.tsx`
- `packages/web/src/App.tsx`
- `packages/web/src/styles/globals.css`
- `packages/web/src/App.test.tsx`

### Checkpoint 2

- Worker 和 Web 测试通过。
- Web 构建通过。
- 手工确认 Token 不出现在列表、详情和浏览器响应中。

## Phase 3：插件上传与失败恢复

### 任务 7：插件设置和图库选择

**说明：** 增加图床开关、图库 ID/名称设置和与主存储相同的下拉选择。

**验收标准：**
- 默认关闭，不改变现有用户行为。
- 登录后可拉取图库并固定选择一个默认图库。
- 图库切换仅影响后续上传。

**验证：** `npm test -w @synx/plugin -- settings.test.ts workerClient.test.ts`

**依赖：** 任务 4

**可能涉及：**
- `packages/plugin/src/settings.ts`
- `packages/plugin/src/settings.test.ts`
- `packages/plugin/src/settingsTab.ts`
- `packages/plugin/src/workerClient.ts`
- `packages/plugin/src/workerClient.test.ts`

### 任务 8：粘贴/拖入上传闭环

**说明：** 提取独立图片上传控制器，拦截图片事件、插入唯一占位符、调用 Worker，并精准替换 Markdown。

**验收标准：**
- 开关关闭、未登录或未选图库时不拦截默认行为。
- 成功时公共/私有链接均正确插入。
- 临时错误总尝试 3 次；确定性错误不做连续重试。

**验证：** `npm test -w @synx/plugin -- imageUpload.test.ts`

**依赖：** 任务 7

**可能涉及：**
- `packages/plugin/src/imageUpload.ts`
- `packages/plugin/src/imageUpload.test.ts`
- `packages/plugin/src/main.ts`

### 任务 9：本地降级队列与启动重试

**说明：** 上传失败后按 Obsidian 附件规则落盘，记录本机队列；启动重试成功后安全替换和清理。

**验收标准：**
- 本地附件、Markdown 嵌入和队列写入保持原子顺序。
- 队列只写本机状态，按本地路径和笔记路径去重。
- 成功后先替换链接，再扫描引用；无其他引用才删本地文件。
- 文本已变化或再次失败时保留文件并提示，支持手动重试。

**验证：** `npm test -w @synx/plugin -- pendingImageUploads.test.ts`

**依赖：** 任务 8

**可能涉及：**
- `packages/plugin/src/pendingImageUploads.ts`
- `packages/plugin/src/pendingImageUploads.test.ts`
- `packages/plugin/src/main.ts`
- `packages/plugin/src/settingsTab.ts`

### Checkpoint 3

- 插件单元测试与类型检查通过。
- 手工模拟 5xx、403 和重启恢复，确认不丢图、不误删。

## Phase 4：私有渲染与孤儿清理

### 任务 10：Obsidian 私有图片渲染

**说明：** Reading View 和 Live Preview 识别 `synx-image://`，鉴权获取并缓存 Blob URL。

**验收标准：**
- 两种视图均可显示私有图片。
- 未登录/无权限时显示错误占位。
- 插件卸载时释放全部 Object URL。

**验证：** `npm test -w @synx/plugin -- privateImage.test.ts`

**依赖：** 任务 7、任务 4

**可能涉及：**
- `packages/plugin/src/privateImage.ts`
- `packages/plugin/src/privateImage.test.ts`
- `packages/plugin/src/main.ts`

### 任务 11：Synx 网页私有图片渲染

**说明：** 网页 Markdown 渲染器解析 `synx-image://`，携 JWT 获取 Blob 并管理 Object URL 生命周期。

**验收标准：**
- 已登录用户可看自己图库图片。
- 退出登录或无权限不能读取。
- 组件卸载时释放 Object URL。

**验证：** `npm test -w @synx/web -- NotesPage.test.tsx`

**依赖：** 任务 5

**可能涉及：**
- `packages/web/src/notes/NotesPage.tsx`
- `packages/web/src/notes/privateImage.ts`
- `packages/web/src/notes/privateImage.test.ts`

### 任务 12：Worker 孤儿扫描和安全删除

**说明：** 根据插件提交的引用集合计算疑似孤儿，应用 30 天保护期，并以最新 SHA 删除用户确认项。

**验收标准：**
- 只处理图库目录内符合 Synx 命名规则的图片。
- 30 天内图片不进入结果。
- 路径或 SHA 变化时拒绝删除并要求重扫。

**验证：** `npm test -w @synx/worker -- imageGalleries.test.ts`

**依赖：** 任务 4

**可能涉及：**
- `packages/worker/src/routes/imageGalleries.ts`
- `packages/worker/src/routes/imageGalleries.test.ts`
- `packages/worker/src/services/githubGallery.ts`

### 任务 13：引用收集与网页人工清理

**说明：** 插件扫描 Markdown、Canvas 和 HTML 图片引用并提交；网页显示疑似孤儿、默认不选中并二次确认删除。

**验收标准：**
- 插件只提交规范化的图库路径，不上传笔记正文。
- 网页清楚标记“疑似未使用”和 30 天保护规则。
- 删除必须显式勾选并二次确认。

**验证：** `npm test -w @synx/plugin -- imageReferences.test.ts`、`npm test -w @synx/web`

**依赖：** 任务 12、任务 6

**可能涉及：**
- `packages/plugin/src/imageReferences.ts`
- `packages/plugin/src/imageReferences.test.ts`
- `packages/plugin/src/settingsTab.ts`
- `packages/web/src/settings/SettingsPage.tsx`
- `packages/web/src/api/queries.ts`

### Checkpoint 4：完整验收

- `npm run typecheck`
- `npm test --workspaces --if-present`
- `npm run build`
- 真实公共/私有 GitHub 仓库完成上传、渲染、失败恢复与人工删除。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Worker 二进制/Base64 内存放大 | 高 | 首版单图限制 20 MiB；超限直接本地降级 |
| 私有链接无法由普通 `<img>` 鉴权 | 高 | 双端 fetch Blob，不把 JWT 放 URL |
| 多设备或外部网站引用导致误判孤儿 | 高 | 30 天保护、仅疑似报告、人工确认、Git SHA 二次校验 |
| Markdown 在重试期间被编辑 | 高 | 精确匹配原嵌入；不做模糊替换，不删除本地文件 |
| GitHub 限流或权限变化 | 中 | 稳定错误码、三次临时重试、本地降级和显式提示 |
| Token 泄漏 | 高 | Worker AES-GCM 加密、永不回显、日志不记录请求体/上游头 |

## 实施原则

- 每个行为修改先写失败测试，再写最少实现。
- 不改造现有同步存储抽象，不做规格之外的 NotePix 功能。
- 不提交、不部署、不使用真实 Token，除非用户另行明确要求。
