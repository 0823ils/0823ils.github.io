// ===== 端末への通知（Web Push） =====
var PUSH_T = {
    ja: { on: 'この端末に通知を送る', off: 'この端末の通知を切る',
          ios: 'iPhone・iPadでは、Safariの共有メニューから「ホーム画面に追加」をして、そのアプリから開くと、設定できます',
          unsupported: 'このブラウザは、端末への通知に対応していません',
          denied: '通知がブロックされています。ブラウザやOSの設定で、許可してください',
          disabled: '端末への通知は、まだ準備中です',
          done: '通知を有効にしました', fail: '通知を設定できませんでした', login: 'ログインすると、設定できます' },
    en: { on: 'Send notifications to this device', off: 'Turn off notifications for this device',
          ios: 'On iPhone/iPad, use Safari\'s Share menu > "Add to Home Screen", then open the app to enable this',
          unsupported: 'This browser does not support device notifications',
          denied: 'Notifications are blocked. Allow them in your browser or OS settings',
          disabled: 'Device notifications are not ready yet',
          done: 'Notifications enabled', fail: 'Could not set up notifications', login: 'Log in to enable this' }
};
var pushKeyCache = null;     // サーバーの公開鍵（空文字 = サーバー側が未設定）
var pushSyncedFor = 0;

function pt(k) { return (PUSH_T[currentLang] || PUSH_T.ja)[k] || k; }
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function pushIsIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

function pushKeyBytes(b64) {
    var s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

async function pushSubscription() {
    try {
        var reg = await navigator.serviceWorker.getRegistration('/');
        return reg ? await reg.pushManager.getSubscription() : null;
    } catch (e) { return null; }
}

// 通知メニューの下の、「この端末に通知を送る」ボタンの表示を決める
async function refreshPushUI(keepNote) {
    var btn = document.getElementById('push-btn'), note = document.getElementById('push-note');
    if (!btn || !note) return;
    if (!keepNote) note.innerText = '';
    if (!loginUser) { btn.style.display = 'none'; note.innerText = pt('login'); return; }
    if (!pushSupported()) { btn.style.display = 'none'; note.innerText = pushIsIOS() ? pt('ios') : pt('unsupported'); return; }
    if (Notification.permission === 'denied') { btn.style.display = 'none'; note.innerText = pt('denied'); return; }
    if (pushKeyCache === null) {
        apiCall('GET', '/api/push/key').then(function(k) { pushKeyCache = k.key || ''; }).catch(function() {});
    }
    var sub = await pushSubscription();
    btn.style.display = '';
    btn.dataset.on = sub ? '1' : '0';
    btn.innerText = sub ? pt('off') : pt('on');
}

async function togglePush() {
    var btn = document.getElementById('push-btn'), note = document.getElementById('push-note');
    btn.disabled = true;
    note.innerText = '';
    try {
        if (btn.dataset.on === '1') {
            var sub = await pushSubscription();
            if (sub) {
                try { await apiCall('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint }); } catch (e) {}
                await sub.unsubscribe();
            }
        } else {
            if (pushKeyCache === '') { note.innerText = pt('disabled'); return; }
            // 許可のお願いは、タップの直後に出す（iPhoneは、通信のあとだと出せない）
            var perm = await Notification.requestPermission();
            if (perm !== 'granted') { note.innerText = pt('denied'); return; }
            if (pushKeyCache === null) pushKeyCache = (await apiCall('GET', '/api/push/key')).key || '';
            if (!pushKeyCache) { note.innerText = pt('disabled'); return; }
            await navigator.serviceWorker.register('/sw.js');
            var reg = await navigator.serviceWorker.ready;
            var s2 = (await reg.pushManager.getSubscription()) ||
                (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(pushKeyCache) }));
            var j = s2.toJSON();
            await apiCall('POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
            pushSyncedFor = loginUser ? loginUser.id : 0;
            note.innerText = pt('done');
        }
    } catch (e) { note.innerText = pt('fail'); }
    finally { btn.disabled = false; refreshPushUI(true); }
}

// ログインしたとき、この端末の通知の宛先を、ログイン中のアカウントに付け替える
async function syncPushSub() {
    if (!loginUser || !pushSupported() || Notification.permission !== 'granted' || pushSyncedFor === loginUser.id) return;
    try {
        var sub = await pushSubscription();
        if (!sub) return;
        var j = sub.toJSON();
        await apiCall('POST', '/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
        pushSyncedFor = loginUser.id;
    } catch (e) {}
}

// ログアウトするとき、この端末への通知をやめる（次の人に届かないように）
async function pushUnbind() {
    try {
        if (!loginUser || !pushSupported()) return;
        var sub = await pushSubscription();
        if (sub) await apiCall('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint });
    } catch (e) {}
    pushSyncedFor = 0;
}

