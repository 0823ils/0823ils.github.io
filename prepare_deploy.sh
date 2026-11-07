#!/bin/bash
# GitHub Pages 公開用の準備スクリプト
# 実行すると docs/ フォルダに公開ファイルが揃う

cd "$(dirname "$0")"

echo "=== デプロイ準備 ==="

# 1. DBをWALモードから通常モードに変換（単一ファイルにまとめる）
echo "DBを最適化中..."
sqlite3 projects.db "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"

# 2. docs/ フォルダを作成
mkdir -p docs

# 3. 必要なファイルをコピー
cp index.html docs/index.html
cp projects.db docs/projects.db

# 4. 検索エンジン向けの静的ページ（作品・ユーザー・sitemap）を生成
python3 generate_pages.py projects.db docs

DB_SIZE=$(du -sh docs/projects.db | cut -f1)
echo ""
echo "完了！"
echo "  docs/index.html  → フロントエンド"
echo "  docs/projects.db → データベース (${DB_SIZE})"
echo ""
echo "=== GitHub Pages の設定手順 ==="
echo "1. GitHubでリポジトリを作成（または既存のリポジトリを使う）"
echo "2. docs/ フォルダごとpush:"
echo "     git add docs/"
echo "     git commit -m 'deploy'"
echo "     git push"
echo "3. GitHub → Settings → Pages"
echo "   → Source: Deploy from a branch"
echo "   → Branch: main, /docs フォルダを選択"
echo "   → Save"
echo ""
echo "数分後に https://<ユーザー名>.github.io/<リポジトリ名>/ で公開されます"
