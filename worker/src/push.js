// Web Push（ブラウザの通知）を送るための部品。外部ライブラリは使わない。
//   VAPID（RFC 8292）で自分を名乗り、中身は aes128gcm（RFC 8291）で暗号化して、
//   各ブラウザの配信サービス（FCM・Mozilla・Apple など）へ POST する。
// 必要なシークレット: VAPID_PRIVATE_JWK（worker/gen_vapid.mjs で作る）

const enc = new TextEncoder();

export function b64uEncode(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 送り先として認めるのは、主要ブラウザの配信サービスだけ（任意のURLへ送らせない）
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.apple.com',        // web.push.apple.com など
  'notify.windows.com',    // *.notify.windows.com
];
export function isAllowedEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.port) return false;
  return PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}

let cachedKeys = null;
async function vapidKeys(env) {
  if (!env.VAPID_PRIVATE_JWK) return null;
  if (cachedKeys && cachedKeys.src === env.VAPID_PRIVATE_JWK) return cachedKeys;
  const j = JSON.parse(env.VAPID_PRIVATE_JWK);
  const priv = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pub = b64uEncode(concat(new Uint8Array([4]), b64uDecode(j.x), b64uDecode(j.y)));
  cachedKeys = { src: env.VAPID_PRIVATE_JWK, priv, pub };
  return cachedKeys;
}

// ブラウザが購読するときに渡す公開鍵（base64url）。未設定なら null
export async function vapidPublicKey(env) {
  const k = await vapidKeys(env);
  return k ? k.pub : null;
}

async function vapidAuthHeader(env, endpoint) {
  const k = await vapidKeys(env);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: String(env.VAPID_SUBJECT || 'https://0823ils.github.io/'),
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, enc.encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64uEncode(sig) + ', k=' + k.pub;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// RFC 8291: aes128gcm
export async function encryptPayload(sub, plaintext) {
  const uaPublic = b64uDecode(sub.p256dh);
  const authSecret = b64uDecode(sub.auth);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = concat(plaintext, new Uint8Array([2]));   // 最後のレコードの印
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));

  const rs = new Uint8Array([0, 0, 16, 0]);               // レコードサイズ 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// 1端末に送る。返り値は HTTP ステータス（404/410 は、その端末の登録が無効になったということ）
export async function sendPush(env, sub, payload) {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
  return res.status;
}
