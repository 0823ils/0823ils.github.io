-- コメント認証の発行済みコード（10分で失効・1回使い切り）
CREATE TABLE IF NOT EXISTS auth_challenges (
  code TEXT PRIMARY KEY,
  username TEXT NOT NULL,          -- 小文字
  created_at INTEGER NOT NULL      -- ミリ秒
);
CREATE INDEX IF NOT EXISTS idx_challenge_user ON auth_challenges(username, created_at);

-- 技術力の評価（1ユーザー1作品につき1件）
CREATE TABLE IF NOT EXISTS ratings (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,        -- ScratchのユーザーID
  username TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ratings_user ON ratings(user_id);

-- 保存した作品（ブックマーク）
CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_saves_user_time ON saves(user_id, created_at DESC);
