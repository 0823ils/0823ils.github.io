#!/usr/bin/env python3
"""
評価からスコアを計算して、docs/ratings.json（静的ファイル）に書き出す。

  サイトはこのファイルを GitHub Pages から読むので、順位表・評価数の表示で
  Worker / D1 を使わない（無料枠の節約）。GitHub Actions（ratings.yml）が数時間おきに実行する。

環境変数:
  TWC_API       WorkerのURL（必須）
  EXPORT_TOKEN  Worker の EXPORT_TOKEN と同じ値（必須）
使い方:
  python3 build_ratings.py [出力先 (既定 docs/ratings.json)]
  python3 build_ratings.py --selftest     # 計算だけ試す（通信しない）

スコアの考え方（作品ごと）:
  1. 評価者ごとに、自分の平均・ばらつきを使って「偏差値」にする（甘い人・辛い人の差をならす）
  2. 偏差値と元の点から、補正後の評価（0.33〜5）を作る
  3. 評価者の重みは、「その人の点が、自分以外の平均とどれだけ似ているか」（相関）で決める
  4. 重みつき平均を出す。評価が少ない作品は、全体の平均に少し引き寄せる（1人の5点で1位にならないように）
  5. 最後に、平方根で下のほうを持ち上げて 0〜5 の表示用スコアにする
"""
import json
import math
import os
import sys
import time

import requests

HEADERS = {"User-Agent": "scratch-twc/1.0"}
PRIOR_K = 1.0            # 少ない評価を全体平均に引き寄せる強さ（平均的な評価者の何人ぶんか）
MAX_ITEMS = 5000         # 載せる作品数の上限
WEEK_MS = 7 * 24 * 3600 * 1000
WEEKLY_LIMIT = 30
WEEKLY_PRIOR_MEAN, WEEKLY_PRIOR_WEIGHT = 3.0, 2.0


def calculate_scores(projects):
    """projects: {作品: {評価者: 点}} -> {scores, averages, counts, correlations}"""
    by_user = {}
    for project, ratings in projects.items():
        for user, score in ratings.items():
            by_user.setdefault(user, {})[project] = score

    averages = {p: sum(r.values()) / len(r) for p, r in projects.items()}

    # 評価者ごとの平均・標準偏差
    user_stats = {}
    for user, rs in by_user.items():
        vals = list(rs.values())
        mean = sum(vals) / len(vals)
        sd = math.sqrt(sum((x - mean) ** 2 for x in vals) / len(vals))
        user_stats[user] = (mean, sd)

    # 評価者と「自分以外の平均」との相関（評価者が1人しかいない作品は除く）
    correlations = {}
    for user, rs in by_user.items():
        xs, ys = [], []
        for project, score in rs.items():
            n = len(projects[project])
            if n < 2:
                continue
            xs.append(score)
            ys.append((averages[project] * n - score) / (n - 1))
        if len(xs) < 2 or len(set(xs)) < 2 or len(set(ys)) < 2:
            correlations[user] = 0.0
            continue
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        dy = math.sqrt(sum((y - my) ** 2 for y in ys))
        correlations[user] = num / (dx * dy)

    def adjusted(user, rating):
        mean, sd = user_stats[user]
        hensachi = 50.0 if sd == 0 else 50 + 10 * (rating - mean) / sd
        return (rating / 2 + math.atan((hensachi - 50) / 6.0) * (5.0 / math.pi) + 2.5) / 1.5

    def importance(user):
        return max(correlations[user] + 0.3, 0.1)

    # 全体の重みつき平均（少ない評価の引き寄せ先）
    tot_w = tot_s = 0.0
    for project, ratings in projects.items():
        for user, rating in ratings.items():
            w = importance(user)
            tot_w += w
            tot_s += adjusted(user, rating) * w
    prior = tot_s / tot_w if tot_w else 2.5
    n_ratings = sum(len(r) for r in projects.values())
    prior_k = PRIOR_K * (tot_w / n_ratings if n_ratings else 1.0)   # 「平均的な評価者 PRIOR_K 人ぶん」の重み

    scores = {}
    for project, ratings in projects.items():
        w_sum = s_sum = 0.0
        for user, rating in ratings.items():
            w = importance(user)
            w_sum += w
            s_sum += adjusted(user, rating) * w
        m = (s_sum + prior_k * prior) / (w_sum + prior_k)
        scores[project] = math.sqrt(max(m, 0.0) / 5) * 5

    return {
        "scores": scores,
        "averages": averages,
        "counts": {p: len(r) for p, r in projects.items()},
        "correlations": correlations,
    }


def build(rows, now_ms):
    """rows: [[project_id, user_id, score, updated_at], ...] -> JSONにする辞書"""
    projects = {}
    for pid, uid, score, _ in rows:
        projects.setdefault(int(pid), {})[int(uid)] = int(score)
    res = calculate_scores(projects) if projects else {"scores": {}, "averages": {}, "counts": {}}

    items = [
        {"id": p, "score": round(res["scores"][p], 2), "avg": round(res["averages"][p], 2), "count": res["counts"][p]}
        for p in projects
    ]
    items.sort(key=lambda x: (-x["score"], -x["count"], -x["id"]))
    items = items[:MAX_ITEMS]

    # 今週: 直近7日につけられた評価だけで、少ない評価を引き寄せた平均
    recent = {}
    for pid, uid, score, updated in rows:
        if now_ms - int(updated) <= WEEK_MS:
            recent.setdefault(int(pid), []).append(int(score))
    weekly = []
    for p, vals in recent.items():
        w = (sum(vals) + WEEKLY_PRIOR_MEAN * WEEKLY_PRIOR_WEIGHT) / (len(vals) + WEEKLY_PRIOR_WEIGHT)
        weekly.append({"id": p, "avg": round(sum(vals) / len(vals), 2), "count": len(vals), "_w": w})
    weekly.sort(key=lambda x: (-x["_w"], -x["count"], -x["id"]))
    weekly = [{k: v for k, v in x.items() if k != "_w"} for x in weekly[:WEEKLY_LIMIT]]
    return {"items": items, "weekly": weekly}


def selftest():
    sample = {
        "project1": {"user1": 5, "user2": 5, "user3": 4},
        "project2": {"user1": 1, "user3": 5, "user4": 4},
        "project3": {"user1": 3, "user2": 4, "user3": 2, "user4": 5},
        "project4": {"user5": 2},
    }
    res = calculate_scores(sample)
    print("Project Scores:")
    for p, v in res["scores"].items():
        print("  %s: %.3f (平均 %.3f, %d人)" % (p, v, res["averages"][p], res["counts"][p]))


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    api = os.environ.get("TWC_API", "").rstrip("/")
    token = os.environ.get("EXPORT_TOKEN", "")
    if not api or not token:
        sys.exit("TWC_API と EXPORT_TOKEN が必要です")
    out_path = next((a for a in sys.argv[1:] if not a.startswith("-")), "docs/ratings.json")

    r = requests.get(api + "/api/ratings/export", headers={**HEADERS, "Authorization": "Bearer " + token}, timeout=60)
    if r.status_code != 200:
        sys.exit("評価の取得に失敗: HTTP %d %s" % (r.status_code, r.text[:200]))
    rows = r.json().get("ratings", [])
    now_ms = int(time.time() * 1000)
    data = build(rows, now_ms)
    print("評価 %d 件 → 作品 %d 件、今週 %d 件" % (len(rows), len(data["items"]), len(data["weekly"])))

    # 中身が変わらないときは書き直さない（コミットを増やさない）
    old = None
    try:
        with open(out_path, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        pass
    if old and old.get("items") == data["items"] and old.get("weekly") == data["weekly"]:
        print("変更なし")
        return
    data["generated_at"] = now_ms
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("書き出しました:", out_path)


if __name__ == "__main__":
    main()
