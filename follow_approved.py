#!/usr/bin/env python3
"""
TWC-ils が承認したユーザーを、Scratchアカウント（既定: TWC-ils）でフォローする。

  1. Worker の /api/applications/approved-users から承認済みユーザーを取る
  2. Scratch公開APIで、自分が既にフォローしている人を取る
  3. 未フォローの人だけ scratchattach でフォローする（1回あたり MAX_FOLLOW_PER_RUN 人まで）

環境変数:
  TWC_API               WorkerのURL（必須）
  SCRATCH_USERNAME      フォローするアカウント（既定 TWC-ils）
  SCRATCH_SESSION_ID    ScratchのセッションID（推奨。あればパスワードより優先）
  SCRATCH_PASSWORD      Scratchのパスワード（SESSION_IDが無いときだけ使う）
  MAX_FOLLOW_PER_RUN    1回の上限（既定 30）
  FOLLOW_SLEEP          フォローの間隔の秒数（既定 3）
"""
import os
import random
import sys
import time

import requests

API = os.environ.get("TWC_API", "").rstrip("/")
ME = os.environ.get("SCRATCH_USERNAME", "TWC-ils")
MAX_FOLLOW = int(os.environ.get("MAX_FOLLOW_PER_RUN", "30"))
SLEEP = float(os.environ.get("FOLLOW_SLEEP", "3"))
HEADERS = {"User-Agent": "scratch-twc/1.0"}


def approved_users():
    r = requests.get(API + "/api/applications/approved-users", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return [u["username"] for u in r.json().get("users", []) if u.get("username")]


def my_following():
    names, offset = set(), 0
    while True:
        r = requests.get(
            "https://api.scratch.mit.edu/users/%s/following/" % ME,
            params={"limit": 40, "offset": offset},
            headers=HEADERS,
            timeout=30,
        )
        r.raise_for_status()
        page = r.json()
        if not page:
            break
        names.update(u["username"].lower() for u in page if u.get("username"))
        if len(page) < 40:
            break
        offset += 40
    return names


def login():
    import scratchattach as sa

    sid = os.environ.get("SCRATCH_SESSION_ID", "").strip()
    pw = os.environ.get("SCRATCH_PASSWORD", "")
    if sid:
        return sa.login_by_id(sid, username=ME)
    if pw:
        return sa.login(ME, pw)
    sys.exit("SCRATCH_SESSION_ID か SCRATCH_PASSWORD が設定されていません")


def main():
    if not API:
        sys.exit("TWC_API が設定されていません")

    approved = approved_users()
    following = my_following()
    todo = [n for n in approved if n.lower() not in following and n.lower() != ME.lower()]
    print("承認済み %d 人 / 既にフォロー済み・自分を除いた未フォロー %d 人" % (len(approved), len(todo)))
    if not todo:
        return

    # 毎回同じ失敗ユーザー（退会・凍結など）が先頭を塞がないよう、順番をばらす
    random.shuffle(todo)
    session = login()
    done = failed = 0
    for name in todo[:MAX_FOLLOW]:
        try:
            session.connect_user(name).follow()
            done += 1
            print("フォローした:", name)
        except Exception as e:  # 1人の失敗で全体を止めない
            failed += 1
            print("失敗:", name, "-", type(e).__name__, e)
        time.sleep(SLEEP)

    rest = max(0, len(todo) - MAX_FOLLOW)
    print("結果: 成功 %d / 失敗 %d / 次回に持ち越し %d" % (done, failed, rest))
    if done == 0 and failed > 0:
        sys.exit(1)  # 全滅のときだけ失敗扱いにする（ログイン不備などに気づけるように）


if __name__ == "__main__":
    main()
