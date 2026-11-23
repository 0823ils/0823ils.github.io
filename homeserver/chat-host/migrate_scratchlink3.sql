-- ユーザーごとの保存（変数Aが変わったら、その値と変えたユーザーを保存する）
CREATE TABLE IF NOT EXISTS cv_ustore (
  project_id INTEGER NOT NULL,
  var_name TEXT NOT NULL,           -- 保存する変数（変数A、☁なしの名前）
  username TEXT NOT NULL,           -- 変えたユーザー
  data TEXT NOT NULL,               -- そのユーザーの、いちばん新しい値
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, var_name, username)
);
