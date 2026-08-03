import type {
  RepoChange,
  RepoCommit,
  RepoCommitSummary,
  RepoDiffEntry,
  RepoFile,
  RepositoryHead,
  RetentionPolicy,
  StorageConfig,
  Storage,
  StorageType,
  User,
  UserPreferences,
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
  // Git 式仓库（全库历史）
  repoHead: '/api/repository/head',
  repoInit: '/api/repository/init',
  repoCommits: '/api/repository/commits',
  repoCommit: '/api/repository/commits/:id',
  repoCommitDiff: '/api/repository/commits/:id/diff',
  repoFinalize: '/api/repository/commits/finalize',
  repoRestore: '/api/repository/restore',
  repoTree: '/api/repository/tree',
  repoBlobs: '/api/repository/blobs',
  repoMultipartStart: '/api/repository/multipart/start',
  repoMultipartParts: '/api/repository/multipart/parts',
  repoMultipartComplete: '/api/repository/multipart/complete',
  repoMultipartAbort: '/api/repository/multipart/abort',
  repoContent: '/api/repository/content',
  repoFileHistory: '/api/repository/file-history',
  repoGc: '/api/repository/gc',
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

// ===== Git 式仓库 API =====

/** 仓库读取基线：HEAD + 完整内容树（当前远端文件列表） */
export interface RepoHeadResponse {
  head: RepositoryHead | null;
  tree: RepoFile[];
  storageId: string;
  syncFolder: string;
}

/** 初始化仓库：把当前远端状态完整收进 initial 提交。仓库已存在时返回 409 REPO_EXISTS。 */
export interface RepoInitRequest {
  author?: string;
}

export interface RepoInitResponse {
  head: RepositoryHead;
  commit: RepoCommit;
}

export interface RepoCommitsResponse {
  commits: RepoCommitSummary[];
  /** 分页游标：下一次请求传该值继续向前翻页；无更多提交时为 null */
  cursor: string | null;
}

export interface RepoCommitResponse {
  commit: RepoCommit;
}

export interface RepoDiffResponse {
  against: string;
  target: string;
  changes: RepoDiffEntry[];
  added: number;
  modified: number;
  renamed: number;
  deleted: number;
}

export interface MultipartUploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface MultipartStartRequest {
  path: string;
  size: number;
  hash: string;
  mtime: number;
  resume?: { blobId: string; uploadId: string };
}

export interface MultipartSessionResponse {
  blobId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  uploadedParts: MultipartUploadedPart[];
}

export interface MultipartPartsRequest {
  path: string;
  blobId: string;
  uploadId: string;
  partNumbers: number[];
}

export interface MultipartPartsResponse {
  parts: Array<{ partNumber: number; url: string }>;
}

export interface MultipartCompleteRequest {
  path: string;
  blobId: string;
  uploadId: string;
  size: number;
  hash: string;
  parts: Array<{ partNumber: number; etag: string }>;
}

export interface MultipartCompleteResponse {
  blobId: string;
  size: number;
  hash: string;
}

export interface MultipartAbortRequest {
  path: string;
  blobId: string;
  uploadId: string;
}

/** 原子提交变更集。冲突（HEAD 已被推进）返回 409 HEAD_CONFLICT。 */
export interface RepoFinalizeRequest {
  baseCommitId: string;
  baseGeneration: number;
  author?: string;
  message?: string;
  changes: RepoChange[];
}

export interface RepoFinalizeResponse {
  commit: RepoCommit;
  head: RepositoryHead;
}

/** 全库恢复：dryRun=true 只返回预览；否则创建 kind=restore 新提交并推进 HEAD。 */
export interface RepoRestoreRequest {
  toCommitId: string;
  dryRun?: boolean;
  author?: string;
}

export interface RepoRestorePreview {
  /** 当前 HEAD → 目标提交的反向变更集 */
  changes: RepoDiffEntry[];
  added: number;
  modified: number;
  renamed: number;
  deleted: number;
}

export interface RepoRestoreResponse {
  preview?: RepoRestorePreview;
  commit?: RepoCommit;
  head?: RepositoryHead;
}

/** 某提交下的文件树（网页浏览用） */
export interface RepoTreeResponse {
  commitId: string;
  files: RepoFile[];
}

/** 某提交下单文件的版本历史（从提交链按 identity 派生） */
export interface RepoFileHistoryResponse {
  identity: string;
  commits: RepoCommitSummary[];
  changes: RepoChange[];
  /** 有下一页时返回游标（下次请求的 from 提交 id）；没有则为空 */
  nextCursor: string | null;
}

/** 垃圾回收结果：清理未引用内容对象；deletedCommits 为按保留策略淘汰的历史提交数 */
export interface RepoGcResponse {
  scanned: number;
  deleted: number;
  deletedCommits: number;
  more: boolean;
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
