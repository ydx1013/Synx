-- 提交元数据索引（加速 listCommits / fileHistory）
-- D1 只存投影/缓存，仓库数据本身在用户存储的文本对象里；丢了可重建。
CREATE TABLE IF NOT EXISTS commit_index (
  user_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  sync_folder TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  parent_commit_id TEXT,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sync',
  author TEXT,
  message TEXT,
  change_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, storage_id, sync_folder, commit_id)
);
CREATE INDEX IF NOT EXISTS idx_commit_time
  ON commit_index(user_id, storage_id, sync_folder, created_at DESC);

-- 单文件历史索引（加速 fileHistory：按 identity 一次查询代替串行扫描提交链）
CREATE TABLE IF NOT EXISTS file_history_index (
  user_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  sync_folder TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  change_json TEXT NOT NULL,
  PRIMARY KEY (user_id, storage_id, sync_folder, file_identity, commit_id)
);
CREATE INDEX IF NOT EXISTS idx_file_hist_time
  ON file_history_index(user_id, storage_id, sync_folder, file_identity, created_at DESC);
