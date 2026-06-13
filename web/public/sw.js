self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', () => {});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Remotty needs your input';
  const baseUrl = new URL('./', self.registration.scope);
  const options = {
    body: data.body || 'Open Remotty to continue.',
    icon: new URL('icon-192.png', baseUrl).href,
    badge: new URL('icon-192.png', baseUrl).href,
    tag: data.tag || 'remotty-input',
    renotify: true,
    data: { url: data.url || '' },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      typeof self.navigator.setAppBadge === 'function'
        ? self.navigator.setAppBadge(1).catch(() => {})
        : Promise.resolve(),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      if (typeof self.navigator.clearAppBadge === 'function') {
        await self.navigator.clearAppBadge().catch(() => {});
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('navigate' in client) await client.navigate(url);
        return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
