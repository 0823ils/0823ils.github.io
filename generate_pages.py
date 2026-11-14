#!/usr/bin/env python3
"""
projects.db から検索エンジン向けの静的ページを生成する。

  docs/p/<作品ID>.html     作品ページ
  docs/u/<ユーザー名>.html  ユーザーページ
  docs/authors.html         ユーザー一覧（クローラーの入口）
  docs/sitemap.xml          サイトマップ
  docs/assets/page.css      共通CSS

使い方:
  python3 generate_pages.py [DBパス] [出力先] 
  SITE_URL=https://example.com python3 generate_pages.py   # 独自ドメイン時

注意: いいね数・閲覧数は毎日変わるため、あえてページに載せない。
      載せると毎日ほぼ全ファイルが変更され、リポジトリが肥大化するため。
"""
import html
import json
import os
import shutil
import sqlite3
import sys
from urllib.parse import quote

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else "projects.db"
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else "docs"
# 末尾スラッシュなし。独自ドメインにしたら SITE_URL を変える。
SITE_URL = os.environ.get("SITE_URL", "https://0823ils.github.io").rstrip("/")

SITE_NAME = "scratch-TWC"
SITE_FULL = "scratch TWC｜Technical Works Collection スクラッチ技術作品コレクション"

CSS = """\
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#f0f2f5;color:#333;padding-top:56px;display:flex;justify-content:center}
.site-header{position:fixed;top:0;left:0;right:0;background:#4D97FF;box-shadow:0 2px 12px rgba(77,151,255,.35);z-index:10}
.site-header-inner{max-width:700px;margin:0 auto;padding:0 20px;height:56px;display:flex;align-items:center}
.site-header a{color:#fff;font-weight:800;font-size:17px;text-decoration:none}
.container{width:100%;max-width:700px;background:#fff;padding:24px 30px 30px;border-radius:15px;box-shadow:0 4px 20px rgba(0,0,0,.1);margin:20px 12px}
.crumbs{font-size:.8em;color:#999;margin-bottom:14px}
.crumbs a{color:#4D97FF;text-decoration:none}
h1{font-size:1.3em;line-height:1.4;margin-bottom:10px;word-break:break-word}
h2{font-size:1.05em;color:#555;margin:24px 0 10px}
.thumb{width:100%;max-width:480px;aspect-ratio:4/3;object-fit:cover;background:#f0f0f0;border-radius:10px;display:block;margin:12px 0}
.meta{color:#666;font-size:.92em;margin-bottom:8px}
.meta a{color:#4D97FF}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
.btn{padding:11px 22px;border-radius:24px;border:2px solid #4D97FF;color:#4D97FF;background:#fff;font-weight:bold;font-size:.95em;text-decoration:none}
.btn.primary{background:#4D97FF;color:#fff}
.desc{font-size:.9em;color:#666;line-height:1.8;margin-top:8px}
ul.list{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px 14px}
ul.list li{font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ul.list a{color:#333;text-decoration:none}
ul.list a:hover{color:#4D97FF;text-decoration:underline}
.count{color:#aaa;font-size:.85em}
footer{margin-top:28px;padding-top:14px;border-top:1px solid #eee;font-size:.8em;color:#aaa}
footer a{color:#4D97FF}
"""


def esc(s):
    return html.escape(s or "", quote=True)


def clean_title(t):
    # 連続空白などを整理（タイトルに大量の空白が入る作品がある）
    t = " ".join((t or "").split())
    return t if t else "（無題）"


def short(t, n):
    return t if len(t) <= n else t[: n - 1] + "…"


def layout(*, title, description, canonical, rel, body, og_image=None, jsonld=None):
    """rel: このページからサイトルートへの相対パス（例 '../'）"""
    ld = ""
    if jsonld:
        ld = '<script type="application/ld+json">%s</script>\n' % json.dumps(
            jsonld, ensure_ascii=False
        ).replace("</", "<\\/")
    img = ""
    if og_image:
        img = (
            '<meta property="og:image" content="%s">\n'
            '<meta name="twitter:card" content="summary_large_image">\n'
            '<meta name="twitter:image" content="%s">\n' % (esc(og_image), esc(og_image))
        )
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{esc(canonical)}">
<link rel="icon" type="image/png" href="{rel}icon.png">
<link rel="stylesheet" href="{rel}assets/page.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{SITE_NAME}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(canonical)}">
{img}{ld}</head>
<body>
<header class="site-header"><div class="site-header-inner"><a href="{rel}">{SITE_NAME}</a></div></header>
<main class="container">
{body}
<footer>
<a href="{rel}">{SITE_NAME}（Scratch Technical Works Collection）</a> ―
Scratchの技術作品（scratch技術作品）を検索できるサイト ・ <a href="{rel}authors.html">ユーザー一覧</a>
</footer>
</main>
</body>
</html>
"""


def main():
    if not os.path.exists(DB_PATH):
        sys.exit("DBが見つかりません: " + DB_PATH)

    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT id, title, author_username FROM projects "
        "WHERE author_username IS NOT NULL AND author_username != '' ORDER BY id DESC"
    ).fetchall()

    by_author = {}
    for pid, title, author in rows:
        by_author.setdefault(author, []).append((pid, clean_title(title)))

    # 生成物を毎回作り直す（DBから消えた作品のページも消すため）
    for d in ("p", "u"):
        shutil.rmtree(os.path.join(OUT_DIR, d), ignore_errors=True)
        os.makedirs(os.path.join(OUT_DIR, d))
    os.makedirs(os.path.join(OUT_DIR, "assets"), exist_ok=True)
    with open(os.path.join(OUT_DIR, "assets", "page.css"), "w", encoding="utf-8") as f:
        f.write(CSS)

    urls = [SITE_URL + "/", SITE_URL + "/authors.html"]

    # ---- 作品ページ ----
    for author, items in by_author.items():
        for pid, title in items:
            thumb = "https://uploads.scratch.mit.edu/get_image/project/%d_480x360.png" % pid
            canonical = "%s/p/%d.html" % (SITE_URL, pid)
            u_href = "../u/%s.html" % quote(author)
            others = [x for x in items if x[0] != pid][:12]
            others_html = ""
            if others:
                others_html = (
                    "<h2>%s さんの他の作品</h2>\n<ul class=\"list\">\n%s\n</ul>\n"
                    % (
                        esc(author),
                        "\n".join(
                            '<li><a href="%d.html">%s</a></li>' % (i, esc(short(t, 40)))
                            for i, t in others
                        ),
                    )
                )
            desc = (
                "「%s」はScratchユーザー %s さんの作品。Scratchの技術作品を集めた "
                "scratch-TWC（スクラッチTWC・scratch TWC）に収録されています。ScratchまたはTurboWarpで開けます。"
                % (short(title, 60), author)
            )
            body = f"""<div class="crumbs"><a href="../">{SITE_NAME}</a> › <a href="{u_href}">{esc(author)}</a> › 作品</div>
<h1>{esc(title)}</h1>
<p class="meta">作者: <a href="{u_href}">{esc(author)}</a>（Scratchユーザー）</p>
<img class="thumb" src="{esc(thumb)}" alt="Scratch作品「{esc(short(title, 60))}」のサムネイル" loading="lazy" width="480" height="360">
<div class="btns">
<a class="btn primary" href="../?m=p&amp;id={pid}">サイトで開く</a>
<a class="btn" href="https://scratch.mit.edu/projects/{pid}/" target="_blank" rel="noopener">Scratchで開く</a>
<a class="btn" href="https://turbowarp.org/{pid}" target="_blank" rel="noopener">TurboWarpで開く</a>
</div>
<p class="desc">この作品はScratchの技術作品コレクション「scratch TWC（Scratch Technical Works Collection）」に収録されています。
作品名やユーザー名で他のscratch技術作品を探すには<a href="../" style="color:#4D97FF">トップページの検索</a>をご利用ください。</p>
{others_html}<script>if(!/bot|crawl|spider|slurp|facebookexternalhit|preview|discord/i.test(navigator.userAgent))location.replace('../?m='+(/[?&]m=h/.test(location.search)?'h':'p')+'&id={pid}'+location.hash);</script>"""
            jsonld = {
                "@context": "https://schema.org",
                "@type": "CreativeWork",
                "name": title,
                "url": canonical,
                "author": {"@type": "Person", "name": author},
                "thumbnailUrl": thumb,
                "sameAs": "https://scratch.mit.edu/projects/%d/" % pid,
                "isPartOf": {"@type": "WebSite", "name": SITE_NAME, "url": SITE_URL + "/"},
            }
            page = layout(
                title="%s｜%s の Scratch作品 - scratch TWC" % (short(title, 50), author),
                description=desc,
                canonical=canonical,
                rel="../",
                body=body,
                og_image=thumb,
                jsonld=jsonld,
            )
            with open(os.path.join(OUT_DIR, "p", "%d.html" % pid), "w", encoding="utf-8") as f:
                f.write(page)
            urls.append(canonical)

    # ---- ユーザーページ ----
    for author, items in by_author.items():
        canonical = "%s/u/%s.html" % (SITE_URL, quote(author))
        lis = "\n".join(
            '<li><a href="../p/%d.html">%s</a></li>' % (i, esc(short(t, 40))) for i, t in items
        )
        desc = (
            "Scratchユーザー %s さんの技術作品 %d 件。scratch-TWC（スクラッチTWC・scratch TWC）に収録されているscratch技術作品の一覧です。"
            % (author, len(items))
        )
        body = f"""<div class="crumbs"><a href="../">{SITE_NAME}</a> › <a href="../authors.html">ユーザー一覧</a> › {esc(author)}</div>
<h1>{esc(author)} さんのScratch技術作品</h1>
<p class="meta">収録作品 {len(items)} 件 ・ <a href="https://scratch.mit.edu/users/{quote(author)}/" target="_blank" rel="noopener">Scratchのプロフィール</a></p>
<h2>作品一覧</h2>
<ul class="list">
{lis}
</ul>
"""
        page = layout(
            title="%s のScratch技術作品一覧 - scratch TWC" % author,
            description=desc,
            canonical=canonical,
            rel="../",
            body=body,
            jsonld={
                "@context": "https://schema.org",
                "@type": "ProfilePage",
                "name": "%s のScratch技術作品" % author,
                "url": canonical,
                "mainEntity": {"@type": "Person", "name": author},
            },
        )
        with open(os.path.join(OUT_DIR, "u", "%s.html" % author), "w", encoding="utf-8") as f:
            f.write(page)
        urls.append(canonical)

    # ---- ユーザー一覧 ----
    authors_sorted = sorted(by_author.items(), key=lambda kv: kv[0].lower())
    lis = "\n".join(
        '<li><a href="u/%s.html">%s</a> <span class="count">(%d)</span></li>'
        % (quote(a), esc(a), len(it))
        for a, it in authors_sorted
    )
    body = f"""<div class="crumbs"><a href="./">{SITE_NAME}</a> › ユーザー一覧</div>
<h1>scratch技術作品 ユーザー一覧</h1>
<p class="desc">scratch TWC（Scratch Technical Works Collection）に収録されているScratchユーザーの一覧です（{len(by_author)}人・{len(rows)}作品）。</p>
<h2>ユーザー</h2>
<ul class="list">
{lis}
</ul>
"""
    page = layout(
        title="ユーザー一覧｜scratch技術作品 - scratch TWC",
        description="scratch-TWC（スクラッチTWC・scratch TWC）に収録されているScratch技術作品の作者一覧。%d人・%d作品。" % (len(by_author), len(rows)),
        canonical=SITE_URL + "/authors.html",
        rel="",
        body=body,
    )
    with open(os.path.join(OUT_DIR, "authors.html"), "w", encoding="utf-8") as f:
        f.write(page)

    # ---- サイトマップ ----
    # 1ファイル上限は50,000 URL。超えたら分割する。
    LIMIT = 45000
    chunks = [urls[i : i + LIMIT] for i in range(0, len(urls), LIMIT)]

    def urlset(us):
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "".join("<url><loc>%s</loc></url>\n" % esc(u) for u in us)
            + "</urlset>\n"
        )

    if len(chunks) == 1:
        with open(os.path.join(OUT_DIR, "sitemap.xml"), "w", encoding="utf-8") as f:
            f.write(urlset(urls))
    else:
        index = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        for n, ch in enumerate(chunks, 1):
            name = "sitemap-%d.xml" % n
            with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
                f.write(urlset(ch))
            index += "<sitemap><loc>%s/%s</loc></sitemap>\n" % (SITE_URL, name)
        index += "</sitemapindex>\n"
        with open(os.path.join(OUT_DIR, "sitemap.xml"), "w", encoding="utf-8") as f:
            f.write(index)

    print("生成: 作品 %d / ユーザー %d / sitemap URL %d" % (len(rows), len(by_author), len(urls)))


if __name__ == "__main__":
    main()
