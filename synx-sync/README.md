# Synx Sync

Synx Sync 是一个 Obsidian 云同步系统：Obsidian 插件负责本地文件检测、双向同步和备份镜像，Cloudflare Worker 提供账号、存储配置、Git 式仓库、提交历史与恢复 API。文件内容与仓库元数据存入用户配置的 S3、R2、MinIO、WebDAV 或 OneDrive，D1 只保存账号和存储配置等控制面数据。

## 结构

- `packages/worker`：Cloudflare Worker、D1、KV 与同步 API
- `packages/web`：账号和 S3 存储管理页面
- `packages/plugin`：Obsidian 插件
- `packages/shared`：共享类型和 API 契约

## 本地验证

需要 Node.js 20.19.0 或更高版本。

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

启动本地 Worker 前，在 `packages/worker/.dev.vars` 配置开发密钥：

```text
JWT_SECRET=<至少 32 字符的随机值>
ENCRYPTION_KEY=<至少 32 字符的随机值>
```

然后执行：

```powershell
cd packages/worker
npx wrangler d1 migrations apply synx-sync-db --local
npm run dev
```

访问 `http://localhost:8787/api/health` 检查服务状态。

## Cloudflare 部署

`packages/worker/wrangler.toml` 中的 D1 和 KV ID 必须对应目标 Cloudflare 账号中的真实资源。

首次部署依次执行：

```powershell
cd packages/worker
npx wrangler whoami
npx wrangler d1 migrations apply synx-sync-db --remote
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler deploy
```

生产密钥必须使用独立随机值。`ENCRYPTION_KEY` 用于加密用户的 S3 凭证，部署后不得随意更换，否则已有凭证无法解密。

部署后验证：

```powershell
curl.exe https://<worker-domain>/api/health
curl.exe -I https://<worker-domain>/
curl.exe -I https://<worker-domain>/login.html
```

## Web 使用

1. 打开 Worker 地址。
2. 注册并登录。
3. 添加 S3、R2 或 MinIO 兼容存储。
4. 在 Obsidian 插件设置中填写同一个 Worker 地址。
5. 登录、选择存储并设置同步文件夹。

## Obsidian 插件安装

构建插件：

```powershell
npm run build --workspace @synx/plugin
```

将以下文件复制到 Vault 的 `.obsidian/plugins/synx-sync/`：

- `packages/plugin/manifest.json`
- `packages/plugin/main.js`
- `packages/plugin/styles.css`

重启 Obsidian，在社区插件中启用 **Synx Sync**。

## 同步、历史与恢复

- 默认启用启动同步、每 5 分钟定时同步，以及文件保存后 5 秒防抖同步；没有内容变化时不会创建空提交。
- 每次有效同步会创建一个包含父提交、代次和文件变更的仓库提交；内容以不可变 blob 保存，HEAD 通过代次比较避免并发覆盖。
- 仓库按间隔生成完整 checkpoint，历史页可按年月日浏览提交、查看逐行文件差异，并预览或恢复到任意保留提交。
- 恢复采用 revert 语义：恢复操作本身会创建一个新的提交，不会改写已有历史，因此可以再次恢复回较新的状态。
- 默认保留最近 24 小时、30 天、12 个月和 5 年的分层快照，每个时间桶保留代表提交；GC 在同步成功后渐进清理淘汰提交和无引用对象。
- 可配置一个主存储和多个仅推送的备份存储；备份存储不会反向覆盖本地文件。

## 文件大小与 Multipart

- 默认单文件上限为 20 MiB；超过 20 MiB 的 S3/R2/MinIO 文件可使用 16 MiB 分片直传与断点续传，分片内容不经过 Worker。
- WebDAV 和 OneDrive 不使用 Multipart，仍受普通上传大小限制。
- 当前插件仍通过 Obsidian `readBinary` 将文件整体读入内存后再分片；超大文件尤其是移动端尚未完成低内存范围读取验证，不应将协议上限等同于所有平台的稳定文件上限。
- S3 兼容存储必须允许客户端对预签名 URL 执行 `PUT`，并通过 CORS 暴露 `ETag` 响应头。

## 质量门禁

GitHub 插件发布工作流会在写回版本、打 tag 和创建 Release 之前依次执行锁文件安装、全仓类型检查、单元测试、生产依赖高危审计和全仓构建。任一步失败都会阻止发布。

## 回滚部署

Worker 发布异常时，在 Cloudflare Dashboard 的 Workers 部署页面选择上一版本回滚。数据库 migration `0001_init.sql` 只创建表和索引，不删除数据；不要在回滚 Worker 时删除 D1 或 KV 资源。
