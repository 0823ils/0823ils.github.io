// Scratch連携（チャットサーバーの中で動く）
//  1. Scratchの通知の数を見て、増えたらWeb Pushで知らせる   2. 登録された作品のクラウド変数の履歴を、ずっと保存する
// 外向きの通信だけ。保存先は、チャットと同じSQLite（cv_log テーブル）。
const UA = 'scratch-TWC-home/1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = n => { n = String(n); return n.startsWith('☁ ') ? n.slice(2) : n; };

export function startScratchLink(env, db, srv) {
  const API = String(env.SCRATCH_API || 'https://api.scratch.mit.edu').replace(/\/+$/, '');
  const LOGS = env.CLOUD_LOGS || 'https://clouddata.scratch.mit.edu/logs';
  const every = Math.max(20, Number(env.SCRATCH_LINK_INTERVAL || 60)) * 1000;
  if (!env.HOME_SECRET || !srv || !srv.workerFetch) { console.log('scratch-link: 使えません（HOME_SECRET / workerFetch がありません）'); return null; }
  db.exec(`CREATE TABLE IF NOT EXISTS cv_log (
    project_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, user TEXT,
    PRIMARY KEY (project_id, ts, name, value));
    CREATE INDEX IF NOT EXISTS idx_cv_name ON cv_log(project_id, name, ts);`);
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
  const t1 = setTimeout(cycle, 8000), t2 = setInterval(cycle, every);
  console.log(`scratch-link: ${every / 1000}秒ごとに、Scratchの通知とクラウド変数を確認します`);
  return { cycle, stop() { clearTimeout(t1); clearInterval(t2); } };
}
