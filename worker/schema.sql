-- コメント認証の発行済みコード（10分で失効・1回使い切り）
CREATE TABLE IF NOT EXISTS auth_challenges (
  code TEXT PRIMARY KEY,
  username TEXT NOT NULL,          -- 小文字
  created_at INTEGER NOT NULL,     -- ミリ秒
  verifier TEXT                    -- 本人の画面だけが知る秘密のSHA-256（base64url）。verify で、元の秘密を確かめる
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
  room TEXT NOT NULL DEFAULT '3d',     -- 部屋: general / 3d / math / physics / triangle
  hidden INTEGER NOT NULL DEFAULT 0,   -- 1: 通報で自動非表示 or 管理者が非表示
  deleted INTEGER NOT NULL DEFAULT 0,  -- 1: 削除（本人 or 管理者）
  client_id TEXT,                    -- クライアント側の送信ID（再送による二重投稿を防止）
  edited_at INTEGER                  -- 編集した時刻（編集していなければ NULL）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_user_client_id ON chat_messages(user_id, client_id);
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

-- チャットの返信（返信先のメッセージID）
CREATE TABLE IF NOT EXISTS chat_replies (
  message_id INTEGER PRIMARY KEY,
  reply_to INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_replies_to ON chat_replies(reply_to);

-- 通知（返信・メンション）。to_username は小文字
CREATE TABLE IF NOT EXISTS chat_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_username TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'mention')),
  message_id INTEGER NOT NULL,
  room TEXT NOT NULL,
  from_username TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON chat_notifications(to_username, is_read, id DESC);

-- スタジオのキュレター・マネージャー（チャットのタグ表示用。Scratchから定期的に取り直す）
CREATE TABLE IF NOT EXISTS studio_roles (
  studio_id TEXT NOT NULL,
  username TEXT NOT NULL,            -- 小文字
  PRIMARY KEY (studio_id, username)
);
CREATE TABLE IF NOT EXISTS studio_sync (
  studio_id TEXT PRIMARY KEY,
  synced_at INTEGER NOT NULL
);

-- チャットの動画（Backblaze B2 に保存。ここには場所と状態だけ持つ）
CREATE TABLE IF NOT EXISTS chat_videos (
  id TEXT PRIMARY KEY,               -- ランダムID（ファイル名にも使う）
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  object_key TEXT NOT NULL,          -- B2 上のキー（例: v/xxxx.mp4）
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,   -- アップロード確認後の実サイズ
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'deleted')),
  message_id INTEGER,                -- 投稿に紐づいたら入る
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_user_time ON chat_videos(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_videos_message ON chat_videos(message_id);

-- 添付した .sb3 の元のファイル名（表示用）
CREATE TABLE IF NOT EXISTS chat_video_names (
  video_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- 作品のジャンル（みんなの投票。2票以上、または管理者・キュレターの1票で確定）
CREATE TABLE IF NOT EXISTS project_genres (
  project_id INTEGER NOT NULL,
  genre TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,   -- 1: 投票した時点で管理者かキュレターだった
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, genre, user_id)
);
CREATE INDEX IF NOT EXISTS idx_genres_genre ON project_genres(genre, project_id);
CREATE INDEX IF NOT EXISTS idx_genres_user ON project_genres(user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_time ON ratings(updated_at);
CREATE INDEX IF NOT EXISTS idx_saves_time ON saves(created_at);

-- 端末への通知（Web Push）の登録。username は小文字。1人あたり最大5台
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(username);

-- 通知の範囲の設定。行がない人は「all」（すべてのメッセージ）として扱う
--   mode: 'all' = すべてのメッセージ / 'mentions' = 返信・メンションだけ
--   all_seen_id: 「all」のとき、このメッセージIDまでは既読（発言ごとに通知の行は作らず、この位置から未読を数える）
CREATE TABLE IF NOT EXISTS notif_prefs (
  username TEXT PRIMARY KEY,         -- 小文字
  mode TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'mentions')),
  all_seen_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- チャットの絵文字リアクション（1人が1メッセージに、同じ絵文字は1回だけ）
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON chat_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user_time ON chat_reactions(user_id, created_at);
