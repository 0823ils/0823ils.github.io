# scratch-TWC API (Cloudflare Workers + D1)

ログイン（Scratchコメント認証）と、作品ごとの「技術力」5段階評価を保存するAPIです。
リポジトリの `worker/` に置いてください（GitHub Actions のワークフローには影響しません）。

## セットアップ（初回のみ）

```bash
brew install node            # Node.js が無ければ
cd worker
npx wrangler login           # ブラウザでCloudflareにログイン（無料アカウントでOK）

# 1. データベースを作る。表示される database_id を wrangler.toml に貼る
npx wrangler d1 create twc-ratings

# 2. テーブルを作る
npx wrangler d1 execute twc-ratings --remote --file=schema.sql

# 3. ログイン用トークンの署名キー（ランダムな文字列）を登録する
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET

# 4. デプロイ。表示された https://twc-api.xxxx.workers.dev をコピー
npx wrangler deploy
```

## 機能を追加したあとの更新（保存機能を追加した場合など）

`schema.sql` に新しいテーブルが増えたときは、同じコマンドをもう一度実行してください（既存のデータは消えません）。そのあとデプロイし直します。

```bash
cd worker
npx wrangler d1 execute twc-ratings --remote --file=schema.sql
npx wrangler deploy
```

## サイトとつなぐ

`index.html` の次の行に、デプロイで表示されたURL（末尾の `/` なし）を入れて、commit & push します。

```js
var TWC_API = 'https://twc-api.xxxx.workers.dev';
```

空のままだと、ログインボタンと技術力の表示は隠れます。

## 設定

`wrangler.toml`

- `ALLOWED_ORIGINS`: APIを呼んでよいサイト。GitHub Pagesのオリジン（`https://<ユーザー名>.github.io`）です。独自ドメインを使う場合は書き換えてください。
- `AUTH_PROJECT_ID`: コメント認証に使うScratchプロジェクトのID。

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/api/auth/start` | `{username}` → 確認コードを発行（10分有効・1回限り） |
| POST | `/api/auth/verify` | `{code}` → Scratchのコメントを確認して、ログイントークンを返す（30日有効） |
| GET | `/api/ratings?ids=1,2,3` | 作品ごとの平均・件数・自分の評価（最大100件） |
| GET | `/api/ratings/ranking` | 評価のある作品の順位表（技術力の高い順。評価が少ない作品が上位に偏らないよう、平均3点の評価2件を足して計算。最大5000件） |
| PUT | `/api/ratings/:projectId` | `{score: 1〜5}` で評価（要ログイン。同じ作品は上書き。自分の作品は403、Scratchに存在しない・非公開の作品は404） |
| DELETE | `/api/ratings/:projectId` | 自分の評価を取り消す（要ログイン） |
| GET | `/api/saves` | 自分が保存した作品IDの一覧（新しい順・最大1000件。要ログイン） |
| PUT | `/api/saves/:projectId` | 作品を保存（要ログイン。1ユーザー1000件まで） |
| DELETE | `/api/saves/:projectId` | 保存を解除（要ログイン） |

## ローカルで試す

```bash
npx wrangler d1 execute twc-ratings --local --file=schema.sql
echo 'SESSION_SECRET=dev-secret' > .dev.vars
npx wrangler dev        # http://localhost:8787
```

このときは `index.html` の `TWC_API` を `http://localhost:8787` にして、`ALLOWED_ORIGINS` に、サイトを開いているオリジンを追加してください。
