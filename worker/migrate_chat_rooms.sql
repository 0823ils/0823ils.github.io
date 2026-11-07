-- すでにチャットのテーブルがあるDB用（1回だけ実行）。既存のメッセージは「3D」の部屋に入る。
-- 2回目以降に実行すると、列がすでにあるというエラーになるが、害はない。
ALTER TABLE chat_messages ADD COLUMN room TEXT NOT NULL DEFAULT '3d';
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room, id);
