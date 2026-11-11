-- チャット翻訳の訳文を保存するテーブル（同じメッセージを二度訳さないため）
CREATE TABLE IF NOT EXISTS chat_translations (
  message_id INTEGER NOT NULL,
  lang       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  user_id    INTEGER NOT NULL,   -- 最初に訳した人（回数の上限の計算に使う）
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_chat_translations_user    ON chat_translations (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_translations_created ON chat_translations (created_at);
