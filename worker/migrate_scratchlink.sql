-- Scratchの通知を知らせる機能と、クラウド変数の保存機能（家のサーバーと連携）。何度実行しても害はない
CREATE TABLE IF NOT EXISTS sl_watch (
  username TEXT PRIMARY KEY,        -- 小文字（TWCのユーザー名＝Scratchのユーザー名）
  last_count INTEGER,               -- 前回見たScratchの通知の数（NULL=まだ見ていない）
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cv_projects (
  project_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,              -- 小文字。登録した人（作品の作者）
  created_at INTEGER NOT NULL,
  last_sync INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cv_owner ON cv_projects(owner);
CREATE TABLE IF NOT EXISTS cv_vars (
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
