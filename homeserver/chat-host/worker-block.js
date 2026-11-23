// ---------- Scratchの通知・クラウド変数の保存（家のサーバーと連携） ----------
// 家のサーバーが、外向きの通信だけでこのAPIと話す（ポート開放は要らない）。
//   GET  /api/scratchlink/mine                 -> { notify, projects:[{ id, last_sync, vars:[{name,value,updated_at}] }] }  (要ログイン)
//   PUT  /api/scratchlink/notify { enabled }   -> { ok }                          (要ログイン。Scratchの通知を知らせる/やめる)
//   POST /api/cloudsave/register { id }        -> { ok }                          (要ログイン。自分の作品だけ登録できる)
//   POST /api/cloudsave/remove   { id }        -> { ok }                          (要ログイン)
//   GET  /api/home/jobs                        -> { watchers:[{u,last}], projects:[{id,owner}] }   (家のサーバー用。HOME_SECRET)
//   POST /api/home/report { counts, vars }     -> { ok, notified }                (家のサーバー用)
// 設定: シークレット HOME_SECRET（長いランダムな文字列）。未設定なら家のサーバー用APIは使えない。
const MAX_CV_PER_USER = 10;     // 1人が登録できる作品の数
const MAX_CV_TOTAL = 300;       // 全体の上限
const MAX_CV_VARS = 40;         // 1作品あたり保存する変数の数
const MAX_HOME_WATCH = 300;

// ---------- サブアカウント連携 ----------
// 1つの本垢に、Scratchのサブ垢をひも付ける。サブ垢が自分のものであることは、ログインと同じ「コードをコメントする」方法で確かめる。
//   GET  /api/scratchlink/subs          -> { me, is_sub, owner, subs:[{name}] }
//   POST /api/scratchlink/subs/start    { username, verifier } -> { code }        （本垢でログイン中）
//   POST /api/scratchlink/subs/verify   { code, secret }       -> { ok, name }
//   POST /api/scratchlink/subs/remove   { name }               -> { ok }          （本垢、または、そのサブ垢本人）
//   POST /api/scratchlink/subs/switch   { name }               -> { token, username, id, expires_at }   （同じグループの垢へ切り替える）
// グループ（本垢+サブ垢）は、Scratch連携の作品の登録・履歴・書き込みルール・通知で、まとめて「自分」として扱われる。
const MAX_SUBS = 5;
async function scGroup(env, uLower) {
  let owner = uLower;
  try {
    const row = await env.DB.prepare('SELECT owner FROM sub_accounts WHERE sub = ?').bind(uLower).first();
    if (row) owner = row.owner;
    const subs = await env.DB.prepare('SELECT sub FROM sub_accounts WHERE owner = ?').bind(owner).all();
    return { owner, names: [owner, ...subs.results.map(r => r.sub)] };
  } catch (e) { return { owner, names: [uLower] }; }
}
const scIn = names => names.map(() => '?').join(',');

async function scSubs(request, env) {
  const user = await requireUser(request, env);
  const me = user.u.toLowerCase();
  const g = await scGroup(env, me);
  const rows = await env.DB.prepare('SELECT sub_name, owner_name, created_at FROM sub_accounts WHERE owner = ? ORDER BY created_at').bind(g.owner).all();
  return json({
    me: user.u, is_sub: g.owner !== me,
    owner: rows.results[0] ? rows.results[0].owner_name : user.u,
    subs: rows.results.map(r => ({ name: r.sub_name, created_at: r.created_at })),
  });
}

async function scSubStart(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request) || {};
  const username = String(body.username || '');
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) throw new HttpError(400, 'bad_username');
  const lower = username.toLowerCase();
  const verifier = String(body.verifier || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new HttpError(400, 'bad_verifier');
  const me = user.u.toLowerCase();
  if (lower === me) throw new HttpError(400, 'same_account');
  const g = await scGroup(env, me);
  if (g.owner !== me) throw new HttpError(403, 'sub_cannot_link');            // サブ垢からは足せない（本垢でログインして足す）
  if (g.names.length - 1 >= MAX_SUBS) throw new HttpError(409, 'too_many_subs');
  const taken = await env.DB.prepare('SELECT 1 AS x FROM sub_accounts WHERE sub = ? OR owner = ?').bind(lower, lower).first();
  if (taken) throw new HttpError(409, 'already_linked');
  const now = Date.now();
  await env.DB.prepare('DELETE FROM auth_challenges WHERE created_at < ?').bind(now - CODE_TTL).run();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS c FROM auth_challenges WHERE username = ?').bind(lower).first();
  if (pending && pending.c >= MAX_PENDING_PER_USER) throw new HttpError(429, 'too_many_requests');
  const code = genCode();
  await env.DB.prepare('INSERT INTO auth_challenges (code, username, created_at, verifier) VALUES (?, ?, ?, ?)').bind(code, lower, now, verifier).run();
  return json({ code, expires_in: CODE_TTL / 1000 });
}

async function scSubVerify(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request) || {};
  const code = String(body.code || '').toUpperCase();
  if (!/^TWC-[A-Z2-9]{8}$/.test(code)) throw new HttpError(400, 'bad_code');
  const ch = await env.DB.prepare('SELECT username, created_at, verifier FROM auth_challenges WHERE code = ?').bind(code).first();
  if (!ch) throw new HttpError(404, 'no_challenge');
  if (Date.now() - ch.created_at > CODE_TTL) { await env.DB.prepare('DELETE FROM auth_challenges WHERE code = ?').bind(code).run(); throw new HttpError(410, 'expired'); }
  const secret = String(body.secret || '');
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(secret)) throw new HttpError(403, 'bad_secret');
  if (!ch.verifier || !timingSafeEqualStr(await sha256B64u(secret), ch.verifier)) throw new HttpError(403, 'bad_secret');
  const me = user.u.toLowerCase();
  const g = await scGroup(env, me);
  if (g.owner !== me) throw new HttpError(403, 'sub_cannot_link');
  if (g.names.length - 1 >= MAX_SUBS) throw new HttpError(409, 'too_many_subs');
  const e2 = env.AUTH_PROJECT_ID ? env : { ...env, AUTH_PROJECT_ID: '1410118669' };   // 家のサーバーには、認証用の作品IDの設定が無いので、既定の値を使う
  const owner = await getAuthOwner(e2);
  const found = await findComment(e2, owner, ch.username, code, ch.created_at - CLOCK_SKEW);
  if (!found) throw new HttpError(404, 'comment_not_found');
  await env.DB.prepare('DELETE FROM auth_challenges WHERE code = ?').bind(code).run();
  const sub = found.author.username.toLowerCase();
  if (sub === me) throw new HttpError(400, 'same_account');
  const taken = await env.DB.prepare('SELECT 1 AS x FROM sub_accounts WHERE sub = ? OR owner = ?').bind(sub, sub).first();
  if (taken) throw new HttpError(409, 'already_linked');
  await env.DB.prepare('INSERT INTO sub_accounts (sub, sub_uid, sub_name, owner, owner_uid, owner_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(sub, found.author.id, found.author.username, me, user.uid, user.u, Date.now()).run();
  const w = await env.DB.prepare('SELECT enabled FROM sl_watch WHERE username = ?').bind(me).first();   // 本垢が通知をオンにしていたら、サブ垢の通知も見る
  if (w && w.enabled) await env.DB.prepare('INSERT INTO sl_watch (username, last_count, enabled, updated_at) VALUES (?, NULL, 1, ?) ON CONFLICT(username) DO UPDATE SET enabled = 1').bind(sub, Date.now()).run();
  return json({ ok: true, name: found.author.username });
}

async function scSubRemove(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request) || {};
  const sub = String(body.name || '').toLowerCase();
  const row = await env.DB.prepare('SELECT owner FROM sub_accounts WHERE sub = ?').bind(sub).first();
  if (!row) throw new HttpError(404, 'not_found');
  const me = user.u.toLowerCase();
  if (me !== row.owner && me !== sub) throw new HttpError(403, 'forbidden');
  await env.DB.prepare('DELETE FROM sub_accounts WHERE sub = ?').bind(sub).run();
  return json({ ok: true });
}

async function scSwitch(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request) || {};
  const target = String(body.name || '').toLowerCase();
  const me = user.u.toLowerCase();
  if (!target || target === me) throw new HttpError(400, 'same_account');
  const g = await scGroup(env, me);
  let t = null;
  const s = await env.DB.prepare('SELECT sub_uid, sub_name FROM sub_accounts WHERE sub = ? AND owner = ?').bind(target, g.owner).first();
  if (s) t = { uid: s.sub_uid, u: s.sub_name };
  else {
    const o = await env.DB.prepare('SELECT owner, owner_uid, owner_name FROM sub_accounts WHERE owner = ? LIMIT 1').bind(g.owner).first();
    if (o && target === o.owner) t = { uid: o.owner_uid, u: o.owner_name };
  }
  if (!t) throw new HttpError(404, 'not_found');
  const expiresAt = Date.now() + SESSION_TTL;
  const token = await signToken({ uid: t.uid, u: t.u, exp: expiresAt }, env.SESSION_SECRET);
  return json({ token, username: t.u, id: t.uid, expires_at: expiresAt });
}


async function slMine(request, env) {
  const user = await requireUser(request, env);
  const me = user.u.toLowerCase();
  const w = await env.DB.prepare('SELECT enabled, last_count, updated_at FROM sl_watch WHERE username = ?').bind(me).first();
  const g = await scGroup(env, me);
  const ps = await env.DB.prepare('SELECT project_id, last_sync, owner FROM cv_projects WHERE owner IN (' + scIn(g.names) + ') ORDER BY created_at').bind(...g.names).all();
  const projects = [];
  for (const p of ps.results) {
    const vs = await env.DB.prepare('SELECT name, value, updated_at FROM cv_vars WHERE project_id = ? ORDER BY name LIMIT ?').bind(p.project_id, MAX_CV_VARS).all();
    projects.push({ id: p.project_id, last_sync: p.last_sync, owner: p.owner, vars: vs.results });
  }
  return json({ notify: !!(w && w.enabled), last_count: w ? w.last_count : null, checked_at: w ? w.updated_at : null, projects });
}

async function slNotify(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const me = user.u.toLowerCase();
  const g = await scGroup(env, me);   // 本垢とサブ垢の通知を、まとめてオン・オフする
  if (body && body.enabled) {
    for (const nm of g.names) await env.DB.prepare(
      `INSERT INTO sl_watch (username, last_count, enabled, updated_at) VALUES (?, NULL, 1, ?)
       ON CONFLICT(username) DO UPDATE SET enabled = 1, last_count = NULL, updated_at = excluded.updated_at`
    ).bind(nm, Date.now()).run();
  } else {
    for (const nm of g.names) await env.DB.prepare('DELETE FROM sl_watch WHERE username = ?').bind(nm).run();
  }
  return json({ ok: true });
}

async function cvRegister(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const id = String(body && body.id || '').trim();
  if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'bad_id');
  const me = user.u.toLowerCase();
  const g = await scGroup(env, me);
  const mine = await env.DB.prepare('SELECT COUNT(*) AS c FROM cv_projects WHERE owner IN (' + scIn(g.names) + ')').bind(...g.names).first();
  if (mine && mine.c >= MAX_CV_PER_USER) throw new HttpError(409, 'too_many_projects');
  const all = await env.DB.prepare('SELECT COUNT(*) AS c FROM cv_projects').first();
  if (all && all.c >= MAX_CV_TOTAL) throw new HttpError(409, 'full');
  const exists = await env.DB.prepare('SELECT owner FROM cv_projects WHERE project_id = ?').bind(Number(id)).first();
  if (exists) { if (g.names.includes(exists.owner)) return json({ ok: true }); throw new HttpError(409, 'already_registered'); }
  // 自分の作品だけ登録できる（作者をScratchに問い合わせる）
  let r;
  try { r = await fetch(`${env.SCRATCH_API || SCRATCH_API}/projects/${id}`, { headers: { 'User-Agent': 'scratch-TWC' } }); }
  catch (e) { throw new HttpError(502, 'scratch_unreachable'); }
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, 'scratch_error');
  const j = await r.json();
  const author = String(j && j.author && j.author.username || '').toLowerCase();
  if (!g.names.includes(author)) throw new HttpError(403, 'not_your_project');   // 本垢か、ひも付けたサブ垢の作品なら登録できる
  await env.DB.prepare('INSERT INTO cv_projects (project_id, owner, created_at) VALUES (?, ?, ?)').bind(Number(id), author, Date.now()).run();
  return json({ ok: true });
}

// 1つの変数の変更履歴（新しい順）。自分の作品だけ。history は、家のサーバーの cv_log テーブルにある
async function cvHistory(request, env, url) {
  const user = await requireUser(request, env);
  const id = Number(url.searchParams.get('id')), name = String(url.searchParams.get('name') || '');
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 200));
  if (!Number.isInteger(id) || !name || name.length > 100) throw new HttpError(400, 'bad_request');
  await cvOwned(env, user, id);
  let rows;
  try { rows = await env.DB.prepare('SELECT ts, value, user FROM cv_log WHERE project_id = ? AND name = ? ORDER BY ts DESC LIMIT ?').bind(id, name, limit).all(); }
  catch (e) { return json({ rows: [] }); }
  return json({ rows: rows.results.map(r => ({ ts: r.ts, value: r.value, user: r.user })) });
}


// 安全な計算（eval は使わない）。v = 受け取った値。+ - * / % ^ と ( )、floor ceil round abs sqrt min max mod が使える
function cvCalc(src, v) {
  const s = String(src || '');
  if (!s || s.length > 120) throw new Error('bad_formula');
  const tk = []; const re = /\s*(\d+\.?\d*|[A-Za-z_]\w*|[-+*\/%^(),])/y; let pos = 0, m;
  while (pos < s.length && /\S/.test(s.slice(pos))) { re.lastIndex = pos; m = re.exec(s); if (!m) throw new Error('bad_formula'); tk.push(m[1]); pos = re.lastIndex; }
  let i = 0;
  const F = { floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs, sqrt: Math.sqrt, min: Math.min, max: Math.max, mod: (a, b) => ((a % b) + b) % b };
  const peek = () => tk[i], eat = t => { if (tk[i] !== t) throw new Error('bad_formula'); i++; };
  function expr() { let a = term(); while (peek() === '+' || peek() === '-') { const o = tk[i++], b = term(); a = o === '+' ? a + b : a - b; } return a; }
  function term() { let a = unary(); while (peek() === '*' || peek() === '/' || peek() === '%') { const o = tk[i++], b = unary(); a = o === '*' ? a * b : o === '/' ? a / b : a % b; } return a; }
  function unary() { if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return pow(); }
  function pow() { const a = atom(); if (peek() === '^') { i++; return Math.pow(a, unary()); } return a; }
  function atom() {
    const t = tk[i++];
    if (t === undefined) throw new Error('bad_formula');
    if (/^\d/.test(t)) return Number(t);
    if (t === '(') { const a = expr(); eat(')'); return a; }
    if (t === 'v') return v;
    if (F[t] && peek() === '(') { i++; const args = []; if (peek() !== ')') { args.push(expr()); while (peek() === ',') { i++; args.push(expr()); } } eat(')'); return F[t](...args); }
    throw new Error('bad_formula');
  }
  const r = expr(); if (i !== tk.length) throw new Error('bad_formula');
  return r;
}

const MAX_CV_RULES = 20;      // 1作品あたりのルールの数
const CV_KINDS = ['load', 'save', 'calc', 'usave', 'uload', 'user'];
function cvVarName(s) {
  s = String(s || '').replace(/^☁\s*/, '').trim();
  if (!s || s.length > 100 || /[\u0000-\u001f]/.test(s)) throw new HttpError(400, 'bad_var');
  return s;
}
async function cvOwned(env, user, id) {
  if (!Number.isInteger(id)) throw new HttpError(400, 'bad_id');
  const row = await env.DB.prepare('SELECT owner FROM cv_projects WHERE project_id = ?').bind(id).first();
  const g = await scGroup(env, user.u.toLowerCase());
  if (!row || !g.names.includes(row.owner)) throw new HttpError(404, 'not_found');
}

// 書き込みルール。「変数Aが変わったら、変数Bに○○を書く」
//   load: A=ID → B=「IDの桁数(1桁)+ID+保存してあるデータ」   save: A=「IDの桁数+ID+データ」→ データだけをIDごとに保存（Bがあれば同じ値を返事に書く）
//   calc: A=値 → B=式（vは受け取った値）の結果。echo をオンにすると、先頭に「桁数+受け取った値」を付ける
async function cvRules(request, env, url) {
  const user = await requireUser(request, env);
  const id = Number(url.searchParams.get('id'));
  await cvOwned(env, user, id);
  const rs = await env.DB.prepare('SELECT id, kind, trigger_var, target_var, formula, echo, hits, last_at FROM cv_rules WHERE project_id = ? ORDER BY id').bind(id).all();
  const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM cv_store WHERE project_id = ?').bind(id).first();
  return json({ rules: rs.results, store_count: n ? n.c : 0, writer: !!(env.SCRATCH_SESSION || (env.SCRATCH_USER && env.SCRATCH_PASS)) });
}

async function cvRuleAdd(request, env) {
  const user = await requireUser(request, env);
  const b = await readJson(request) || {};
  const id = Number(b.id);
  await cvOwned(env, user, id);
  const kind = String(b.kind || '');
  if (!CV_KINDS.includes(kind)) throw new HttpError(400, 'bad_kind');
  const trig = cvVarName(b.trigger);
  const optTarget = kind === 'save' || kind === 'usave' || kind === 'uload';   // 返事の変数は、空でもよい
  const target = (optTarget && !String(b.target || '').trim()) ? null : cvVarName(b.target);
  if (target === trig && kind !== 'uload') throw new HttpError(400, 'same_var');
  let formula = null;
  if (kind === 'uload') formula = cvVarName(b.formula);   // 取り出す元の変数（変数A）の名前
  if (kind === 'calc') {
    formula = String(b.formula || '').trim();
    try { const r = cvCalc(formula, 7); if (!Number.isFinite(r)) { /* 0で割るなど。式の形は正しい */ } } catch (e) { throw new HttpError(400, 'bad_formula'); }
  }
  const all = await env.DB.prepare('SELECT kind, trigger_var, target_var FROM cv_rules WHERE project_id = ?').bind(id).all();
  if (all.results.length >= MAX_CV_RULES) throw new HttpError(409, 'too_many_rules');
  // 返事の変数を、別のルールの受付にしてもよい（変数2つで、セーブもロードもできる）。ぐるぐる回らないよう、家のサーバー側で守っている
  const names = kind === 'user' ? [trig, target] : [trig];   // ユーザー別セーブは、変数AもBも受付になる
  if (all.results.some(r => names.includes(r.trigger_var) || (r.kind === 'user' && names.includes(r.target_var)))) throw new HttpError(409, 'dup_trigger');
  await env.DB.prepare('INSERT INTO cv_rules (project_id, kind, trigger_var, target_var, formula, echo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, kind, trig, target, formula, b.echo ? 1 : 0, Date.now()).run();
  return json({ ok: true });
}

async function cvRuleRemove(request, env) {
  const user = await requireUser(request, env);
  const b = await readJson(request) || {};
  const r = await env.DB.prepare('SELECT project_id FROM cv_rules WHERE id = ?').bind(Number(b.rid)).first();
  if (!r) throw new HttpError(404, 'not_found');
  await cvOwned(env, user, r.project_id);
  await env.DB.prepare('DELETE FROM cv_rules WHERE id = ?').bind(Number(b.rid)).run();
  return json({ ok: true });
}

async function cvStore(request, env, url) {
  const user = await requireUser(request, env);
  const id = Number(url.searchParams.get('id'));
  await cvOwned(env, user, id);
  const rows = await env.DB.prepare('SELECT store_key, data, updated_at FROM cv_store WHERE project_id = ? ORDER BY updated_at DESC LIMIT 200').bind(id).all();
  return json({ items: rows.results.map(r => ({ key: r.store_key, data: r.data, updated_at: r.updated_at })) });
}

async function cvUStore(request, env, url) {
  const user = await requireUser(request, env);
  const id = Number(url.searchParams.get('id'));
  await cvOwned(env, user, id);
  const rows = await env.DB.prepare('SELECT var_name, username, data, updated_at FROM cv_ustore WHERE project_id = ? ORDER BY updated_at DESC LIMIT 200').bind(id).all();
  const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM cv_ustore WHERE project_id = ?').bind(id).first();
  return json({ items: rows.results.map(r => ({ name: r.var_name, user: r.username, data: r.data, updated_at: r.updated_at })), count: n ? n.c : 0 });
}

async function cvStoreRemove(request, env) {
  const user = await requireUser(request, env);
  const b = await readJson(request) || {};
  const id = Number(b.id);
  await cvOwned(env, user, id);
  await env.DB.prepare('DELETE FROM cv_store WHERE project_id = ? AND store_key = ?').bind(id, String(b.key || '')).run();
  return json({ ok: true });
}

async function cvRemove(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const id = Number(body && body.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'bad_id');
  await cvOwned(env, user, id);
  await env.DB.prepare('DELETE FROM cv_projects WHERE project_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM cv_vars WHERE project_id = ?').bind(id).run();
  try { await env.DB.prepare('DELETE FROM cv_rules WHERE project_id = ?').bind(id).run(); await env.DB.prepare('DELETE FROM cv_store WHERE project_id = ?').bind(id).run(); } catch (e) { /* 表がまだ無いとき */ }
  return json({ ok: true });
}

// 家のサーバーだけが呼べる。シークレットが合わなければ、存在も教えない
function homeAuth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer (.+)$/);
  const secret = env.HOME_SECRET;
  if (!secret || secret.length < 24 || !m || m[1].length !== secret.length) throw new HttpError(404, 'not_found');
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ m[1].charCodeAt(i);
  if (diff) throw new HttpError(404, 'not_found');
}

async function homeJobs(request, env) {
  homeAuth(request, env);
  const w = await env.DB.prepare('SELECT username, last_count FROM sl_watch WHERE enabled = 1 LIMIT ?').bind(MAX_HOME_WATCH).all();
  const p = await env.DB.prepare('SELECT project_id, owner FROM cv_projects LIMIT ?').bind(MAX_CV_TOTAL).all();
  return json({
    watchers: w.results.map(r => ({ u: r.username, last: r.last_count })),
    projects: p.results.map(r => ({ id: r.project_id, owner: r.owner })),
  });
}

async function homeReport(request, env) {
  homeAuth(request, env);
  const body = await readJson(request);
  const now = Date.now();
  let notified = 0;
  const counts = body && typeof body.counts === 'object' && body.counts ? body.counts : {};
  for (const [u, nRaw] of Object.entries(counts).slice(0, MAX_HOME_WATCH)) {
    const n = Number(nRaw);
    if (!Number.isInteger(n) || n < 0 || n > 1e6) continue;
    const row = await env.DB.prepare('SELECT last_count FROM sl_watch WHERE username = ? AND enabled = 1').bind(String(u).toLowerCase()).first();
    if (!row) continue;
    await env.DB.prepare('UPDATE sl_watch SET last_count = ?, updated_at = ? WHERE username = ?').bind(n, now, String(u).toLowerCase()).run();
    if (row.last_count != null && n > row.last_count) {
      const who = String(u).toLowerCase(), grp = await scGroup(env, who);   // 本垢・サブ垢のどの端末にも届ける
      const payload = {
        title: 'Scratch', body: (grp.names.length > 1 ? who + ': ' : '') + 'Scratchに新しい通知が ' + (n - row.last_count) + ' 件あります（合計 ' + n + ' 件）',
        url: 'https://scratch.mit.edu/messages/', tag: 'scratch-messages-' + who,
      };
      for (const nm of grp.names) notified += await pushToUser(env, nm, payload);
    }
  }
  const vars = body && typeof body.vars === 'object' && body.vars ? body.vars : {};
  for (const [pidRaw, kv] of Object.entries(vars).slice(0, MAX_CV_TOTAL)) {
    const pid = Number(pidRaw);
    if (!Number.isInteger(pid) || !kv || typeof kv !== 'object') continue;
    const reg = await env.DB.prepare('SELECT 1 AS x FROM cv_projects WHERE project_id = ?').bind(pid).first();
    if (!reg) continue;
    const stmts = Object.entries(kv).slice(0, MAX_CV_VARS).filter(([k, v]) => k.length <= 100 && /^-?\d{1,256}$/.test(String(v))).map(([k, v]) =>
      env.DB.prepare('INSERT INTO cv_vars (project_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(pid, k, String(v), now));
    stmts.push(env.DB.prepare('UPDATE cv_projects SET last_sync = ? WHERE project_id = ?').bind(now, pid));
    await env.DB.batch(stmts);
  }
  return json({ ok: true, notified });
}

async function pushToUser(env, username, payload) {
  if (!env.VAPID_PRIVATE_JWK) return 0;
  const rows = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE username = ? LIMIT ?').bind(username, MAX_PUSH_SUBS).all();
  let ok = 0;
  await Promise.all(rows.results.map(async sub => {
    try {
      const status = await sendPush(env, sub, payload);
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
      else if (status < 300) ok++;
    } catch (e) { console.error('push user', e); }
  }));
  return ok;
}
