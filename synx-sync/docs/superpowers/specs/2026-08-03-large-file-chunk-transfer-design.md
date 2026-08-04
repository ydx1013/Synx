# S3/R2/MinIO 大文件直传设计

> **设计变更（v2）**：本文档最初描述的是分片（Multipart）方案。经实现后评估，该方案对实际需求（单文件 ≤100MB、Worker 128MB 内存、100MB 请求体上限）属于过度设计。
> **最终采用方案：单请求预签名 PUT 直传**——Worker 生成对象键 + 整对象预签名 PUT URL，插件一次性 PUT 整个文件内容到 S3/R2/MinIO（S3 单次 PUT 上限 5GiB），随后沿用 `finalizeCommit` 校验 blob 存在并推进 HEAD。无分片、无 ETag 列表、无断点持久化。
> 协议演进：`POST /api/repository/direct-upload/start` 返回 `{ blobId, uploadUrl, expiresIn }`。第 3 章及以后的多分片细节均为**历史参考，不反映最终实现**；第 2 章的数据流与默认参数为当前实现。

## 1. 目标与边界

为 Synx 增加最大 5 GiB 单文件的 S3 直传能力。大文件内容直接从插件上传到 S3、R2 或 MinIO，不经过 Cloudflare Worker；Worker 只负责认证、短期预签名和现有 Git 式仓库控制面。

目标：

1. S3、R2、MinIO 使用同一套预签名 PUT 直传。
2. 大文件的上传请求不经过 Worker，绕开 Worker 请求体和内存限制。
3. 无分片状态机、无断点持久化——失败重试即为整文件重传（覆盖 ≤100MB 实际场景，简单可靠）。
4. 保持现有 `blobId → finalizeCommit → HEAD/CAS → 历史/恢复/GC` 语义不变。
5. 旧普通 blob 无需迁移，继续可读和恢复。
6. 首版只改变 S3 类存储上传；WebDAV、OneDrive 和下载链路继续使用现有实现。

非目标：

- 不把 S3 凭证下发给插件。
- 不改变提交树、提交 ID、HEAD、CAS、diff 或恢复协议。
- 不在首版实现 WebDAV、OneDrive 大文件直传。
- 不承诺移动端可低内存读取大文件；该能力取决于 Obsidian Adapter。
- 不做分片与断点续传（单次 PUT 上限 5GiB 内无需；超限属未来需求再引入 Multipart）。

## 2. 核心方案（v2：单请求预签名直传）

上传数据流：

```text
插件 → Worker：POST /direct-upload/start {path, size, hash, mtime}
Worker → S3：  生成对象键 makeStorageKey(...)，presignPut(blobId, 900s)
Worker → 插件：{ blobId, uploadUrl, expiresIn: 900 }
插件 → S3：    一次性 PUT 整个文件内容到 uploadUrl（不经过 Worker）
插件 → Worker：沿用 finalizeCommit（已有单次 list 校验 blob 存在）
```

默认参数：

| 参数 | 值 |
|---|---:|
| 最大业务文件大小 | 5 GiB（S3 单次 PUT 上限） |
| 直传阈值 | 20 MiB（严格大于时启用） |
| 请求次数 | 插件侧 1 次（直接 PUT 整个文件） |
| 预签名 URL 有效期 | 15 分钟 |
| 断点持久化 | 无（失败即整文件重试） |

单次 PUT 覆盖 ≤5 GiB，完全覆盖 Worker 请求体限制（100 MiB）外的实际需求；短期 URL 仅授权特定对象的 HTTP PUT，不暴露存储凭证。

## 3. 对象键与 Git 兼容

最终对象键继续由现有 `makeStorageKey(syncFolder, path, blobId)` 生成。Worker 在 `/direct-upload/start` 时生成 `blobId`，并以最终对象键调用 `presignPut`。

上传完成后，远端只有一个标准对象：

```text
<syncFolder>/<path>@<blobId>
```

Git 层无需识别 Multipart：

- `RepoChange.blobId` 仍引用同一个最终对象。
- `finalizeCommit` 仍验证最终对象存在，然后创建提交并 CAS 推进 HEAD。
- 未完成 Multipart 没有最终对象，因此不能被 finalize。
- restore、diff、历史和现有 GC 继续把它当作普通 blob。
- 小文件和旧仓库对象完全不变。

## 4. Worker API

在现有仓库路由下增加一个认证接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/repository/direct-upload/start` | 校验文件元数据与大小限制，生成对象键和整对象预签名 PUT URL |

复用现有 JWT、`storageId`、`syncFolder` 与存储归属校验，并且仅允许 `type === 's3'`。

### 4.1 发起直传

请求：

```ts
interface DirectUploadStartRequest {
  path: string;
  size: number;
  hash: string;
  mtime: number;
}
```

响应（201）：

```ts
interface DirectUploadSession {
  blobId: string;
  uploadUrl: string;   // 预签名 PUT URL，插件把整个文件内容 PUT 上去
  expiresIn: number;   // 秒
}
```

Worker 校验 `path`、`size ≤ 5 GiB`、SHA-256 `hash`、`mtime`，再校验服务端保留策略（默认 20 MiB，可配），生成 `blobId = makeStorageKey(syncFolder, path, uuid)`，用 `aws4fetch` 的 `signQuery: true` 签名 15 分钟有效的整对象 PUT URL。URL 只授权该对象的 PUT，不暴露存储凭证；首版不签 `Content-Type`，插件不得向 URL 附加查询参数。

### 4.2 完成与校验

插件 PUT 成功后沿用现有 `finalizeCommit`：finalize 时 Worker 已对变更集 blob 做单次存在性校验（`head`），返回 `{ blobId, size, hash }` 语义与普通上传一致，无需新增完成接口。

## 5. Worker 存储边界

在 `S3Fs` 上增加单个直传能力，不扩展通用 `WorkerFs`，避免 WebDAV 和 OneDrive 被迫实现无关接口：

```ts
class S3Fs {
  presignPut(key: string, expiresSeconds: number): Promise<string>;
}
```

`S3Fs` 复用当前 path-style / virtual-host URL 构造和 `aws4fetch 1.0.20`。Worker 不接收文件内容。

## 6. 插件上传

现有小文件上传路径保留。大于 20 MiB 且当前存储为 S3 时走直传：

1. 计算文件 SHA-256。
2. `POST /direct-upload/start` 取得 `blobId` 与 `uploadUrl`。
3. 一次性 `PUT` 整个文件内容到 `uploadUrl`（请求不带 Worker 的 JWT/仓库头）。
4. 沿用现有 `RepoUploadedFile`（`blobId`）和 finalize 流程，服务端 `head` 校验 blob 存在。

无断点状态：失败即整文件重试（重试仍从 start 重新申请 URL）。`synx-state.json` 不需要新增字段。

### 平台限制

直传时插件必须一次性 PUT 整个文件内容，内存占用约等于文件大小。移动端若 Obsidian Adapter 仅支持 `readBinary()`，上传 100 MiB 文件仍可能耗尽内存；桌面端内存通常足够。首版必须明确报告该平台限制，不得宣称移动端稳定支持大文件。

## 7. CORS 与部署要求

因为插件直接向对象存储 PUT，存储必须允许相关跨域请求：

- Allowed methods：`PUT`、`HEAD`；
- Allowed headers：至少允许实际发送的请求头；
- Allowed origins：按部署实际来源配置（如 `app://obsidian.md`、`capacitor://localhost`、`http://localhost`）；
- 若需读取响应体/状态，按需配置 Exposed headers（直传流程不依赖 ETag，可不暴露）。

凭证始终只保存在 Worker 加密配置中；直传失败时插件可给出指向 CORS 配置的指引。

## 8. 错误与恢复

| HTTP | 错误码 | 含义 |
|---:|---|---|
| 400 | `INVALID_DIRECT_UPLOAD` | 参数（path/size/hash/mtime）非法 |
| 400 | `UNSUPPORTED_STORAGE` | 当前存储不是 S3/R2/MinIO |
| 413 | `FILE_TOO_LARGE` | 超过 5 GiB 或远端保留策略限制 |
| 502 | `DIRECT_UPLOAD_UPSTREAM_FAILED` | S3 兼容服务拒绝预签名操作 |

恢复原则：

- PUT 失败即整文件重试：重新调用 start 申请新 URL 后重传。
- 预签名 URL 过期（15 分钟）同样重新 start。
- finalize 发生 HEAD 冲突时，已完成对象保持可复用，重新规划后无需重新上传。
- finalize 时 blob 缺失（例如 PUT 被 CORS 拦截）会得到明确的对象缺失错误，插件下次同步重传。

## 9. 安全与资源控制

- Worker 只为当前用户拥有的 S3 存储签名。
- 对象 key 完全由服务端生成，客户端不能提交任意 key。
- 限制路径、Hash、总大小（≤5 GiB）和服务端保留策略（默认 20 MiB）。
- URL 有效期固定 15 分钟，并视为 bearer token，日志中不得记录完整 URL。
- Worker 不接收文件内容，内存不随文件大小增长。

## 10. 测试与验收

### Worker 单元与路由测试

- path-style 和 virtual-host 两种 URL 下 `presignPut` 正确。
- 预签名 URL 仅授权目标 key 和 PUT，`X-Amz-Expires` 为 900 秒。
- 非 S3 存储、越权 storageId、非法路径/大小/hash 被拒绝（413/400）。
- 超过服务端保留策略默认 20 MiB 返回 413。

### 插件测试

- 20 MiB 走旧上传；20 MiB + 1 在 S3 走直传（start + PUT 两次请求）。
- PUT 直接请求对象存储域名，不携带 Worker 的 JWT/仓库头。
- 非 S3 存储保持现有 20 MiB 限制和旧路径。

### 集成验收

1. S3、R2、MinIO 各完成一次大于 100 MiB 的上传和 finalize。
2. 抓包确认 PUT 请求目标是对象存储域名，不是 Worker 域名。
3. Worker 请求体中不出现文件内容，Worker 内存不随文件总大小增长。
4. 最终对象可由现有下载、历史和恢复路径读取。
5. 现有小文件、WebDAV、OneDrive、CAS、历史和 GC 测试全部通过。
6. 大于 5 GiB 的文件在 start 时被 413 拒绝。

## 11. 实施顺序

1. **S3Fs 直传能力**：在 `S3Fs` 实现 `presignPut`，并以 mock S3 验证不发起网络请求。
2. **共享 API 契约与 Worker 路由**：增加请求/响应类型、S3-only 鉴权校验、参数与保留策略校验。
3. **插件客户端**：增加 WorkerClient 的 start + uploadDirect 方法。
4. **同步路径接入**：仅对 S3 且超过阈值的文件启用；保留小文件与其他存储旧路径；删除 Multipart 状态机与断点。
5. **回归与集成验证**：类型检查、单元测试、构建以及 S3/R2/MinIO 实测。

在步骤 1–4 完成并验证前，不提高默认 20 MiB 上限。首版完成后，再单独评估 OneDrive Upload Session 直传、WebDAV 方案和下载直传。

## 12. 官方依据

- AWS S3 对象 PUT：单请求 PUT 上限 5 GiB；超出才需要 Multipart Upload。
- Cloudflare R2：预签名 URL 可直接上传对象并应作为 bearer token 保护；R2 对象存储与 S3 兼容。
- `aws4fetch`：项目当前使用的 1.0.20 支持 `AwsClient.sign(..., { aws: { signQuery: true } })` 生成 SigV4 查询签名。
- MinIO：通过 S3 兼容 API和 SigV4 复用同一协议；实际部署仍需集成测试其 endpoint、path-style 与 CORS 配置。
- remotely-save：参考其"插件直连对象存储、提供跳过大文件选项"的简洁思路；本方案保持凭证不下发的安全边界。
