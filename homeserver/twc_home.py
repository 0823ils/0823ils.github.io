#!/usr/bin/env python3
"""scratch-TWC 家のサーバー用プログラム（外向きの通信だけ。ポート開放は要りません）

やること
  1. Scratchの通知の数を見て、増えたらTWCに知らせる（TWCがスマホ・PCに通知を送る）
  2. 登録された作品のクラウド変数の変更履歴を、ずっと保存する（SQLite）。現在の値はTWCの画面に出る
  3. （手動）保存してある値を、自分の作品に書き戻す: python3 twc_home.py restore 作品ID

使い方は README.md を見てください。標準ライブラリだけで動きます（restore だけ scratchattach が要ります）。
"""
import json, os, sqlite3, sys, time, urllib.request, urllib.error, urllib.parse

TWC_API = os.environ.get("TWC_API", "https://twc-api.twc-scratch.workers.dev").rstrip("/")
SECRET = os.environ.get("HOME_SECRET", "")
DB_PATH = os.environ.get("TWC_HOME_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "twc_home.sqlite"))
INTERVAL = int(os.environ.get("TWC_INTERVAL", "60"))
SCRATCH_API = os.environ.get("SCRATCH_API", "https://api.scratch.mit.edu").rstrip("/")
CLOUD_LOGS = os.environ.get("CLOUD_LOGS", "https://clouddata.scratch.mit.edu/logs")
UA = "scratch-TWC-home/1.0"


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def http(method, url, data=None, headers=None, timeout=25):
    h = {"User-Agent": UA}
    h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "null")


def twc(method, path, data=None):
    return http(method, TWC_API + path, data, {"Authorization": "Bearer " + SECRET})


def db():
    c = sqlite3.connect(DB_PATH)
    c.execute("""CREATE TABLE IF NOT EXISTS cv_log (
        project_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, user TEXT,
        PRIMARY KEY (project_id, ts, name, value))""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_cv_name ON cv_log(project_id, name, ts)")
    return c


def clean_name(n):
    n = str(n)
    return n[2:] if n.startswith("☁ ") else n


def sync_project(c, pid, max_pages=25):
    """変更履歴を新しい順に読み、すでに持っている所まで保存する。最初の1回は古い所まで多めに読む"""
    new = 0
    have = c.execute("SELECT COALESCE(MAX(ts),0) FROM cv_log WHERE project_id=?", (pid,)).fetchone()[0]
    offset = 0
    for _ in range(max_pages):
        q = urllib.parse.urlencode({"projectid": pid, "limit": 40, "offset": offset})
        rows = http("GET", CLOUD_LOGS + "?" + q)
        if not rows:
            break
        stop = False
        for r in rows:
            if r.get("verb") != "set_var":
                continue
            ts = int(r.get("timestamp", 0))
            cur = c.execute("INSERT OR IGNORE INTO cv_log (project_id, ts, name, value, user) VALUES (?,?,?,?,?)",
                            (pid, ts, clean_name(r.get("name", "")), str(r.get("value", "")), r.get("user")))
            new += cur.rowcount
            if have and ts < have:
                stop = True
        c.commit()
        if stop or len(rows) < 40:
            break
        offset += 40
        time.sleep(0.4)
    return new


def current_vars(c, pid):
    rows = c.execute("""SELECT name, value FROM cv_log l WHERE project_id=? AND ts=(
        SELECT MAX(ts) FROM cv_log WHERE project_id=l.project_id AND name=l.name)""", (pid,)).fetchall()
    return {n: v for n, v in rows}


def cycle(c):
    jobs = twc("GET", "/api/home/jobs")
    counts, vars_ = {}, {}
    for w in jobs.get("watchers", []):
        try:
            counts[w["u"]] = int(http("GET", "%s/users/%s/messages/count" % (SCRATCH_API, urllib.parse.quote(w["u"])))["count"])
        except Exception as e:
            log("通知数の取得に失敗", w["u"], e)
        time.sleep(0.4)
    for p in jobs.get("projects", []):
        try:
            n = sync_project(c, int(p["id"]))
            vars_[str(p["id"])] = current_vars(c, int(p["id"]))
            if n:
                log("作品", p["id"], "の履歴を", n, "件保存")
        except Exception as e:
            log("クラウド変数の取得に失敗", p["id"], e)
        time.sleep(0.4)
    if counts or vars_:
        res = twc("POST", "/api/home/report", {"counts": counts, "vars": vars_})
        if res.get("notified"):
            log("通知を", res["notified"], "台に送りました")


def run():
    if len(SECRET) < 24:
        sys.exit("環境変数 HOME_SECRET（24文字以上）を設定してください")
    c = db()
    log("開始。", INTERVAL, "秒ごとに確認します。", TWC_API)
    while True:
        try:
            cycle(c)
        except urllib.error.HTTPError as e:
            log("TWCとの通信エラー", e.code, "（HOME_SECRET が TWC側と合っているか確認してください）" if e.code == 404 else "")
        except Exception as e:
            log("エラー", e)
        time.sleep(INTERVAL)


def restore(pid, only=None):
    """保存してある最新の値を、自分の作品に書き戻す（要: pip install scratchattach と SCRATCH_USER / SCRATCH_PASS）"""
    import scratchattach as sa
    c = db()
    want = current_vars(c, int(pid))
    if only:
        want = {k: v for k, v in want.items() if k == only}
    if not want:
        sys.exit("保存された値がありません")
    user = os.environ["SCRATCH_USER"]
    sess = sa.login_by_id(os.environ["SCRATCH_SESSION"], username=user) if os.environ.get("SCRATCH_SESSION") else sa.login(user, os.environ["SCRATCH_PASS"])
    cloud = sess.connect_cloud(str(pid))
    for k, v in want.items():
        cloud.set_var(k, v)
        log("書き戻し", k, "=", v)
        time.sleep(0.3)


def status():
    c = db()
    for pid, n, last in c.execute("SELECT project_id, COUNT(*), MAX(ts) FROM cv_log GROUP BY project_id"):
        print("作品", pid, "履歴", n, "件 / 最後の変更", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(last / 1000)))
        for k, v in sorted(current_vars(c, pid).items()):
            print("   ", k, "=", v)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        run()
    elif cmd == "once":
        if len(SECRET) < 24:
            sys.exit("HOME_SECRET を設定してください")
        cycle(db())
    elif cmd == "restore" and len(sys.argv) >= 3:
        restore(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "status":
        status()
    else:
        sys.exit(__doc__)
