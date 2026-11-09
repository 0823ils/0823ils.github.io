# 動画機能（Backblaze B2）の設定手順

チャットに動画（MP4 / WebM、20MBまで、1人1日3本）を送れるようにするための設定です。
設定しないままでも、サイトは今までどおり動きます（動画のボタンが出ないだけです）。

動画の流れ: ブラウザ → B2 に直接アップロード → チャットのメッセージに動画をひもづけ。
B2の動画は14日で自動削除されます。メッセージを削除すると、動画も消えます。

## 1. アカウントとバケット

1. https://www.backblaze.com/ で B2 Cloud Storage のアカウントを作ります（無料枠は10GB）。
2. **Buckets → Create a Bucket** を開きます。
   - Bucket Unique Name: 好きな名前（例 `twc-videos`）。これが `B2_BUCKET` です。
   - Files in Bucket are: **Public**（動画をそのまま再生するため）
   - Default Encryption / Object Lock: どちらも無効のままで構いません。
3. 作ったバケットの詳細に、**Endpoint**（例 `s3.us-west-004.backblazeb2.com`）が出ます。これが `B2_ENDPOINT` です。

## 2. 14日で自動削除する（ライフサイクル）

バケットの **Lifecycle Settings** で「Use custom lifecycle rules」を選び、次を入れます。

- File Path: `v/`
- Days Till Hide: `14`
- Days Till Delete: `1`

（アップロードしたのに投稿されなかった動画も、これで片付きます。日数を変えたときは、`wrangler.toml` の `VIDEO_TTL_DAYS` も同じ値にしてください。）

## 3. CORS（ブラウザからの直接アップロードを許可）

バケットの **CORS Rules** で、次の内容のルールを作ります。画面で選べない場合は、B2のコマンドラインツール（`b2`）で設定します。

```bash
b2 bucket update --cors-rules '[
  {
    "corsRuleName": "twc-chat-media",
    "allowedOrigins": ["https://0823ils.github.io"],
    "allowedOperations": ["s3_put", "s3_get", "s3_head"],
    "allowedHeaders": ["*"],
    "exposeHeaders": ["ETag"],
    "maxAgeSeconds": 3600
  }
]' バケット名 allPublic
```

（古いバージョンの `b2` では `b2 update-bucket --corsRules '...' バケット名 allPublic` です。）
ローカルで試すときは、`allowedOrigins` に `http://localhost:5001` も足します。

## 4. アプリケーションキー

**Application Keys → Add a New Application Key** で作ります。

- Name: 好きな名前（例 `twc-worker`）
- Allow access to Bucket(s): **作ったバケットだけ**
- Type of Access: **Read and Write**
- 表示される **keyID** と **applicationKey** をメモします（applicationKey は一度しか表示されません）。

## 5. Worker に設定する

`worker/wrangler.toml` の `[vars]` を埋めます。

```toml
B2_ENDPOINT = "s3.us-west-004.backblazeb2.com"            # 手順1の Endpoint
B2_BUCKET = "twc-videos"                                    # バケット名
VIDEO_BASE_URL = "https://twc-videos.s3.us-west-004.backblazeb2.com"   # https://バケット名.Endpoint
VIDEO_TTL_DAYS = "14"
```

キーはシークレットとして登録します（ファイルには書きません）。

```bash
cd worker
npx wrangler secret put B2_KEY_ID        # keyID を貼る
npx wrangler secret put B2_APP_KEY       # applicationKey を貼る
npx wrangler d1 execute twc-ratings --remote --file=schema.sql
npx wrangler deploy
```

## 6. 動作確認

1. サイトを開き直して、チャットを開きます。入力欄の左にビデオのボタンが出ていれば、設定できています。
2. 小さいMP4を選んで、アップロード → 送信 → 再生できるか確認します。
3. 失敗するときの目安:
   - ボタンが出ない → 変数かシークレットが足りません（`wrangler deploy` のやり直しも確認）。
   - 「アップロードに失敗しました」→ CORS の設定（手順3）か、`allowedOrigins` のURLを確認してください。
   - 送信後に再生できない → バケットが Public か、`VIDEO_BASE_URL` が合っているか確認してください。

## 無料枠について

- B2の無料枠は、保存10GBです。ダウンロード（再生）は、1日あたりの無料量に上限があります（最新の条件は、Backblazeの料金ページで確認してください）。
- 動画は `preload="none"` で、再生ボタンを押したときだけ読み込みます。転送量を節約するためです。


## 非公開（Private）バケットで使う場合（カード登録なし）

バケットを Private で作った場合は、`wrangler.toml` の `VIDEO_BASE_URL` を **空のまま** にします。
Worker が、見るたびに6時間有効の署名つきURLを作って返します（1時間ごとに切り替わるので、ブラウザはキャッシュできます）。
動画・写真のアップロードと14日での自動削除は、Public の場合と同じ設定です。
後から Public に切り替えたら、`VIDEO_BASE_URL` にバケットのURLを入れて再デプロイしてください。
