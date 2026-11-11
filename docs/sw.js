// 端末への通知（Web Push）を受け取る。画面を閉じていても、これが通知を出す。
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(event) {
    var d = {};
    try { d = event.data ? event.data.json() : {}; }
    catch (e) { d = { body: event.data ? event.data.text() : '' }; }
    event.waitUntil((async function() {
        await self.registration.showNotification(d.title || 'scratch-TWC', {
            body: d.body || '',
            icon: '/favicon-192.png',
            tag: d.tag || undefined,
            data: { url: d.url || '/' }
        });
        // 開いているタブに知らせる（画面のベルの未読数を、すぐ取り直してもらうため）
        try {
            var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            list.forEach(function(c) { try { c.postMessage({ type: 'twc-push' }); } catch (e) {} });
        } catch (e) {}
    })());
});

// 通知をタップしたら、その部屋を開く（すでに開いているタブがあれば、それを使う）
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    var target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
    event.waitUntil((async function() {
        var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (var i = 0; i < list.length; i++) {
            if (list[i].url.indexOf(self.location.origin) === 0) {
                await list[i].focus();
                if ('navigate' in list[i]) { try { await list[i].navigate(target); } catch (e) {} }
                return;
            }
        }
        await self.clients.openWindow(target);
    })());
});
