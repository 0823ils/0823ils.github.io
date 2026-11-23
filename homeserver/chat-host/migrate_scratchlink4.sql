-- サブアカウント連携（本垢にひも付けたScratchのサブ垢）
CREATE TABLE IF NOT EXISTS sub_accounts (
  sub TEXT PRIMARY KEY,             -- サブ垢（小文字）
  sub_uid INTEGER NOT NULL,
  sub_name TEXT NOT NULL,           -- 大文字小文字そのまま
  owner TEXT NOT NULL,              -- 本垢（小文字）
  owner_uid INTEGER NOT NULL,
  owner_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_owner ON sub_accounts(owner);
