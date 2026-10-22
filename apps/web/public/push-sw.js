// Browser push handlers, loaded into the PWA service worker (vite.config.ts `importScripts`).
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'বারাকাহ ফান্ড', {
      body: msg.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      lang: 'bn',
      data: { url: (msg.data && msg.data.url) || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
