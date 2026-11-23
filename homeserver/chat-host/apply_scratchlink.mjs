// Scratch連携を、いまのチャットサーバー（C:\twc-chat-host）に足す。
// 使い方（サーバーを止めてから）:  node apply_scratchlink.mjs C:\twc-chat-host
// 既存のファイルは、変えるものだけ「.bak-scratchlink」に控えを残し、決まった場所に数行足すだけです（上書きではありません）。
// 何度実行しても、二重には足しません。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || '.');
const f = p => path.join(root, p);
const read = p => fs.readFileSync(f(p), 'utf8');
function save(p, s) { if (!fs.existsSync(f(p) + '.bak-scratchlink')) fs.copyFileSync(f(p), f(p) + '.bak-scratchlink'); fs.writeFileSync(f(p), s); }
function must(s, a, what) { if (!s.includes(a)) { console.error('見つかりません:', what, '\n→ ファイルが想定と違います。変更せずに止めます'); process.exit(1); } }
function swap(s, a, b, what) { must(s, a, what); return s.replace(a, () => b); }

for (const p of ['server.mjs', 'worker/index.js', 'schema.sql']) if (!fs.existsSync(f(p))) { console.error(p, 'がありません。フォルダを確認してください:', root); process.exit(1); }

// ---- server.mjs ----
let sv = read('server.mjs');
if (!sv.includes('scratchlink.mjs')) {
  sv = swap(sv, "import { createHash } from 'node:crypto';", "import { createHash, randomBytes } from 'node:crypto';", "import createHash");
  sv = swap(sv, "import { startLlmTranslate } from './llm-translate.mjs';", "import { startLlmTranslate } from './llm-translate.mjs';\nimport { startScratchLink } from './scratchlink.mjs';", 'import startLlmTranslate');
  sv = swap(sv, "/^\\/api\\/push(\\/|$)/];", "/^\\/api\\/push(\\/|$)/, /^\\/api\\/scratchlink(\\/|$)/, /^\\/api\\/cloudsave(\\/|$)/];", 'ALLOW');
  sv = swap(sv, '  srv.files = files;', '  srv.files = files;\n  srv.workerFetch = req => worker.fetch(req, full, ctx);   // Scratch連携が、同じ処理を中から呼ぶ（外からは見えない）', 'srv.files');
  sv = swap(sv, '  const srv = createServer(env, db);', "  if (!env.HOME_SECRET) env.HOME_SECRET = randomBytes(24).toString('hex');   // Scratch連携の内部用（起動のたびに作る。外には出ない）\n  const srv = createServer(env, db);", 'createServer');
  sv = swap(sv, '  startLlmTranslate(env);', '  startScratchLink(env, db, srv);   // Scratchの通知・クラウド変数の保存\n  startLlmTranslate(env);', 'startLlmTranslate(env)');
  save('server.mjs', sv);
  console.log('server.mjs: 変更しました');
} else console.log('server.mjs: すでに変更済み');

// ---- worker/index.js ----
// 足りない道だけを足し、Scratch連携の部分は新しい版に入れ替える（前の版が入っていても、入っていなくても同じ手順）
let wk = read('worker/index.js');
const MARK = '// ---------- Scratchの通知・クラウド変数の保存';
const block = fs.readFileSync(path.join(here, 'worker-block.js'), 'utf8');
const ROUTES = [
  "  if (path === '/api/scratchlink/mine' && method === 'GET') return slMine(request, env);\n",
  "  if (path === '/api/scratchlink/notify' && method === 'PUT') return slNotify(request, env);\n",
  "  if (path === '/api/cloudsave/register' && method === 'POST') return cvRegister(request, env);\n",
  "  if (path === '/api/cloudsave/remove' && method === 'POST') return cvRemove(request, env);\n",
  "  if (path === '/api/cloudsave/history' && method === 'GET') return cvHistory(request, env, url);\n",
  "  if (path === '/api/cloudsave/rules' && method === 'GET') return cvRules(request, env, url);\n",
  "  if (path === '/api/cloudsave/rule' && method === 'POST') return cvRuleAdd(request, env);\n",
  "  if (path === '/api/cloudsave/rule/remove' && method === 'POST') return cvRuleRemove(request, env);\n",
  "  if (path === '/api/cloudsave/store' && method === 'GET') return cvStore(request, env, url);\n",
  "  if (path === '/api/cloudsave/store/remove' && method === 'POST') return cvStoreRemove(request, env);\n",
  "  if (path === '/api/home/jobs' && method === 'GET') return homeJobs(request, env);\n",
  "  if (path === '/api/home/report' && method === 'POST') return homeReport(request, env);\n",
];
if (!wk.includes('cvRuleAdd')) {
  const anchor = "  if (path === '/api/push/test' && method === 'POST') return pushTest(request, env);\n";
  must(wk, anchor, 'push/test の道');
  const missing = ROUTES.filter(r => !wk.includes(r.trim()));
  wk = wk.replace(anchor, () => anchor + missing.join(''));
  const at = wk.indexOf(MARK);
  wk = (at >= 0 ? wk.slice(0, at) : wk.replace(/\s*$/, '\n') + '\n') + block;
  save('worker/index.js', wk);
  console.log('worker/index.js: 変更しました');
} else console.log('worker/index.js: すでに最新');

// ---- schema.sql ----
let sc = read('schema.sql');
if (!sc.includes('sl_watch')) { sc = sc.replace(/\s*$/, '\n') + '\n' + fs.readFileSync(path.join(here, 'migrate_scratchlink.sql'), 'utf8'); save('schema.sql', sc); console.log('schema.sql: 通知・保存の表を足しました'); }
if (!sc.includes('cv_rules')) { sc = sc.replace(/\s*$/, '\n') + '\n' + fs.readFileSync(path.join(here, 'migrate_scratchlink2.sql'), 'utf8'); save('schema.sql', sc); console.log('schema.sql: 書き込みルールの表を足しました'); }

fs.copyFileSync(path.join(here, 'scratchlink.mjs'), f('scratchlink.mjs'));
console.log('scratchlink.mjs: 置きました');
console.log('\n完了。サーバーを起動し直してください（start.command（Windowsは start.bat））。起動の表示に「scratch-link: 60秒ごとに…」が出れば成功です。');
