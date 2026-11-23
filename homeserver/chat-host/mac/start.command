#!/bin/bash
# ダブルクリックでも、ターミナルから ./start.command でも起動できる
cd "$(dirname "$0")" || exit 1
NODE="$(command -v node || true)"
[ -z "$NODE" ] && for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$p" ] && NODE="$p"; done
if [ -z "$NODE" ]; then echo "Node.js が見つかりません。ターミナルで: brew install node"; read -r -p "Enterで閉じる"; exit 1; fi
if [ ! -f .env ]; then echo ".env がありません。README-mac.txt の手順2を先にやってください"; read -r -p "Enterで閉じる"; exit 1; fi
if [ ! -f server.mjs ]; then echo "server.mjs がありません。このフォルダが違います"; read -r -p "Enterで閉じる"; exit 1; fi
mkdir -p data backup files
# スリープで止まらないようにして起動（caffeinate は Mac 標準）
exec caffeinate -i "$NODE" --env-file=.env --disable-warning=ExperimentalWarning server.mjs
