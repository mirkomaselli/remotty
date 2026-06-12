// Service worker minimale: nessuna cache aggressiva, solo passthrough di rete.
// Esiste per rendere la PWA installabile quando servita su https (Tailscale Serve).
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
// Listener fetch senza respondWith => il browser usa la rete normalmente.
self.addEventListener('fetch', () => {});
