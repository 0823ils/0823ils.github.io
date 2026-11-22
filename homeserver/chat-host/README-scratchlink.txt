Scratch連携（Scratchの通知をプッシュで知らせる／クラウド変数の履歴をずっと保存する）

C:\twc-chat-host に足す手順
1. サーバーを止める（Ctrl+C）。念のため、フォルダと data\chat.db の控えを取る
2. このZIPを、C:\twc-chat-host とは別の場所（例: デスクトップ）に展開する
3. コマンドプロンプトで:
     cd 展開した場所
     node apply_scratchlink.mjs C:\twc-chat-host
   server.mjs / worker\index.js / schema.sql に数行だけ足し、scratchlink.mjs を置きます（上書きではありません）。
   変えたファイルの控えは「○○.bak-scratchlink」に残ります。何度実行しても二重には足しません
4. start.bat で起動する。表示に「scratch-link: 60秒ごとに…」が出れば成功

使い方
- TWC にログイン → 設定（右上） → 「Scratch連携を開く」（大きな画面が開きます。通知タブとクラウド変数タブがあります）
  ・Scratchに通知が来たら、TWCのプッシュ通知でも知らせる（先に「この端末に通知」をオン）
  ・作品のID（URLでも可）を登録 → クラウド変数の履歴が、このPCに保存され続ける。変数を押すと、値の移り変わりのグラフと履歴が出て、CSVでも保存できる
- すでに前の版を入れている場合も、同じ手順で新しい版に入れ替わります
- 登録できるのは自分の作品だけ（作者を、Scratchに問い合わせて確かめます）
- 履歴は chat.db の cv_log テーブルに入ります

メモ
- 変更履歴は1回40件ずつ読みます。60秒のあいだに40回より多く変わる変数は、取りこぼします（.env の SCRATCH_LINK_INTERVAL=20 で短くできます。最短20秒）
- Cloudflare 側（wrangler deploy）は、この機能には不要です
- 外からは /api/scratchlink と /api/cloudsave だけ呼べます。サーバー内部用の /api/home/* は、外からは届きません

保存した値を自分の作品に書き戻す（任意）
  Python と scratchattach が要ります（uv が入っていれば）:
    set SCRATCH_USER=ユーザー名
    set SCRATCH_PASS=パスワード
    set TWC_HOME_DB=C:\twc-chat-host\data\chat.db
    uv run --python 3.12 --with scratchattach python twc_home.py restore 作品ID
  （twc_home.py はこのZIPに入っています。専用アカウントで使ってください）

書き込み（クラウド変数の自動返信）
- 「Scratch連携」の「書き込み」タブで、ルールを作ります（作品を先に登録）
    読み込み: 受け取る変数(例 SAVE)にIDが入ると、返事の変数(例 SAVEDATA)が「IDの桁数(1桁)+ID+保存してあるデータ」になる
    保存    : 受け取る変数に「IDの桁数(1桁)+ID+データ」が入ると、データだけをIDごとに保存する（返事の変数を決めれば、同じ値を書いて知らせる）
    計算    : 受け取る変数に値が入ると、式（v=受け取った値。例 v*2+1）の結果を返事の変数に書く。「受け取った値も返す」で、先頭に「桁数+値」が付く
  例）IDが1234、データが98765 → 保存する値は 4 1234 98765 → 41234 98765（くっつけて 4123498765）
- 書き込みには、専用のScratchアカウントが要ります。家のサーバーの .env に次を足してください
    SCRATCH_USER=専用アカウントのユーザー名
    SCRATCH_SESSION=そのアカウントでログインしたブラウザの Cookie「scratchsessionsid」の値
  （メインのアカウントは使わない。自分の作品にだけ使う）
- つなぎ直すときは、サーバーを再起動してください。ルールは、10秒ごとに読み直します
- 受け取る変数と返事の変数がぐるぐる回る組み合わせは、作れません
- Scratchの決まりで、値は数字だけ・256桁まで、書き込みは1秒に8回までです
