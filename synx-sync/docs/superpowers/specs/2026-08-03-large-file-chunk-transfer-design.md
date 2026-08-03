# S3/R2/MinIO 大文件直传设计

## 1. 目标与边界

为 Synx 增加最大 2 GiB 单文件的 S3 Multipart 直传能力。文件分片直接从插件上传到 S3、R2 或 MinIO，不经过 Cloudflare Worker；Worker 只负责认证、短期签名、完成校验和现有 Git 式仓库控制面。

目标：

1. S3、R2、MinIO 使用同一套 S3 Multipart 协议。
2. 大文件的上传请求不经过 Worker，绕开 Worker 请求体和内存限制。
3. 支持分片重试以及跨同步、跨插件重启恢复。
4. 保持现有 `blobId → finalizeCommit → HEAD/CAS → 历史/恢复/GC` 语义不变。
5. 旧普通 blob 无需迁移，继续可读和恢复。
6. 首版只改变 S3 类存储上传；WebDAV、OneDrive 和下载链路继续使用现有实现。

非目标：

- 不把 S3 凭证下发给插件。
- 不改变提交树、提交 ID、HEAD、CAS、diff 或恢复协议。
- 不在首版实现 WebDAV、OneDrive 大文件直传。
- 不承诺移动端可低内存读取 2 GiB 文件；该能力取决于 Obsidian Adapter。
- 不将普通 blob 改成自定义分片清单；Multipart 完成后仍是一个标准 S3 对象。

## 2. 核心方案

上传数据流：

```text
插件 → Worker：创建/恢复 Multipart 会话
Worker → S3：CreateMultipartUpload / ListParts
Worker → 插件：uploadId、缺失分片的短期预签名 UploadPart URL
插件 → S3：直接 PUT 各分片，读取响应 ETag
插件 → Worker：提交 PartNumber + ETag
Worker → S3：ListParts 校验后 CompleteMultipartUpload
插件 → Worker：沿用 finalizeCommit 推进 HEAD
```

默认参数：

| 参数 | 值 |
|---|---:|
| 最大业务文件大小 | 2 GiB |
| Multipart 阈值 | 20 MiB（严格大于时启用） |
| 固定分片大小 | 16 MiB，末片除外 |
| 单文件分片数上限 | 128 |
| 预签名 URL 有效期 | 15 分钟 |
| 单文件并发分片数 | 2 |
| 本地断点保留 | 7 天 |

16 MiB 满足 S3/R2 非末片至少 5 MiB 的约束；2 GiB 恰好为 128 片，远低于 10,000 片上限。短期 URL 仅授权特定对象、`uploadId`、`partNumber` 和 HTTP PUT，不暴露存储凭证。

## 3. 对象键与 Git 兼容

最终对象键继续由现有 `makeStorageKey(syncFolder, path, blobId)` 生成。Worker 在创建 Multipart 会话前生成 `blobId`，并以最终对象键调用 `CreateMultipartUpload`。

Multipart 完成后，远端只有一个标准对象：

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

在现有仓库路由下增加四个认证接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/repository/multipart/start` | 创建或恢复会话，返回 `blobId`、`uploadId`、分片参数和已上传部分 |
| POST | `/api/repository/multipart/parts` | 为一组缺失 `partNumber` 生成短期 UploadPart URL |
| POST | `/api/repository/multipart/complete` | 校验远端 ListParts 后完成 Multipart |
| POST | `/api/repository/multipart/abort` | 终止 Multipart 并清除本地可恢复状态 |

所有接口复用现有 JWT、`storageId`、`syncFolder` 与存储归属校验，并且仅允许 `type === 's3'`。

### 4.1 创建或恢复

请求：

```ts
interface StartMultipartRequest {
  path: string;
  size: number;
  hash: string;
  mtime: number;
  resume?: {
    blobId: string;
    uploadId: string;
  };
}
```

响应：

```ts
interface MultipartSession {
  blobId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  uploadedParts: Array<{ partNumber: number; etag: string; size: number }>;
}
```

恢复时，Worker 不信任插件保存的完成列表，而是对目标对象调用 `ListParts`。若 `uploadId` 已失效，返回稳定错误 `MULTIPART_NOT_FOUND`，插件创建新会话。

### 4.2 申请分片 URL

请求包含会话身份及最多 16 个缺失 `partNumber`。Worker 验证编号在 `1..partCount` 内，再使用 `aws4fetch` 的 `signQuery: true` 生成 15 分钟有效的 PUT URL。

响应只包含：

```ts
interface MultipartPartUrl {
  partNumber: number;
  url: string;
}
```

首版不签 `Content-Type`，避免插件请求头与签名不一致。插件不得向 URL 附加查询参数。

### 4.3 完成

插件提交收集到的 `{ partNumber, etag }`。Worker 先调用 `ListParts`，验证：

- 分片编号连续且数量为 `partCount`；
- 非末片大小等于 16 MiB；
- 末片大小符合总文件大小；
- 插件提交的 ETag 与远端 ListParts 一致。

验证通过后由 Worker调用 `CompleteMultipartUpload`。必须解析响应 XML；不能只依据 HTTP 200，因为 S3 允许完成错误嵌入 200 响应体。完成后再次 HEAD，确认最终对象大小等于请求大小，再返回 `{ blobId, size, hash }`。

### 4.4 终止

Worker 调用 `AbortMultipartUpload`。终止操作幂等：会话已不存在时仍返回成功。桶应配置生命周期规则自动终止长期未完成 Multipart，防止客户端永久离线后残留计费。

## 5. Worker 存储边界

在 `S3Fs` 上增加 Multipart 专用能力，不扩展通用 `WorkerFs`，避免 WebDAV 和 OneDrive 被迫实现无关接口：

```ts
interface S3UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

class S3Fs {
  createMultipartUpload(key: string): Promise<string>;
  listMultipartParts(key: string, uploadId: string): Promise<S3UploadedPart[]>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: S3UploadedPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
```

`S3Fs` 复用当前 path-style / virtual-host URL 构造和 `aws4fetch 1.0.20`。XML 字段必须转义和解码；ListParts 必须处理分页。

Worker 不保存分片内容，也不接收 UploadPart 的请求体。

## 6. 插件上传与断点

现有小文件上传路径保留。大于 20 MiB 且当前存储为 S3 时走 Multipart：

1. 计算文件 SHA-256，并生成/恢复会话。
2. 以固定 16 MiB 范围读取文件。
3. 每次申请有限数量的 URL，最多并发上传两片。
4. 每片 PUT 成功后读取响应 `ETag` 并立即持久化断点。
5. URL 过期时只重新申请对应 part URL；网络失败只重试当前片。
6. 所有分片完成后调用 complete，取得原先预留的 `blobId`。
7. 沿用现有 `RepoUploadedFile` 和 finalize 流程。

在现有 `synx-state.json` 增加可选状态：

```ts
interface MultipartResumeState {
  storageId: string;
  syncFolder: string;
  path: string;
  size: number;
  mtime: number;
  hash: string;
  blobId: string;
  uploadId: string;
  partSize: number;
  uploadedParts: Array<{ partNumber: number; etag: string }>;
  updatedAt: number;
}
```

恢复匹配必须包含 `storageId + syncFolder + path + size + mtime + hash`。Worker 的 ListParts 是权威状态。本地内容变化后不得复用旧会话。

### 平台限制

桌面端若能取得底层文件路径，应使用 Node/Electron 范围读取，内存保持在有限分片数量。移动端若 Obsidian Adapter 仅支持 `readBinary()`，上传协议虽然可处理 2 GiB，但读取文件时仍可能耗尽内存。首版必须明确报告该平台限制，不得宣称移动端稳定支持 2 GiB。

## 7. CORS 与部署要求

因为插件直接向对象存储 PUT，存储必须允许相关跨域请求，并暴露 `ETag`：

- Allowed methods：`PUT`、`HEAD`；
- Allowed headers：至少允许实际发送的请求头；
- Exposed headers：`ETag`；
- Allowed origins：按部署实际来源配置；无法稳定限定 Obsidian 来源时需要由用户明确配置兼容策略。

连接测试应新增直传能力检查，或在首次 Multipart 时返回明确的 `DIRECT_UPLOAD_CORS` 指引。凭证始终只保存在 Worker 加密配置中。

## 8. 错误与恢复

| HTTP | 错误码 | 含义 |
|---:|---|---|
| 400 | `INVALID_MULTIPART` | 参数、分片编号或状态非法 |
| 400 | `UNSUPPORTED_STORAGE` | 当前存储不是 S3/R2/MinIO |
| 404 | `MULTIPART_NOT_FOUND` | uploadId 不存在或已失效 |
| 409 | `MULTIPART_CONFLICT` | 文件身份或远端分片状态不一致 |
| 413 | `FILE_TOO_LARGE` | 超过 2 GiB 或远端保留策略限制 |
| 422 | `MULTIPART_INCOMPLETE` | 缺片、大小或 ETag 校验失败 |
| 502 | `MULTIPART_UPSTREAM_FAILED` | S3 兼容服务拒绝操作 |

恢复原则：

- 单片失败只重传该片。
- URL 过期只重新签名，不新建会话。
- 插件重启后用本地会话调用 start/resume，并以 ListParts 覆盖本地完成列表。
- complete 成功但响应丢失时，Worker通过 HEAD 判断最终对象是否已形成；若大小正确则幂等返回成功。
- finalize 发生 HEAD 冲突时，已完成对象保持可复用，重新规划后无需重新上传。

## 9. 安全与资源控制

- Worker 只为当前用户拥有的 S3 存储签名。
- 对象 key 完全由服务端生成，客户端不能提交任意 key。
- 限制路径、Hash、总大小、partCount 和每次签名数量。
- URL 有效期固定 15 分钟，并视为 bearer token，日志中不得记录完整 URL。
- complete/abort 必须以 `blobId + uploadId + path` 重建并校验唯一对象键。
- Worker 不信任客户端 ETag；必须与 ListParts 对照。
- S3/R2/MinIO 应配置自动清理未完成 Multipart 的生命周期规则。

## 10. 测试与验收

### Worker 单元与路由测试

- path-style 和 virtual-host 两种 URL 下 Create/List/Presign/Complete/Abort 正确。
- 预签名 URL 仅授权目标 key、uploadId、partNumber 和 PUT，过期时间为 900 秒。
- ListParts 分页、XML 实体和 ETag 解析正确。
- Complete XML 按 PartNumber 升序生成并解析 200 内嵌错误。
- 非 S3 存储、越权 storageId、非法路径/大小/分片编号被拒绝。
- complete 在缺片、错片、大小不符或 ETag 不符时不调用上游完成。

### 插件测试

- 20 MiB 走旧上传；20 MiB + 1 在 S3 走 Multipart。
- 2 GiB 为 128 片；2 GiB + 1 被拒绝。
- 单片失败只重试该片，URL 过期只重新签名。
- 重启后使用 Worker ListParts 恢复，不重复上传已存在分片。
- complete 后沿用原有 finalize，HEAD 冲突不重复上传。
- 非 S3 存储保持现有 20 MiB 限制和旧路径。

### 集成验收

1. S3、R2、MinIO 各完成一次大于 100 MiB 的上传、断点恢复和 finalize。
2. 抓包确认 UploadPart 请求目标是对象存储域名，不是 Worker 域名。
3. Worker 请求体中不出现文件分片，Worker 内存不随文件总大小增长。
4. 最终对象可由现有下载、历史和恢复路径读取。
5. 现有小文件、WebDAV、OneDrive、CAS、历史和 GC 测试全部通过。
6. 使用生成数据验证 2 GiB 的分片计算与状态机，测试进程不一次分配 2 GiB。

## 11. 实施顺序

1. **S3 Multipart 基础能力**：在 `S3Fs` 实现 Create/List/Presign/Complete/Abort，并以 mock S3 覆盖 XML、分页和错误。
2. **共享 API 契约与 Worker 路由**：增加请求/响应类型、S3-only 鉴权校验、参数与远端状态校验。
3. **插件客户端与状态机**：增加 WorkerClient 方法、Multipart 上传调度、ETag 收集和有限并发。
4. **插件持久化恢复**：扩展 `synx-state.json`，实现重启后与 ListParts 对账。
5. **同步路径接入**：仅对 S3 且超过阈值的文件启用；保留小文件与其他存储旧路径。
6. **回归与集成验证**：类型检查、单元测试、构建以及 S3/R2/MinIO 实测。

在步骤 1–4 完成并验证前，不提高默认 20 MiB 上限。首版完成后，再单独评估 OneDrive Upload Session 直传、WebDAV 方案和下载直传。

## 12. 官方依据

- AWS S3 Multipart：创建会话、上传分片、按 `PartNumber + ETag` 完成，并要求未完成会话最终 complete 或 abort。
- Cloudflare R2：Multipart 支持 5 MiB–5 GiB 分片、最多 10,000 片和可恢复上传；预签名 URL 可用于直接上传且应作为 bearer token 保护。
- `aws4fetch`：项目当前使用的 1.0.20 支持 `AwsClient.sign(..., { aws: { signQuery: true } })` 生成 SigV4 查询签名。
- MinIO：通过 S3 兼容 API和 SigV4 复用同一协议；实际部署仍需集成测试其 endpoint、path-style 与 CORS 配置。
