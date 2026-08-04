CREATE TABLE image_galleries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'github'),
  config TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_image_galleries_user ON image_galleries(user_id);
