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
  storageRetention: '/api/storage/:id/retention',
  // 专用 API Token 与外部添加笔记
  tokenList: '/api/tokens',
  tokenCreate: '/api/tokens',
  tokenDelete: '/api/tokens/:id',
  inboxNoteCreate: '/api/inbox/notes',
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

export interface RetentionPolicyResponse {
  policy: RetentionPolicy;
}

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  storageId: string;
  storageName?: string;
  syncFolder: string;
  targetFolder: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreateApiTokenRequest {
  name: string;
  storageId: string;
  syncFolder: string;
  targetFolder: string;
}

export interface CreateApiTokenResponse {
  token: string;
  apiToken: ApiToken;
}

export interface ApiTokenListResponse {
  tokens: ApiToken[];
}

export interface CreateInboxNoteRequest {
  title: string;
  content: string;
}

export interface CreateInboxNoteResponse {
  note: { path: string; fileUuid: string; versionId: string; createdAt: number };
}

export interface UpdateRetentionPolicyRequest extends Partial<RetentionPolicy> {}

// ===== 同步 API =====

/**
 * POST /api/put 使用「查询参数 + 原始二进制 body」：
 * URL query: path / fileUuid / mtime / author / baseVersionId
 * body: 文件内容（octet-stream），不再 base64 编码。
 */
export interface PutRequest {
  /** vault 内相对路径 */
  path: string;
  fileUuid?: string;
  mtime: number;
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

/**
 * GET /api/get 的响应为「原始二进制 body + X-Synx-Version 响应头」。
 * content 不再经 base64 编码（大文件在 worker 内 base64 会触发 Cloudflare 免费版
 * CPU 超限 error 1102）。客户端直接读取 response.arrayBuffer()。
 */
export interface GetResponse {
  /** 文件内容（客户端从二进制 body 读取，不再走 base64） */
  content: ArrayBuffer;
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
