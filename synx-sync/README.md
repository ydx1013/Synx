# Synx Sync

Synx Sync 是一个 Obsidian 云同步系统：Obsidian 插件负责本地文件检测与双向同步，Cloudflare Workers 提供账号、存储配置、版本历史和回滚 API，文件内容存入用户配置的 S3 兼容存储。

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

## 同步与版本

- 默认每 5 分钟同步一次，文件变更后有 5 秒防抖触发。
- 当前版本与历史版本元数据存于 D1。
- 文件对象存于用户配置的 S3 兼容存储。
- 默认每个文件保留 10 个版本，单文件最大 20 MB。
- 回滚会生成一个新的当前版本，不会直接覆盖历史记录。

## 回滚部署

Worker 发布异常时，在 Cloudflare Dashboard 的 Workers 部署页面选择上一版本回滚。数据库 migration `0001_init.sql` 只创建表和索引，不删除数据；不要在回滚 Worker 时删除 D1 或 KV 资源。
