CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  token_prefix TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  sync_folder TEXT NOT NULL,
  target_folder TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE api_note_paths (
  token_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  sync_folder TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (storage_id, sync_folder, path),
  FOREIGN KEY (token_id) REFERENCES api_tokens(id) ON DELETE CASCADE,
  FOREIGN KEY (storage_id) REFERENCES storages(id) ON DELETE CASCADE
);
