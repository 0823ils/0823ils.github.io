// 通知を受け取るためのファイル（Service Worker）。ページを閉じていても、ブラウザが起こしてくれる。
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e) {
    var d = {};
    try { d = e.data ? e.data.json() : {}; } catch (x) {}
    e.waitUntil(self.registration.showNotification(d.title || 'scratch-TWC', {
        body: d.body || '',
        icon: '/favicon-192.png',
        badge: '/favicon-192.png',
        tag: d.tag || undefined,
        renotify: !!d.tag,
        data: { url: d.url || '/' }
    }));
});

self.addEventListener('notificationclick', function(e) {
    e.notification.close();
    var url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
    e.waitUntil((async function() {
        var cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (var i = 0; i < cs.length; i++) {
            if (cs[i].url.indexOf(self.location.origin) === 0) {
                await cs[i].focus();
                try { await cs[i].navigate(url); } catch (x) {}
                return;
            }
        }
        await self.clients.openWindow(url);
    })());
});
