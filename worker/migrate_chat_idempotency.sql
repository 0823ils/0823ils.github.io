-- チャットの二重送信防止用（既存D1データベースに1回だけ実行）
ALTER TABLE chat_messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_user_client_id ON chat_messages(user_id, client_id);
