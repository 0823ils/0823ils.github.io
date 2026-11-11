#!/usr/bin/env python3
"""
チャットで、最新50件より前のメッセージも読めるようにする（「以前のメッセージを読み込む」ボタン）。
DBには、古いメッセージもすべて残っている。見えなかったのは、表示が最新50件だけだったため。
リポジトリのルートで実行:  python3 patch_older.py
書き換える場所が見つからなければ、何も変更せずに止まる。
"""
import os
import sys


def rep(s, old, new):
    n = s.count(old)
    if n != 1:
        sys.exit("書き換えの場所が見つかりません（%d 件）: %s\n何も変更していません。" % (n, old[:70]))
    return s.replace(old, new)


for p in ("worker/src/index.js", "index.html"):
    if not os.path.exists(p):
        sys.exit(p + " が見つかりません。リポジトリのルートで実行してください。")

w = open("worker/src/index.js", encoding="utf-8").read()
h = open("index.html", encoding="utf-8").read()
if "before=" in w and "chatLoadOlder" in h:
    sys.exit("すでに適用済みです。")

# ---------- Worker: before=<ID> で、それより古いメッセージを返す ----------
w = rep(w, "  const since = sinceRaw !== null && /^\\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : null;\n  if (since === null) await syncStudioRoles(env);\n",
        "  const since = sinceRaw !== null && /^\\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : null;\n"
        "  // before=<先頭のID> のときは、それより古いメッセージを返す（「以前のメッセージを読み込む」用）\n"
        "  const beforeRaw = url.searchParams.get('before');\n"
        "  const before = beforeRaw !== null && /^\\d{1,12}$/.test(beforeRaw) ? Number(beforeRaw) : null;\n"
        "  if (since === null && before === null) await syncStudioRoles(env);\n")
w = rep(w, "WHERE m.room = ? ${since !== null ? 'AND m.id > ?' : ''} AND m.deleted = 0",
        "WHERE m.room = ? ${since !== null ? 'AND m.id > ?' : before !== null ? 'AND m.id < ?' : ''} AND m.deleted = 0")
w = rep(w, ".bind(...(since !== null ? [room, since, CHAT_PAGE] : [room, CHAT_PAGE])).all();",
        ".bind(...(since !== null ? [room, since, CHAT_PAGE] : before !== null ? [room, before, CHAT_PAGE] : [room, CHAT_PAGE])).all();")
w = rep(w, "partial: since !== null, video_enabled: videoEnabled(env) });",
        "partial: since !== null, has_more: since === null && list.length >= CHAT_PAGE, video_enabled: videoEnabled(env) });")

# ---------- 画面: 「以前のメッセージを読み込む」ボタン ----------
h = rep(h, "        .chat-act:hover {",
        "        .chat-older-btn { display: block; margin: 6px auto 10px; padding: 6px 14px; border-radius: 14px; border: 1px solid #ddd; background: #fff; color: #4D97FF; font-size: 12px; font-weight: bold; cursor: pointer; }\n"
        "        .chat-older-btn:hover { border-color: #4D97FF; }\n"
        "        .chat-older-btn:disabled { opacity: 0.5; cursor: default; }\n"
        "        .chat-act:hover {")
h = rep(h, "// partialOk のときは、前回より新しいメッセージだけを取る",
        "// ===== 以前のメッセージを読み込む =====\n"
        "var chatHasMore = false;     // これより古いメッセージが、まだあるか\n"
        "var chatOlderBusy = false;\n"
        "\n"
        "// 一覧を描くたびに、先頭に「以前のメッセージを読み込む」ボタンを付ける\n"
        "var renderChatBase = renderChat;\n"
        "renderChat = function(msgs, forceScroll) {\n"
        "    renderChatBase(msgs, forceScroll);\n"
        "    if (!chatHasMore || !msgs.length) return;\n"
        "    var box = document.getElementById('chat-list');\n"
        "    box.insertAdjacentHTML('afterbegin', '<button class=\"chat-older-btn\" id=\"chat-older\" onclick=\"chatLoadOlder()\">' +\n"
        "        (currentLang === 'en' ? 'Load older messages' : '以前のメッセージを読み込む') + '</button>');\n"
        "};\n"
        "\n"
        "async function chatLoadOlder() {\n"
        "    if (chatOlderBusy || !chatMsgs.length) return;\n"
        "    chatOlderBusy = true;\n"
        "    var room = chatRoom;\n"
        "    var btn = document.getElementById('chat-older');\n"
        "    if (btn) btn.disabled = true;\n"
        "    try {\n"
        "        var d = await apiCall('GET', '/api/chat/messages?room=' + encodeURIComponent(room) + '&before=' + chatMsgs[0].id);\n"
        "        if (room !== chatRoom) return;\n"
        "        var box = document.getElementById('chat-list');\n"
        "        var prevH = box.scrollHeight, prevT = box.scrollTop;\n"
        "        chatMsgs = d.messages.concat(chatMsgs);\n"
        "        chatHasMore = !!d.has_more;\n"
        "        chatSig = '';\n"
        "        renderChat(chatMsgs, false);\n"
        "        box.scrollTop = prevT + (box.scrollHeight - prevH);   // 読んでいた位置を動かさない\n"
        "    } catch (e) { setChatMsg(chatErr(e)); }\n"
        "    finally { chatOlderBusy = false; }\n"
        "}\n"
        "\n"
        "// partialOk のときは、前回より新しいメッセージだけを取る")
# 新着を足すとき、読み込んだ古いメッセージを切り捨てない（上限は300件）
h = rep(h, "chatMsgs = chatMsgs.concat(d.messages).slice(-50);", "chatMsgs = chatMsgs.concat(d.messages).slice(-300);")
# 最新を取り直すとき（削除・非表示の反映）も、読み込んだ古い分は残す
h = rep(h, "        chatMsgs = d.messages;\n        var sig = d.messages.map(",
        "        var firstId = d.messages.length ? d.messages[0].id : 0;\n"
        "        var keepOld = chatMsgs.filter(function(m) { return m.id < firstId; });\n"
        "        if (!keepOld.length) chatHasMore = !!d.has_more;\n"
        "        chatMsgs = keepOld.concat(d.messages);\n"
        "        var sig = chatMsgs.map(")
h = rep(h, "renderChat(d.messages, forceScroll);", "renderChat(chatMsgs, forceScroll);")

open("worker/src/index.js", "w", encoding="utf-8").write(w)
open("index.html", "w", encoding="utf-8").write(h)
os.makedirs("docs", exist_ok=True)
open(os.path.join("docs", "index.html"), "w", encoding="utf-8").write(h)
print("OK: worker/src/index.js、index.html、docs/index.html を更新しました")
