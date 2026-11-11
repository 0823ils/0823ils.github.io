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

スコアの考え方（message.txt と同じ計算）:
  1. 各評価を (点数 / 5)² × 5 に変換する
  2. 変換後の点数から、評価者ごとの平均・標準偏差と作品ごとの平均を求める
  3. 自分の評価を除いた作品平均との相関から、評価者ごとの重要度を求める
  4. 偏差値を atan 関数で補正し、重要度による重みつき平均を求める
  5. 最後に √(点数 / 5) × 5 で表示用スコアに戻す
  ※ 評価数が少ない作品を全体平均へ寄せる追加補正は行わない
"""
import json
import math
import os
import sys
import time

import requests

HEADERS = {"User-Agent": "scratch-twc/1.0"}
MAX_ITEMS = 5000         # 載せる作品数の上限
WEEK_MS = 7 * 24 * 3600 * 1000
WEEKLY_LIMIT = 30
WEEKLY_PRIOR_MEAN, WEEKLY_PRIOR_WEIGHT = 3.0, 2.0


def helper(projects):
    """各評価を message.txt と同じ二乗スケールへ変換する。"""
    return {
        project: {
            user: (rating / 5) ** 2 * 5
            for user, rating in ratings.items()
        }
        for project, ratings in projects.items()
        if ratings
    }


def helper2(values):
    """二乗スケールの値を表示用の 0〜5 に戻す。"""
    return {
        project: (max(score, 0.0) / 5) ** 0.5 * 5
        for project, score in values.items()
    }


def calculate_scores(project_points):
    """projects: {作品: {評価者: 点}} -> {scores, averages, counts, correlations, user_stats}"""
    projects = helper(project_points)
    users = {
        user
        for ratings in projects.values()
        for user in ratings
    }

    # 各プロジェクトの平均評価（変換後）
    project_averages = {
        project: sum(ratings.values()) / len(ratings)
        for project, ratings in projects.items()
    }

    # 各ユーザーの平均・標準偏差
    user_stats = {}
    for user in users:
        ratings = [
            project_ratings[user]
            for project_ratings in projects.values()
            if user in project_ratings
        ]
        # 評価が1作品だけのユーザーは「基準★3・標準偏差1.0」と仮定する。
        # 二乗スケールでは ★3 = (3/5)^2*5 = 1.8
        if len(ratings) == 1:
            mean, sd = 1.8, 1.0
        else:
            mean = sum(ratings) / len(ratings)
            variance = sum((x - mean) ** 2 for x in ratings) / len(ratings)
            sd = math.sqrt(variance)
        user_stats[user] = {"mean": mean, "sd": sd, "rating_count": len(ratings)}

    # 各ユーザーと「自分自身を除いたプロジェクト平均」の相関係数
    correlations = {}
    for user in users:
        pairs = []
        for project, ratings in projects.items():
            n = len(ratings)
            # 評価者が1人のプロジェクトは除外
            if n < 2 or user not in ratings:
                continue
            other_average = (
                project_averages[project] * n - ratings[user]
            ) / (n - 1)
            pairs.append((ratings[user], other_average))

        xs = [x for x, _ in pairs]
        ys = [y for _, y in pairs]
        # 相関係数を計算できない場合は 0
        if len(pairs) < 2 or len(set(xs)) < 2 or len(set(ys)) < 2:
            correlations[user] = 0.0
            continue

        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        numerator = sum((x - mx) * (y - my) for x, y in pairs)
        dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        dy = math.sqrt(sum((y - my) ** 2 for y in ys))
        correlations[user] = numerator / (dx * dy)

    # プロジェクトごとの補正後スコア
    scores_internal = {}
    for project, ratings in projects.items():
        weighted_sum = 0.0
        importance_sum = 0.0

        for user, rating in ratings.items():
            stats = user_stats[user]

            # 偏差値
            if stats["sd"] == 0:
                hensachi = 50.0
            else:
                hensachi = 50 + 10 * (rating - stats["mean"]) / stats["sd"]

            # 補正後評価
            adjusted = (
                rating / 2
                + math.atan((hensachi - 50) / 6.0) * (5.0 / math.pi)
                + 2.5
            ) / 1.5

            # 評価者の重要度
            # 評価作品数による重み: Weight × (3 + sqrt(評価作品数))
            rating_count = user_stats[user]["rating_count"]
            importance = max(correlations[user] + 0.3, 0.1) * (3 + math.sqrt(rating_count))
            weighted_sum += adjusted * importance
            importance_sum += importance

        scores_internal[project] = weighted_sum / importance_sum

    return {
        "scores": helper2(scores_internal),
        "averages": helper2(project_averages),
        "counts": {project: len(ratings) for project, ratings in projects.items()},
        "correlations": correlations,
        "user_stats": user_stats,
    }


def build(rows, now_ms):
    """rows: [[project_id, user_id, score, updated_at], ...] -> JSONにする辞書"""
    projects = {}
    for pid, uid, score, _ in rows:
        projects.setdefault(int(pid), {})[int(uid)] = int(score)
    res = calculate_scores(projects) if projects else {
        "scores": {}, "averages": {}, "counts": {}, "correlations": {}, "user_stats": {}
    }

    items = [
        {"id": p, "score": round(res["scores"][p], 2), "avg": round(res["averages"][p], 2), "count": res["counts"][p]}
        for p in projects
    ]
    items.sort(key=lambda x: (-x["score"], -x["count"], -x["id"]))
    items = items[:MAX_ITEMS]

    # 今週の一覧は、直近7日分の単純平均に従来の少数評価向け補正を適用する。
    # message.txt の全期間スコア計算とは別枠のランキング。
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
