import type {
  FileMeta,
  RetentionPolicy,
  StorageConfig,
  Storage,
  StorageType,
  User,
  UserPreferences,
  VersionRecord,
} from './types.js';

/** API 路径常量 */
export const API = {
  health: '/api/health',
  // 认证
  register: '/api/auth/register',
  login: '/api/auth/login',
  me: '/api/auth/me',
  // 存储
  storageList: '/api/storage',
  storageCreate: '/api/storage',
  storageTest: '/api/storage/test',
  storageDelete: '/api/storage/:id',
  storagePurge: '/api/storage/:id/purge',
  // 同步
  put: '/api/put',
  get: '/api/get',
  list: '/api/list',
  file: '/api/file',
  // 版本历史
  history: '/api/history',
  rollback: '/api/rollback',
} as const;

// ===== 认证请求/响应 =====

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  usernameOrEmail: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface MeResponse {
  user: User;
  preferences: UserPreferences;
}

export interface UpdatePreferencesRequest {
  defaultStorageId: string | null;
  defaultSyncFolder: string;
}

export interface PreferencesResponse {
  preferences: UserPreferences;
}

// ===== 存储 CRUD =====

export interface CreateStorageRequest {
  name: string;
  type: StorageType;
  config: StorageConfig;
}

/** 存储 summary（list 接口不返回明文 config） */
export interface StorageSummary extends Omit<Storage, 'config'> {
  /** list 接口永远为 null，明文凭证不暴露 */
  config: null;
}

export interface StorageListResponse {
  storages: StorageSummary[];
}

// ===== 同步 API =====

export interface PutRequest {
  /** vault 内相对路径 */
  path: string;
  fileUuid?: string;
  mtime: number;
  /** base64 编码内容 */
  content: string;
  /** 设备标识 */
  author?: string;
  /** 并发保护：打开文件时的当前版本；远端已变化则返回 409 */
  baseVersionId?: string;
}

export interface PutResponse {
  version: VersionRecord;
}

export interface GetRequest {
  path: string;
  /** 不传则返回 current 版本 */
  version?: string;
}

export interface GetResponse {
  /** base64 编码内容 */
  content: string;
  version: VersionRecord;
}

export interface ListResponse {
  files: FileMeta[];
}

// ===== 版本历史 =====

export interface HistoryResponse {
  versions: VersionRecord[];
}

export interface RollbackRequest {
  path: string;
  fileUuid?: string;
  version: string;
}

export interface RollbackResponse {
  version: VersionRecord;
}

// ===== 错误响应 =====

export interface ErrorResponse {
  error: string;
  code?: string;
}

// ===== HTTP Headers =====

export const HEADERS = {
  authorization: 'Authorization',
  storageId: 'X-Storage-Id',
  syncFolder: 'X-Sync-Folder',
  contentType: 'Content-Type',
} as const;

/** JWT payload */
export interface JwtPayload {
  sub: string; // user_id
  iat: number;
  exp: number;
}

/** 保留策略（可按 storage 覆盖） */
export interface RetentionPolicyDto extends RetentionPolicy {}
