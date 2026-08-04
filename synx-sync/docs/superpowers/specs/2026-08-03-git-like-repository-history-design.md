# 自建 Git 式全库仓库设计（无历史包袱版）

> 本设计替代原"兼容现有版本"路线的 spec，明确允许格式断裂：老库不做数据迁移，首次访问时把现有远端内容完整收进一个 `initial` 提交。

## 1. 目标

在用户自有的 S3/R2/MinIO/WebDAV/OneDrive 存储之上，自建一套 git 式仓库层（不依赖 Git 软件、不承诺 Git 协议兼容）：

1. **每次成功同步 = 一个原子提交**。整批全成或全不成，其他设备永远看不到半成品。
2. **全库历史时间线**。每个提交可查看相对上一提交的 diff（新增/修改/重命名/删除）。
3. **全库安全恢复**。可恢复到任意保留提交；恢复创建新提交、不破坏历史、可反悔。
4. **网页端 + Obsidian 插件共用同一套 API**：查看笔记、历史、diff、恢复。
5. 文件内容只存一份（blob），历史增长取决于真实变更量，不随"提交数 × 全库大小"膨胀。

第一版不做：分支、合并、cherry-pick、rebase、Git 协议兼容、命令行模拟。

## 2. 仓库边界与核心概念

一个 `storageId + syncFolder` 是一个逻辑仓库，单主线、单 HEAD。参与同步的全部内容（Markdown、附件、`.obsidian/`）都进入提交。

Git 概念映射：

| Git | 本项目 |
|---|---|
| blob（内容寻址） | 不可变内容对象，按唯一 id 存储 |
| tree（目录快照） | 内容树（path → 版本引用） |
| commit | 提交（变更集 + 父提交） |
| ref / HEAD | HEAD 指针对象 |
| gc / 保留策略 | 提交分层保留 + 引用可达性清理 |
| revert | 安全恢复（新建 restore 提交） |

## 3. 存储布局

全部放在用户存储的同步目录元数据根下：

```
<syncFolder>/.synx/
  blobs/{blobId}                  # 文件内容，不可变，每种内容一份
  repo/
    HEAD.json                     # {version, commitId, generation}
    commits/{commitId}.json       # 提交（含变更集）
    checkpoints/{checkpointId}.json  # 完整内容树快照
```

- `blobId`：客户端生成的唯一 id（现有 versionId 生成逻辑可复用）。内容哈希 `hash` 作为元数据随提交保存，用于 rename 检测与可选去重；**不做强制内容寻址**，避免 Worker 对大文件哈希超出 CPU 预算。
- 提交、检查点、HEAD 都是小 JSON，开销可忽略。
- **仓库层零 D1 / 零 KV（硬性约束，不得违反）**：HEAD、提交、检查点、blob、任何仓库数据/缓存全部是用户存储上的文本对象，**绝不写入 KV 或 D1**，也不准为仓库数据引入 KV/D1 缓存层。D1 仅保留用户账户、存储配置、API token 与保留策略配置；KV 仅用于限流（防御机制，不属于仓库数据）。原因：Synx 必须兼容 S3、R2、MinIO、WebDAV、OneDrive 等多种存储，KV/D1 只在 Cloudflare 上存在，一旦引入就会破坏存储无关性。并发原子性依赖存储条件写（S3/R2/MinIO 支持 `If-Match`；WebDAV 用锁对象降级），不需要数据库事务。

## 4. 数据模型

### 4.1 Commit

- `commitId`：由仓库身份 + 父提交 + 规范化变更 + 作者 + 时间哈希而来，不可变。
- `parentCommitId`：初始提交为 `null`。
- `generation`：单调递增，CAS 并发校验用。
- `createdAt`、`author`/设备标识、`message`。
- `kind`: `initial | sync | restore`。
- `changeCount`、`checkpointId?`（该提交若带检查点）。
- `changes`：变更数组，规范化排序后写入，保证 commitId 可复现。

### 4.2 Change

- `identity`：Markdown 用 UUID；无 UUID 文件用 `path:<path>`。
- `operation`: `add | modify | rename | delete`。
- `path`、`previousPath?`（仅 rename 需要）。
- `blobId`（delete 为空）。
- `hash`、`size`、`mtime`（重建与展示用）。

### 4.3 内容树与检查点

- 内容树 = `path → {identity, blobId, hash, size, mtime}`，是**派生数据**。
- **检查点**：完整内容树快照。初始提交必带；之后每 K 个提交生成一个（K 为服务端实现参数，默认较小如 10）。
- 任意提交的内容树 = 最近的祖先检查点 + 沿提交链前向重放变更。增量提交只存变更，树不必每提交存全量。

### 4.4 HEAD

- `{version, commitId, generation}`，每次提交原子推进。
- HEAD 是权威全库状态；"当前远端文件列表" = HEAD 提交的内容树。

## 5. 同步协议

### 5.1 首次 / 老库访问

无 HEAD 时：

1. 若存在旧的 `.synx/files/` 远端状态，读取并作为当前内容。
2. 建立完整内容树检查点，创建 `Initial snapshot` 提交（kind=initial）。
3. 原子设置 HEAD。

不迁移旧版本历史，不保留旧 manifest/current/tombstone 语义；旧元数据后续清理。

### 5.2 普通同步

1. 插件读 HEAD + 内容树，记录 `baseCommitId`、`generation`。
2. 三方比较生成同步计划（现有 syncAlgo 不变）。
3. 新增/修改内容先以不可变 blob 上传（**不更新任何可见状态**）。
4. 执行本批所有上传、本地拉取、删除。
5. 整批全部成功 → 插件调用 `finalize` 提交规范化变更集。
6. Worker 校验 HEAD 的 generation，写入提交（及检查点），原子更新 HEAD。
7. 无全库内容变化 → 不创建提交。

### 5.3 删除语义

- **删除不是即时删对象，而是"树里不再引用它"**。提交后，其他设备下次同步从树看到文件消失，本地删除。
- 物理 blob 删除完全交给 GC。因此**不需要墓碑（tombstone）机制**，删除天然与提交原子。

### 5.4 失败与并发

- 任一动作失败 → 不 finalize，不产生提交，HEAD 不变，其他设备不可见半成品；临时 blob 由 GC 清理。
- 并发 finalize：Worker 以 generation 做 CAS（条件写）。冲突返回 HTTP 409 `HEAD_CONFLICT`，插件重新拉取并重新规划同步，现有三方冲突规则处理双方修改。
- 服务端不得依赖进程内锁；优先条件写，WebDAV 等弱条件写后端用"锁对象"（create-if-not-exists）降级。

## 6. 全库恢复（类似 revert，非 reset --hard）

1. 读目标提交树与当前 HEAD 树。
2. 计算"当前树 → 目标树"的反向变更集。
3. 展示影响统计，二次确认。
4. 以当前 HEAD 为父，创建 `kind=restore` 新提交（内容树与目标一致，消息 `Restore to <short>`）。
5. 原子推进 HEAD。

- 恢复只改引用，不复制内容；blob 全部复用。
- 恢复提交自身进历史，可再次恢复反悔。
- 其他设备下次同步按普通远端更新处理；有未同步修改的设备进入现有冲突规则。

## 7. 重命名

- Markdown：UUID 相同、路径不同 → `rename`。
- 附件/配置（路径身份）：第一版先用**内容哈希精确匹配**把"删+增"识别为 rename；哈希级模糊匹配（git 式相似度）留到后续。

## 8. 保留策略与 GC

保留单位 = 全库提交（替代单文件版本保留）。

1. 按小时/天/月/年分层策略选出保留提交；HEAD 与恢复目标必须保留。
2. 重建保留提交的完整引用集（它们的树引用的 blob）。
3. 仅删除未被任何保留提交或 HEAD 引用、且超过宽限期的 blob；清理多余提交与检查点。
4. GC 失败不影响提交，绝不删除仍被引用的内容。

`.obsidian/` 与普通内容同样受提交引用保护，不再特殊裁剪。

## 9. API 契约（网页与插件共用）

新增（均在 auth 之后，按 `X-Storage-Id` + `X-Sync-Folder` 定位仓库）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/repository/head` | HEAD + 当前树（同步基线） |
| GET | `/api/repository/commits?cursor=` | 提交分页列表 |
| GET | `/api/repository/commits/:id` | 提交详情 |
| GET | `/api/repository/commits/:id/diff?against=` | 提交差异 |
| POST | `/api/repository/commits/finalize` | 原子提交变更集 |
| POST | `/api/repository/restore` | 预览 / 执行恢复 |
| GET | `/api/repository/tree?commitId=&prefix=` | 某提交的文件树（网页浏览用） |
| GET | `/api/repository/content?commitId=&path=` | 某提交下文件内容（网页查看笔记用） |

现有 `/api/put` 保留但语义收敛为"写不可变 blob"（不再写 current/manifest）；`/api/history`、`/api/rollback` 被提交模型取代：**单文件历史 = 从提交链按 identity 过滤派生**，不必再维护独立的版本对象列表。

## 10. UI 范围

- 插件：全库历史时间线、提交 diff、恢复预览/确认、单文件历史（派生）、同步详情显示基线/最终提交/HEAD 冲突。
- 网页：同样的历史浏览 + 提交下的文件列表与笔记内容查看（md 用现有渲染）+ 恢复。

## 11. 分阶段实施

1. **阶段 1（后端核心）**：存储布局 + HEAD + init + finalize + commits/diff/tree/content API + restore + 单文件历史派生。
   验收：两设备连续同步形成线性提交；部分失败不产生提交；并发 finalize 只一个成功；restore 后第二设备拉取正确且可反悔。
2. **阶段 2（UI）**：插件历史面板与恢复流程；网页历史浏览与笔记查看。
   验收：两端能查看提交时间线、diff 并恢复。
3. **阶段 3（规模与优化）**：检查点策略调优、分层保留 GC、rename 检测、网页笔记浏览完善。
   验收：GC 后保留提交仍可读可恢复；存储增长仅随真实变更量。

## 12. 错误处理

- `HEAD_CONFLICT`(409)：不重试 finalize，重新同步。
- 目标 blob 缺失：拒绝 finalize/restore，HEAD 不变，记录诊断。
- 提交/检查点损坏：拒绝推进 HEAD；从更早检查点重建，仍失败报仓库完整性错误。
- 部分上传失败：不 finalize，临时对象交 GC。

## 13. 风险与权衡

- **复杂度上升**：引入提交链、树重建、CAS、GC 引用可达性，代码量与调试面显著大于单文件版本模型。阶段 1 已收窄到最小闭环以降低风险。
- **元数据量**：提交只存变更集（每批几 KB），树快照每 K 次提交写一次；对比现在每次同步重写全库 manifest.json，新设计元数据开销反而更小。存储总量由保留策略 + GC 控制，不会按"提交数 × 全库大小"膨胀。
- **吞吐**：每次同步多写提交/检查点元数据（小对象），开销可忽略。
- **格式断裂**：老库的每文件版本历史不保留，重新收进 initial 提交。已确认接受。
- **WebDAV 弱条件写**：并发原子性走锁对象降级，需单独测试。

## 14. 测试与验收（要点）

- 变更规范化、commitId 确定性、树重建与检查点一致。
- 整批成功仅一个提交；部分失败无可见影响。
- 双设备 CAS 只有一个成功；restore 可反悔。
- GC 后保留提交仍可读可恢复。
- WebDAV/OneDrive 后端下 finalize 与 restore 的端到端。
