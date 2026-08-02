ALTER TABLE users ADD COLUMN default_storage_id TEXT;
ALTER TABLE users ADD COLUMN default_sync_folder TEXT NOT NULL DEFAULT 'my-vault/';
