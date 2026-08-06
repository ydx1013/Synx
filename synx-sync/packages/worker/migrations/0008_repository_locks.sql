CREATE TABLE IF NOT EXISTS repository_locks (
  user_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  sync_folder TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  operation TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, storage_id, sync_folder)
);
