TWC ホームサーバー（Mac 版）と Scratch連携 の入れ方
==========================================================
以下は全部、ターミナル（Launchpad > その他 > ターミナル）で行います。
フォルダは ~/twc-chat-host を使う想定です。

【0】Node.js を入れる（22.13 以上）
    brew install node
    node -v
  brew が無ければ https://brew.sh の1行を先に実行。

【1】チャットホストのファイルを置く
  今までの twc_chat_*.zip（server.mjs などが入っているもの）を展開して、中身を ~/twc-chat-host に置く。
    mkdir -p ~/twc-chat-host
    cd ~/Downloads && unzip -o 展開したいzip名.zip -d ~/twc-chat-host
  ※ .bat と .ps1 は Windows 用なので使いません（Mac では mac フォルダのものを使う）。

【2】設定と引っ越し（Windows から移す場合）
  Windows の C:\twc-chat-host から、次の3つを Mac の ~/twc-chat-host にコピーする（USBやAirDropで）。
    .env          設定（パスワード類。誰にも見せない）
    vapid.json    通知の鍵（あれば）
    data/chat.db  今までのチャットの中身（data フォルダごと）
  .env の中で Windows のパスが書いてあれば直す。
    DB_PATH=./data/chat.db       ← そのままでOK
    BACKUP_DIR=./backup          ← 別のディスクなら /Volumes/名前/backup
  新規で始めるなら:  cp .env.example .env  して中を埋める。

【3】Scratch連携を足す（1回だけ。もう一度やっても安全）
    cd ~/Downloads/展開したこのZIPのフォルダ
    node apply_scratchlink.mjs ~/twc-chat-host
  ~/twc-chat-host/.env.bak-scratchlink などの控えが自動で作られます。

【4】Scratchのログイン情報を .env に足す（専用アカウント推奨）
    cd ~/twc-chat-host
    printf 'SCRATCH_USER=ユーザー名\nSCRATCH_PASS=パスワード\n' >> .env
  Cookie(SCRATCH_SESSION)は不要です。パスワードでログインします。

【5】起動
    cd ~/twc-chat-host
    cp ~/Downloads/このZIPのフォルダ/mac/start.command .
    chmod +x start.command
    ./start.command
  「scratch-link: 通知は15秒ごと…」と出れば成功。止める: Control+C
  Finder から ダブルクリックでも起動できます（初回は右クリック > 開く）。

【6】自動起動（Macにログインしたら勝手に動く）
    cd ~/twc-chat-host
    cp ~/Downloads/このZIPのフォルダ/mac/autostart-install.sh .
    bash autostart-install.sh
    tail -f data/server.log        ← ログを見る（Control+Cで抜ける）
  止める: launchctl unload ~/Library/LaunchAgents/com.twc.chathost.plist
  ※ スリープ対策: システム設定 > バッテリー(省エネルギー) で「電源接続時はスリープさせない」にする。

【7】外から見えるようにする（Tailscale Funnel）
    brew install --cask tailscale     （アプリを開いてログイン）
    tailscale funnel --bg 8787
  表示された https://….ts.net のURLを .env の PUBLIC_URL に入れ、サイト側の接続先もそれに合わせる。
  ※ Mac App Store 版の場合 tailscale コマンドは
    /Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8787

【翻訳（任意）】
  Ollama: brew install ollama && ollama pull qwen2.5:7b
  NLLB:   cd ~/twc-chat-host && npm install
  PLaMo は Windows 用の llama-server.exe なので、Mac では使わず Ollama を使ってください。

【困ったとき】
  ・node: command not found      → brew install node。入れた後ターミナルを開き直す
  ・EADDRINUSE（ポート使用中）   → lsof -i :8787 で相手を確認、kill PID
  ・Permission denied            → chmod +x start.command
  ・Scratch連携のつかいかたは README-scratchlink.txt（「set」は export に、C:\… は ~/ に読み替え）
