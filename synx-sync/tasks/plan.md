# 实施计划：S3/R2/MinIO 大文件直传

## 概览

实现最大 2 GiB 的 S3 Multipart 上传。Worker 只创建、签名、校验和完成会话；插件把 16 MiB 分片直接 PUT 到 S3/R2/MinIO。最终仍生成一个普通对象，并沿用现有 Git finalize、HEAD/CAS、历史、恢复和 GC。

## 架构决策

- 首版仅支持 `StorageType === 's3'`，不改变 WebDAV、OneDrive 和下载链路。
- 最终 key 沿用 `makeStorageKey(syncFolder, path, blobId)`，不引入清单格式或数据迁移。
- Worker 不接收文件分片；凭证不离开 Worker，只返回 15 分钟 UploadPart URL。
- 采用 16 MiB 固定分片、2 GiB 上限、单文件并发 2。
- 断点存在 `synx-state.json`，恢复时以 S3 `ListParts` 为权威。
- 在功能完整验证前保留默认 20 MiB 限制；用户显式提高限制后，大文件才进入直传路径。

## 依赖关系

```text
共享 API 类型
  └─ S3Fs Multipart 能力
       └─ Worker Multipart 路由
            └─ WorkerClient 方法
                 └─ 插件上传状态机
                      └─ 本地断点恢复
                           └─ 主同步/备份接入
                                └─ 集成回归
```

## 任务列表

### 阶段 1：协议基础

#### 任务 1：定义共享 Multipart API 契约

**说明：** 在 shared 中增加 start、parts、complete、abort 的请求/响应类型与 API 路径。

**验收标准：**
- 类型包含 `blobId`、`uploadId`、1-based `partNumber`、ETag、大小和分片参数。
- API 常量只增加四条 repository multipart 路径。
- shared 类型检查通过。

**验证：** `npm run typecheck -w @synx/shared`

**依赖：** 无

**可能涉及：**
- `packages/shared/src/types.ts`
- `packages/shared/src/api.ts`
- `packages/shared/src/index.ts`

#### 任务 2：实现 S3Fs Multipart 原语

**说明：** 复用现有 aws4fetch 与 URL 构造，实现 Create、ListParts、UploadPart 预签名、Complete 和 Abort。

**验收标准：**
- path-style 与 virtual-host 均构造正确。
- ListParts 支持分页并安全解析 XML。
- Complete 按 partNumber 排序，识别 HTTP 200 内嵌错误。
- 预签名 URL 为 PUT、900 秒，并包含指定 uploadId/partNumber。

**验证：** `npm test -w @synx/worker -- s3Fs.test.ts`

**依赖：** 任务 1

**可能涉及：**
- `packages/worker/src/storage/s3Fs.ts`
- `packages/worker/src/storage/s3Fs.test.ts`

### 检查点：协议基础

- shared、worker 类型检查通过。
- 原有 S3Fs 测试无回归。
- 测试中没有真实文件内容经过 Worker 路由。

### 阶段 2：Worker 控制面

#### 任务 3：增加 S3-only Multipart 路由

**说明：** 在 repository 路由中实现 start、parts、complete、abort，复用 repoScope、getFs、保留策略和统一错误处理。

**验收标准：**
- 仅当前用户拥有的 S3 存储可调用。
- start 生成服务端对象 key 与 blobId；resume 通过 ListParts 对账。
- parts 限制编号和每批签名数量。
- complete 对 ListParts 的数量、顺序、大小和 ETag 完整校验后才完成，并 HEAD 校验最终大小。
- 请求体均为小型 JSON，不接收二进制分片。

**验证：** `npm test -w @synx/worker -- repository.test.ts`

**依赖：** 任务 1、2

**可能涉及：**
- `packages/worker/src/routes/repository.ts`
- `packages/worker/src/routes/repository.test.ts`
- `packages/worker/src/storage/factory.ts`

#### 任务 4：补齐幂等与安全错误路径

**说明：** 覆盖会话失效、完成响应丢失、非 S3、越权、超限、错误 ETag 和上游故障。

**验收标准：**
- 稳定错误码与规格一致。
- complete 后重试可通过 HEAD 幂等返回。
- abort 对不存在会话幂等。
- 错误和日志不泄露凭证或完整预签名 URL。

**验证：** `npm test -w @synx/worker -- repository.test.ts s3Fs.test.ts`

**依赖：** 任务 3

**可能涉及：**
- `packages/worker/src/routes/repository.ts`
- `packages/worker/src/routes/repository.test.ts`
- `packages/worker/src/storage/s3Fs.ts`

### 检查点：Worker 控制面

- Worker 测试、类型检查、dry-run build 全部通过。
- mock 断言 UploadPart URL 返回客户端，而不是由 Worker fetch 上传。

### 阶段 3：插件直传

#### 任务 5：扩展 WorkerClient Multipart 方法

**说明：** 增加四个控制面调用以及对预签名 URL 的无 Worker 鉴权直传方法。

**验收标准：**
- 控制面请求仍携带 JWT、storageId、syncFolder。
- 分片 PUT 只请求预签名对象存储 URL，不附加 Worker JWT。
- 成功读取并返回 ETag；缺失 ETag 视为失败。
- 单片网络/5xx 可重试，403 URL 失效由上层重新申请 URL。

**验证：** `npm test -w @synx/plugin -- workerClient.test.ts`

**依赖：** 任务 1、3

**可能涉及：**
- `packages/plugin/src/workerClient.ts`
- `packages/plugin/src/workerClient.test.ts`

#### 任务 6：实现可测试的 Multipart 上传状态机

**说明：** 把分片计算、缺片选择、有限并发、ETag 收集、重新签名和 complete 编排放到独立可测试模块；不在 main.ts 内堆叠协议细节。

**验收标准：**
- 20 MiB + 1 与 2 GiB 的分片边界正确，2 GiB + 1 被拒绝。
- 并发不超过 2；失败只影响对应分片。
- 已由 ListParts 确认的分片不会重复上传。
- 测试使用小型模拟数据，不分配 2 GiB。

**验证：** 运行新增 Multipart 上传模块测试。

**依赖：** 任务 5

**可能涉及：**
- `packages/plugin/src/multipartUpload.ts`（仅在确认独立模块确有必要时新增）
- `packages/plugin/src/multipartUpload.test.ts`

#### 任务 7：增加本地断点持久化与恢复

**说明：** 扩展现有 SynxStateData，按文件身份保存 uploadId/blobId/parts；每片成功后持久化，并在恢复时与 Worker ListParts 对账。

**验收标准：**
- 旧 synx-state.json 可无迁移加载。
- 匹配 storageId、syncFolder、path、size、mtime、hash 时可恢复。
- 文件变化、会话失效或完成后清除对应断点。
- 7 天前状态会被忽略/清理。

**验证：** 相关状态测试与插件类型检查通过。

**依赖：** 任务 6

**可能涉及：**
- `packages/plugin/src/main.ts`
- `packages/plugin/src/multipartUpload.ts`
- 对应测试文件

### 检查点：插件直传

- WorkerClient 和上传状态机测试通过。
- 模拟重启后仅上传缺失分片。
- 分片请求中没有 Worker JWT 或存储密钥。

### 阶段 4：同步接入与平台边界

#### 任务 8：接入主同步和备份同步上传路径

**说明：** 在 uploadToClient 中按文件大小和目标存储能力选择旧 uploadBlob 或 Multipart；主同步与备份共用同一路径。

**验收标准：**
- ≤20 MiB 保持原有路径。
- >20 MiB 仅 S3 走 Multipart；非 S3 返回清晰限制，不改变原行为。
- Multipart 完成得到的 blobId 继续进入现有 RepoUploadedFile/finalize。
- HEAD 冲突后可复用已完成对象。

**验证：** 插件同步测试、类型检查和 build 通过。

**依赖：** 任务 6、7

**可能涉及：**
- `packages/plugin/src/main.ts`
- `packages/plugin/src/repoSync.ts`
- `packages/plugin/src/settings.ts`
- `packages/plugin/src/settingsTab.ts`
- 对应测试文件

#### 任务 9：实现分段文件读取能力与明确降级

**说明：** 桌面端优先按范围读取；移动端不具备分段读取时明确报告平台内存限制，不伪装成端到端低内存。

**验收标准：**
- 桌面上传峰值受分片并发约束，不完整读取 2 GiB。
- .obsidian 与普通 vault 文件路径均有可验证读取方案。
- 移动端不支持时产生稳定、可理解错误且保留断点。
- 不引入未经 Obsidian/Electron 类型与运行时验证的私有 API。

**验证：** 单元模拟 + 桌面开发环境手动上传大文件。

**依赖：** 任务 8

**可能涉及：**
- `packages/plugin/src/main.ts`
- `packages/plugin/src/multipartUpload.ts`
- 插件构建配置（仅实际需要时）

### 阶段 5：完整回归

#### 任务 10：回归与真实后端验收

**说明：** 执行全仓测试、类型检查、构建，并分别验证 S3、R2、MinIO 的 CORS、ETag 和断点续传。

**验收标准：**
- `npm run typecheck`、`npm test`、`npm run build` 全部通过。
- 三个后端各完成一次 >100 MiB 上传和断点恢复。
- 抓包确认分片目标是存储域名，Worker 请求体没有分片。
- 旧小文件、WebDAV、OneDrive、历史、恢复、GC 无回归。

**验证：** 自动化命令 + 真实存储手工检查。

**依赖：** 任务 1–9

**可能涉及：** 仅测试修复直接相关文件。

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Obsidian 移动端缺少范围读取 | 无法稳定处理 2 GiB | 明确平台限制，先保证桌面端低内存；不伪造支持 |
| 对象存储 CORS 未暴露 ETag | 无法 Complete | 部署指引要求 ExposeHeaders: ETag；首次失败返回明确错误 |
| MinIO/S3 endpoint 风格差异 | 签名不匹配 | 复用现有 pathStyle/region 配置并做真实后端测试 |
| Complete 返回 HTTP 200 内嵌错误 | 误认为上传完成 | 必须解析 XML，并最终 HEAD 校验大小 |
| 未完成分片长期残留 | 存储费用 | abort 接口 + 后端生命周期清理规则 |
| 设置层提前放开 2 GiB | 非 S3 或未完成代码误读大文件 | 完整功能验证前保留默认 20 MiB，按存储能力路由 |

## 开放问题

- 真正编码任务 9 前，需要确认当前 Obsidian 桌面端可用的底层文件路径/范围读取 API；若无法从官方类型或项目运行时证据确认，应先暂停并向用户说明限制。
- 真实 S3/R2/MinIO 的 CORS 配置需由部署者完成，代码无法代替桶级策略。
