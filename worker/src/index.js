// scratch-TWC API (Cloudflare Workers + D1)
//   POST   /api/auth/start      { username }   -> { code }
//   POST   /api/auth/verify     { code }       -> { token, username, id, expires_at }
//   GET    /api/ratings?ids=1,2,3              -> { ratings: { "1": { avg, count, mine } } }
//   GET    /api/ratings/ranking                -> { items: [{ id, avg, count }] }  技術力の高い順
//   PUT    /api/ratings/:projectId { score }   -> { avg, count, mine }   (要ログイン。自分の作品・存在しない作品は不可)
//   DELETE /api/ratings/:projectId             -> { avg, count, mine }   (要ログイン)
//   GET    /api/saves                          -> { ids: [新しい順の作品ID] }   (要ログイン)
//   PUT    /api/saves/:projectId               -> { saved: true }              (要ログイン)
//   DELETE /api/saves/:projectId               -> { saved: false }             (要ログイン)
//   POST   /api/applications { kind, target, message } -> { application }      (要ログイン。参加申請)
//   GET    /api/applications/mine              -> { items, is_admin }          (要ログイン)
//   GET    /api/applications/approved-users    -> { users: [{ id, username }] } (公開。収集ツール用)
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
// 順位は、評価が少ない作品に偏らないよう「平均3点の評価が2件ある」ものとして計算する
const PRIOR_MEAN = 3;
const PRIOR_WEIGHT = 2;
const MAX_PENDING_APPLICATIONS = 10;        // 1ユーザーが同時に出せる未審査の申請数
const MAX_APP_MESSAGE = 300;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

let cachedOwner = null; // 認証用プロジェクトの作者名（Worker内でキャッシュ）

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
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
  const cm = path.match(/^\/api\/chat\/messages\/(\d{1,12})(\/report)?$/);
  if (cm) {
    const id = Number(cm[1]);
    if (cm[2] && method === 'POST') return chatReport(request, env, id);
    if (!cm[2] && method === 'DELETE') return chatDelete(request, env, id);
  }
  const cam = path.match(/^\/api\/admin\/chat\/messages\/(\d{1,12})$/);
  if (cam && method === 'POST') return chatAdminAction(request, env, Number(cam[1]));
  if (path === '/api/admin/chat/bans' && method === 'POST') return chatAdminBan(request, env);
  if (path === '/api/chat/videos/start' && method === 'POST') return videoStart(request, env);
  const vm = path.match(/^\/api\/chat\/videos\/([a-f0-9]{32})(\/complete)?$/);
  if (vm && vm[2] && method === 'POST') return videoComplete(request, env, vm[1]);
  if (vm && !vm[2] && method === 'DELETE') return videoDiscard(request, env, vm[1]);
  if (path === '/api/admin/chat/reports' && method === 'GET') return adminReports(request, env);
  if (path === '/api/admin/chat/bans' && method === 'GET') return adminBans(request, env);
  if (path === '/api/chat/latest' && method === 'GET') return chatLatest(env);
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

async function authStart(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '');
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) throw new HttpError(400, 'bad_username');
  const lower = username.toLowerCase();
  const now = Date.now();

  await env.DB.prepare('DELETE FROM auth_challenges WHERE created_at < ?').bind(now - CODE_TTL).run();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS c FROM auth_challenges WHERE username = ?').bind(lower).first();
  if (pending && pending.c >= MAX_PENDING_PER_USER) throw new HttpError(429, 'too_many_requests');

  const code = genCode();
  await env.DB.prepare('INSERT INTO auth_challenges (code, username, created_at) VALUES (?, ?, ?)')
    .bind(code, lower, now).run();
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

  const ch = await env.DB.prepare('SELECT username, created_at FROM auth_challenges WHERE code = ?').bind(code).first();
  if (!ch) throw new HttpError(404, 'no_challenge');
  if (Date.now() - ch.created_at > CODE_TTL) {
    await env.DB.prepare('DELETE FROM auth_challenges WHERE code = ?').bind(code).run();
    throw new HttpError(410, 'expired');
  }

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
  return { avg: count ? Math.round(row.a * 100) / 100 : 0, count, mine: mine ?? null };
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

async function getRanking(env) {
  const rows = await env.DB.prepare(
    `SELECT project_id, COUNT(*) AS c, AVG(score) AS a,
            (SUM(score) + ?) * 1.0 / (COUNT(*) + ?) AS w
       FROM ratings GROUP BY project_id
      ORDER BY w DESC, c DESC, project_id DESC
      LIMIT ?`
  ).bind(PRIOR_MEAN * PRIOR_WEIGHT, PRIOR_WEIGHT, MAX_RANKING).all();
  return json({
    items: rows.results.map(r => ({ id: r.project_id, avg: Math.round(r.a * 100) / 100, count: r.c })),
  });
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

// 承認済みのユーザー（収集ツールが、フォロー先と合わせて作品を集める）
async function approvedUsers(env) {
  const rows = await env.DB.prepare(
    "SELECT DISTINCT target_user_id AS id, target_username AS username FROM applications WHERE status = 'approved'"
  ).all();
  return json({ users: rows.results });
}


// ---------- チャット ----------
//   GET    /api/chat/messages?room=3d|math|physics|triangle  -> { messages: [...最新50件、古い順], is_admin }  (公開。管理者は非表示のものも見える)
//   POST   /api/chat/messages { content }        -> { message }       (要ログイン。禁止ユーザー・連投は不可)
//   DELETE /api/chat/messages/:id                -> { deleted }       (本人 or 管理者)
//   POST   /api/chat/messages/:id/report         -> { reported }      (要ログイン。通報が3件で自動的に非表示)
//   POST   /api/admin/chat/messages/:id { action: hide | restore | delete }   (管理者のみ)
//   POST   /api/admin/chat/bans { username, banned }                          (管理者のみ。投稿禁止/解除)
const CHAT_MAX_LEN = 300;
const CHAT_PAGE = 50;
const CHAT_REPORT_HIDE = 3;       // この件数の通報で自動的に非表示にする
const CHAT_MIN_INTERVAL = 2000;   // 連投の最短間隔(ms)
const CHAT_PER_MINUTE = 15;       // 1分あたりの投稿数の上限
const CHAT_ROOMS = ['3d', 'math', 'physics', 'triangle'];  // 部屋（3D / 数学 / 物理 / 三角形）

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
  if (r.video_id) {
    if (isImageType(r.video_type)) o.image = videoInfo(r, env);
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
  if (since === null) await syncStudioRoles(env);
  const rows = await env.DB.prepare(
    `SELECT m.id, m.user_id, m.username, m.content, m.created_at, m.hidden,
            rp.reply_to, p.username AS reply_username, p.content AS reply_content,
            p.deleted AS reply_deleted, p.hidden AS reply_hidden,
            v.id AS video_id, v.object_key AS video_key, v.content_type AS video_type, v.created_at AS video_created
       FROM chat_messages m
       LEFT JOIN chat_replies rp ON rp.message_id = m.id
       LEFT JOIN chat_messages p ON p.id = rp.reply_to
       LEFT JOIN chat_videos v ON v.message_id = m.id AND v.state = 'ready'
      WHERE m.room = ? ${since !== null ? 'AND m.id > ?' : ''} AND m.deleted = 0 ${admin ? '' : 'AND m.hidden = 0'}
      ORDER BY m.id ${since !== null ? 'ASC' : 'DESC'} LIMIT ?`
  ).bind(...(since !== null ? [room, since, CHAT_PAGE] : [room, CHAT_PAGE])).all();
  const list = since !== null ? rows.results : rows.results.reverse();
  const tags = await tagsFor(env, [...new Set(list.map(r => r.username.toLowerCase()))]);
  for (const r of list) { r.tags = tags[r.username.toLowerCase()] || []; }
  return json({ messages: list.map(r => chatRow(r, env)), is_admin: admin, partial: since !== null, video_enabled: videoEnabled(env) });
}

async function chatPost(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const content = String(body.content || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CHAT_MAX_LEN);
  const room = chatRoom(body.room);

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

  const res = await env.DB.prepare(
    'INSERT INTO chat_messages (user_id, username, content, created_at, room) VALUES (?, ?, ?, ?, ?)'
  ).bind(user.uid, user.u, content, now, room).run();
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

  return json({ message: { id, user_id: user.uid, username: user.u, content, created_at: now, hidden: false, tags: [] } }, 201);
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


// ---------- 通知（返信・メンション） ----------
//   GET  /api/notifications         -> { items: [...新しい順50件], unread }  (要ログイン)
//   GET  /api/notifications/count   -> { unread }                            (要ログイン)
//   POST /api/notifications/read { id } か { all: true }  -> { unread }     (要ログイン)
// 削除・非表示になったメッセージの通知は出さない。

const NOTIF_VISIBLE = `FROM chat_notifications n
   JOIN chat_messages m ON m.id = n.message_id AND m.deleted = 0 AND m.hidden = 0
  WHERE n.to_username = ?`;

async function unreadCount(env, user) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c ${NOTIF_VISIBLE} AND n.is_read = 0`)
    .bind(user.u.toLowerCase()).first();
  return r ? r.c : 0;
}

async function notifList(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.DB.prepare(
    `SELECT n.id, n.kind, n.message_id, n.room, n.from_username, n.snippet, n.created_at, n.is_read
       ${NOTIF_VISIBLE} ORDER BY n.id DESC LIMIT ?`
  ).bind(user.u.toLowerCase(), NOTIF_PAGE).all();
  return json({
    items: rows.results.map(r => ({ id: r.id, kind: r.kind, message_id: r.message_id, room: r.room,
      from_username: r.from_username, snippet: r.snippet, created_at: r.created_at, read: !!r.is_read })),
    unread: await unreadCount(env, user),
  });
}

async function notifCount(request, env) {
  const user = await requireUser(request, env);
  return json({ unread: await unreadCount(env, user) });
}

async function notifRead(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const me = user.u.toLowerCase();
  if (body.all === true) {
    await env.DB.prepare('UPDATE chat_notifications SET is_read = 1 WHERE to_username = ? AND is_read = 0').bind(me).run();
  } else if (Number.isInteger(body.id)) {
    await env.DB.prepare('UPDATE chat_notifications SET is_read = 1 WHERE id = ? AND to_username = ?').bind(body.id, me).run();
  } else {
    throw new HttpError(400, 'bad_request');
  }
  return json({ unread: await unreadCount(env, user) });
}


// ---------- 動画（Backblaze B2 / S3互換API） ----------
//   POST   /api/chat/videos/start { size, type }  -> { id, upload_url, headers }   (要ログイン。動画(mp4/webm)・写真(jpeg/png/webp)を、B2へ直接アップロードするための一時URL)
//   POST   /api/chat/videos/:id/complete          -> { id, url, type }             (アップロード後に確認。大きすぎたら消す)
//   DELETE /api/chat/videos/:id                   -> { deleted }                   (投稿前の動画を取り消す)
// 投稿は POST /api/chat/messages に video_id を付ける。メッセージを削除すると、動画も消える。
// 設定（worker/B2_SETUP.md）: 変数 B2_ENDPOINT, B2_BUCKET, VIDEO_BASE_URL, VIDEO_TTL_DAYS、
//   シークレット B2_KEY_ID, B2_APP_KEY。未設定なら動画機能は無効（video_enabled: false）。
const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_PER_DAY = 3;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;     // ブラウザ側で縮小してから送るので、実際は数百KB程度
const IMAGE_PER_DAY = 10;
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const isImageType = (t) => String(t).startsWith('image/');
const VIDEO_PRESIGN_SECONDS = 600;

function videoEnabled(env) {
  return !!(env.B2_ENDPOINT && env.B2_BUCKET && env.VIDEO_BASE_URL && env.B2_KEY_ID && env.B2_APP_KEY);
}
function requireVideo(env) {
  if (!videoEnabled(env)) throw new HttpError(503, 'video_disabled');
}
function videoTtlMs(env) {
  const d = Number(env.VIDEO_TTL_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : 14) * 24 * 3600 * 1000;
}
// B2のライフサイクル設定で消えた後は、再生できないことを知らせる
function videoInfo(r, env) {
  if (Date.now() - r.video_created > videoTtlMs(env)) return { id: r.video_id, type: r.video_type, expired: true };
  return { id: r.video_id, type: r.video_type, url: String(env.VIDEO_BASE_URL).replace(/\/+$/, '') + '/' + r.video_key };
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
async function presignUrl({ method, host, path, region, keyId, secret, now, expires, signHeaders }) {
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
  };
  const canonicalQuery = Object.keys(q).sort().map(k => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const sig = hex(await hmac(await signingKey(secret, date, region), toSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

// ヘッダー方式で署名したリクエストを送る（HEAD / DELETE 用）
async function s3Fetch(env, method, key) {
  const region = regionOf(env.B2_ENDPOINT);
  const host = `${env.B2_BUCKET}.${env.B2_ENDPOINT}`;
  const path = '/' + key;
  const { amzDate, date } = amzDates(Date.now());
  const scope = `${date}/${region}/s3/aws4_request`;
  const payloadHash = await sha256Hex('');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const sig = hex(await hmac(await signingKey(env.B2_APP_KEY, date, region), toSign));
  return fetch(`https://${host}${path}`, {
    method,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
  });
}

async function b2Delete(env, key) {
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
  const image = isImageType(type);
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'bad_video_size');
  if (size > (image ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES)) throw new HttpError(413, image ? 'image_too_big' : 'video_too_big');

  const ban = await env.DB.prepare('SELECT 1 AS x FROM chat_bans WHERE user_id = ?').bind(user.uid).first();
  if (ban) throw new HttpError(403, 'banned');

  const now = Date.now();
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM chat_videos WHERE user_id = ? AND created_at > ? AND state != 'deleted'
       AND content_type ${image ? 'LIKE' : 'NOT LIKE'} 'image/%'`
  ).bind(user.uid, now - 24 * 3600 * 1000).first();
  if (used && used.c >= (image ? IMAGE_PER_DAY : VIDEO_PER_DAY)) throw new HttpError(429, image ? 'image_limit' : 'video_limit');

  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `v/${id}.${VIDEO_TYPES[type]}`;
  await env.DB.prepare(
    'INSERT INTO chat_videos (id, user_id, username, object_key, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, user.uid, user.u, key, type, now).run();

  const uploadUrl = await presignUrl({
    method: 'PUT',
    host: `${env.B2_BUCKET}.${env.B2_ENDPOINT}`,
    path: '/' + key,
    region: regionOf(env.B2_ENDPOINT),
    keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY,
    now, expires: VIDEO_PRESIGN_SECONDS,
    signHeaders: { 'content-type': type },
  });
  return json({ id, upload_url: uploadUrl, headers: { 'Content-Type': type }, max_bytes: image ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES });
}

// アップロードされたものを確認する。署名ではサイズを縛れないので、ここで実サイズを調べる
async function videoComplete(request, env, id) {
  const user = await requireUser(request, env);
  requireVideo(env);
  const v = await env.DB.prepare("SELECT * FROM chat_videos WHERE id = ? AND user_id = ? AND state != 'deleted'").bind(id, user.uid).first();
  if (!v) throw new HttpError(404, 'not_found');
  let r;
  try { r = await s3Fetch(env, 'HEAD', v.object_key); } catch { throw new HttpError(502, 'storage_unreachable'); }
  if (r.status === 404) throw new HttpError(409, 'not_uploaded');
  if (!r.ok) throw new HttpError(502, 'storage_error');
  const size = Number(r.headers.get('content-length') || 0);
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim();
  const image = isImageType(v.content_type);
  const maxBytes = image ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (!size || size > maxBytes || type !== v.content_type) {
    await b2Delete(env, v.object_key);
    await env.DB.prepare("UPDATE chat_videos SET state = 'deleted' WHERE id = ?").bind(id).run();
    throw new HttpError(size > maxBytes ? 413 : 400, size > maxBytes ? (image ? 'image_too_big' : 'video_too_big') : 'bad_video');
  }
  await env.DB.prepare("UPDATE chat_videos SET state = 'ready', size = ? WHERE id = ?").bind(size, id).run();
  return json({ id, type, url: String(env.VIDEO_BASE_URL).replace(/\/+$/, '') + '/' + v.object_key });
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
//   GET /api/chat/latest -> { rooms: { "3d": 最新ID, ... } }   （部屋ごとの最新のメッセージID。公開）
async function chatLatest(env) {
  const rooms = {};
  for (const r of CHAT_ROOMS) {
    const row = await env.DB.prepare(
      'SELECT MAX(id) AS m FROM chat_messages WHERE room = ? AND deleted = 0 AND hidden = 0'
    ).bind(r).first();
    rooms[r] = row && row.m ? row.m : 0;
  }
  return json({ rooms });
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
    attachment: r.vtype ? (isImageType(r.vtype) ? 'image' : 'video') : null,
  })) });
}

async function adminBans(request, env) {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare('SELECT user_id, username, created_at FROM chat_bans ORDER BY created_at DESC LIMIT 200').all();
  return json({ items: rows.results });
}
