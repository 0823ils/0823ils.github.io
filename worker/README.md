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
| GET | `/api/ratings?ids=1,2,3` | 作品ごとの二乗平均平方根 (RMS)・件数・自分の評価（最大100件） |
| GET | `/api/ratings/ranking` | message.txt と同じ評価者補正・相関重み付けによる技術力順位（最大5000件）。`score` が順位用補正スコア、`avg` が表示用RMS |
| PUT | `/api/ratings/:projectId` | `{score: 1〜5}` で評価（要ログイン。同じ作品は上書き。自分の作品は403、Scratchに存在しない・非公開の作品は404） |
| DELETE | `/api/ratings/:projectId` | 自分の評価を取り消す（要ログイン） |
| GET | `/api/saves` | 自分が保存した作品IDの一覧（新しい順・最大1000件。要ログイン） |
| PUT | `/api/saves/:projectId` | 作品を保存（要ログイン。1ユーザー1000件まで） |
| DELETE | `/api/saves/:projectId` | 保存を解除（要ログイン） |
| POST | `/api/applications` | `{kind: "user"\|"project", target, message}` で参加申請（要ログイン。ユーザー名/URL・作品URL/IDを指定。同じ対象の重複は409、審査待ちは10件まで） |
| GET | `/api/applications/mine` | 自分の申請一覧と `is_admin`（要ログイン） |
| GET | `/api/applications/approved-users` | 承認済みユーザーの一覧（公開。収集ツールが使う） |
| GET | `/api/admin/applications?status=pending` | 申請の一覧（管理者のみ） |
| POST | `/api/admin/applications/:id` | `{status: "approved"\|"rejected"\|"pending"}` で審査（管理者のみ） |

## 参加申請

ログインしたユーザーは、サイト右上の「参加申請」から、ユーザーまたは作品の収録を申請できます。`wrangler.toml` の `ADMIN_USERS`（既定は `TWC-ils`）に入っているユーザーでログインすると、同じ画面に審査待ち一覧が出て、承認・却下できます。承認されたユーザーは、毎日の更新（`update.yml`）でフォロー先と一緒に収集されます（`TWC_API` 環境変数で指定）。

## ローカルで試す

```bash
npx wrangler d1 execute twc-ratings --local --file=schema.sql
echo 'SESSION_SECRET=dev-secret' > .dev.vars
npx wrangler dev        # http://localhost:8787
```

このときは `index.html` の `TWC_API` を `http://localhost:8787` にして、`ALLOWED_ORIGINS` に、サイトを開いているオリジンを追加してください。

## チャット

全員で入る1つの部屋です。読むだけならログイン不要、投稿はログイン（Scratchコメント認証）が必要です。テーブルが増えているので、更新時は次を実行してください。

```bash
cd worker
npx wrangler d1 execute twc-ratings --remote --file=schema.sql
npx wrangler deploy
```

- 1メッセージ300字まで。連投は2秒以上あける、1分15件まで。
- 通報が3件たまったメッセージは自動で非表示になります（管理者は画面で「再表示」できます）。
- 管理者（`ADMIN_USERS`）は、削除・非表示・投稿禁止ができます。
- リンクは自動では開けないよう、テキストとしてだけ表示します。

### チャットの部屋

部屋は「3D」「数学」「物理」「三角形」の4つです（`index.js` の `CHAT_ROOMS`）。すでにチャットを使っているDBでは、**先に1回だけ**次を実行してから、デプロイしてください。既存のメッセージは「3D」の部屋に入ります。

```bash
cd worker
npx wrangler d1 execute twc-ratings --remote --file=migrate_chat_rooms.sql
npx wrangler deploy
```

新しくDBを作る場合は、`schema.sql` だけで足ります。


## チャットのタグ・返信・通知

- **タグ:** スタジオ [51603915](https://scratch.mit.edu/studios/51603915/) のキュレター・マネージャーに `TWC`、[32030084](https://scratch.mit.edu/studios/32030084/) のキュレター・マネージャーに `GAS` が付きます（両方なら2つ）。Scratchから1時間ごとに取り直します（取得に失敗したら前の結果を使い、5分後に再試行）。スタジオIDとタグ名は `src/index.js` の `STUDIO_TAGS` で変えられます。
- **返信:** `POST /api/chat/messages` に `reply_to`（同じ部屋のメッセージID）を付けます。
- **メンション:** 本文の `@ユーザー名` を通知します（1メッセージ5人まで）。返信と重複する人には、通知は1件だけです。自分宛ては作りません。
- **通知:** `GET /api/notifications`（一覧・未読数・`mode`）、`GET /api/notifications/count`（未読数）、`POST /api/notifications/read`（`{id}` か `{upto: メッセージID}` か `{all:true}`）。30日で消えます。削除・非表示になったメッセージの通知は出ません。

### 通知の範囲（すべてのメッセージ / 返信・メンションだけ）

ヘッダー右上の設定メニュー（言語などがあるところ）の「通知する範囲」で、人ごとに選べます。同じ場所で、この端末への通知（Web Push）のオン/オフもできます。サイトを開いてすぐ（ログイン中で、この端末が未設定のとき）、「通知をオンにしますか？」という案内も出ます（「あとで」で7日間は非表示）。**初期設定は「すべてのメッセージ」**です（設定をしていない人も同じ）。

| mode | 通知されるもの |
| --- | --- |
| `all`（初期設定） | 返信・メンションに加えて、**自分以外の全部屋の発言** |
| `mentions` | 返信・メンションだけ |

- `GET /api/notifications/settings` → `{mode}`、`PUT /api/notifications/settings` `{mode: "all" | "mentions"}` → `{mode, unread}`（要ログイン）。設定は `notif_prefs` テーブルに保存します。
- **ベルの未読:** 「すべて」の発言は、人数分の通知の行を書きません（D1の書き込みの節約）。`notif_prefs.all_seen_id` より後の発言を未読として数え、100件で打ち切ります（画面は `99+`）。返信・メンションの通知がすでにある発言は、そちらで1回だけ数えます。発言を開くと、その発言までが既読になります。「すべて既読」で全部が既読になります。
- **設定を「返信・メンションだけ」→「すべて」に変えた瞬間**は、いまの最新までを既読にします（昔の発言がまとめて未読にならないように）。はじめて使う人も、いまの最新から始まります。
- **端末への通知（Web Push）:** 返信・メンションされた人には、設定に関係なく届きます。そのあと、残りの枠（1回の投稿につき最大 `MAX_PUSH_SEND` = 40台）を、「すべて」の人の端末にあてます。登録が40台を超えるときは、毎回ランダムに選びます。通常の発言の通知は、返信・メンションの通知を置き換えないよう、別のタグで送ります。

新しいテーブル `notif_prefs` があるので、更新時は次を実行します（既存のデータは消えません）。**先にこちらを実行してから、Workerをデプロイしてください。**

```bash
cd worker
npx wrangler d1 execute twc-ratings --remote --file=schema.sql
npx wrangler deploy
```

## チャットの動画（Backblaze B2）

チャットに動画（MP4 / WebM・20MBまで・1人1日3本）を添付できます。写真（JPEG / PNG / WebP / GIF を選べる。ブラウザで長辺1280pxのJPEGに縮小・再圧縮してから送るので、位置情報などのEXIFも消える。サーバー側の上限は5MB・1人1日10枚）も同じ仕組みで送れます。写真は動画とは別に数え、メッセージには `image` として返ります（動画は `video`）。設定は [B2_SETUP.md](B2_SETUP.md) を見てください。未設定なら動画機能は無効です。

- `POST /api/chat/videos/start` `{size, type}`: B2への一時的なアップロードURLを返す（要ログイン）
- `POST /api/chat/videos/:id/complete`: アップロード後に実サイズを確認する（大きすぎたら消す）
- `DELETE /api/chat/videos/:id`: 投稿前の動画を取り消す
- `POST /api/chat/messages` に `video_id` を付けて投稿する。メッセージを削除すると動画も消える。
- `GET /api/chat/messages?room=...&since=<ID>`: そのIDより新しいメッセージだけを返す（自動更新用。読み取りが軽い）

チャットの本文に貼ったScratchの作品・YouTube・ニコニコ動画のURLは、サイト側でクリックして再生できるカードになります（Workerの設定は不要）。

## ジャンル・ランキング・プロフィール・管理・未読

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/genres?genre=3d` | そのジャンルで確定した作品IDの一覧（公開） |
| GET | `/api/genres/project/:id` | `{confirmed, votes, mine}` |
| PUT / DELETE | `/api/genres/project/:id/:genre` | 投票 / 取り消し（要ログイン）。2人以上、または TWC・GAS のキュレーター/マネージャー1人で確定 |
| GET | `/api/ranking/weekly` | 直近7日の評価で並べた今週のランキング |
| POST | `/api/ratings/stats` | `{ids}` の作品が受けた評価のまとめ |
| GET | `/api/users/:name/profile` | タグ・チャット投稿数・つけた評価数 |
| GET | `/api/chat/latest` | 部屋ごとの最新メッセージID（未読の点に使う） |
| GET | `/api/admin/chat/reports`, `/api/admin/chat/bans` | 管理画面用（管理者のみ） |

新しいテーブル `project_genres` があるので、更新時は次を実行します。

```
npx wrangler d1 execute twc-ratings --remote --file=schema.sql
npx wrangler deploy
```

## 無料枠の節約（評価の静的ファイル化・自動更新・B2）

### 評価を静的ファイル（docs/ratings.json）で配る
順位表・評価数・今週のランキングは、GitHub Actions（`.github/workflows/ratings.yml`、6時間おき）が
`build_ratings.py` で計算して `docs/ratings.json` に書き出します。サイトはこのファイルを GitHub Pages から読むので、
**表示のためにWorker/D1を使いません**（ファイルが読めないときだけ、従来のAPIに戻ります）。

初回だけ、次の準備が要ります。

1. 合言葉を作る: `openssl rand -hex 24`
2. Worker に登録: `cd worker && npx wrangler secret put EXPORT_TOKEN`（上の値を貼る）→ `npx wrangler deploy`
3. GitHub のリポジトリ → Settings → Secrets and variables → Actions → New repository secret
   名前 `EXPORT_TOKEN`、値は同じもの
4. Actions → Update Ratings → Run workflow（最初の `ratings.json` を作る）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/ratings/export` | 全評価の書き出し。`Authorization: Bearer <EXPORT_TOKEN>` が合うときだけ（Actions用） |
| GET | `/api/ratings/mine` | 自分がつけた評価を全部返す（要ログイン）。画面は作品ごとに問い合わせず、これを1回だけ使う |
| GET | `/api/chat/latest` | 部屋ごとの最新ID。ログイン中は通知の未読数 `unread` も返す（通知の定期確認が不要） |

スコアは、評価者ごとの偏差値で甘辛をならし、「自分以外の平均との相関」で評価者の重みを決め、
評価が少ない作品は全体の平均に少し寄せます（`build_ratings.py` の説明を参照）。
`python3 build_ratings.py --selftest` で計算だけ試せます。

### チャットの自動更新
新しい発言がないあいだは、確認の間隔を8秒から最大60秒まで延ばします。画面が見えていないとき、
10分操作がないときは確認しません。未読の点と通知の数は、90秒おきの1回の確認にまとめています。

### B2 の転送量
- 閲覧URLの署名時刻を3日ごとに区切り、同じファイルのURLを3日間変えません（ブラウザが保存したものを使い回せる）。
- 閲覧URLに `response-cache-control`（既定7日）を付けて、ブラウザに長く覚えさせます。
  B2が受け付けず見られなくなった場合は、`wrangler.toml` の `VIEW_CACHE_SECONDS = "0"` にして再デプロイすると外れます。
- 動画は再生を押すまで読み込みません。写真は画面に入るまで読み込みません。

## チャット翻訳（Google Apps Script）

スマートフォンでログイン中、ブラウザ内蔵の翻訳APIが使えない場合は、Worker の `POST /api/chat/translate` 経由で Google Apps Script（`LanguageApp.translate`）を利用します。翻訳済みの文章は D1 の `chat_translations` に保存し、同じメッセージ・言語の再翻訳を避けます。失敗時は端末内の翻訳にフォールバックします。

- GAS スクリプト: `translate.gs`。Web アプリとして公開し、スクリプトプロパティ `TWC_SECRET` を設定します。
- Worker のシークレット: `TRANSLATE_URL`（GAS の `/exec` URL）と `TRANSLATE_SECRET`（GAS の `TWC_SECRET` と同じ値）。
- D1 の初回セットアップ: `npx wrangler d1 execute twc-ratings --remote --file=migrate_translate.sql`
- Worker の反映: `npx wrangler deploy`

GAS 側は日本語・英語の翻訳に対応し、1回の要求で最大20件、各1,000文字まで処理します。Worker 側ではログイン必須・ユーザーごとの利用回数制限・サイト全体の日次上限を適用します。
