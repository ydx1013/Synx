# S3/R2/MinIO 大文件直传任务

- [x] 1. 定义 shared Multipart 请求、响应和 API 常量
- [x] 2. 为 S3Fs 实现 Create/ListParts/Presign/Complete/Abort 及单元测试
- [x] 3. 实现 repository Multipart 控制面路由与 S3-only 鉴权校验
- [x] 4. 覆盖幂等、安全错误码、XML 内嵌错误和凭证脱敏
- [x] 5. 扩展 WorkerClient 控制面方法和对象存储直传 PUT
- [x] 6. 实现可测试的 16 MiB 分片上传状态机与断点持久化回调
- [x] 7. 扩展 synx-state.json 以持久化并恢复 Multipart 会话（服务端 ListParts 为权威）
- [x] 8. 将 Multipart 接入主同步和备份同步，保留旧小文件路径
- [ ] 9. 验证桌面分段读取并为移动端限制提供明确错误（未做：读取仍走 readBinary 整文件，需单独验证 Obsidian/Electron 范围读取 API）
- [ ] 10. 在真实 S3、R2、MinIO 上验证 >100 MiB 直传与续传（需真实凭证与 CORS 配置）
