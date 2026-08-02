-- Synx-Sync 初始 schema（设计文档第 3.3、6.1 节）
-- D1 (SQLite) 语法

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 存储配置表（config 为 AES-256-GCM 加密后的 JSON）
CREATE TABLE IF NOT EXISTS storages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- 's3' | 'onedrive' | 'webdav' | 'dropbox'
  config TEXT NOT NULL,         -- 加密后的 JSON: {endpoint, bucket, access_key, secret_key, region, pathStyle}
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_storages_user ON storages(user_id);

-- 会话表（可选，JWT 自包含，此表用于主动登出/吊销）
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
