// 核心类型定义（基于设计文档第 3.3、6.1 节 schema）

/** 存储类型 */
export type StorageType = 's3' | 'onedrive' | 'webdav' | 'dropbox';

/** 用户（不返回 password_hash） */
export interface User {
  id: string;
  username: string;
  email: string;
  createdAt: number;
  updatedAt: number;
}

/** Web 端账号级笔记默认位置 */
export interface UserPreferences {
  defaultStorageId: string | null;
  defaultSyncFolder: string;
}

/** 存储配置（list 接口不返回明文凭证） */
export interface Storage {
  id: string;
  userId: string;
  name: string;
  type: StorageType;
  config: StorageConfig;
  createdAt: number;
}

/** S3 兼容存储的凭证（明文，仅在内存中；D1 中 AES 加密） */
export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  /** 是否使用 path-style（MinIO 需要 true） */
  pathStyle?: boolean;
}

/** WebDAV 认证类型 */
export type WebdavAuthType = 'basic';

/** WebDAV 存储的凭证（明文，仅在内存中；D1 中 AES 加密） */
export interface WebdavConfig {
  /** WebDAV 服务器地址，如 https://dav.example.com/remote.php/dav/files/user */
  address: string;
  username: string;
  password: string;
  authType: WebdavAuthType;
  /** 服务器上的子目录（留空则使用根目录） */
  remoteBaseDir?: string;
  /** 自定义请求头（每行一个，格式 Key: Value） */
  customHeaders?: string;
}

/** OneDrive 存储的凭证（明文，仅在内存中；D1 中 AES 加密） */
export interface OnedriveConfig {
  /** OAuth2 access token（短期有效，过期后用 refreshToken 刷新） */
  accessToken: string;
  /** OAuth2 refresh token（长期有效，用于获取新 access token） */
  refreshToken: string;
  /** access token 过期时间戳（毫秒） */
  accessTokenExpiresAt: number;
  /** Microsoft app registration 的 client ID */
  clientId: string;
  /** OAuth2 authority URL，如 https://login.microsoftonline.com/consumers */
  authority: string;
  /** OneDrive App Folder 内的子目录（留空则使用 App Folder 根） */
  remoteBaseDir?: string;
  /** 用户显示名（来自 /me，用于 UI 展示） */
  username?: string;
}

export type StorageConfig = S3Config | WebdavConfig | OnedriveConfig;

/** GitHub 图库凭证（明文仅存在于 Worker 内存，D1 中 AES 加密） */
export interface GitHubGalleryConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  folder: string;
}

export interface ImageGallery {
  id: string;
  userId: string;
  name: string;
  provider: 'github';
  owner: string;
  repo: string;
  branch: string;
  folder: string;
  isPrivate: boolean;
  hasToken: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 文件实体（FakeFs 读写单位，兼容 remotely-save 的 Entity 用法） */
export interface Entity {
  /** vault 内相对路径（含前导 /） */
  key: string;
  mtime: number;
  size: number;
  /** 是否为目录 */
  type: 'file' | 'folder';
  /** 内容 sha256（hex） */
  hash?: string;
  /** 兼容旧调用方的别名 */
  etag?: string;
  /** 远端版本身份 */
  versionId?: string;
  fileUuid?: string | null;
}

/** 文件元信息（list 接口返回的 current 版本） */
export interface FileMeta {
  path: string;
  fileUuid?: string | null;
  versionId: string;
  mtime: number;
  size: number;
  hash: string;
  author: string | null;
}

/** 保留策略配置（按 storage 可覆盖） */
export interface RetentionPolicy {
  /** 单文件最大字节数，0=不限 */
  maxFileSize: number;
  /** 每小时层窗口：保留最近 N 小时内、每小时桶中最新 1 份 */
  hourlyWindowHours: number;
  /** 每天层窗口：保留最近 N 天内、每天桶中最新 1 份 */
  dailyWindowDays: number;
  /** 每月层窗口：保留最近 N 个月内、每月桶中最新 1 份 */
  monthlyWindowMonths: number;
  /** 每年层窗口：保留最近 N 年内、每年桶中最新 1 份 */
  yearlyWindowYears: number;
  /** 每文件最大版本数（总上限兜底），0=不限 */
  maxVersionsPerFile: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxFileSize: 20 * 1024 * 1024, // 20MB
  hourlyWindowHours: 60,
  dailyWindowDays: 24,
  monthlyWindowMonths: 30,
  yearlyWindowYears: 3,
  maxVersionsPerFile: 1000,
};

// ===== Git 式仓库（全库历史） =====
// 每个 storageId + syncFolder 是一个逻辑仓库：单主线、单 HEAD。
// 全部状态（HEAD/提交/检查点/内容树）都保存在用户存储的对象上，仓库层零 D1 / 零 KV。

/** 内容树条目：path → 不可变内容对象引用 */
export interface RepoFile {
  /** vault 内相对路径 */
  path: string;
  /** Markdown 用 UUID；无 UUID 文件用 `path:<path>` */
  identity: string;
  /** 不可变内容对象 key（当前实现复用现有 version 内容的 storageKey） */
  blobId: string;
  /** 内容 sha256（hex）。E2E 加密场景由客户端在加密前计算，服务端不做内容寻址校验 */
  hash: string;
  size: number;
  mtime: number;
}

export type RepoChangeOperation = 'add' | 'modify' | 'rename' | 'delete';

/** 提交内的单条变更 */
export interface RepoChange {
  identity: string;
  operation: RepoChangeOperation;
  path: string;
  /** 仅 rename 需要 */
  previousPath?: string;
  /** delete 时为空 */
  blobId?: string;
  hash?: string;
  size?: number;
  mtime?: number;
}

export type RepoCommitKind = 'initial' | 'sync' | 'restore';

/** 提交：一次成功同步形成的全库一致性节点（不可变） */
export interface RepoCommit {
  commitId: string;
  parentCommitId: string | null;
  /** 单调递增，CAS 并发校验用 */
  generation: number;
  createdAt: number;
  /** 设备标识 */
  author: string | null;
  message: string;
  kind: RepoCommitKind;
  changeCount: number;
  /** 该提交是否带完整内容树快照 */
  checkpointId: string | null;
  /** 规范化排序后的变更集（相对父提交） */
  changes: RepoChange[];
}

/** 提交列表中的摘要 */
export interface RepoCommitSummary {
  commitId: string;
  parentCommitId: string | null;
  kind: RepoCommitKind;
  createdAt: number;
  author: string | null;
  message: string;
  changeCount: number;
}

/** HEAD 指针：仓库的权威状态 */
export interface RepositoryHead {
  version: 1;
  commitId: string;
  generation: number;
  updatedAt: number;
}

/** 两个提交之间的差异条目（供 diff / 恢复预览展示） */
export interface RepoDiffEntry {
  operation: RepoChangeOperation;
  path: string;
  previousPath?: string;
  blobId?: string;
  size?: number;
}
