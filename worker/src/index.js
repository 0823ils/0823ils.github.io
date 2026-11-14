// scratch-TWC API (Cloudflare Workers + D1)
//   POST   /api/auth/start      { username, verifier }  -> { code }   verifier = SHA-256(本人の画面だけが知る秘密)（base64url）
//   POST   /api/auth/verify     { code, secret }        -> { token, username, id, expires_at }   secret = 元の秘密。ハッシュが一致しないと完了できない
//   GET    /api/ratings?ids=1,2,3              -> { ratings: { "1": { avg(RMS), count, mine } } }
//   GET    /api/ratings/ranking                -> { items: [{ id, score, avg(RMS), count }] } 技術力の高い順
//   PUT    /api/ratings/:projectId { score }   -> { avg(RMS), count, mine } (要ログイン。自分の作品・存在しない作品は不可)
//   DELETE /api/ratings/:projectId             -> { avg(RMS), count, mine } (要ログイン)
//   GET    /api/saves                          -> { ids: [新しい順の作品ID] }   (要ログイン)
//   PUT    /api/saves/:projectId               -> { saved: true }              (要ログイン)
//   DELETE /api/saves/:projectId               -> { saved: false }             (要ログイン)
//   POST   /api/applications { kind, target, message } -> { application }      (要ログイン。参加申請)
//   GET    /api/applications/mine              -> { items, is_admin }          (要ログイン)
//   GET    /api/applications/approved-users    -> { users: [{ id, username }], projects: [{ id }] } (公開。収集ツール用。users=ユーザーとして承認、projects=作品として承認)
//   GET    /api/admin/applications?status=pending -> { items }                 (管理者のみ)
//   POST   /api/admin/applications/:id { status } -> { application }           (管理者のみ。approved / rejected / pending)

const SCRATCH_API = 'https://api.scratch.mit.edu';
const CODE_TTL = 10 * 60 * 1000;            // コードの有効期限
const SESSION_TTL = 30 * 24 * 3600 * 1000;  // ログインの有効期間
const CLOCK_SKEW = 2 * 60 * 1000;           // 時計ずれの許容
const MAX_COMMENT_PAGES = 10;               // コメントを遡る最大ページ数(40件/ページ)
const MAX_PENDING_PER_USER = 5;             // 同一ユーザー名の同時発行数の上限
const MAX_IDS = 100;
const MAX_SAVES = 1000;
const MAX_RANKING = 5000;                   // 順位表に載せる作品数の上限
// 今週ランキング用の少数評価補正（技術力順位の計算には使用しない）
const PRIOR_MEAN = 3;
const PRIOR_WEIGHT = 2;
const MAX_PENDING_APPLICATIONS = 10;        // 1ユーザーが同時に出せる未審査の申請数
const MAX_APP_MESSAGE = 300;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

let cachedOwner = null; // 認証用プロジェクトの作者名（Worker内でキャッシュ）

import { vapidPublicKey, sendPush, isAllowedEndpoint } from './push.js';
const CTX = new WeakMap();   // リクエストごとの waitUntil（通知を返事の後に送るため）

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      CTX.set(request, ctx);
      res = await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.code }, e.status);
      else { console.error(e); res = json({ error: 'internal' }, 500); }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'bad_json'); }
}




async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/auth/start' && method === 'POST') return authStart(request, env);
  if (path === '/api/auth/verify' && method === 'POST') return authVerify(request, env);
  if (path === '/api/ratings' && method === 'GET') return getRatings(request, env, url);
  if (path === '/api/ratings/ranking' && method === 'GET') return getRanking(env);
  if (path === '/api/ratings/mine' && method === 'GET') return myRatings(request, env);
  if (path === '/api/ratings/detail' && method === 'GET') return ratingDetail(request, env, url);
  if (path === '/api/scratch/project' && method === 'GET') return scratchProjectInfo(url);
  if (path === '/api/ratings/export' && method === 'GET') return exportRatings(request, env);
  if (path === '/api/ratings.csv' && method === 'GET') return exportRatingsCsv(env);

  if (path === '/api/saves' && method === 'GET') return listSaves(request, env);

  const m = path.match(/^\/api\/ratings\/(\d{1,12})$/);
  if (m) {
    const projectId = Number(m[1]);
    if (method === 'PUT') return putRating(request, env, projectId);
    if (method === 'DELETE') return deleteRating(request, env, projectId);
  }
  if (path === '/api/applications' && method === 'POST') return postApplication(request, env);
  if (path === '/api/applications/mine' && method === 'GET') return myApplications(request, env);
  if (path === '/api/applications/approved-users' && method === 'GET') return approvedUsers(env);
  if (path === '/api/admin/applications' && method === 'GET') return adminList(request, env, url);
  const am = path.match(/^\/api\/admin\/applications\/(\d{1,12})$/);
  if (am && method === 'POST') return adminReview(request, env, Number(am[1]));

  const sm = path.match(/^\/api\/saves\/(\d{1,12})$/);
  if (sm) {
    const projectId = Number(sm[1]);
    if (method === 'PUT') return putSave(request, env, projectId);
    if (method === 'DELETE') return deleteSave(request, env, projectId);
  }
  if (path === '/api/chat/messages' && method === 'GET') return chatList(request, env, url);
  if (path === '/api/chat/messages' && method === 'POST') return chatPost(request, env);
  if (path === '/api/chat/translate' && method === 'POST') return translateChat(request, env);
  const cm = path.match(/^\/api\/chat\/messages\/(\d{1,12})(\/report)?$/);
  if (cm) {
    const id = Number(cm[1]);
    if (cm[2] && method === 'POST') return chatReport(request, env, id);
    if (!cm[2] && method === 'DELETE') return chatDelete(request, env, id);
  }
  const em = path.match(/^\/api\/chat\/messages\/(\d{1,12})\/edit$/);
  if (em && method === 'POST') return chatEdit(request, env, Number(em[1]));
  const rm = path.match(/^\/api\/chat\/messages\/(\d{1,12})\/react$/);
  if (rm && method === 'POST') return chatReact(request, env, Number(rm[1]));
  if (path === '/api/chat/reactions' && method === 'GET') return chatReactions(request, env, url);
  const cam = path.match(/^\/api\/admin\/chat\/messages\/(\d{1,12})$/);
  if (cam && method === 'POST') return chatAdminAction(request, env, Number(cam[1]));
  if (path === '/api/admin/chat/bans' && method === 'POST') return chatAdminBan(request, env);
  if (path === '/api/chat/videos/start' && method === 'POST') return videoStart(request, env);
  const vm = path.match(/^\/api\/chat\/videos\/([a-f0-9]{32})(\/complete)?$/);
  if (vm && vm[2] && method === 'POST') return videoComplete(request, env, vm[1]);
  if (vm && !vm[2] && method === 'DELETE') return videoDiscard(request, env, vm[1]);
  if (path === '/api/admin/chat/reports' && method === 'GET') return adminReports(request, env);
  if (path === '/api/admin/chat/bans' && method === 'GET') return adminBans(request, env);
  if (path === '/api/chat/latest' && method === 'GET') return chatLatest(request, env);
  if (path === '/api/ranking/weekly' && method === 'GET') return weeklyRanking(env);
  if (path === '/api/ratings/stats' && method === 'POST') return ratingStats(request, env);
  if (path === '/api/genres' && method === 'GET') return genreIds(env, url);
  const gm = path.match(/^\/api\/genres\/project\/(\d{1,12})(?:\/([a-z0-9]{2,12}))?$/);
  if (gm) {
    const projectId = Number(gm[1]);
    if (!gm[2] && method === 'GET') return genreOfProject(request, env, projectId);
    if (gm[2] && method === 'PUT') return genreVote(request, env, projectId, gm[2], true);
    if (gm[2] && method === 'DELETE') return genreVote(request, env, projectId, gm[2], false);
  }
  const um = path.match(/^\/api\/users\/([A-Za-z0-9_-]{3,20})\/profile$/);
  if (um && method === 'GET') return userProfile(env, um[1]);
  if (path === '/api/notifications' && method === 'GET') return notifList(request, env);
  if (path === '/api/notifications/count' && method === 'GET') return notifCount(request, env);
  if (path === '/api/notifications/read' && method === 'POST') return notifRead(request, env);
  if (path === '/api/notifications/settings' && method === 'GET') return notifSettingsGet(request, env);
  if (path === '/api/notifications/settings' && method === 'PUT') return notifSettingsPut(request, env);
  if (path === '/api/push/key' && method === 'GET') return pushKey(env);
  if (path === '/api/push/subscribe' && method === 'POST') return pushSubscribe(request, env);
  if (path === '/api/push/unsubscribe' && method === 'POST') return pushUnsubscribe(request, env);
  if (path === '/api/push/test' && method === 'POST') return pushTest(request, env);

  throw new HttpError(404, 'not_found');
}

// ---------- 認証 ----------

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除く
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return 'TWC-' + s;
}

// コメントは誰でも読めるので、コードだけではログインを完了できないようにする。
// 本人の画面が作った秘密のSHA-256だけを、start で預かり、verify で元の秘密を確かめる。
async function sha256B64u(text) {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authStart(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '');
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) throw new HttpError(400, 'bad_username');
  const lower = username.toLowerCase();
  const verifier = String(body.verifier || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new HttpError(400, 'bad_verifier');
  const now = Date.now();

  await env.DB.prepare('DELETE FROM auth_challenges WHERE created_at < ?').bind(now - CODE_TTL).run();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS c FROM auth_challenges WHERE username = ?').bind(lower).first();
  if (pending && pending.c >= MAX_PENDING_PER_USER) throw new HttpError(429, 'too_many_requests');

  const code = genCode();
  await env.DB.prepare('INSERT INTO auth_challenges (code, username, created_at, verifier) VALUES (?, ?, ?, ?)')
    .bind(code, lower, now, verifier).run();
  return json({ code, expires_in: CODE_TTL / 1000 });
}

async function scratchJson(url) {
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': 'scratch-twc/1.0' } }); }
  catch { throw new HttpError(502, 'scratch_unreachable'); }
  if (!r.ok) throw new HttpError(502, 'scratch_error');
  try { return await r.json(); } catch { throw new HttpError(502, 'scratch_error'); }
}

async function getAuthOwner(env) {
  if (cachedOwner) return cachedOwner;
  const pj = await scratchJson(`${SCRATCH_API}/projects/${env.AUTH_PROJECT_ID}`);
  const owner = pj && pj.author && pj.author.username;
  if (!owner) throw new HttpError(502, 'scratch_error');
  cachedOwner = owner;
  return owner;
}

async function findComment(env, owner, usernameLower, code, minTime) {
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const list = await scratchJson(
      `${SCRATCH_API}/users/${encodeURIComponent(owner)}/projects/${env.AUTH_PROJECT_ID}/comments?limit=40&offset=${page * 40}`
    );
    if (!Array.isArray(list) || list.length === 0) break;
    for (const c of list) {
      if (!c || !c.author || !c.author.username) continue;
      if (c.author.username.toLowerCase() !== usernameLower) continue;
      if (String(c.content || '').toUpperCase().indexOf(code) === -1) continue;
      if (Date.parse(c.created) < minTime) continue;
      return c;
    }
    if (list.length < 40) break;
  }
  return null;
}

async function authVerify(request, env) {
  const body = await readJson(request);
  const code = String(body.code || '').toUpperCase();
  if (!/^TWC-[A-Z2-9]{8}$/.test(code)) throw new HttpError(400, 'bad_code');

  const ch = await env.DB.prepare('SELECT username, created_at, verifier FROM auth_challenges WHERE code = ?').bind(code).first();
  if (!ch) throw new HttpError(404, 'no_challenge');
  if (Date.now() - ch.created_at > CODE_TTL) {
    await env.DB.prepare('DELETE FROM auth_challenges WHERE code = ?').bind(code).run();
    throw new HttpError(410, 'expired');
  }

  // ログインを始めた本人の画面だけが知る秘密。コメントを読んだだけの他人は、これを持っていない
  const secret = String(body.secret || '');
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(secret)) throw new HttpError(403, 'bad_secret');
  if (!ch.verifier || !timingSafeEqualStr(await sha256B64u(secret), ch.verifier)) throw new HttpError(403, 'bad_secret');

  const owner = await getAuthOwner(env);
  const found = await findComment(env, owner, ch.username, code, ch.created_at - CLOCK_SKEW);
  if (!found) throw new HttpError(404, 'comment_not_found');

  // コードは1回使い切り
  await env.DB.prepare('DELETE FROM auth_challenges WHERE code = ?').bind(code).run();

  const expiresAt = Date.now() + SESSION_TTL;
  const token = await signToken({ uid: found.author.id, u: found.author.username, exp: expiresAt }, env.SESSION_SECRET);
  return json({ token, username: found.author.username, id: found.author.id, expires_at: expiresAt });
}

// ---------- トークン (HMAC-SHA256) ----------

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function hmacKey(secret) {
  if (!secret) throw new HttpError(500, 'server_not_configured');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(payload, secret) {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return body + '.' + b64urlEncode(new Uint8Array(sig));
}
async function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(parts[1]), new TextEncoder().encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (!payload || !payload.uid || !payload.u || !(payload.exp > Date.now())) return null;
    return payload;
  } catch { return null; }
}

async function getUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  return verifyToken(m[1], env.SESSION_SECRET);
}
async function requireUser(request, env) {
  const u = await getUser(request, env);
  if (!u) throw new HttpError(401, 'unauthorized');
  return u;
}

// ---------- 評価 ----------

function summarize(row, mine) {
  const count = row ? row.c : 0;
  // 表示は、つけられた点の普通の平均（順位用のスコアとは別）
  const avg = count ? Number(row.a) || 0 : 0;
  return { avg: Math.round(avg * 100) / 100, count, mine: mine ?? null };
}

async function summaryFor(env, projectId, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c, AVG(score) AS a FROM ratings WHERE project_id = ?').bind(projectId).first();
  let mine = null;
  if (userId) {
    const r = await env.DB.prepare('SELECT score FROM ratings WHERE project_id = ? AND user_id = ?').bind(projectId, userId).first();
    mine = r ? r.score : null;
  }
  return summarize(row && row.c ? row : null, mine);
}

async function getRatings(request, env, url) {
  const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',')
    .map(s => s.trim()).filter(s => /^\d{1,12}$/.test(s)).map(Number))];
  if (ids.length === 0) return json({ ratings: {} });
  if (ids.length > MAX_IDS) throw new HttpError(400, 'too_many_ids');

  const ph = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT project_id, COUNT(*) AS c, AVG(score) AS a FROM ratings WHERE project_id IN (${ph}) GROUP BY project_id`
  ).bind(...ids).all();

  const mineMap = new Map();
  const user = await getUser(request, env);
  if (user) {
    const mr = await env.DB.prepare(
      `SELECT project_id, score FROM ratings WHERE user_id = ? AND project_id IN (${ph})`
    ).bind(user.uid, ...ids).all();
    for (const r of mr.results) mineMap.set(r.project_id, r.score);
  }

  const byId = new Map(rows.results.map(r => [r.project_id, r]));
  const out = {};
  for (const id of ids) out[id] = summarize(byId.get(id) || null, mineMap.get(id));
  return json({ ratings: out });
}

// 作品ページ用：平均・件数・自分の評価と、★1〜5それぞれの人数
async function ratingDetail(request, env, url) {
  const id = String(url.searchParams.get('id') || '');
  if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'bad_id');
  const pid = Number(id);
  const rows = await env.DB.prepare('SELECT score, COUNT(*) AS n FROM ratings WHERE project_id = ? GROUP BY score').bind(pid).all();
  const dist = [0, 0, 0, 0, 0];
  let c = 0, sq = 0;
  for (const r of rows.results) {
    if (r.score >= 1 && r.score <= 5) { dist[r.score - 1] = r.n; c += r.n; sq += r.n * r.score * r.score; }
  }
  const user = await getUser(request, env);
  let mine = null;
  if (user) {
    const m = await env.DB.prepare('SELECT score FROM ratings WHERE project_id = ? AND user_id = ?').bind(pid, user.uid).first();
    mine = m ? m.score : null;
  }
  return json({ ...summarize(c ? { c, a: sq / c } : null, mine), dist });
}

// 作品の「使い方」「メモとクレジット」を Scratch から取って返す（ブラウザから直接取れないとき用）
async function scratchProjectInfo(url) {
  const id = String(url.searchParams.get('id') || '');
  if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'bad_id');
  let r;
  try {
    r = await fetch(`${SCRATCH_API}/projects/${id}`, { headers: { 'User-Agent': 'scratch-TWC' }, cf: { cacheTtl: 3600, cacheEverything: true } });
  } catch (e) { throw new HttpError(502, 'scratch_unreachable'); }
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, 'scratch_error');
  const j = await r.json();
  const res = json({ instructions: String(j.instructions || ''), description: String(j.description || ''), title: String(j.title || ''), author: String((j.author && j.author.username) || '') });
  res.headers.set('Cache-Control', 'public, max-age=600');
  return res;
}

// 自分がつけた評価を全部返す（画面は、ここから「自分の評価」を知る。作品ごとに問い合わせない）
async function myRatings(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare('SELECT project_id, score FROM ratings WHERE user_id = ? LIMIT 5000').bind(user.uid).all();
  const out = {};
  for (const r of rows.results) out[r.project_id] = r.score;
  return json({ ratings: out });
}

// 全評価の書き出し（GitHub Actions が、スコアを計算して docs/ratings.json にするために使う）。
// EXPORT_TOKEN が合わなければ見せない。誰がどれをつけたかを含むので、公開はしない

// 公開評価データのCSVダウンロード（Excel向けUTF-8 BOM付き）
async function exportRatingsCsv(env) {
  const rows = await env.DB.prepare(
    'SELECT project_id, user_id, username, score, updated_at FROM ratings ORDER BY project_id, user_id'
  ).all();
  const quote = (value) => {
    let s = String(value ?? '');
    // CSVを開いた際の数式実行を防ぐ
    if (/^[=+@\\-\\t\\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [
    ['project_id', 'user_id', 'username', 'score', 'updated_at'].join(','),
    ...(rows.results || []).map(r => [r.project_id, r.user_id, r.username, r.score, r.updated_at].map(quote).join(','))
  ];
  return new Response('\\uFEFF' + lines.join('\\r\\n') + '\\r\\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="projects.db.csv"',
      'Cache-Control': 'no-store'
    }
  });
}

async function exportRatings(request, env) {
  const token = String(env.EXPORT_TOKEN || '');
  if (token.length < 16) throw new HttpError(503, 'export_disabled');
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(token);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] || 0) ^ b[i];
  if (diff !== 0) throw new HttpError(403, 'forbidden');
  const rows = await env.DB.prepare('SELECT project_id, user_id, score, updated_at FROM ratings').all();
  return json({ ratings: rows.results.map(r => [r.project_id, r.user_id, r.score, r.updated_at]) });
}

// 作品の作者のIDを返す。一度調べたらD1に覚えておく（作者は変わらない）。
// 公開されていない・存在しない作品は 404 にする。
async function getProjectAuthorId(env, projectId) {
  const cached = await env.DB.prepare('SELECT author_id FROM project_authors WHERE project_id = ?')
    .bind(projectId).first();
  if (cached) return cached.author_id;

  const pj = await scratchProject(projectId);
  const authorId = pj && pj.author && pj.author.id;
  if (!Number.isInteger(authorId)) throw new HttpError(502, 'scratch_error');
  await env.DB.prepare('INSERT OR IGNORE INTO project_authors (project_id, author_id) VALUES (?, ?)')
    .bind(projectId, authorId).run();
  return authorId;
}

async function scratchProject(projectId) {
  let r;
  try { r = await fetch(`${SCRATCH_API}/projects/${projectId}`, { headers: { 'User-Agent': 'scratch-twc/1.0' } }); }
  catch { throw new HttpError(502, 'scratch_unreachable'); }
  if (r.status === 404) throw new HttpError(404, 'no_such_project');
  if (!r.ok) throw new HttpError(502, 'scratch_error');
  try { return await r.json(); } catch { throw new HttpError(502, 'scratch_error'); }
}

async function putRating(request, env, projectId) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const score = body.score;
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new HttpError(400, 'bad_score');
  // 自分の作品には付けられない（存在しない作品への書き込みも、ここで止まる）
  const authorId = await getProjectAuthorId(env, projectId);
  if (authorId === user.uid) throw new HttpError(403, 'own_project');
  await env.DB.prepare(
    `INSERT INTO ratings (project_id, user_id, username, score, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET score = excluded.score, username = excluded.username, updated_at = excluded.updated_at`
  ).bind(projectId, user.uid, user.u, score, Date.now()).run();
  return json(await summaryFor(env, projectId, user.uid));
}

async function deleteRating(request, env, projectId) {
  const user = await requireUser(request, env);
  await env.DB.prepare('DELETE FROM ratings WHERE project_id = ? AND user_id = ?').bind(projectId, user.uid).run();
  return json(await summaryFor(env, projectId, user.uid));
}

// ---------- 保存（ブックマーク） ----------

async function listSaves(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(
    'SELECT project_id FROM saves WHERE user_id = ? ORDER BY created_at DESC, project_id DESC LIMIT ?'
  ).bind(user.uid, MAX_SAVES).all();
  return json({ ids: rows.results.map(r => r.project_id) });
}

async function putSave(request, env, projectId) {
  const user = await requireUser(request, env);
  const exists = await env.DB.prepare('SELECT 1 AS x FROM saves WHERE user_id = ? AND project_id = ?')
    .bind(user.uid, projectId).first();
  if (!exists) {
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM saves WHERE user_id = ?').bind(user.uid).first();
    if (cnt && cnt.c >= MAX_SAVES) throw new HttpError(409, 'too_many_saves');
    await env.DB.prepare('INSERT OR IGNORE INTO saves (user_id, project_id, created_at) VALUES (?, ?, ?)')
      .bind(user.uid, projectId, Date.now()).run();
  }
  return json({ saved: true });
}

async function deleteSave(request, env, projectId) {
  const user = await requireUser(request, env);
  await env.DB.prepare('DELETE FROM saves WHERE user_id = ? AND project_id = ?').bind(user.uid, projectId).run();
  return json({ saved: false });
}

// ---------- 技術力の順位表 ----------

function displayRatingValue(value) {
  return Math.sqrt(Math.max(value, 0) / 5) * 5;
}

// 評価者ごとの平均・標準偏差に、「★3をつけた、標準偏差1.0の評価作品1件ぶん」を、あらかじめ混ぜておく。
//   ・評価の少ない人は、平均や標準偏差が当てにならない（1件だと標準偏差が0になる）ので、これで安定させる
//   ・評価が多い人は、混ぜた1件の影響がほとんどなくなる
// 値は、評価（(★/5)^2*5 に直したあとの値）と同じ尺度で扱う。
const USER_PRIOR_STARS = 3;
const USER_PRIOR_MEAN = (USER_PRIOR_STARS / 5) ** 2 * 5;
const USER_PRIOR_SD = 1.0;
const USER_PRIOR_COUNT = 1;   // 評価作品数として数える件数

// message.txt の calculate_scores と同じアルゴリズム。
// raw rating -> (rating / 5)^2 * 5 -> 評価者補正・相関重み -> helper2。
function calculateRatingRanking(rows) {
  const projects = new Map();
  for (const row of rows) {
    const projectId = Number(row.project_id);
    const userId = Number(row.user_id);
    const rawRating = Number(row.score);
    if (!Number.isFinite(projectId) || !Number.isFinite(userId) || !Number.isFinite(rawRating)) continue;
    if (!projects.has(projectId)) projects.set(projectId, new Map());
    projects.get(projectId).set(userId, (rawRating / 5) ** 2 * 5);
  }

  const projectAverages = new Map();
  const users = new Map();
  for (const [projectId, ratings] of projects) {
    let sum = 0;
    for (const [userId, rating] of ratings) {
      sum += rating;
      if (!users.has(userId)) users.set(userId, new Map());
      users.get(userId).set(projectId, rating);
    }
    projectAverages.set(projectId, sum / ratings.size);
  }

  const userStats = new Map();
  for (const [userId, ratings] of users) {
    const values = [...ratings.values()];
    // 仮の評価（★3・標準偏差1.0）を USER_PRIOR_COUNT 件ぶん足して、平均と分散を出す
    const total = values.length + USER_PRIOR_COUNT;
    const mean = (values.reduce((a, b) => a + b, 0) + USER_PRIOR_MEAN * USER_PRIOR_COUNT) / total;
    const variance = (
      values.reduce((sum, x) => sum + (x - mean) ** 2, 0)
      + USER_PRIOR_COUNT * ((USER_PRIOR_MEAN - mean) ** 2 + USER_PRIOR_SD ** 2)
    ) / total;
    userStats.set(userId, { mean, sd: Math.sqrt(variance), count: values.length });
  }

  const correlations = new Map();
  for (const [userId, ratings] of users) {
    const pairs = [];
    for (const [projectId, rating] of ratings) {
      const projectRatings = projects.get(projectId);
      const n = projectRatings.size;
      if (n < 2) continue;
      const otherAverage = (projectAverages.get(projectId) * n - rating) / (n - 1);
      pairs.push([rating, otherAverage]);
    }

    const xs = pairs.map(pair => pair[0]);
    const ys = pairs.map(pair => pair[1]);
    if (pairs.length < 2 || new Set(xs).size < 2 || new Set(ys).size < 2) {
      correlations.set(userId, 0);
      continue;
    }
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let numerator = 0, dx2 = 0, dy2 = 0;
    for (const [x, y] of pairs) {
      numerator += (x - mx) * (y - my);
      dx2 += (x - mx) ** 2;
      dy2 += (y - my) ** 2;
    }
    correlations.set(userId, numerator / (Math.sqrt(dx2) * Math.sqrt(dy2)));
  }

  const items = [];
  for (const [projectId, ratings] of projects) {
    let weightedSum = 0;
    let importanceSum = 0;
    for (const [userId, rating] of ratings) {
      const stats = userStats.get(userId);
      const hensachi = stats.sd === 0
        ? 50
        : 50 + 10 * (rating - stats.mean) / stats.sd;
      const adjusted = (
        rating / 2
        + Math.atan((hensachi - 50) / 6) * (5 / Math.PI)
        + 2.5
      ) / 1.5;
      // 重み: 相関による重みに、評価数が多い人ほど大きくなる係数（3 + √評価数）をかける
      const importance = Math.max(correlations.get(userId) + 0.3, 0.1) * (3 + Math.sqrt(stats.count));
      weightedSum += adjusted * importance;
      importanceSum += importance;
    }
    const internalScore = weightedSum / importanceSum;
    items.push({
      id: projectId,
      score: Math.round(displayRatingValue(internalScore) * 100) / 100,
      avg: Math.round(displayRatingValue(projectAverages.get(projectId)) * 100) / 100,
      count: ratings.size,
    });
  }

  items.sort((a, b) => (b.score - a.score) || (b.count - a.count) || (b.id - a.id));
  return items.slice(0, MAX_RANKING);
}

async function getRanking(env) {
  const rows = await env.DB.prepare(
    'SELECT project_id, user_id, score FROM ratings'
  ).all();
  return json({ items: calculateRatingRanking(rows.results) });
}


// ---------- 参加申請 ----------

function isAdmin(user, env) {
  const admins = String(env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(String(user.u).toLowerCase());
}
async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!isAdmin(user, env)) throw new HttpError(403, 'forbidden');
  return user;
}

async function scratchUser(name) {
  let r;
  try { r = await fetch(`${SCRATCH_API}/users/${encodeURIComponent(name)}`, { headers: { 'User-Agent': 'scratch-twc/1.0' } }); }
  catch { throw new HttpError(502, 'scratch_unreachable'); }
  if (r.status === 404) throw new HttpError(404, 'no_such_user');
  if (!r.ok) throw new HttpError(502, 'scratch_error');
  let u;
  try { u = await r.json(); } catch { throw new HttpError(502, 'scratch_error'); }
  if (!u || !Number.isInteger(u.id) || !u.username) throw new HttpError(502, 'scratch_error');
  return u;
}

function appRow(r) {
  return {
    id: r.id, kind: r.kind,
    target_user_id: r.target_user_id, target_username: r.target_username,
    project_id: r.project_id, project_title: r.project_title,
    applicant_username: r.applicant_username,
    message: r.message, status: r.status,
    created_at: r.created_at, reviewed_at: r.reviewed_at,
  };
}

async function postApplication(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const kind = body.kind;
  if (kind !== 'user' && kind !== 'project') throw new HttpError(400, 'bad_kind');
  const message = String(body.message || '').trim().slice(0, MAX_APP_MESSAGE);
  const target = String(body.target || '').trim();

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE applicant_id = ? AND status = 'pending'"
  ).bind(user.uid).first();
  if (pending && pending.c >= MAX_PENDING_APPLICATIONS) throw new HttpError(429, 'too_many_applications');

  let targetId, targetName, projectId = null, projectTitle = null;
  if (kind === 'user') {
    const name = target.replace(/^.*\/users\//, '').replace(/\/.*$/, '');
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) throw new HttpError(400, 'bad_target');
    const u = await scratchUser(name);
    targetId = u.id; targetName = u.username;
  } else {
    const m = target.match(/^(\d{1,12})$/) || target.match(/\/projects\/(\d{1,12})/);
    if (!m) throw new HttpError(400, 'bad_target');
    projectId = Number(m[1]);
    const pj = await scratchProject(projectId);
    if (!pj || !pj.author || !Number.isInteger(pj.author.id) || !pj.author.username) throw new HttpError(502, 'scratch_error');
    targetId = pj.author.id; targetName = pj.author.username;
    projectTitle = String(pj.title || '').slice(0, 200);
  }

  // 同じ内容の申請が審査待ち・承認済みなら重複させない
  const dup = await env.DB.prepare(
    `SELECT id FROM applications
      WHERE kind = ? AND target_user_id = ? AND COALESCE(project_id, 0) = ? AND status IN ('pending', 'approved') LIMIT 1`
  ).bind(kind, targetId, projectId || 0).first();
  if (dup) throw new HttpError(409, 'already_applied');

  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO applications (kind, target_user_id, target_username, project_id, project_title,
                               applicant_id, applicant_username, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(kind, targetId, targetName, projectId, projectTitle, user.uid, user.u, message, now).run();
  const row = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ application: appRow(row) }, 201);
}

async function myApplications(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(
    'SELECT * FROM applications WHERE applicant_id = ? ORDER BY created_at DESC, id DESC LIMIT 50'
  ).bind(user.uid).all();
  return json({ items: rows.results.map(appRow), is_admin: isAdmin(user, env) });
}

async function adminList(request, env, url) {
  await requireAdmin(request, env);
  const status = url.searchParams.get('status') || 'pending';
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'bad_status');
  const rows = await env.DB.prepare(
    'SELECT * FROM applications WHERE status = ? ORDER BY created_at ASC, id ASC LIMIT 200'
  ).bind(status).all();
  return json({ items: rows.results.map(appRow) });
}

async function adminReview(request, env, id) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  if (!['pending', 'approved', 'rejected'].includes(body.status)) throw new HttpError(400, 'bad_status');
  const res = await env.DB.prepare('UPDATE applications SET status = ?, reviewed_at = ? WHERE id = ?')
    .bind(body.status, Date.now(), id).run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found');
  const row = await env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(id).first();
  return json({ application: appRow(row) });
}

// 承認済みのもの（収集ツールが、フォロー先と合わせて集める）
//   users    : ユーザーとして承認された人（その人の公開作品を全部集める）
//   projects : 作品として承認されたもの（その作品だけを載せる）
async function approvedUsers(env) {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT target_user_id AS id, target_username AS username FROM applications WHERE status = 'approved' AND kind = 'user'"
  ).all();
  const pj = await env.DB.prepare(
    "SELECT DISTINCT project_id AS id FROM applications WHERE status = 'approved' AND kind = 'project' AND project_id IS NOT NULL"
  ).all();
  return json({ users: rows.results, projects: pj.results });
}


// ---------- チャット ----------
//   GET    /api/chat/messages?room=3d|math|physics|triangle  -> { messages: [...最新50件、古い順], is_admin }  (公開。管理者は非表示のものも見える)
//   POST   /api/chat/messages { content }        -> { message }       (要ログイン。禁止ユーザー・連投は不可)
//   DELETE /api/chat/messages/:id                -> { deleted }       (本人 or 管理者)
//   POST   /api/chat/messages/:id/edit { content } -> { id, content, edited_at }  (本人のみ)
//   POST   /api/chat/messages/:id/report         -> { reported }      (要ログイン。通報が3件で自動的に非表示)
//   POST   /api/admin/chat/messages/:id { action: hide | restore | delete }   (管理者のみ)
//   POST   /api/admin/chat/bans { username, banned }                          (管理者のみ。投稿禁止/解除)
const CHAT_MAX_LEN = 300;
const CHAT_PAGE = 50;
const CHAT_REPORT_HIDE = 3;       // この件数の通報で自動的に非表示にする
const CHAT_MIN_INTERVAL = 2000;   // 連投の最短間隔(ms)
const CHAT_PER_MINUTE = 15;       // 1分あたりの投稿数の上限
const CHAT_ROOMS = ['general', '3d', 'math', 'physics', 'triangle', 'feedback', 'voice'];  // 部屋（一般 / 3D / 数学 / 物理 / 三角形 / 意見 / 通話）

function chatRoom(v) {
  const r = String(v || '3d');
  if (!CHAT_ROOMS.includes(r)) throw new HttpError(400, 'bad_room');
  return r;
}

// スタジオのキュレター・マネージャーに付けるタグ（スタジオID -> タグ名）
//   51603915 -> TWC / 32030084 -> GAS
const STUDIO_TAGS = { '51603915': 'TWC', '32030084': 'GAS' };
const STUDIO_TTL = 60 * 60 * 1000;          // 取り直す間隔
const STUDIO_RETRY = 5 * 60 * 1000;         // 取得に失敗したときの再試行までの間隔
const STUDIO_MAX_PAGES = 25;                // 1種類につき最大 25 × 40 = 1000人
const NOTIF_PAGE = 50;
const NOTIF_KEEP = 30 * 24 * 3600 * 1000;   // 通知を残す期間
const MAX_MENTIONS = 5;

function chatRow(r, env) {
  const o = { id: r.id, user_id: r.user_id, username: r.username, content: r.content,
              created_at: r.created_at, hidden: !!r.hidden, tags: r.tags || [] };
  if (r.reactions && r.reactions.length) o.reactions = r.reactions;
  if (r.edited_at) o.edited_at = r.edited_at;
  if (r.video_id) {
    if (isImageType(r.video_type)) o.image = videoInfo(r, env);
    else if (isFileType(r.video_type)) o.file = Object.assign(videoInfo(r, env), { name: r.video_name || (isSb3Type(r.video_type) ? 'project.sb3' : 'file'), size: r.video_size || 0 });
    else o.video = videoInfo(r, env);
  }
  if (r.reply_to) {
    o.reply = (r.reply_username && !r.reply_deleted && !r.reply_hidden)
      ? { id: r.reply_to, username: r.reply_username, content: String(r.reply_content).slice(0, 80) || '[添付]' }
      : { id: r.reply_to, gone: true };
  }
  return o;
}

async function scratchList(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'scratch-twc/1.0' } });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('bad json');
  return j;
}

// スタジオのキュレター・マネージャーを取り直す（古いときだけ）。失敗したら、前の結果をそのまま使う
async function syncStudioRoles(env) {
  const now = Date.now();
  for (const studio of Object.keys(STUDIO_TAGS)) {
    const st = await env.DB.prepare('SELECT synced_at FROM studio_sync WHERE studio_id = ?').bind(studio).first();
    if (st && now - st.synced_at < STUDIO_TTL) continue;
    try {
      const names = new Set();
      for (const kind of ['curators', 'managers']) {
        for (let page = 0; page < STUDIO_MAX_PAGES; page++) {
          const list = await scratchList(`${SCRATCH_API}/studios/${studio}/${kind}/?limit=40&offset=${page * 40}`);
          for (const u of list) if (u && u.username) names.add(String(u.username).toLowerCase());
          if (list.length < 40) break;
        }
      }
      const stmts = [env.DB.prepare('DELETE FROM studio_roles WHERE studio_id = ?').bind(studio)];
      for (const n of names) {
        stmts.push(env.DB.prepare('INSERT OR IGNORE INTO studio_roles (studio_id, username) VALUES (?, ?)').bind(studio, n));
      }
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO studio_sync (studio_id, synced_at) VALUES (?, ?)').bind(studio, now));
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('studio sync failed', studio, e);
      await env.DB.prepare('INSERT OR REPLACE INTO studio_sync (studio_id, synced_at) VALUES (?, ?)')
        .bind(studio, now - STUDIO_TTL + STUDIO_RETRY).run();
    }
  }
}

// ユーザー名（小文字）の配列 -> { 小文字名: [タグ...] }
async function tagsFor(env, namesLower) {
  const out = {};
  if (!namesLower.length) return out;
  const ph = namesLower.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT studio_id, username FROM studio_roles WHERE username IN (${ph})`)
    .bind(...namesLower).all();
  for (const r of rows.results) {
    const tag = STUDIO_TAGS[r.studio_id];
    if (!tag) continue;
    (out[r.username] = out[r.username] || []);
    if (!out[r.username].includes(tag)) out[r.username].push(tag);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

async function chatList(request, env, url) {
  const room = chatRoom(url.searchParams.get('room'));
  const user = await getUser(request, env);
  const admin = !!(user && isAdmin(user, env));
  // since=<最後に見たID> のときは、それより新しいメッセージだけを返す（読み取りが軽い）
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw !== null && /^\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : null;
  // before=<表示中の先頭のID> のときは、それより古いメッセージを返す（「以前のメッセージを読み込む」用）
  const beforeRaw = url.searchParams.get('before');
  const before = since === null && beforeRaw !== null && /^\d{1,12}$/.test(beforeRaw) ? Number(beforeRaw) : null;
  if (since === null && before === null) await syncStudioRoles(env);
  await ensureEditedCol(env);
  // around=<メッセージID> のときは、そのメッセージの前後25件ずつを返す（リンクから古いメッセージを開くため）
  const aroundRaw = url.searchParams.get('around');
  const around = since === null && aroundRaw !== null && /^\d{1,12}$/.test(aroundRaw) ? Number(aroundRaw) : null;
  let lo = null, hi = null;
  if (around !== null) {
    const vis = `room = ? AND deleted = 0 ${admin ? '' : 'AND hidden = 0'}`;
    const a = await env.DB.prepare(`SELECT MIN(id) AS x FROM (SELECT id FROM chat_messages WHERE ${vis} AND id <= ? ORDER BY id DESC LIMIT 25)`).bind(room, around).first();
    const b = await env.DB.prepare(`SELECT MAX(id) AS x FROM (SELECT id FROM chat_messages WHERE ${vis} AND id >= ? ORDER BY id ASC LIMIT 25)`).bind(room, around).first();
    if (a && a.x && b && b.x) { lo = a.x; hi = b.x; }
  }
  const rows = await env.DB.prepare(
    `SELECT m.id, m.user_id, m.username, m.content, m.created_at, m.hidden${_editedCol ? ', m.edited_at' : ''},
            rp.reply_to, p.username AS reply_username, p.content AS reply_content,
            p.deleted AS reply_deleted, p.hidden AS reply_hidden,
            v.id AS video_id, v.object_key AS video_key, v.content_type AS video_type, v.created_at AS video_created,
            v.size AS video_size, n.name AS video_name
       FROM chat_messages m
       LEFT JOIN chat_replies rp ON rp.message_id = m.id
       LEFT JOIN chat_messages p ON p.id = rp.reply_to
       LEFT JOIN chat_videos v ON v.message_id = m.id AND v.state = 'ready'
       LEFT JOIN chat_video_names n ON n.video_id = v.id
      WHERE m.room = ? ${since !== null ? 'AND m.id > ?' : ''} ${before !== null ? 'AND m.id < ?' : ''} ${lo !== null ? 'AND m.id BETWEEN ? AND ?' : ''} AND m.deleted = 0 ${admin ? '' : 'AND m.hidden = 0'}
      ORDER BY m.id ${since !== null ? 'ASC' : 'DESC'} LIMIT ?`
  ).bind(room, ...(since !== null ? [since] : []), ...(before !== null ? [before] : []), ...(lo !== null ? [lo, hi] : []), CHAT_PAGE).all();
  const list = since !== null ? rows.results : rows.results.reverse();
  const tags = await tagsFor(env, [...new Set(list.map(r => r.username.toLowerCase()))]);
  for (const r of list) { r.tags = tags[r.username.toLowerCase()] || []; }
  const reacts = await reactionsFor(env, list.map(r => r.id), user ? user.uid : 0);
  for (const r of list) { r.reactions = reacts[r.id] || []; }
  return json({ messages: await attachMediaUrls(env, list.map(r => chatRow(r, env))), is_admin: admin, partial: since !== null, has_more: since === null && list.length >= CHAT_PAGE, video_enabled: videoEnabled(env), file_max_mb: Math.round((env.LOCAL_FILES ? fileMaxBytes(env) : VIDEO_MAX_BYTES) / 1048576) });
}

// ---------- チャットの翻訳（全端末共通・GAS） ----------
// Google Apps Script の LanguageApp.translate（Google翻訳）を呼ぶ。GAS側の無料枠は、翻訳の呼び出し 1日5,000回まで。
//   ・ログインしている人だけが使える。失敗時は画面側に理由を返し、端末内翻訳へ自動で切り替えない
//   ・訳すのは、チャットに実際にあるメッセージだけ（ID で指定。自由な文章を訳すAPIにはしない）
//   ・訳文は D1 に保存して、同じメッセージを二度訳さない（他の人が押したときも、保存済みの訳を返す）
//   ・env.TRANSLATE_URL（GASのウェブアプリのURL）と env.TRANSLATE_SECRET（合言葉）は、wrangler secret で設定する
const TRANSLATE_LANGS = ['ja', 'en'];
const TRANSLATE_USER_PER_HOUR = 60;   // 1人が、1時間に新しく訳せる件数（保存済みの訳を見るだけなら数えない）
const TRANSLATE_DAILY_MAX = 1500;     // サイト全体で、24時間に新しく訳す件数の上限。1件は最大3回ほどGASを呼ぶので、GASの 5,000回/日 を超えない値にしてある
const TRANSLATE_WORDS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

// 訳さない部分（URL と @メンション）で、本文を区切る
function translateSplit(text) {
  const re = /https?:\/\/[^\s<>"']+|@[A-Za-z0-9_-]{3,20}/g;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ keep: false, s: text.slice(last, m.index) });
    parts.push({ keep: true, s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ keep: false, s: text.slice(last) });
  return parts;
}

async function translateChat(request, env) {
  const user = await requireUser(request, env);
  if (!env.TRANSLATE_URL || !env.TRANSLATE_SECRET) throw new HttpError(503, 'translate_unavailable');
  const body = await readJson(request);
  const id = body.id, lang = body.lang;
  if (!Number.isInteger(id) || id < 1 || !TRANSLATE_LANGS.includes(lang)) throw new HttpError(400, 'bad_request');

  const msg = await env.DB.prepare('SELECT content, hidden FROM chat_messages WHERE id = ? AND deleted = 0').bind(id).first();
  if (!msg || !msg.content || (msg.hidden && !isAdmin(user, env))) throw new HttpError(404, 'not_found');

  const hit = await env.DB.prepare('SELECT text FROM chat_translations WHERE message_id = ? AND lang = ?').bind(id, lang).first();
  if (hit) return json({ text: hit.text, cached: true });

  const parts = translateSplit(msg.content);
  const todo = parts.filter((p) => !p.keep && TRANSLATE_WORDS.test(p.s));
  if (!todo.length) return json({ text: msg.content });   // 訳すところが無い（URLだけ、など）

  const now = Date.now();
  const mine = await env.DB.prepare('SELECT COUNT(*) AS c FROM chat_translations WHERE user_id = ? AND created_at > ?').bind(user.uid, now - 3600000).first();
  if (mine && mine.c >= TRANSLATE_USER_PER_HOUR) throw new HttpError(429, 'too_many');
  const day = await env.DB.prepare('SELECT COUNT(*) AS c FROM chat_translations WHERE created_at > ?').bind(now - 86400000).first();
  if (day && day.c >= TRANSLATE_DAILY_MAX) throw new HttpError(503, 'translate_quota');

  let data;
  try {
    const res = await fetch(env.TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // GASのウェブアプリは、この形なら事前確認なしで受け取れる
      body: JSON.stringify({ secret: env.TRANSLATE_SECRET, to: lang, texts: todo.map((p) => p.s.trim()) }),
      redirect: 'follow',
    });
    data = await res.json();
  } catch {
    throw new HttpError(502, 'translate_failed');
  }
  if (!data || data.ok !== true) throw new HttpError(data && data.error === 'quota' ? 503 : 502, data && data.error === 'quota' ? 'translate_quota' : 'translate_failed');
  if (!Array.isArray(data.texts) || data.texts.length !== todo.length || data.texts.some((t) => typeof t !== 'string')) throw new HttpError(502, 'translate_failed');

  let k = 0;
  const text = parts.map((p) => {
    if (p.keep || !TRANSLATE_WORDS.test(p.s)) return p.s;
    const lead = p.s.match(/^\s*/)[0], trail = p.s.match(/\s*$/)[0];
    return lead + data.texts[k++] + trail;
  }).join('').slice(0, CHAT_MAX_LEN * 4);

  await env.DB.prepare('INSERT OR IGNORE INTO chat_translations (message_id, lang, text, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, lang, text, user.uid, now).run();
  return json({ text });
}

async function chatPost(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const content = String(body.content || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CHAT_MAX_LEN);
  const room = chatRoom(body.room);
  const clientId = body.client_id == null || body.client_id === '' ? '' : String(body.client_id);
  if (clientId && !/^[a-f0-9]{32}$/.test(clientId)) throw new HttpError(400, 'bad_client_id');

  // 同じ送信要求の再送は、投稿済みのメッセージを返すだけにする。
  // ネットワーク切断後にブラウザが再試行しても、同じコメントを二重登録しない。
  if (clientId) {
    const existing = await env.DB.prepare(
      'SELECT id, user_id, username, content, created_at, hidden FROM chat_messages WHERE user_id = ? AND client_id = ?'
    ).bind(user.uid, clientId).first();
    if (existing) {
      return json({ message: { id: existing.id, user_id: existing.user_id, username: existing.username,
        content: existing.content, created_at: existing.created_at, hidden: !!existing.hidden, tags: [] } });
    }
  }

  // 動画（先にアップロードして確認済みのものだけ）
  let video = null;
  if (body.video_id !== undefined && body.video_id !== null) {
    if (!/^[a-f0-9]{32}$/.test(String(body.video_id))) throw new HttpError(400, 'bad_video');
    video = await env.DB.prepare(
      "SELECT id FROM chat_videos WHERE id = ? AND user_id = ? AND state = 'ready' AND message_id IS NULL"
    ).bind(body.video_id, user.uid).first();
    if (!video) throw new HttpError(404, 'video_not_found');
  }
  if (!content && !video) throw new HttpError(400, 'empty');

  const ban = await env.DB.prepare('SELECT 1 AS x FROM chat_bans WHERE user_id = ?').bind(user.uid).first();
  if (ban) throw new HttpError(403, 'banned');

  const now = Date.now();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS c, MAX(created_at) AS m FROM chat_messages WHERE user_id = ? AND created_at > ?'
  ).bind(user.uid, now - 60000).first();
  if (recent && ((recent.m && now - recent.m < CHAT_MIN_INTERVAL) || recent.c >= CHAT_PER_MINUTE)) {
    throw new HttpError(429, 'too_fast');
  }

  // 返信先（同じ部屋の、削除されていないメッセージだけ）
  let parent = null;
  if (body.reply_to !== undefined && body.reply_to !== null) {
    if (!Number.isInteger(body.reply_to) || body.reply_to < 1) throw new HttpError(400, 'bad_reply');
    parent = await env.DB.prepare(
      'SELECT id, username FROM chat_messages WHERE id = ? AND room = ? AND deleted = 0 AND hidden = 0'
    ).bind(body.reply_to, room).first();
    if (!parent) throw new HttpError(404, 'reply_not_found');
  }

  let res;
  if (clientId) {
    res = await env.DB.prepare(
      'INSERT INTO chat_messages (user_id, username, content, created_at, room, client_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, client_id) DO NOTHING'
    ).bind(user.uid, user.u, content, now, room, clientId).run();
    if (!res.meta.changes) {
      // 別リクエストと同時に同じIDが届いた場合も、先に作られた1件だけを返す。
      const existing = await env.DB.prepare(
        'SELECT id, user_id, username, content, created_at, hidden FROM chat_messages WHERE user_id = ? AND client_id = ?'
      ).bind(user.uid, clientId).first();
      if (!existing) throw new HttpError(503, 'post_retry');
      return json({ message: { id: existing.id, user_id: existing.user_id, username: existing.username,
        content: existing.content, created_at: existing.created_at, hidden: !!existing.hidden, tags: [] } });
    }
  } else {
    res = await env.DB.prepare(
      'INSERT INTO chat_messages (user_id, username, content, created_at, room) VALUES (?, ?, ?, ?, ?)'
    ).bind(user.uid, user.u, content, now, room).run();
  }
  const id = res.meta.last_row_id;
  if (parent) await env.DB.prepare('INSERT INTO chat_replies (message_id, reply_to) VALUES (?, ?)').bind(id, parent.id).run();
  if (video) await env.DB.prepare('UPDATE chat_videos SET message_id = ? WHERE id = ?').bind(id, video.id).run();

  // 通知: 返信先の人（返信）と、@で呼ばれた人（メンション）。自分宛て・同じ人への重複は作らない
  const me = user.u.toLowerCase();
  const targets = new Map();
  if (parent) targets.set(parent.username.toLowerCase(), 'reply');
  for (const m of new Set([...content.matchAll(/@([A-Za-z0-9_-]{3,20})/g)].map(x => x[1].toLowerCase()))) {
    if (targets.size >= MAX_MENTIONS + 1) break;
    if (!targets.has(m)) targets.set(m, 'mention');
  }
  targets.delete(me);
  const snippet = (content || '[添付]').replace(/\s+/g, ' ').slice(0, 80);
  const stmts = [];
  for (const [to, kind] of targets) {
    stmts.push(env.DB.prepare(
      `INSERT INTO chat_notifications (to_username, kind, message_id, room, from_username, snippet, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(to, kind, id, room, user.u, snippet, now));
  }
  stmts.push(env.DB.prepare('DELETE FROM chat_notifications WHERE created_at < ?').bind(now - NOTIF_KEEP));
  await env.DB.batch(stmts);

  // 端末への通知（Web Push）。返事を待たせないよう、あとで送る
  const pushJob = notifyPush(env, targets, user.u, snippet, room).catch(e => console.error('push', e));
  const pctx = CTX.get(request);
  if (pctx) pctx.waitUntil(pushJob); else await pushJob;

  return json({ message: { id, user_id: user.uid, username: user.u, content, created_at: now, hidden: false, tags: [] } }, 201);
}

// ---------- 絵文字リアクション ----------
//   POST /api/chat/messages/:id/react { emoji }   -> { reactions: [{e, n, me}] }  (要ログイン。同じ絵文字をもう一度送ると取り消し)
//   GET  /api/chat/reactions?ids=1,2,3             -> { reactions: { "1": [{e, n, me}], ... } }  (公開。最大100件)
// どの絵文字でもよい。ただし「絵文字1つ」だけ（文字や、2つ以上は受け付けない）。1つのメッセージにつく絵文字は種類を限る
const REACTION_MAX_KINDS = 24;
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u;
function isReactionEmoji(e) {
  if (typeof e !== 'string' || !e || e.length > 32) return false;
  if (!EMOJI_RE.test(e)) return false;
  // 見た目で1つ分（結合文字・肌の色・ZWJでつないだものを含む）だけ
  try {
    let n = 0;
    for (const _ of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(e)) if (++n > 1) return false;
  } catch (err) { return /^[^\s\w]{1,12}$/u.test(e); }
  // 文字・数字・空白・制御が混ざっていないか（キーキャップの数字、ZWJ・異体字セレクタは除く）
  return !/[\p{L}\p{Zs}\p{Cc}]/u.test(e.replace(/^[#*0-9]\uFE0F?\u20E3$/u, '').replace(/[\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, ''));
}
const REACT_PER_MINUTE = 40;

// ids のメッセージごとのリアクション一覧。me は、いまのユーザーが付けたか
async function reactionsFor(env, ids, uid) {
  const out = {};
  const list = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 100);
  if (!list.length) return out;
  const rows = await env.DB.prepare(
    `SELECT message_id, emoji, COUNT(*) AS n, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS me, MIN(created_at) AS first
       FROM chat_reactions WHERE message_id IN (${list.map(() => '?').join(',')})
      GROUP BY message_id, emoji ORDER BY message_id, first, emoji`
  ).bind(uid || 0, ...list).all();
  for (const r of rows.results) (out[r.message_id] = out[r.message_id] || []).push({ e: r.emoji, n: Number(r.n), me: Number(r.me) > 0 });
  return out;
}

// chat_reactions に username 列がある作り（別の版のスキーマ）でも、ない作りでも動くようにする
let reactHasUsername = null;
async function reactionsHaveUsername(env) {
  if (reactHasUsername === null) {
    try {
      const r = await env.DB.prepare('PRAGMA table_info(chat_reactions)').all();
      reactHasUsername = (r.results || []).some((c) => c.name === 'username');
    } catch { reactHasUsername = false; }
  }
  return reactHasUsername;
}

async function chatReact(request, env, id) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const emoji = body && body.emoji;
  if (!isReactionEmoji(emoji)) throw new HttpError(400, 'bad_emoji');
  const ban = await env.DB.prepare('SELECT 1 AS x FROM chat_bans WHERE user_id = ?').bind(user.uid).first();
  if (ban) throw new HttpError(403, 'banned');
  const msg = await env.DB.prepare('SELECT id FROM chat_messages WHERE id = ? AND deleted = 0 AND hidden = 0').bind(id).first();
  if (!msg) throw new HttpError(404, 'not_found');
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM chat_reactions WHERE user_id = ? AND created_at > ?').bind(user.uid, now - 60000).first();
  const mine = await env.DB.prepare('SELECT 1 AS x FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').bind(id, user.uid, emoji).first();
  if (!mine) {
    const kinds = await env.DB.prepare('SELECT COUNT(DISTINCT emoji) AS c, SUM(emoji = ?) AS has FROM chat_reactions WHERE message_id = ?').bind(emoji, id).first();
    if (kinds && !kinds.has && kinds.c >= REACTION_MAX_KINDS) throw new HttpError(400, 'too_many_emoji');
  }
  if (mine) {
    await env.DB.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').bind(id, user.uid, emoji).run();
  } else {
    if (recent && recent.c >= REACT_PER_MINUTE) throw new HttpError(429, 'too_fast');
    if (await reactionsHaveUsername(env)) {
      await env.DB.prepare('INSERT OR IGNORE INTO chat_reactions (message_id, user_id, username, emoji, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, user.uid, user.u, emoji, now).run();
    } else {
      await env.DB.prepare('INSERT OR IGNORE INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').bind(id, user.uid, emoji, now).run();
    }
  }
  const r = await reactionsFor(env, [id], user.uid);
  return json({ reactions: r[id] || [] });
}

async function chatReactions(request, env, url) {
  const user = await getUser(request, env);
  const ids = String(url.searchParams.get('ids') || '').split(',').filter(s => /^\d{1,12}$/.test(s)).map(Number).slice(0, 100);
  return json({ reactions: await reactionsFor(env, ids, user ? user.uid : 0) });
}

// 編集した印（edited_at）の列。なければ、最初に使うときに足す（D1にもホストの自前DBにも、そのまま効く）
let _editedCol = false;
async function ensureEditedCol(env) {
  if (_editedCol) return;
  try {
    const r = await env.DB.prepare('PRAGMA table_info(chat_messages)').all();
    if (!(r.results || []).some(c => c.name === 'edited_at')) await env.DB.prepare('ALTER TABLE chat_messages ADD COLUMN edited_at INTEGER').run();
    _editedCol = true;
  } catch (e) { /* 失敗しても、チャットは今までどおり動く（編集だけ使えない） */ }
}

// POST /api/chat/messages/:id/edit { content } -> { id, content, edited_at }  (本人のみ。削除・非表示のものは不可)
async function chatEdit(request, env, id) {
  const user = await requireUser(request, env);
  await ensureEditedCol(env);
  if (!_editedCol) throw new HttpError(503, 'edit_unavailable');
  const body = await readJson(request);
  const content = String(body.content || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CHAT_MAX_LEN);
  const row = await env.DB.prepare(
    `SELECT m.user_id, m.hidden, m.content, (SELECT 1 FROM chat_videos v WHERE v.message_id = m.id AND v.state = 'ready' LIMIT 1) AS has_media
       FROM chat_messages m WHERE m.id = ? AND m.deleted = 0`
  ).bind(id).first();
  if (!row) throw new HttpError(404, 'not_found');
  if (row.user_id !== user.uid) throw new HttpError(403, 'forbidden');
  if (row.hidden) throw new HttpError(403, 'forbidden');
  if (!content && !row.has_media) throw new HttpError(400, 'empty');
  const ban = await env.DB.prepare('SELECT 1 AS x FROM chat_bans WHERE user_id = ?').bind(user.uid).first();
  if (ban) throw new HttpError(403, 'banned');
  if (content === row.content) return json({ id, content, edited_at: null });   // 変更なし
  const now = Date.now();
  await env.DB.prepare('UPDATE chat_messages SET content = ?, edited_at = ? WHERE id = ?').bind(content, now, id).run();
  return json({ id, content, edited_at: now });
}

async function chatDelete(request, env, id) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare('SELECT user_id FROM chat_messages WHERE id = ? AND deleted = 0').bind(id).first();
  if (!row) throw new HttpError(404, 'not_found');
  if (row.user_id !== user.uid && !isAdmin(user, env)) throw new HttpError(403, 'forbidden');
  await env.DB.prepare('UPDATE chat_messages SET deleted = 1 WHERE id = ?').bind(id).run();
  await deleteVideosOfMessage(env, id);
  return json({ deleted: true });
}

async function chatReport(request, env, id) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare('SELECT user_id FROM chat_messages WHERE id = ? AND deleted = 0').bind(id).first();
  if (!row) throw new HttpError(404, 'not_found');
  if (row.user_id === user.uid) throw new HttpError(400, 'own_message');
  await env.DB.prepare('INSERT OR IGNORE INTO chat_reports (message_id, reporter_id, created_at) VALUES (?, ?, ?)')
    .bind(id, user.uid, Date.now()).run();
  const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM chat_reports WHERE message_id = ?').bind(id).first();
  if (c && c.c >= CHAT_REPORT_HIDE) {
    await env.DB.prepare('UPDATE chat_messages SET hidden = 1 WHERE id = ?').bind(id).run();
  }
  return json({ reported: true });
}

async function chatAdminAction(request, env, id) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const action = body.action;
  let sql;
  if (action === 'hide') sql = 'UPDATE chat_messages SET hidden = 1 WHERE id = ?';
  else if (action === 'restore') sql = 'UPDATE chat_messages SET hidden = 0 WHERE id = ?';
  else if (action === 'delete') sql = 'UPDATE chat_messages SET deleted = 1 WHERE id = ?';
  else throw new HttpError(400, 'bad_action');
  const res = await env.DB.prepare(sql).bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'not_found');
  // 再表示したら通報をリセットする（残すと、次の1件でまた非表示になるため）
  if (action === 'restore') await env.DB.prepare('DELETE FROM chat_reports WHERE message_id = ?').bind(id).run();
  if (action === 'delete') await deleteVideosOfMessage(env, id);
  return json({ ok: true });
}

async function chatAdminBan(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const name = String(body.username || '').trim();
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) throw new HttpError(400, 'bad_username');
  const u = await scratchUser(name);
  if (isAdmin({ u: u.username }, env)) throw new HttpError(400, 'cannot_ban_admin');
  const banned = body.banned !== false;
  if (banned) {
    await env.DB.prepare('INSERT OR REPLACE INTO chat_bans (user_id, username, created_at) VALUES (?, ?, ?)')
      .bind(u.id, u.username, Date.now()).run();
  } else {
    await env.DB.prepare('DELETE FROM chat_bans WHERE user_id = ?').bind(u.id).run();
  }
  return json({ username: u.username, banned });
}


// ---------- 通知（返信・メンション・すべてのメッセージ） ----------
//   GET  /api/notifications         -> { items: [...新しい順50件], unread, mode }  (要ログイン)
//   GET  /api/notifications/count   -> { unread }                                   (要ログイン)
//   POST /api/notifications/read { id } か { upto: メッセージID } か { all: true }  -> { unread }  (要ログイン)
//   GET  /api/notifications/settings -> { mode }                                    (要ログイン)
//   PUT  /api/notifications/settings { mode: 'all' | 'mentions' } -> { mode, unread } (要ログイン)
// 通知の範囲（mode）:
//   all      … すべてのメッセージ（初期設定）。返信・メンションに加えて、自分以外の全部屋の発言が通知される
//   mentions … 返信・メンションだけ
// 「all」の発言は、人数分の通知の行を書かない（無料枠の節約）。notif_prefs.all_seen_id から後の発言を、未読として数える。
//   返信・メンションの通知がすでにある発言は、そちらで数えるので、二重にはしない。
// 削除・非表示になったメッセージの通知は出さない。

const NOTIF_VISIBLE = `FROM chat_notifications n
   JOIN chat_messages m ON m.id = n.message_id AND m.deleted = 0 AND m.hidden = 0
  WHERE n.to_username = ?`;

// 「すべてのメッセージ」の対象: 自分以外の発言で、返信・メンションの通知が別にないもの
const NOTIF_MSG_WHERE = `FROM chat_messages m
  WHERE m.deleted = 0 AND m.hidden = 0 AND lower(m.username) != ?
    AND NOT EXISTS (SELECT 1 FROM chat_notifications n WHERE n.message_id = m.id AND n.to_username = ?)`;
const NOTIF_MODES = ['all', 'mentions'];
const NOTIF_UNREAD_CAP = 100;   // 数えるのは100件まで（画面は 99+）

async function notifPrefs(env, user) {
  const me = user.u.toLowerCase();
  const sel = 'SELECT mode, all_seen_id FROM notif_prefs WHERE username = ?';
  let p = await env.DB.prepare(sel).bind(me).first();
  if (!p) {
    // はじめての人は「all」で始める。いまの最新までを既読にして、過去の発言がまとめて未読にならないようにする
    await env.DB.prepare(
      `INSERT OR IGNORE INTO notif_prefs (username, mode, all_seen_id, updated_at)
       VALUES (?, 'all', (SELECT COALESCE(MAX(id), 0) FROM chat_messages), ?)`
    ).bind(me, Date.now()).run();
    p = await env.DB.prepare(sel).bind(me).first();
  }
  return { mode: p && p.mode === 'mentions' ? 'mentions' : 'all', seen: p ? p.all_seen_id : 0 };
}

// room を渡したときは、その部屋（いま開いて読んでいる部屋）の分は数えない
async function unreadCount(env, user, prefs, room) {
  const me = user.u.toLowerCase();
  const ex = typeof room === 'string' && CHAT_ROOMS.includes(room) ? room : '';
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c ${NOTIF_VISIBLE} AND n.is_read = 0 AND n.room != ?`).bind(me, ex).first();
  let n = r ? r.c : 0;
  prefs = prefs || await notifPrefs(env, user);
  if (prefs.mode === 'all') {
    const q = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM (SELECT 1 ${NOTIF_MSG_WHERE} AND m.room != ? AND m.id > ? LIMIT ${NOTIF_UNREAD_CAP})`
    ).bind(me, me, ex, prefs.seen).first();
    n += q ? q.c : 0;
  }
  return n;
}

async function notifList(request, env) {
  const user = await requireUser(request, env);
  const me = user.u.toLowerCase();
  const prefs = await notifPrefs(env, user);
  const rows = await env.DB.prepare(
    `SELECT n.id, n.kind, n.message_id, n.room, n.from_username, n.snippet, n.created_at, n.is_read
       ${NOTIF_VISIBLE} ORDER BY n.id DESC LIMIT ?`
  ).bind(me, NOTIF_PAGE).all();
  let items = rows.results.map(r => ({ id: r.id, kind: r.kind, message_id: r.message_id, room: r.room,
    from_username: r.from_username, snippet: r.snippet, created_at: r.created_at, read: !!r.is_read }));

  if (prefs.mode === 'all') {
    const msgs = await env.DB.prepare(
      `SELECT m.id, m.room, m.username, m.content, m.created_at ${NOTIF_MSG_WHERE} AND m.created_at > ?
        ORDER BY m.id DESC LIMIT ?`
    ).bind(me, me, Date.now() - NOTIF_KEEP, NOTIF_PAGE).all();
    for (const r of msgs.results) {
      items.push({ id: 0, kind: 'message', message_id: r.id, room: r.room, from_username: r.username,
        snippet: String(r.content || '').replace(/\s+/g, ' ').slice(0, 80) || '[添付]',
        created_at: r.created_at, read: r.id <= prefs.seen });
    }
    items.sort((a, b) => (b.created_at - a.created_at) || (b.message_id - a.message_id));
    items = items.slice(0, NOTIF_PAGE);
  }
  return json({ items, unread: await unreadCount(env, user, prefs), mode: prefs.mode });
}

async function notifCount(request, env) {
  const user = await requireUser(request, env);
  return json({ unread: await unreadCount(env, user, undefined, new URL(request.url).searchParams.get('room')) });
}

async function notifRead(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const me = user.u.toLowerCase();
  await notifPrefs(env, user);   // 行がなければ作る（既読位置を持つ行）
  const LATEST = '(SELECT COALESCE(MAX(id), 0) FROM chat_messages)';
  if (typeof body.room === 'string' && CHAT_ROOMS.includes(body.room) && Number.isInteger(body.upto) && body.upto > 0) {
    // その部屋を開いて、upto までのメッセージを読んだとき。
    //   ・その部屋の返信・メンションの通知を、upto までは既読にする
    //   ・「すべてのメッセージ」の既読位置は、他の部屋に未読の発言があるときは、その手前までしか進めない（他の部屋の未読を消さないため）
    await env.DB.batch([
      env.DB.prepare('UPDATE chat_notifications SET is_read = 1 WHERE to_username = ? AND room = ? AND message_id <= ? AND is_read = 0').bind(me, body.room, body.upto),
      env.DB.prepare(
        `UPDATE notif_prefs SET all_seen_id = MAX(all_seen_id, MIN(?, ${LATEST}, COALESCE((SELECT MIN(m.id) - 1 ${NOTIF_MSG_WHERE} AND m.room != ? AND m.id > notif_prefs.all_seen_id), ?))) WHERE username = ?`
      ).bind(body.upto, me, me, body.room, body.upto, me),
    ]);
    return json({ unread: await unreadCount(env, user, undefined, body.room) });
  } else if (body.all === true) {
    await env.DB.batch([
      env.DB.prepare('UPDATE chat_notifications SET is_read = 1 WHERE to_username = ? AND is_read = 0').bind(me),
      env.DB.prepare(`UPDATE notif_prefs SET all_seen_id = ${LATEST} WHERE username = ?`).bind(me),
    ]);
  } else if (Number.isInteger(body.upto) && body.upto > 0) {
    // 「すべてのメッセージ」の発言を開いたとき。そのメッセージまでを既読にする（戻ることはない）
    await env.DB.prepare(
      `UPDATE notif_prefs SET all_seen_id = MAX(all_seen_id, MIN(?, ${LATEST})) WHERE username = ?`
    ).bind(body.upto, me).run();
  } else if (Number.isInteger(body.id)) {
    await env.DB.prepare('UPDATE chat_notifications SET is_read = 1 WHERE id = ? AND to_username = ?').bind(body.id, me).run();
  } else {
    throw new HttpError(400, 'bad_request');
  }
  return json({ unread: await unreadCount(env, user) });
}

async function notifSettingsGet(request, env) {
  const user = await requireUser(request, env);
  const prefs = await notifPrefs(env, user);
  return json({ mode: prefs.mode });
}

async function notifSettingsPut(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (!body || !NOTIF_MODES.includes(body.mode)) throw new HttpError(400, 'bad_mode');
  // 「mentions」から「all」に変えた瞬間は、いまの最新までを既読にする（昔の発言がまとめて未読にならないように）。
  // 同じ設定のまま送られたときは、既読位置を動かさない。
  await env.DB.prepare(
    `INSERT INTO notif_prefs (username, mode, all_seen_id, updated_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM chat_messages), ?)
     ON CONFLICT(username) DO UPDATE SET
       all_seen_id = CASE WHEN notif_prefs.mode != excluded.mode THEN excluded.all_seen_id ELSE notif_prefs.all_seen_id END,
       mode = excluded.mode,
       updated_at = excluded.updated_at`
  ).bind(user.u.toLowerCase(), body.mode, Date.now()).run();
  return json({ mode: body.mode, unread: await unreadCount(env, user) });
}


// ---------- 動画（Backblaze B2 / S3互換API） ----------
//   POST   /api/chat/videos/start { size, type }  -> { id, upload_url, headers }   (要ログイン。動画(mp4/webm)・写真(jpeg/png/webp)を、B2へ直接アップロードするための一時URL)
//   POST   /api/chat/videos/:id/complete          -> { id, url, type }             (アップロード後に確認。大きすぎたら消す)
//   DELETE /api/chat/videos/:id                   -> { deleted }                   (投稿前の動画を取り消す)
// 投稿は POST /api/chat/messages に video_id を付ける。メッセージを削除すると、動画も消える。
// 設定（worker/B2_SETUP.md）: 変数 B2_ENDPOINT, B2_BUCKET, VIDEO_BASE_URL, VIDEO_TTL_DAYS、
//   シークレット B2_KEY_ID, B2_APP_KEY。未設定なら動画機能は無効（video_enabled: false）。
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;   // B2を使うときの上限。このPCに保存するときは FILE_MAX_MB（既定50）
const VIDEO_PER_DAY = 3;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;     // ブラウザ側で縮小してから送るので、実際は数百KB程度
const IMAGE_PER_DAY = 10;
const SB3_TYPE = 'application/x.scratch.sb3';
const SB3_PER_DAY = 5;
const isSb3Type = (t) => t === SB3_TYPE;
// sb3 以外の「その他のファイル」（zip・pdf・音声・txt など）。いつも「ダウンロード」として配る（ページとしては開かせない）
const FILE_TYPE = 'application/x.twc.file';
const FILE_PER_DAY = 10;
const isFileType = (t) => t === SB3_TYPE || t === FILE_TYPE;       // 添付のうち、ダウンロード形式のもの
// 送れない拡張子: 実行ファイル・スクリプト・ページとして開けるもの
const FILE_DENY = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'jar', 'apk', 'dmg', 'app', 'pkg', 'deb', 'rpm', 'lnk', 'reg', 'dll', 'sys', 'cpl', 'msc', 'html', 'htm', 'xhtml', 'svg', 'swf']);
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', [SB3_TYPE]: 'sb3', [FILE_TYPE]: 'bin', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// 表示用のファイル名。制御文字と、長すぎる分は落とす
function cleanFileName(raw, fallback) {
  return String(raw || fallback).replace(/[\u0000-\u001f\u007f<>"\\/:*?|]/g, '').trim().slice(0, 100) || fallback;
}
function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}
function fileMaxBytes(env) {
  const m = Number(env.FILE_MAX_MB);
  return (Number.isFinite(m) && m > 0 ? m : (env.LOCAL_FILES ? 50 : 20)) * 1048576;
}
const isImageType = (t) => String(t).startsWith('image/');
const VIDEO_PRESIGN_SECONDS = 600;

function videoEnabled(env) {
  // VIDEO_BASE_URL が空なら「非公開バケット」。見るときは期限つきの閲覧URLを都度つくる
  if (env.LOCAL_FILES) return !!env.PUBLIC_URL;     // このPC（server.mjs）に保存する
  return !!(env.B2_ENDPOINT && env.B2_BUCKET && env.B2_KEY_ID && env.B2_APP_KEY);
}
function requireVideo(env) {
  if (!videoEnabled(env)) throw new HttpError(503, 'video_disabled');
}
function videoTtlMs(env) {
  const d = Number(env.VIDEO_TTL_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : (env.LOCAL_FILES ? 30 : 14)) * 24 * 3600 * 1000;
}
// B2のライフサイクル設定で消えた後は、再生できないことを知らせる
function videoInfo(r, env) {
  if (Date.now() - r.video_created > videoTtlMs(env)) return { id: r.video_id, type: r.video_type, expired: true };
  return { id: r.video_id, type: r.video_type, _key: r.video_key };   // url は mediaUrl() であとから付ける
}

// 閲覧URL。公開バケットならそのまま、非公開なら署名つき。
// 署名の時刻を3日ごとに区切るので、同じファイルのURLは3日間変わらない＝ブラウザが保存したものを使い回せる
// （毎時間変わると、見るたびにB2から取り直すことになり、転送量を食う）。
// 署名の有効期間は6日なので、どの時点でも最低3日は使える。
const VIEW_WINDOW = 3 * 24 * 3600 * 1000;
const VIEW_EXPIRES = 6 * 24 * 3600;
async function mediaUrl(env, key) {
  if (env.LOCAL_FILES) return String(env.PUBLIC_URL).replace(/\/+$/, '') + '/f/' + key.replace(/^v\//, '');
  if (env.VIDEO_BASE_URL) return String(env.VIDEO_BASE_URL).replace(/\/+$/, '') + '/' + key;
  const now = Math.floor(Date.now() / VIEW_WINDOW) * VIEW_WINDOW;
  // ブラウザに長く覚えさせる指定。うまく働かないときは VIEW_CACHE_SECONDS = "0" にすると外れる
  const cache = Number(env.VIEW_CACHE_SECONDS === undefined || env.VIEW_CACHE_SECONDS === '' ? 604800 : env.VIEW_CACHE_SECONDS);
  return presignUrl({
    method: 'GET', host: `${env.B2_BUCKET}.${env.B2_ENDPOINT}`, path: '/' + key,
    region: regionOf(env.B2_ENDPOINT), keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY,
    now, expires: VIEW_EXPIRES,
    extraQuery: cache > 0 ? { 'response-cache-control': `private, max-age=${Math.floor(cache)}, immutable` } : undefined,
  });
}
async function attachMediaUrls(env, rows) {
  for (const m of rows) {
    for (const k of ['video', 'image', 'file']) {
      const x = m[k];
      if (x && x._key) { x.url = await mediaUrl(env, x._key); delete x._key; }
    }
  }
  return rows;
}

// --- AWS Signature V4（S3互換。B2用） ---
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(data) { return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data)); }
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function signingKey(secret, date, region) {
  let k = await hmac(enc.encode('AWS4' + secret), date);
  k = await hmac(k, region);
  k = await hmac(k, 's3');
  return hmac(k, 'aws4_request');
}
function rfc3986(s) { return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function amzDates(now) {
  const iso = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20130524T000000Z
  return { amzDate: iso, date: iso.slice(0, 8) };
}
function regionOf(endpoint) {                       // s3.us-west-004.backblazeb2.com -> us-west-004
  const m = String(endpoint).match(/^s3\.([^.]+)\./);
  return m ? m[1] : 'us-east-1';
}

// 署名付きURL（クエリ方式）。signHeaders は署名に含めるヘッダー（host以外）
async function presignUrl({ method, host, path, region, keyId, secret, now, expires, signHeaders, extraQuery }) {
  const { amzDate, date } = amzDates(now);
  const scope = `${date}/${region}/s3/aws4_request`;
  const headers = { host, ...(signHeaders || {}) };
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const signedHeaders = names.join(';');
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${keyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(extraQuery || {}),
  };
  const canonicalQuery = Object.keys(q).sort().map(k => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const sig = hex(await hmac(await signingKey(secret, date, region), toSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

// HEAD / DELETE も、アップロードと同じ「署名つきURL」で送る（実際に通ることを確認済みの方式）
async function s3Fetch(env, method, key, extraHeaders) {
  const url = await presignUrl({
    method,
    host: `${env.B2_BUCKET}.${env.B2_ENDPOINT}`,
    path: '/' + key,
    region: regionOf(env.B2_ENDPOINT),
    keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY,
    now: Date.now(), expires: 120,
  });
  return fetch(url, { method, headers: extraHeaders || {} });
}

async function b2Delete(env, key) {
  if (env.LOCAL_FILES) { try { await env.LOCAL_FILES.remove(key); } catch (e) { console.error('file delete failed', key, e); } return; }
  try { await s3Fetch(env, 'DELETE', key); } catch (e) { console.error('b2 delete failed', key, e); }
}

async function deleteVideosOfMessage(env, messageId) {
  if (!videoEnabled(env)) return;
  const rows = await env.DB.prepare("SELECT id, object_key FROM chat_videos WHERE message_id = ? AND state != 'deleted'").bind(messageId).all();
  for (const v of rows.results) {
    await b2Delete(env, v.object_key);
    await env.DB.prepare("UPDATE chat_videos SET state = 'deleted' WHERE id = ?").bind(v.id).run();
  }
}

async function videoStart(request, env) {
  const user = await requireUser(request, env);
  requireVideo(env);
  const body = await readJson(request);
  const type = String(body.type || '');
  const size = body.size;
  if (!VIDEO_TYPES[type]) throw new HttpError(400, 'bad_video_type');
  const image = isImageType(type), sb3 = isSb3Type(type), gen = type === FILE_TYPE;
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'bad_video_size');
  const maxBytes = image ? IMAGE_MAX_BYTES : (env.LOCAL_FILES ? fileMaxBytes(env) : VIDEO_MAX_BYTES);
  if (size > maxBytes) throw new HttpError(413, image ? 'image_too_big' : sb3 ? 'sb3_too_big' : gen ? 'file_too_big' : 'video_too_big');
  // その他のファイル: 元の名前と拡張子を確かめる
  let fname = '', ext = VIDEO_TYPES[type];
  if (gen) {
    fname = cleanFileName(body.name, 'file');
    ext = fileExt(fname) || 'bin';
    if (FILE_DENY.has(ext)) throw new HttpError(400, 'bad_file_type');
  }

  const ban = await env.DB.prepare('SELECT 1 AS x FROM chat_bans WHERE user_id = ?').bind(user.uid).first();
  if (ban) throw new HttpError(403, 'banned');

  const now = Date.now();
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM chat_videos WHERE user_id = ? AND created_at > ? AND state != 'deleted'
       AND ${image ? "content_type LIKE 'image/%'" : sb3 ? `content_type = '${SB3_TYPE}'` : gen ? `content_type = '${FILE_TYPE}'` : `content_type NOT LIKE 'image/%' AND content_type != '${SB3_TYPE}' AND content_type != '${FILE_TYPE}'`}`
  ).bind(user.uid, now - 24 * 3600 * 1000).first();
  if (used && used.c >= (image ? IMAGE_PER_DAY : sb3 ? SB3_PER_DAY : gen ? FILE_PER_DAY : VIDEO_PER_DAY)) throw new HttpError(429, image ? 'image_limit' : sb3 ? 'sb3_limit' : gen ? 'file_limit' : 'video_limit');

  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `v/${id}.${ext}`;
  await env.DB.prepare(
    'INSERT INTO chat_videos (id, user_id, username, object_key, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, user.uid, user.u, key, type, now).run();
  if (sb3 || gen) {
    // 元のファイル名（表示用・ダウンロード時の名前）
    let name = gen ? fname : cleanFileName(body.name, 'project.sb3');
    if (sb3 && !/\.sb3$/i.test(name)) name = (name || 'project') + '.sb3';
    await env.DB.prepare('INSERT OR REPLACE INTO chat_video_names (video_id, name) VALUES (?, ?)').bind(id, name).run();
  }
  if (env.LOCAL_FILES) {
    // このPCへ直接アップロードするための、10分だけ使える合鍵つきURL（server.mjs の PUT /api/chat/upload が受ける）
    const t = await signToken({ up: key, ty: type, mx: maxBytes, exp: now + VIDEO_PRESIGN_SECONDS * 1000 }, env.SESSION_SECRET);
    return json({ id, upload_url: String(env.PUBLIC_URL).replace(/\/+$/, '') + '/api/chat/upload?t=' + encodeURIComponent(t), headers: { 'Content-Type': type }, max_bytes: maxBytes });
  }

  const uploadUrl = await presignUrl({
    method: 'PUT',
    host: `${env.B2_BUCKET}.${env.B2_ENDPOINT}`,
    path: '/' + key,
    region: regionOf(env.B2_ENDPOINT),
    keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY,
    now, expires: VIDEO_PRESIGN_SECONDS,
    signHeaders: { 'content-type': type },
  });
  return json({ id, upload_url: uploadUrl, headers: { 'Content-Type': type }, max_bytes: maxBytes });
}

// アップロードされたものを確認する。署名ではサイズを縛れないので、ここで実サイズを調べる
async function videoComplete(request, env, id) {
  const user = await requireUser(request, env);
  requireVideo(env);
  const v = await env.DB.prepare("SELECT * FROM chat_videos WHERE id = ? AND user_id = ? AND state != 'deleted'").bind(id, user.uid).first();
  if (!v) throw new HttpError(404, 'not_found');
  // 大きさと種類を確かめる（B2: 先頭だけ読む。HEADが拒否されたため、GETの範囲指定で代用 / このPC: ファイルを直接調べる）
  let size = 0, type = '', head = new Uint8Array(0);
  if (env.LOCAL_FILES) {
    const st = await env.LOCAL_FILES.stat(v.object_key);
    if (!st) throw new HttpError(409, 'not_uploaded');
    size = st.size; type = v.content_type;            // 種類は、アップロードの受け口が合鍵と照らして確かめ済み
    head = await env.LOCAL_FILES.head(v.object_key, 4);
  } else {
    let r;
    try { r = await s3Fetch(env, 'GET', v.object_key, { Range: 'bytes=0-3' }); } catch { throw new HttpError(502, 'storage_unreachable'); }
    if (r.status === 404) throw new HttpError(409, 'not_uploaded');
    if (!r.ok) {
      let body = ''; try { body = (await r.text()).slice(0, 300); } catch {}
      console.error('b2 check failed', r.status, body);
      throw new HttpError(502, 'storage_error');
    }
    const cr = String(r.headers.get('content-range') || '').match(/\/(\d+)$/);
    size = cr ? Number(cr[1]) : Number(r.headers.get('content-length') || 0);
    type = String(r.headers.get('content-type') || '').split(';')[0].trim();
    head = new Uint8Array(await r.arrayBuffer());
  }
  const image = isImageType(v.content_type), sb3 = isSb3Type(v.content_type), gen = v.content_type === FILE_TYPE;
  const maxBytes = image ? IMAGE_MAX_BYTES : (env.LOCAL_FILES ? fileMaxBytes(env) : VIDEO_MAX_BYTES);
  // sb3 は zip なので、先頭が "PK\x03\x04" であることも確かめる
  let magicOk = true;
  if (sb3) magicOk = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;
  if (!size || size > maxBytes || type !== v.content_type || !magicOk) {
    await b2Delete(env, v.object_key);
    await env.DB.prepare("UPDATE chat_videos SET state = 'deleted' WHERE id = ?").bind(id).run();
    throw new HttpError(size > maxBytes ? 413 : 400, size > maxBytes ? (image ? 'image_too_big' : sb3 ? 'sb3_too_big' : gen ? 'file_too_big' : 'video_too_big') : 'bad_video');
  }
  await env.DB.prepare("UPDATE chat_videos SET state = 'ready', size = ? WHERE id = ?").bind(size, id).run();
  return json({ id, type, url: await mediaUrl(env, v.object_key) });
}

async function videoDiscard(request, env, id) {
  const user = await requireUser(request, env);
  const v = await env.DB.prepare("SELECT object_key FROM chat_videos WHERE id = ? AND user_id = ? AND message_id IS NULL AND state != 'deleted'")
    .bind(id, user.uid).first();
  if (!v) throw new HttpError(404, 'not_found');
  if (videoEnabled(env)) await b2Delete(env, v.object_key);
  await env.DB.prepare("UPDATE chat_videos SET state = 'deleted' WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}


// ---------- ジャンル（みんなで付ける） ----------
//   GET    /api/genres?genre=3d                    -> { ids: [...] }                       (確定したものだけ。公開)
//   GET    /api/genres/project/:id                 -> { confirmed, votes, mine }           (mine はログイン時のみ)
//   PUT    /api/genres/project/:id/:genre          -> { ... }                              (要ログイン。投票)
//   DELETE /api/genres/project/:id/:genre          -> { ... }                              (要ログイン。自分の投票を取り消す)
// 確定: 2票以上、または管理者・キュレター（TWC/GASタグの人）の1票。
const GENRES = ['3d', 'physics', 'engine', 'render', 'algorithm', 'math', 'tool', 'media', 'audio', 'ai', 'other'];
const MAX_GENRE_IDS = 3000;
const MAX_GENRE_VOTES_PER_USER = 500;
const GENRE_CONFIRMED = 'COUNT(*) >= 2 OR SUM(trusted) >= 1';

async function genreIds(env, url) {
  const g = url.searchParams.get('genre') || '';
  if (!GENRES.includes(g)) throw new HttpError(400, 'bad_genre');
  const rows = await env.DB.prepare(
    `SELECT project_id FROM project_genres WHERE genre = ? GROUP BY project_id HAVING ${GENRE_CONFIRMED}
      ORDER BY project_id DESC LIMIT ?`
  ).bind(g, MAX_GENRE_IDS).all();
  return json({ ids: rows.results.map(r => r.project_id) });
}

async function genreSummary(env, projectId, user) {
  const rows = await env.DB.prepare(
    'SELECT genre, COUNT(*) AS c, SUM(trusted) AS t FROM project_genres WHERE project_id = ? GROUP BY genre'
  ).bind(projectId).all();
  const votes = {}, confirmed = [];
  for (const r of rows.results) {
    votes[r.genre] = r.c;
    if (r.c >= 2 || r.t >= 1) confirmed.push(r.genre);
  }
  let mine = [];
  if (user) {
    const m = await env.DB.prepare('SELECT genre FROM project_genres WHERE project_id = ? AND user_id = ?').bind(projectId, user.uid).all();
    mine = m.results.map(r => r.genre);
  }
  return { confirmed, votes, mine };
}

async function genreOfProject(request, env, projectId) {
  const user = await getUser(request, env);
  return json(await genreSummary(env, projectId, user));
}

async function genreVote(request, env, projectId, genre, on) {
  const user = await requireUser(request, env);
  if (!GENRES.includes(genre)) throw new HttpError(400, 'bad_genre');
  if (on) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM project_genres WHERE user_id = ?').bind(user.uid).first();
    if (n && n.c >= MAX_GENRE_VOTES_PER_USER) throw new HttpError(429, 'too_many_votes');
    await syncStudioRoles(env);
    const tg = await tagsFor(env, [user.u.toLowerCase()]);
    const trusted = isAdmin(user, env) || (tg[user.u.toLowerCase()] || []).length > 0 ? 1 : 0;
    await env.DB.prepare(
      'INSERT OR IGNORE INTO project_genres (project_id, genre, user_id, username, trusted, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(projectId, genre, user.uid, user.u, trusted, Date.now()).run();
  } else {
    await env.DB.prepare('DELETE FROM project_genres WHERE project_id = ? AND genre = ? AND user_id = ?')
      .bind(projectId, genre, user.uid).run();
  }
  return json(await genreSummary(env, projectId, user));
}

// ---------- 今週のランキング ----------
//   GET /api/ranking/weekly -> { items: [{ id, avg, count, saves }], since }
// 直近7日間につけられた評価で並べる（評価が少ない作品が、1件の★5だけで1位にならないよう、全体の平均に寄せる）
const WEEK_MS = 7 * 24 * 3600 * 1000;
const WEEKLY_LIMIT = 30;

async function weeklyRanking(env) {
  const since = Date.now() - WEEK_MS;
  const rows = await env.DB.prepare(
    `SELECT project_id, COUNT(*) AS c, AVG(score) AS a,
            (SUM(score) + ?) * 1.0 / (COUNT(*) + ?) AS w
       FROM ratings WHERE updated_at >= ?
      GROUP BY project_id
      ORDER BY w DESC, c DESC, project_id DESC LIMIT ?`
  ).bind(PRIOR_MEAN * PRIOR_WEIGHT, PRIOR_WEIGHT, since, WEEKLY_LIMIT).all();
  const items = rows.results.map(r => ({ id: r.project_id, avg: Math.round(r.a * 100) / 100, count: r.c, saves: 0 }));
  if (items.length) {
    const ph = items.map(() => '?').join(',');
    const sv = await env.DB.prepare(
      `SELECT project_id, COUNT(*) AS c FROM saves WHERE created_at >= ? AND project_id IN (${ph}) GROUP BY project_id`
    ).bind(since, ...items.map(i => i.id)).all();
    const m = new Map(sv.results.map(r => [r.project_id, r.c]));
    for (const it of items) it.saves = m.get(it.id) || 0;
  }
  return json({ items, since });
}

// ---------- プロフィール ----------
//   POST /api/ratings/stats { ids: [...] }  -> { count, avg, projects }   指定した作品が受けた評価のまとめ（最大500作品）
//   GET  /api/users/:name/profile           -> { username, tags, chat_posts, ratings_given }
async function ratingStats(request, env) {
  const body = await readJson(request);
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter(n => Number.isInteger(n) && n > 0))];
  if (ids.length > 500) throw new HttpError(400, 'too_many_ids');
  if (!ids.length) return json({ count: 0, avg: 0, projects: 0 });
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS c, AVG(score) AS a, COUNT(DISTINCT project_id) AS p FROM ratings WHERE project_id IN (${ph})`
  ).bind(...ids).first();
  return json({ count: r.c || 0, avg: r.c ? Math.round(r.a * 100) / 100 : 0, projects: r.p || 0 });
}

async function userProfile(env, name) {
  await syncStudioRoles(env);
  const lower = name.toLowerCase();
  const tags = (await tagsFor(env, [lower]))[lower] || [];
  const posts = await env.DB.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE lower(username) = ? AND deleted = 0 AND hidden = 0').bind(lower).first();
  const given = await env.DB.prepare('SELECT COUNT(*) AS c FROM ratings WHERE lower(username) = ?').bind(lower).first();
  return json({ username: name, tags, chat_posts: posts ? posts.c : 0, ratings_given: given ? given.c : 0 });
}

// ---------- チャットの未読 ----------
//   GET /api/chat/latest -> { rooms: { "3d": 最新ID, ... }, unread? }   （部屋ごとの最新のメッセージID。公開。ログイン中は通知の未読数 unread も返す）
async function chatLatest(request, env) {
  const rooms = {};
  for (const r of CHAT_ROOMS) {
    const row = await env.DB.prepare(
      'SELECT MAX(id) AS m FROM chat_messages WHERE room = ? AND deleted = 0 AND hidden = 0'
    ).bind(r).first();
    rooms[r] = row && row.m ? row.m : 0;
  }
  // ログインしていれば、通知の未読数も一緒に返す（通知の確認を別に行わなくて済む）
  const out = { rooms };
  const user = await getUser(request, env);
  if (user) out.unread = await unreadCount(env, user, undefined, new URL(request.url).searchParams.get('room'));
  return json(out);
}

// ---------- 管理者用の一覧 ----------
//   GET /api/admin/chat/reports -> { items: [{ id, room, username, content, hidden, reports, created_at, attachment }] }
//   GET /api/admin/chat/bans    -> { items: [{ user_id, username, created_at }] }
async function adminReports(request, env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT m.id, m.room, m.username, m.content, m.hidden, m.created_at, COUNT(r.reporter_id) AS c,
            v.content_type AS vtype
       FROM chat_reports r
       JOIN chat_messages m ON m.id = r.message_id AND m.deleted = 0
       LEFT JOIN chat_videos v ON v.message_id = m.id AND v.state = 'ready'
      GROUP BY m.id ORDER BY c DESC, m.id DESC LIMIT 100`
  ).all();
  return json({ items: rows.results.map(r => ({
    id: r.id, room: r.room, username: r.username, content: r.content, hidden: !!r.hidden,
    reports: r.c, created_at: r.created_at,
    attachment: r.vtype ? (isImageType(r.vtype) ? 'image' : isFileType(r.vtype) ? 'file' : 'video') : null,
  })) });
}

async function adminBans(request, env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare('SELECT user_id, username, created_at FROM chat_bans ORDER BY created_at DESC LIMIT 200').all();
  return json({ items: rows.results });
}


// ---------- 端末への通知（Web Push） ----------
//   GET  /api/push/key                      -> { enabled, key }   （公開。ブラウザが購読するときの公開鍵）
//   POST /api/push/subscribe   { endpoint, keys:{p256dh,auth} } -> { ok }   (要ログイン)
//   POST /api/push/unsubscribe { endpoint }                      -> { ok }   (要ログイン)
// 設定: シークレット VAPID_PRIVATE_JWK（worker/gen_vapid.mjs で作る）。未設定なら通知は無効。
const MAX_PUSH_SUBS = 5;       // 1人が登録できる端末の数
const MAX_PUSH_SEND = 40;      // 1回の投稿で送る最大件数（無料枠の通信回数の範囲に収める）

async function pushKey(env) {
  const key = await vapidPublicKey(env);
  return json(key ? { enabled: true, key } : { enabled: false });
}

async function pushSubscribe(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const ep = body && body.endpoint, k = body && body.keys;
  if (typeof ep !== 'string' || ep.length > 700 || !isAllowedEndpoint(ep) ||
      !k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 60) {
    throw new HttpError(400, 'bad_subscription');
  }
  const me = user.u.toLowerCase();
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, username, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`
  ).bind(ep, me, k.p256dh, k.auth, Date.now()).run();
  await env.DB.prepare(
    'DELETE FROM push_subs WHERE username = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE username = ? ORDER BY created_at DESC LIMIT ?)'
  ).bind(me, me, MAX_PUSH_SUBS).run();
  return json({ ok: true });
}

async function pushUnsubscribe(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (!body || typeof body.endpoint !== 'string') throw new HttpError(400, 'bad_request');
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND username = ?').bind(body.endpoint, user.u.toLowerCase()).run();
  return json({ ok: true });
}

const ROOM_LABELS = { general: '一般', '3d': '3D', math: '数学', physics: '物理', triangle: '三角形', feedback: '意見・要望' };

// targets: Map(小文字のユーザー名 -> 'reply' | 'mention')（自分宛ては除いてある）
// 送り先は、(1) 返信・メンションされた人（設定に関係なく届く）、(2) 通知の範囲が「すべてのメッセージ」の人（設定がない人も含む）。
// 1回の投稿で送る数は MAX_PUSH_SEND まで。(1) を先に入れ、残りの枠を (2) にあてる。
async function notifyPush(env, targets, from, snippet, room) {
  if (!env.VAPID_PRIVATE_JWK) return;
  const me = String(from).toLowerCase();
  const names = targets ? [...targets.keys()] : [];
  const jobs = [];   // { sub, kind: 'reply' | 'mention' | 'message' }

  if (names.length) {
    const rows = await env.DB.prepare(
      `SELECT endpoint, username, p256dh, auth FROM push_subs WHERE username IN (${names.map(() => '?').join(',')}) LIMIT ${MAX_PUSH_SEND}`
    ).bind(...names).all();
    for (const s of rows.results) jobs.push({ sub: s, kind: targets.get(s.username) });
  }

  const left = MAX_PUSH_SEND - jobs.length;
  if (left > 0) {
    const skip = [me, ...names];
    // RANDOM(): 登録が多くて上限を超えるときに、いつも同じ人が外れないようにする
    const rows = await env.DB.prepare(
      `SELECT s.endpoint, s.username, s.p256dh, s.auth FROM push_subs s
         LEFT JOIN notif_prefs p ON p.username = s.username
        WHERE s.username NOT IN (${skip.map(() => '?').join(',')}) AND COALESCE(p.mode, 'all') = 'all'
        ORDER BY RANDOM() LIMIT ${left}`
    ).bind(...skip).all();
    for (const s of rows.results) jobs.push({ sub: s, kind: 'message' });
  }
  if (!jobs.length) return;

  const results = await Promise.allSettled(jobs.map(async ({ sub, kind }) => {
    const label = kind === 'reply' ? ' さんが返信しました'
      : kind === 'mention' ? ' さんがあなたをメンションしました'
      : ' さんが発言しました（' + (ROOM_LABELS[room] || room) + '）';
    const status = await sendPush(env, sub, {
      title: 'scratch-TWC',
      body: from + label + '\n' + snippet,
      url: '/?m=c&room=' + encodeURIComponent(room),
      // 通常の発言は別のタグにして、あとから来た発言が、返信・メンションの通知を置き換えないようにする
      tag: (kind === 'message' ? 'chat-all-' : 'chat-') + room,
    });
    if (status === 404 || status === 410) {   // その端末の登録が無効になった
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
    } else if (status >= 300) {
      console.error('push rejected', status, new URL(sub.endpoint).hostname);   // 401/403: 鍵の不一致など
    }
  }));
  for (const r of results) if (r.status === 'rejected') console.error('push error', r.reason);
}

// 自分の端末に、テストの通知を送る。届かないときの原因（鍵・登録・配信サービスの応答）を調べるためのもの
//   POST /api/push/test -> { enabled, devices, results: [{ host, status }] }   (要ログイン)
async function pushTest(request, env) {
  const user = await requireUser(request, env);
  if (!env.VAPID_PRIVATE_JWK) return json({ enabled: false, devices: 0, results: [] });
  const rows = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE username = ? LIMIT ?').bind(user.u.toLowerCase(), MAX_PUSH_SUBS).all();
  const results = await Promise.all(rows.results.map(async sub => {
    const host = new URL(sub.endpoint).hostname;
    try {
      const status = await sendPush(env, sub, { title: 'scratch-TWC', body: 'テスト通知です。これが見えれば、通知は届いています', url: '/', tag: 'push-test' });
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
      return { host, status };
    } catch (e) { console.error('push test', e); return { host, status: 0 }; }
  }));
  return json({ enabled: true, devices: rows.results.length, results });
}
