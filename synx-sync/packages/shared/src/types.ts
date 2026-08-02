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

/** 用户远程存储中的版本元数据记录 */
export interface VersionRecord {
  userId: string;
  storageId: string;
  fileUuid?: string | null;
  /** vault 内相对路径 */
  path: string;
  /** 时间戳+短哈希 */
  versionId: string;
  mtime: number;
  size: number;
  /** 内容 sha256（hex） */
  hash: string;
  /** 对象存储中的实际 key */
  storageKey: string;
  /** 1=当前版本 */
  isCurrent: number;
  /** 设备标识 */
  author: string | null;
  createdAt: number;
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

