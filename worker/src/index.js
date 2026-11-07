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
const PRIOR_WEIGHT = 2;                     // 1ユーザーが保存できる作品数の上限

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
  const sm = path.match(/^\/api\/saves\/(\d{1,12})$/);
  if (sm) {
    const projectId = Number(sm[1]);
    if (method === 'PUT') return putSave(request, env, projectId);
    if (method === 'DELETE') return deleteSave(request, env, projectId);
  }
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
