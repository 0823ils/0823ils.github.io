// ---------- 端末への通知（Web Push） ----------
//   GET    /api/push/key                            -> { key }      公開鍵（未設定なら空）
//   POST   /api/push/subscribe { endpoint, keys }   -> { ok }       (要ログイン。この端末に通知を送る)
//   DELETE /api/push/subscribe { endpoint }         -> { ok }       (要ログイン。この端末への通知をやめる)
// 返信・@メンションの通知を作るとき（chatPost）に、その人が登録した端末にも送る。
// 設定: 変数 VAPID_PUBLIC_KEY / VAPID_SUBJECT と、シークレット VAPID_PRIVATE_KEY（worker/setup_push.sh が作る）。未設定なら、この機能は無効。
// 送信は RFC 8030 / 8291（aes128gcm）/ 8292（VAPID）。送り先は、既知の通知サービスのドメインだけに限る。
const PUSH_HOSTS = ['googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const PUSH_MAX_PER_USER = 10;
const wpEnc = new TextEncoder();

function pushEnabled(env) { return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY); }

function wpB64uToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wpBytesToB64u(b) {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function wpConcat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function wpHkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// 本文を暗号化する（RFC 8291）。fixed は、決まった値で確かめるとき用（通常は渡さない）
async function wpEncrypt(sub, payload, fixed) {
  const uaPublic = wpB64uToBytes(sub.p256dh);     // 受け取る端末の公開鍵（65バイト）
  const authSecret = wpB64uToBytes(sub.auth);     // 端末との共有の秘密（16バイト）
  let asPrivate, asPublic;
  if (fixed) { asPrivate = fixed.asPrivate; asPublic = fixed.asPublic; }
  else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const ikm = await wpHkdf(authSecret, ecdh, wpConcat(wpEnc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await wpHkdf(salt, ikm, wpEnc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await wpHkdf(salt, ikm, wpEnc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = wpConcat(payload, new Uint8Array([2]));      // 最後のブロックの印(0x02)
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));
  const header = wpConcat(salt, new Uint8Array([0, 0, 0x10, 0, 65]), asPublic);   // salt, 区切りのサイズ4096, 鍵の長さ65, 送り側の公開鍵
  return wpConcat(header, cipher);
}

let wpSignKey = null;
// 送り主の証明（VAPID, RFC 8292）。ES256のJWTを、鍵つきの Authorization ヘッダーにする
async function vapidHeader(env, endpoint) {
  if (!wpSignKey || wpSignKey.d !== env.VAPID_PRIVATE_KEY) {
    const pub = wpB64uToBytes(env.VAPID_PUBLIC_KEY);
    const jwk = { kty: 'EC', crv: 'P-256', x: wpBytesToB64u(pub.slice(1, 33)), y: wpBytesToB64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY, ext: true };
    wpSignKey = { d: env.VAPID_PRIVATE_KEY, key: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  const head = wpBytesToB64u(wpEnc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = wpBytesToB64u(wpEnc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://0823ils.github.io/',
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, wpSignKey.key, wpEnc.encode(head + '.' + claims)));
  return 'vapid t=' + head + '.' + claims + '.' + wpBytesToB64u(sig) + ', k=' + env.VAPID_PUBLIC_KEY;
}

async function sendPushTo(env, usernameLower, payload) {
  const subs = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE username = ?').bind(usernameLower).all();
  const bytes = wpEnc.encode(JSON.stringify(payload));
  await Promise.all(subs.results.map(async (s) => {
    try {
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': await vapidHeader(env, s.endpoint),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'TTL': '86400',
          'Urgency': 'normal',
        },
        body: await wpEncrypt(s, bytes),
      });
      if (res.status === 404 || res.status === 410) {   // 端末が登録を取り消した（アプリを消した等）
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run();
      } else if (!res.ok) {
        console.error('push failed', res.status);
      }
    } catch (e) { console.error('push error', e); }
  }));
}

// 返信・メンションの相手に、端末通知を送る。応答は待たせない（waitUntil）
function pushNotify(env, targets, from, room, messageId, snippet) {
  if (!pushEnabled(env) || !targets.size) return;
  const work = (async () => {
    for (const [to, kind] of targets) {
      await sendPushTo(env, to, {
        title: kind === 'reply' ? from + ' さんが返信しました' : from + ' さんがメンションしました',
        body: String(snippet || '').slice(0, 80),
        url: '/?m=c&room=' + encodeURIComponent(room),
        tag: 'chat-' + messageId,
      });
    }
  })().catch(e => console.error('push', e));
  if (env.__ctx && env.__ctx.waitUntil) env.__ctx.waitUntil(work);
}

async function pushKey(env) {
  return json({ key: pushEnabled(env) ? String(env.VAPID_PUBLIC_KEY) : '' });
}

async function pushSubscribe(request, env) {
  const user = await requireUser(request, env);
  if (!pushEnabled(env)) throw new HttpError(503, 'push_disabled');
  const body = await readJson(request);
  const endpoint = String(body.endpoint || '');
  const keys = body.keys || {};
  const p256dh = String(keys.p256dh || '');
  const auth = String(keys.auth || '');
  let host = '';
  try { const u = new URL(endpoint); if (u.protocol !== 'https:') throw new Error('x'); host = u.hostname; }
  catch (e) { throw new HttpError(400, 'bad_endpoint'); }
  if (endpoint.length > 700 || !PUSH_HOSTS.some(h => host === h || host.endsWith('.' + h))) throw new HttpError(400, 'bad_endpoint');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,30}$/.test(auth)) throw new HttpError(400, 'bad_keys');
  const me = user.u.toLowerCase();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO push_subs (endpoint, username, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(endpoint, me, p256dh, auth, Date.now()).run();
  // 1人につき、新しい10台まで
  await env.DB.prepare(
    'DELETE FROM push_subs WHERE username = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE username = ? ORDER BY created_at DESC LIMIT ?)'
  ).bind(me, me, PUSH_MAX_PER_USER).run();
  return json({ ok: true });
}

async function pushUnsubscribe(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND username = ?')
    .bind(String(body.endpoint || ''), user.u.toLowerCase()).run();
  return json({ ok: true });
}


