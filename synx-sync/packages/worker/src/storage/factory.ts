import type { OnedriveConfig, S3Config, StorageConfig, StorageType, WebdavConfig, WorkerFs } from '@synx/shared';
import { decryptString } from '../auth/crypto.js';
import type { Env } from '../types.js';
import { OneDriveFs } from './onedriveFs.js';
import { S3Fs } from './s3Fs.js';
import { WebDAVFs } from './webdavFs.js';

/** D1 storages 表行结构 */
export interface StorageRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  config: string;
  created_at: number;
}

/** 业务错误：路由层捕获后转 HTTP 状态码 */
export class StorageError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

// 存储行内存缓存：同一 isolate 内短 TTL，避免同步突发中每请求查 D1。
const rowCache = new Map<string, { row: StorageRow; expiresAt: number }>();
const ROW_CACHE_TTL = 60 * 1000;

/** 存储创建/更新/删除后调用，避免缓存过期前读到旧凭证 */
export function invalidateStorageRowCache(storageId: string): void {
  for (const key of rowCache.keys()) {
    if (key.endsWith(`:${storageId}`)) rowCache.delete(key);
  }
}

/** 仅供测试：清空全部缓存，避免用例间污染 */
export function resetStorageRowCache(): void {
  rowCache.clear();
}

/**
 * 取 storage 行（含归属校验）。
 * 不解密 config；调用方决定何时解密。
 */
export async function getStorageRow(
  env: Env,
  userId: string,
  storageId: string,
): Promise<StorageRow> {
  const key = `${userId}:${storageId}`;
  const now = Date.now();
  const cached = rowCache.get(key);
  if (cached && cached.expiresAt > now) return cached.row;

  const row = await env.DB.prepare('SELECT * FROM storages WHERE id = ?')
    .bind(storageId)
    .first<StorageRow>();
  if (!row) throw new StorageError(404, 'storage not found');
  if (row.user_id !== userId) throw new StorageError(403, 'forbidden');

  rowCache.set(key, { row, expiresAt: now + ROW_CACHE_TTL });
  return row;
}

/**
 * 解密 S3 配置（向后兼容）。
 * @deprecated 使用 decryptStorageConfig 替代
 */
export async function decryptS3Config(row: StorageRow, encryptionKey: string): Promise<S3Config> {
  if (row.type !== 's3') throw new StorageError(400, `unsupported storage type: ${row.type}`);
  const json = await decryptString(row.config, encryptionKey);
  return JSON.parse(json) as S3Config;
}

/**
 * 解密 storage config（通用，按 type 返回对应的配置类型）。
 */
export async function decryptStorageConfig(row: StorageRow, encryptionKey: string): Promise<StorageConfig> {
  const json = await decryptString(row.config, encryptionKey);
  const config = JSON.parse(json) as StorageConfig;
  return config;
}

/**
 * 工厂入口：根据 storageId 取解密配置，构造对应 WorkerFs 实例。
 * 校验 storageId 归属 userId，不匹配抛 StorageError(403)。
 */
export async function getFs(
  env: Env,
  userId: string,
  storageId: string,
): Promise<{ fs: WorkerFs; row: StorageRow; type: StorageType }> {
  const row = await getStorageRow(env, userId, storageId);
  const config = await decryptStorageConfig(row, env.ENCRYPTION_KEY);

  let fs: WorkerFs;
  switch (row.type) {
    case 's3':
      fs = new S3Fs(config as S3Config);
      break;
    case 'webdav':
      fs = new WebDAVFs(config as WebdavConfig);
      break;
    case 'onedrive':
      fs = new OneDriveFs(config as OnedriveConfig);
      break;
    default:
      throw new StorageError(400, `unsupported storage type: ${row.type}`);
  }

  return { fs, row, type: row.type as StorageType };
}
