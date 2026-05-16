// MeterIQ Service Worker — v42
const CACHE = 'meteriq-v49.3';
const STATIC = ['./manifest.json', './icon.svg', './icon-maskable.svg', './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png'];

// Install: cache only static assets (not HTML — that stays network-first)
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
});

// Activate: delete ALL old caches, claim all clients immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always pass through: GAS API calls, CDN, cross-origin
  if (url.hostname !== location.hostname ||
      url.pathname.includes('exec') ||
      url.hostname.includes('cdnjs') ||
      url.hostname.includes('googleapis')) {
    return;
  }

  // HTML navigation requests → network-first (always get latest redirect/version)
  if (e.request.mode === 'navigate' ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Cache the fresh response for offline fallback
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('././')))
    );
    return;
  }

  // Static assets → cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('././'));
    })
  );
});
