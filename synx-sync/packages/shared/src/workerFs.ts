import type { Entity } from './types.js';

/**
 * WorkerFs 接口：Workers 端对底层存储（S3/R2/MinIO 等）的抽象。
 * 插件端通过 HTTP 调 Workers，Workers 内部用此接口操作实际存储。
 */
export interface WorkerFs {
  /** 写入对象（多版本：key 形如 `{syncFolder}/{path}@v{ts}_{hash}`） */
  put(storageKey: string, content: ArrayBuffer | Uint8Array): Promise<void>;

  /** 读取对象，返回 ArrayBuffer */
  get(storageKey: string): Promise<ArrayBuffer>;

  /** 删除对象 */
  delete(storageKey: string): Promise<void>;

  /** 批量删除对象（S3 使用 DeleteObjects API；不支持的实现可不提供） */
  deleteMany?(keys: string[]): Promise<{ deleted: number; failed: number }>;

  /** 列举某前缀下的对象 key（用于 GC 扫描孤儿对象） */
  list(prefix: string): Promise<string[]>;

  /** 检查对象是否存在（用于 GC 校验孤儿） */
  head(storageKey: string): Promise<boolean>;

  /**
   * 可选：条件写（CAS）。仅当目标 key 当前值等于 etag 时写入。
   * 返回是否写入成功；etag 失配（412）返回 false，不抛错。
   * 不支持条件写的后端可不实现；仓库写入方必须提供外部串行化。
   */
  putIfMatch?(storageKey: string, content: ArrayBuffer | Uint8Array, etag: string): Promise<boolean>;

  /** 可选：仅当目标 key 不存在时写入。已存在时返回 false。 */
  putIfNoneMatch?(storageKey: string, content: ArrayBuffer | Uint8Array): Promise<boolean>;

  /** 可选：读取对象的 ETag（HEAD 响应头）。不支持时返回 null。 */
  getEtag?(storageKey: string): Promise<string | null>;
}

/**
 * 同步视图 Fs：插件端视角的文件系统操作（按 current 版本读写）。
 * WorkerClient 在插件端实现此接口，内部调 Workers /api/*。
 * Workers 端不实现此接口（Workers 直接操作仓库内容对象）。
 */
export interface SyncFs {
  /** 列举 current 版本（返回 Entity 列表） */
  list(path: string): Promise<Entity[]>;
  /** 读取 current 版本内容 */
  readFile(path: string): Promise<ArrayBuffer>;
  /** 上传新内容并原子提交（产生新提交） */
  writeFile(path: string, content: ArrayBuffer | Uint8Array, mtime: number): Promise<void>;
  /** 删除文件（删除 = 提交 delete 变更，历史保留） */
  rm(path: string): Promise<void>;
  /** 创建目录（no-op，对象存储无目录） */
  mkdir(path: string): Promise<void>;
}
