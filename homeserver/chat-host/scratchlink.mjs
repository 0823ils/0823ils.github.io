// Scratch連携（チャットサーバーの中で動く）
//  1. Scratchの通知の数を見て、増えたらWeb Pushで知らせる   2. 登録された作品のクラウド変数の履歴を、ずっと保存する
// 外向きの通信だけ。保存先は、チャットと同じSQLite（cv_log テーブル）。
const UA = 'scratch-TWC-home/1.0';
const MIGRATE2 = `CREATE TABLE IF NOT EXISTS cv_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, kind TEXT NOT NULL, trigger_var TEXT NOT NULL, target_var TEXT, formula TEXT, echo INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, last_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cv_rules_p ON cv_rules(project_id);
CREATE TABLE IF NOT EXISTS cv_store (project_id INTEGER NOT NULL, store_key TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, store_key));`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = n => { n = String(n); return n.startsWith('☁ ') ? n.slice(2) : n; };

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

// ---- 書き込み（ルール）----
// 変数Aが変わったら変数Bを書く。Scratchのクラウドサーバーに、専用アカウントでつないだまま待つ（外向きの通信だけ）。
// .env に SCRATCH_USER（ユーザー名）と SCRATCH_SESSION（scratchsessionsid の値）が要る。専用アカウントを使うこと
function startLive(env, db) {
  const USER = env.SCRATCH_USER, SESSION = env.SCRATCH_SESSION;
  if (!USER || !SESSION) { console.log('scratch-link: 書き込みルールは動きません（.env に SCRATCH_USER と SCRATCH_SESSION がありません）'); return null; }
  const WS = env.CLOUD_WS || 'wss://clouddata.scratch.mit.edu';
  const rulesOf = db.prepare('SELECT * FROM cv_rules WHERE project_id = ?');
  const projects = db.prepare('SELECT DISTINCT project_id AS p FROM cv_rules');
  const getStore = db.prepare('SELECT data FROM cv_store WHERE project_id = ? AND store_key = ?');
  const putStore = db.prepare('INSERT INTO cv_store (project_id, store_key, data, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id, store_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
  const countStore = db.prepare('SELECT COUNT(*) AS c FROM cv_store WHERE project_id = ?');
  const hit = db.prepare('UPDATE cv_rules SET hits = hits + 1, last_at = ? WHERE id = ?');
  const conns = new Map();

  function connect(pid) {
    const c = { pid, ws: null, queue: [], settleUntil: 0, backoff: 3000, timer: null, closed: false };
    c.open = () => {
      if (c.closed) return;
      let ws;
      try { ws = new WebSocket(WS, { headers: { Cookie: 'scratchsessionsid=' + SESSION + ';', Origin: 'https://scratch.mit.edu', 'User-Agent': UA } }); }
      catch (e) { console.error('scratch-link: 接続できません', e.message); c.timer = setTimeout(c.open, c.backoff); return; }
      c.ws = ws;
      ws.onopen = () => { c.backoff = 3000; c.settleUntil = Date.now() + 2500; ws.send(JSON.stringify({ method: 'handshake', user: USER, project_id: String(pid) }) + '\n'); console.log('scratch-link: 作品', pid, 'につなぎました'); };
      ws.onmessage = ev => {
        for (const line of String(ev.data).split('\n')) {
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.method === 'set' && Date.now() >= c.settleUntil) handle(c, clean(m.name), String(m.value));
        }
      };
      ws.onclose = () => { c.ws = null; if (!c.closed) { c.timer = setTimeout(c.open, c.backoff); c.backoff = Math.min(60000, c.backoff * 2); } };
      ws.onerror = () => {};
    };
    // 1秒に8回まで
    c.pump = setInterval(() => {
      if (!c.ws || c.ws.readyState !== 1 || !c.queue.length) return;
      const [name, value] = c.queue.shift();
      c.ws.send(JSON.stringify({ method: 'set', user: USER, project_id: String(pid), name: '☁ ' + name, value: String(value) }) + '\n');
    }, 125);
    c.close = () => { c.closed = true; clearTimeout(c.timer); clearInterval(c.pump); try { c.ws && c.ws.close(); } catch {} };
    c.open();
    return c;
  }

  function reply(c, name, value) {
    value = String(value);
    if (!/^-?\d{1,256}$/.test(value)) return;
    if (c.queue.length < 200) c.queue.push([name, value]);
  }

  function handle(c, name, v) {
    const rules = rulesOf.all(c.pid).filter(r => r.trigger_var === name);
    if (!rules.length || !/^-?\d{1,256}$/.test(v)) return;
    for (const r of rules) {
      try {
        if (r.kind === 'load') {
          if (!/^\d{1,9}$/.test(v)) continue;
          const row = getStore.get(c.pid, v);
          reply(c, r.target_var, String(v.length) + v + (row ? row.data : ''));
        } else if (r.kind === 'save') {
          const L = Number(v[0]), id = v.slice(1, 1 + L), data = v.slice(1 + L);
          if (!(L >= 1 && L <= 9) || id.length !== L || !data || data.length > 240) continue;
          if (!getStore.get(c.pid, id) && countStore.get(c.pid).c >= 10000) continue;
          putStore.run(c.pid, id, data, Date.now());
          if (r.target_var) reply(c, r.target_var, v);   // 保存できたことを、同じ値で返す
        } else if (r.kind === 'calc') {
          const out = cvCalc(r.formula, Number(v));
          if (!Number.isFinite(out)) continue;
          const res = String(Math.floor(out));
          if (r.echo) { const id = v.replace('-', '').slice(0, 9); reply(c, r.target_var, String(id.length) + id + res); }
          else reply(c, r.target_var, res);
        }
        hit.run(Date.now(), r.id);
      } catch (e) { console.error('scratch-link: ルールの実行に失敗', r.id, e.message); }
    }
  }

  function sync() {
    const want = new Set(projects.all().map(r => r.p));
    for (const p of want) if (!conns.has(p)) conns.set(p, connect(p));
    for (const [p, c] of conns) if (!want.has(p)) { c.close(); conns.delete(p); }
  }
  const t = setInterval(sync, 10000); sync();
  console.log('scratch-link: 書き込みルールを待ち受けます（アカウント: ' + USER + '）');
  return { sync, stop() { clearInterval(t); for (const c of conns.values()) c.close(); conns.clear(); } };
}

export function startScratchLink(env, db, srv) {
  const API = String(env.SCRATCH_API || 'https://api.scratch.mit.edu').replace(/\/+$/, '');
  const LOGS = env.CLOUD_LOGS || 'https://clouddata.scratch.mit.edu/logs';
  const every = Math.max(20, Number(env.SCRATCH_LINK_INTERVAL || 60)) * 1000;
  if (!env.HOME_SECRET || !srv || !srv.workerFetch) { console.log('scratch-link: 使えません（HOME_SECRET / workerFetch がありません）'); return null; }
  db.exec(`CREATE TABLE IF NOT EXISTS cv_log (
    project_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, user TEXT,
    PRIMARY KEY (project_id, ts, name, value));
    CREATE INDEX IF NOT EXISTS idx_cv_name ON cv_log(project_id, name, ts);`);
  db.exec(MIGRATE2);
  const ins = db.prepare('INSERT OR IGNORE INTO cv_log (project_id, ts, name, value, user) VALUES (?,?,?,?,?)');
  const maxTs = db.prepare('SELECT COALESCE(MAX(ts),0) AS m FROM cv_log WHERE project_id = ?');
  const cur = db.prepare(`SELECT name, value FROM cv_log l WHERE project_id = ? AND ts = (
    SELECT MAX(ts) FROM cv_log WHERE project_id = l.project_id AND name = l.name)`);

  async function getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const home = (method, path, body) => srv.workerFetch(new Request('http://local' + path, {
    method, headers: { Authorization: 'Bearer ' + env.HOME_SECRET, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).then(r => r.json());

  // 変更履歴を、新しい順に読み、すでに持っている所まで保存する（最初の1回は古い所まで多めに読む）
  async function syncProject(pid) {
    let added = 0, offset = 0;
    const have = maxTs.get(pid).m;
    for (let page = 0; page < 25; page++) {
      const rows = await getJson(`${LOGS}?projectid=${pid}&limit=40&offset=${offset}`);
      if (!Array.isArray(rows) || !rows.length) break;
      let stop = false;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          if (r.verb !== 'set_var') continue;
          const ts = Number(r.timestamp) || 0;
          added += Number(ins.run(pid, ts, clean(r.name), String(r.value), r.user == null ? null : String(r.user)).changes);
          if (have && ts < have) stop = true;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (stop || rows.length < 40) break;
      offset += 40; await sleep(400);
    }
    return added;
  }

  let running = false;
  async function cycle() {
    if (running) return; running = true;
    try {
      const jobs = await home('GET', '/api/home/jobs');
      const counts = {}, vars = {};
      for (const w of jobs.watchers || []) {
        try { counts[w.u] = Number((await getJson(`${API}/users/${encodeURIComponent(w.u)}/messages/count`)).count); }
        catch (e) { console.error('scratch-link: 通知数の取得に失敗', w.u, e.message); }
        await sleep(400);
      }
      for (const p of jobs.projects || []) {
        try {
          const n = await syncProject(Number(p.id));
          vars[String(p.id)] = Object.fromEntries(cur.all(Number(p.id)).map(r => [r.name, r.value]));
          if (n) console.log('scratch-link: 作品', p.id, 'の履歴を', n, '件保存');
        } catch (e) { console.error('scratch-link: クラウド変数の取得に失敗', p.id, e.message); }
        await sleep(400);
      }
      if (Object.keys(counts).length || Object.keys(vars).length) {
        const res = await home('POST', '/api/home/report', { counts, vars });
        if (res && res.notified) console.log('scratch-link: 通知を', res.notified, '台に送りました');
      }
    } catch (e) { console.error('scratch-link:', e.message); }
    finally { running = false; }
  }
  const live = startLive(env, db);
  const t1 = setTimeout(cycle, 8000), t2 = setInterval(cycle, every);
  console.log(`scratch-link: ${every / 1000}秒ごとに、Scratchの通知とクラウド変数を確認します`);
  return { cycle, stop() { clearTimeout(t1); clearInterval(t2); if (live) live.stop(); } };
}
