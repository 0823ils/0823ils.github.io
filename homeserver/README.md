# 家のサーバー用プログラム（Scratchの通知 / クラウド変数の保存）

家のサーバーが、外向きの通信だけで TWC の Worker と話します（ポート開放・Tunnel は要りません）。

- **Scratchの通知**: TWCで「Scratchに通知が来たら知らせる」をオンにした人の通知数を見て、増えたらTWCのプッシュ通知で知らせます
- **クラウド変数の保存**: TWCに登録された作品の変更履歴を、`twc_home.sqlite` にずっと保存します（Scratch側から消えても残ります）。現在の値はTWCの設定に出ます
- **書き戻し（手動）**: 保存した値を、自分の作品に戻します

## 1. TWC側の準備（最初の1回）
```bash
cd worker
npx wrangler d1 execute twc-ratings --remote --file=migrate_scratchlink.sql
openssl rand -hex 32            # 出た文字列を控える（これが HOME_SECRET）
npx wrangler secret put HOME_SECRET   # 上の文字列を貼る
npx wrangler deploy
```

## 2. 家のサーバー側
Python 3.9 以上があれば動きます（標準ライブラリだけ）。
```bash
cd homeserver
export HOME_SECRET=（上で控えた文字列）
python3 twc_home.py            # 60秒ごとに確認。止めるまで動き続ける
```
`python3 twc_home.py once` で1回だけ試せます。`python3 twc_home.py status` で、保存した値を見られます。

### 常駐させる
- **Mac**: `launchd`（`~/Library/LaunchAgents/` に plist を置く）か、手軽には `tmux` / `screen` の中で動かす
- **Linux**: `systemd` のサービスにする（`Environment=HOME_SECRET=...`、`Restart=always`）

## 3. 書き戻し（自分の作品だけ）
```bash
uv run --python 3.12 --with scratchattach python twc_home.py restore 作品ID        # 全部
uv run --python 3.12 --with scratchattach python twc_home.py restore 作品ID score  # 1つだけ
```
`SCRATCH_USER` と `SCRATCH_PASS`（通らないときは `SCRATCH_SESSION`）を、環境変数に入れてから実行します。専用アカウントを使ってください。

## 注意
- 変更履歴は1回40件ずつ読みます。数分のあいだに40回より多く変わる変数は、取りこぼします（`TWC_INTERVAL` を小さくすると減ります）
- `HOME_SECRET` は誰にも見せない。サイトやリポジトリには置かない
- 他人の作品は登録できません（TWC側で、作者がログイン中のユーザーと一致するか確かめています）
