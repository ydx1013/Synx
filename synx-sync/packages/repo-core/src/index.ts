/**
 * @synx/repo-core：Git 式仓库引擎（Worker 与插件共享）。
 * 全部状态保存在用户存储的文本对象上，零 D1 / 零 KV。
 * 只依赖 @synx/shared 的类型与 WorkerFs 抽象，可在 Workers / Electron / Capacitor 环境运行。
 */
export * from './repositoryService.js';
