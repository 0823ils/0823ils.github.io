-- 作り方・解説（note風の記事）。Workerが最初に使うとき自動で作るので、手で流さなくてもよい
CREATE TABLE IF NOT EXISTS guides ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', cover_id TEXT, published INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_guides_pub ON guides(deleted, published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_guides_user ON guides(user_id, deleted);
CREATE TABLE IF NOT EXISTS guide_likes (guide_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (guide_id, user_id));
CREATE TABLE IF NOT EXISTS guide_comments ( id INTEGER PRIMARY KEY AUTOINCREMENT, guide_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_guide_comments ON guide_comments(guide_id, id);
CREATE TABLE IF NOT EXISTS guide_images (guide_id INTEGER NOT NULL, video_id TEXT NOT NULL, PRIMARY KEY (guide_id, video_id));
CREATE TABLE IF NOT EXISTS guide_bookmarks (guide_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (guide_id, user_id));
CREATE INDEX IF NOT EXISTS idx_guide_bm_user ON guide_bookmarks(user_id, created_at DESC);
