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

-- 作品の作者（自分の作品への評価を止めるための記憶。Scratchに何度も問い合わせないため）
CREATE TABLE IF NOT EXISTS project_authors (
  project_id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL
);

-- 参加申請（ユーザー or 作品を収録してほしいという申請）
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'project')),
  target_user_id INTEGER NOT NULL,   -- 収録されるユーザー（作品の場合は作者）
  target_username TEXT NOT NULL,
  project_id INTEGER,                -- kind = 'project' のときだけ
  project_title TEXT,
  applicant_id INTEGER NOT NULL,
  applicant_username TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status, created_at);
CREATE INDEX IF NOT EXISTS idx_app_applicant ON applications(applicant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_target ON applications(target_user_id);

-- チャット（全員で入る1つの部屋）
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  room TEXT NOT NULL DEFAULT '3d',     -- 部屋: 3d / math / physics / triangle
  hidden INTEGER NOT NULL DEFAULT 0,   -- 1: 通報で自動非表示 or 管理者が非表示
  deleted INTEGER NOT NULL DEFAULT 0   -- 1: 削除（本人 or 管理者）
);
CREATE INDEX IF NOT EXISTS idx_chat_user_time ON chat_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room, id);

-- 通報（1ユーザー1メッセージにつき1回）
CREATE TABLE IF NOT EXISTS chat_reports (
  message_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, reporter_id)
);

-- 投稿禁止のユーザー
CREATE TABLE IF NOT EXISTS chat_bans (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
