-- 端末への通知（Web Push）の宛先。1回だけ実行する（何度実行しても害はない）
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  username TEXT NOT NULL,          -- 小文字
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(username, created_at);
