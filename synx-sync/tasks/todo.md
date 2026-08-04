# GitHub 图床与孤儿图片清理任务

## Phase 1：Worker 基础与上传闭环

- [ ] 1. shared 图库契约、错误码与 `0005_image_galleries.sql`
- [ ] 2. GitHub 图库客户端：仓库检查、上传、读取、列表、删除及错误映射
- [ ] 3. Worker 图库 CRUD/测试接口：加密 Token、用户隔离、永不回显
- [ ] 4. Worker 图片上传与私有内容读取：20 MiB、目录边界、公共/私有引用

### Checkpoint 1

- [ ] shared/worker 类型检查通过
- [ ] Worker 全部测试通过

## Phase 2：图库管理网页

- [ ] 5. Web 图库 API Client 与私有图片 Blob 读取
- [ ] 6. Web 图库列表、添加/编辑/测试/移除与公开性提示

### Checkpoint 2

- [ ] Web 测试、类型检查和构建通过
- [ ] Token 不出现在任何读取响应中

## Phase 3：插件上传与失败恢复

- [ ] 7. 插件图床开关、默认图库设置与下拉选择
- [ ] 8. 粘贴/拖入上传、唯一占位、公共/私有链接替换与三次重试
- [ ] 9. 本地附件降级、本机队列、启动重传、安全替换与引用后删除

### Checkpoint 3

- [ ] 插件测试和类型检查通过
- [ ] 5xx/403/重启场景不丢图、不误删

## Phase 4：私有渲染与孤儿清理

- [ ] 10. Obsidian Reading View/Live Preview 私有图片渲染和 Blob 回收
- [ ] 11. Synx 网页私有图片渲染和 Blob 回收
- [ ] 12. Worker 疑似孤儿扫描、30 天保护和 SHA 安全删除
- [ ] 13. 插件引用收集与网页人工勾选、二次确认删除

### Checkpoint 4

- [ ] 全仓 `npm run typecheck`
- [ ] 全仓 `npm test --workspaces --if-present`
- [ ] 全仓 `npm run build`
- [ ] 真实公共/私有仓库端到端验证
