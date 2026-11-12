-- 絵文字リアクション。1回だけ実行する（何度実行しても害はない）
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
