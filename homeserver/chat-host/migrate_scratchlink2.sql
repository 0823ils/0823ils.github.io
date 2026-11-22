-- クラウド変数の書き込みルールと、保存するデータ（家のサーバーが動かす）
CREATE TABLE IF NOT EXISTS cv_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- load / save / calc
  trigger_var TEXT NOT NULL,        -- 受付の変数（☁なしの名前）
  target_var TEXT,                  -- 返事を書く変数
  formula TEXT,
  echo INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_rules_p ON cv_rules(project_id);
CREATE TABLE IF NOT EXISTS cv_store (
  project_id INTEGER NOT NULL,
  store_key TEXT NOT NULL,          -- ID
  data TEXT NOT NULL,               -- 値のみ
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, store_key)
);
