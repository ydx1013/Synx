# Synx Sync

面向 Obsidian 的自托管云同步与远程 Markdown 管理系统。

Synx Sync 由跨平台 Obsidian 插件、Cloudflare Workers API 和 Web 管理端组成。它将账号、加密后的存储配置和必要元数据保存在 Cloudflare D1/KV 中，将笔记内容与 Git 式仓库历史保存在你选择的 S3 兼容存储、WebDAV 或 OneDrive 中。你可以在 Obsidian 中双向同步整个 Vault，也可以直接在浏览器中查看、编辑和恢复远程 Markdown。

> 当前项目仍处于早期版本。使用前请先备份 Vault，并在非关键数据上验证你的存储服务兼容性。

## 功能特性

- **跨平台 Obsidian 同步**：支持桌面端和移动端，不是仅桌面插件。
- **自动双向同步**：支持启动同步、定时同步、文件保存后防抖同步和手动同步。
- **自带存储**：文件保存在用户自己的 S3 兼容对象存储、WebDAV 或 OneDrive App Folder。
- **Web 笔记管理**：登录后可直接浏览、搜索、编辑和预览远程 Markdown。
- **Git 式全库历史**：每次成功同步生成不可变提交，支持提交列表、差异查看和历史恢复。
- **版本保留策略**：可按小时、天、月、年分层保留，并设置单文件大小与版本数上限。
- **冲突处理**：提供保留较新版本并创建冲突副本、保留本地、保留远端、暂停同步等策略。
- **同步过滤**：支持忽略规则、允许规则、下划线路径和 `.obsidian` 配置目录同步。
- **删除保护**：通过删除队列和文件数量骤降检测，降低误删整库或跨设备连锁删除风险。
- **备份存储**：主存储同步成功后，可将本地内容只推送镜像到多个备份存储。
- **同步报告与诊断**：记录同步结果、冲突、重试与请求 ID，可选生成移动端诊断文件。
- **外部收件箱 API**：创建限定存储和目录的 API Token，让快捷指令或自动化程序安全添加 Markdown 笔记。
- **凭证加密**：远程存储凭证使用服务端密钥加密后写入 D1；API 不在列表响应中返回明文凭证。

## 系统架构

```text
┌──────────────────────┐        HTTPS         ┌────────────────────────┐
│ Obsidian Plugin      │ ◄──────────────────► │ Cloudflare Worker      │
│ 扫描 / 计划 / 执行同步 │                       │ Hono API + 静态 Web UI │
└──────────────────────┘                       └───────────┬────────────┘
                                                         │
                                      ┌──────────────────┼──────────────────┐
                                      │                  │                  │
                                      ▼                  ▼                  ▼
                               Cloudflare D1       Cloudflare KV     用户自有云存储
                               用户与加密配置       缓存与限流         文件与仓库历史
                                                                      S3/WebDAV/
                                                                      OneDrive
```

每个 `storageId + syncFolder` 组成一个逻辑仓库。仓库的 HEAD、提交、检查点、内容树和文件对象均保存在用户的远程存储中；Worker 负责认证、存储适配和并发提交协调，插件负责本地文件扫描、冲突判断与同步执行。

## 快速开始

### 方式一：安装已发布的 Obsidian 插件

1. 从 [GitHub Releases](https://github.com/ydx1013/Synx/releases) 下载最新版本的：
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. 在 Vault 中创建目录：

   ```text
   .obsidian/plugins/synx-sync/
   ```

3. 将三个文件放入该目录，重启 Obsidian。
4. 进入 **设置 → 第三方插件**，启用 **Synx Sync**。
5. 打开插件设置并登录 Synx，选择主存储与同步目录。
6. 首次启用时先手动同步一次，并检查同步详情。

也可以使用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 安装仓库 `ydx1013/Synx` 的最新 Release。

### 方式二：从源码构建插件

环境要求：

- Node.js `20.19.0` 或更高版本
- npm（随 Node.js 安装）
- Obsidian `1.4.0` 或更高版本

```powershell
git clone https://github.com/ydx1013/Synx.git
cd Synx/synx-sync
npm ci
npm run build --workspace @synx/plugin
```

构建产物位于 `synx-sync/packages/plugin/main.js`。将它与同目录下的 `manifest.json`、`styles.css` 一起复制到 Vault 的 `.obsidian/plugins/synx-sync/`。

## 使用流程

### 1. 注册账号

打开已部署的 Synx Worker 地址，在 Web 页面注册并登录。公开实例是否开放注册由实例维护者决定；你也可以按下文自行部署。

### 2. 添加远程存储

进入 **设置 → 存储管理**，添加并测试连接：

| 类型 | 所需配置 | 说明 |
| --- | --- | --- |
| S3 兼容 | HTTPS Endpoint、Bucket、Region、Access Key、Secret Key | 支持 AWS S3、Cloudflare R2、MinIO 等兼容服务；MinIO 通常需要 path-style |
| WebDAV | HTTPS 地址、用户名、应用密码、可选远程目录 | 仅支持 Basic Auth；建议使用服务商提供的应用密码 |
| OneDrive | Microsoft App Client ID、授权账号、可选远程目录 | 使用 OAuth 2.0 PKCE 和 OneDrive App Folder |

建议为 Synx 创建独立 Bucket、远程目录或专用应用凭证，并仅授予所需权限。

### 3. 配置插件

在 Obsidian 的 Synx Sync 设置中确认：

- 主存储与同步根目录；
- 每台设备唯一的设备名；
- 启动、定时和保存后同步策略；
- 文件大小、并发数、忽略/允许规则；
- 是否同步 `.obsidian` 配置；
- 冲突策略、删除保护和备份存储；
- 历史版本保留窗口。

默认每 5 分钟同步一次，并在文件保存后等待 5 秒触发同步。默认冲突策略会保留较新的版本，同时为另一版本创建冲突副本。

### 4. 浏览和恢复历史

- 插件内可打开同步详情和历史面板；
- Web 端 `/notes` 可浏览、编辑和预览 Markdown；
- Web 端 `/history` 可查看仓库提交、文件变化和恢复预览；
- 恢复历史不会改写旧提交，而是生成新的 `restore` 提交。

### 5. 通过 API 添加笔记

在 **设置 → API Token** 创建 Token，并绑定存储、同步根目录和目标子目录。完整 Token 只显示一次。

```bash
curl -X POST "https://<your-worker>/api/inbox/notes" \
  -H "Authorization: Bearer synx_pat_<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"会议记录","content":"# 会议记录\n\n正文"}'
```

服务会自动添加 `.md` 后缀和 `synx-id`，不会覆盖同名笔记。Token 只能向创建时绑定的目录新增笔记；泄露后应立即在 Web 管理端撤销。

## 自行部署

### 1. 创建 Cloudflare 资源

登录 Cloudflare：

```powershell
cd synx-sync
npx wrangler login
npx wrangler whoami
```

创建 D1 数据库和 KV 命名空间：

```powershell
npx wrangler d1 create synx-sync-db
npx wrangler kv namespace create KV
```

将命令返回的 `database_id` 和 KV `id` 填入 `synx-sync/packages/worker/wrangler.toml`。不要直接复用仓库中属于其他账号的资源 ID。

### 2. 安装依赖并构建

```powershell
cd synx-sync
npm ci
npm run typecheck
npm test
npm run build
```

### 3. 初始化远程数据库

```powershell
cd packages/worker
npx wrangler d1 migrations apply synx-sync-db --remote
```

该命令会依次执行 `packages/worker/migrations/` 中的全部迁移。

### 4. 配置生产密钥

生成两个彼此独立、至少 32 字符的强随机值：

```powershell
npx wrangler secret put JWT_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

- `JWT_SECRET` 用于签发和验证登录令牌。
- `ENCRYPTION_KEY` 用于加密远程存储凭证。
- **部署后不要随意更换 `ENCRYPTION_KEY`**，否则已有存储配置将无法解密。
- 不要把密钥写入 `wrangler.toml`、提交到 Git，或暴露在客户端代码中。

### 5. 部署 Worker 与 Web UI

```powershell
npx wrangler deploy
```

Worker 配置会先从 `packages/web/dist` 上传 Web 静态资源，再部署 API。部署后检查：

```powershell
curl.exe https://<your-worker-domain>/api/health
curl.exe -I https://<your-worker-domain>/login
```

如果使用自定义域名，请在 Cloudflare Dashboard 中为 Worker 配置 Route 或 Custom Domain。

### 6. 本地开发 Worker

在 `synx-sync/packages/worker/.dev.vars` 中写入仅用于开发的密钥：

```text
JWT_SECRET=<至少 32 字符的开发密钥>
ENCRYPTION_KEY=<至少 32 字符的开发密钥>
```

初始化本地 D1 并启动：

```powershell
cd synx-sync/packages/worker
npx wrangler d1 migrations apply synx-sync-db --local
npm run dev
```

默认 API 地址为 `http://localhost:8787`，健康检查为 `http://localhost:8787/api/health`。

Web 端单独开发时：

```powershell
cd synx-sync/packages/web
npm run dev
```

## 开发命令

以下命令均在 `synx-sync/` 目录执行：

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按 lockfile 安装依赖 |
| `npm run typecheck` | 检查全部 workspace 的 TypeScript 类型 |
| `npm test` | 运行全部单元测试 |
| `npm run build` | 构建 shared、Web、插件并校验 Worker 部署包 |
| `npm run test --workspace @synx/plugin` | 仅运行插件测试 |
| `npm run test --workspace @synx/worker` | 仅运行 Worker 测试 |
| `npm run test --workspace @synx/web` | 仅运行 Web 单元测试 |
| `npm run test:browser --workspace @synx/web` | 运行 Web Playwright 浏览器测试 |

## 项目结构

```text
Synx/
├─ .github/workflows/release.yml     # 插件自动构建与 GitHub Release
├─ manifest.json                     # GitHub/BRAT 发布入口文件
├─ main.js                           # 已发布插件脚本
├─ styles.css                        # 已发布插件样式
├─ versions.json                     # Obsidian 版本兼容映射
└─ synx-sync/
   ├─ packages/
   │  ├─ plugin/                     # Obsidian 插件：同步、冲突、历史、报告
   │  ├─ worker/                     # Cloudflare Worker、D1 迁移、存储适配器
   │  ├─ web/                        # React/Vite Web 笔记与设置界面
   │  └─ shared/                     # API 契约、共享类型和 WorkerFs 接口
   ├─ docs/superpowers/specs/        # 关键功能设计文档
   ├─ scripts/e2e/                   # 外部存储端到端验证脚本
   └─ package.json                   # npm workspaces 根配置
```

## 数据与安全说明

- 笔记内容、仓库提交和历史对象保存在用户配置的远程存储中。
- 用户账号、偏好、加密后的存储配置和 API Token 元数据保存在 D1。
- KV 用于登录与收件箱 API 限流，不保存笔记文件或仓库历史。
- 存储凭证仅在 Worker 内存中解密；请妥善保护 `ENCRYPTION_KEY` 和 Cloudflare 账号。
- Worker 是数据传输中转站，当前不是端到端加密方案；部署者能够控制服务端代码和密钥。
- 删除存储配置默认不会删除远端文件；执行远端清理前应再次确认并保留备份。
- 同步 `.obsidian` 可以跨设备同步插件和主题配置，也可能传播不兼容配置。建议逐台设备启用并验证。

## 发布方式

推送到 `main` 后，GitHub Actions 会自动：

1. 递增补丁版本；
2. 更新插件 `manifest.json`；
3. 创建版本 Tag；
4. 构建插件；
5. 发布 `manifest.json`、`main.js` 和 `styles.css` 到 GitHub Releases。

也可以手动推送符合 `v*` 或数字版本格式的 Tag 触发发布。

## 参与贡献

欢迎提交 Issue 和 Pull Request：

1. Fork 仓库并创建短期功能分支；
2. 保持修改聚焦，并为行为变更补充测试；
3. 提交前运行 `npm run typecheck`、`npm test` 和 `npm run build`；
4. Pull Request 中说明用户影响、验证方式和存储兼容性变化。

报告问题时，请提供 Obsidian/Node.js 版本、平台、存储类型、复现步骤和同步报告中的错误信息。请先删除 Token、密码、Access Key、完整远程路径等敏感信息。

## 许可证

仓库当前尚未提供开源许可证。在许可证明确之前，源代码仍受默认版权规则约束；公开可见不等于允许复制、修改或再分发。项目维护者如希望开放社区使用，应补充适合项目目标的 `LICENSE` 文件。
