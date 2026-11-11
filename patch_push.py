#!/usr/bin/env python3
"""
端末への通知（Web Push）を足す。返信・メンションの通知を、スマホやパソコンにも届ける。
リポジトリのルートで実行:  python3 patch_push.py
（worker/push_block.js と push_client.js を、同じ場所に置いておくこと）
書き換える場所が見つからなければ、何も変更せずに止まる。
"""
import os
import sys


def rep(s, old, new):
    n = s.count(old)
    if n != 1:
        sys.exit("書き換えの場所が見つかりません（%d 件）: %s\n何も変更していません。" % (n, old[:70]))
    return s.replace(old, new)


def need(p):
    if not os.path.exists(p):
        sys.exit(p + " が見つかりません。リポジトリのルートで、zipを解凍してから実行してください。")


for p in ("worker/src/index.js", "worker/wrangler.toml", "worker/schema.sql", "worker/README.md",
          "worker/push_block.js", "push_client.js", "index.html", "docs/sw.js"):
    need(p)

w = open("worker/src/index.js", encoding="utf-8").read()
toml = open("worker/wrangler.toml", encoding="utf-8").read()
schema = open("worker/schema.sql", encoding="utf-8").read()
readme = open("worker/README.md", encoding="utf-8").read()
h = open("index.html", encoding="utf-8").read()
block = open("worker/push_block.js", encoding="utf-8").read()
client = open("push_client.js", encoding="utf-8").read()

if "pushNotify" in w or "togglePush" in h:
    sys.exit("すでに適用済みです。")

# ================= Worker =================
# 送信を、応答のあとに回せるように、ctx（waitUntil）を渡す
w = rep(w, "  async fetch(request, env) {\n    const cors = corsHeaders(request, env);",
        "  async fetch(request, env, ctx) {\n    const cors = corsHeaders(request, env);")
w = rep(w, "      res = await route(request, env);", "      res = await route(request, { ...env, __ctx: ctx });")
w = rep(w, "  if (path === '/api/notifications' && method === 'GET') return notifList(request, env);",
        "  if (path === '/api/push/key' && method === 'GET') return pushKey(env);\n"
        "  if (path === '/api/push/subscribe' && method === 'POST') return pushSubscribe(request, env);\n"
        "  if (path === '/api/push/subscribe' && method === 'DELETE') return pushUnsubscribe(request, env);\n"
        "  if (path === '/api/notifications' && method === 'GET') return notifList(request, env);")
w = rep(w, "// ---------- 動画（Backblaze B2 / S3互換API） ----------", block + "// ---------- 動画（Backblaze B2 / S3互換API） ----------")
# 返信・メンションの通知を作ったあとに、端末にも送る
w = rep(w, "  await env.DB.batch(stmts);\n\n  return json({ message: { id, user_id: user.uid, username: user.u, content, created_at: now, hidden: false, tags: [] } }, 201);",
        "  await env.DB.batch(stmts);\n  pushNotify(env, targets, user.u, room, id, snippet);   // 端末への通知（待たずに送る）\n\n"
        "  return json({ message: { id, user_id: user.uid, username: user.u, content, created_at: now, hidden: false, tags: [] } }, 201);")

toml = rep(toml, 'VIEW_CACHE_SECONDS = "604800"',
           'VIEW_CACHE_SECONDS = "604800"\n'
           '# 端末への通知（Web Push）。公開鍵は worker/setup_push.sh が書き込む。秘密鍵は Secret（VAPID_PRIVATE_KEY）に入れる\n'
           'VAPID_PUBLIC_KEY = ""\n'
           'VAPID_SUBJECT = "https://0823ils.github.io/"')

schema += """
-- 端末への通知（Web Push）の宛先
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  username TEXT NOT NULL,          -- 小文字
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(username, created_at);
"""

readme += """
## 端末への通知（Web Push）

返信・@メンションの通知を、スマホやパソコンの通知としても届けます（画面を閉じていても届きます）。

```bash
cd worker
npx wrangler d1 execute twc-ratings --remote --file=migrate_push.sql   # 宛先の表（1回だけ）
bash setup_push.sh                                                      # 鍵を作って設定（1回だけ。作り直すと登録済みの端末が止まる）
npx wrangler deploy
```

- 鍵（VAPID）の秘密鍵は Secret の `VAPID_PRIVATE_KEY`、公開鍵は `wrangler.toml` の `VAPID_PUBLIC_KEY` です。
- iPhone・iPad は、Safariの「ホーム画面に追加」をしたアプリからだけ、設定できます（iOS 16.4以降）。
- 端末ごとに、通知メニューの「この端末に通知を送る」を押して、許可してもらいます。
"""

# ================= 画面 =================
h = rep(h, '<link rel="apple-touch-icon" href="/favicon-192.png">',
        '<link rel="apple-touch-icon" href="/favicon-192.png">\n'
        '    <link rel="manifest" href="/manifest.webmanifest">\n'
        '    <meta name="theme-color" content="#4D97FF">\n'
        '    <meta name="apple-mobile-web-app-capable" content="yes">\n'
        '    <meta name="apple-mobile-web-app-title" content="scratch-TWC">')
h = rep(h, '<div class="notif-list" id="notif-list"></div>',
        '<div class="notif-list" id="notif-list"></div>\n'
        '                <div class="notif-foot"><button id="push-btn" onclick="togglePush()" style="display:none"></button><div id="push-note"></div></div>')
h = rep(h, "        .notif-empty {",
        "        .notif-foot { padding: 9px 14px; border-top: 1px solid #f0f0f0; }\n"
        "        .notif-foot button { padding: 6px 12px; border-radius: 14px; border: 1px solid #ddd; background: #fff; color: #4D97FF; font-size: 12px; font-weight: bold; cursor: pointer; }\n"
        "        .notif-foot button:disabled { opacity: 0.5; cursor: default; }\n"
        "        #push-note { color: #888; font-size: 12px; line-height: 1.5; }\n"
        "        .notif-empty {")
h = rep(h, "// ===== チャット =====\nvar CHAT_T = {", client + "// ===== チャット =====\nvar CHAT_T = {")
h = rep(h, "    document.getElementById('notif-btn').classList.add('open');\n    loadNotifs();\n}",
        "    document.getElementById('notif-btn').classList.add('open');\n    loadNotifs();\n    refreshPushUI();\n}")
h = rep(h, "if (uid !== notifUser) { notifUser = uid; setNotifBadge(0); if (uid) refreshNotifCount(); }",
        "if (uid !== notifUser) { notifUser = uid; setNotifBadge(0); if (uid) { refreshNotifCount(); syncPushSub(); } }")
h = rep(h, "function logout() {\n    clearLogin();\n    closeLogin();\n}",
        "async function logout() {\n"
        "    // この端末への通知をやめてから、ログアウトする（1.5秒待っても終わらなければ、先に進む）\n"
        "    await Promise.race([pushUnbind(), new Promise(function(r) { setTimeout(r, 1500); })]);\n"
        "    clearLogin();\n    closeLogin();\n}")

open("worker/src/index.js", "w", encoding="utf-8").write(w)
open("worker/wrangler.toml", "w", encoding="utf-8").write(toml)
open("worker/schema.sql", "w", encoding="utf-8").write(schema)
open("worker/README.md", "w", encoding="utf-8").write(readme)
open("index.html", "w", encoding="utf-8").write(h)
os.makedirs("docs", exist_ok=True)
open(os.path.join("docs", "index.html"), "w", encoding="utf-8").write(h)
print("OK: worker/src/index.js、worker/wrangler.toml、worker/schema.sql、worker/README.md、index.html、docs/index.html を更新しました")
