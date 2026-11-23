const CACHE_NAME = 'renacer-taller-v44';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './qrcode.min.js',
  './html5-qrcode.min.js',
  './logo_renacer.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.url.includes('script.google.com') || req.url.includes('dolarapi.com') || req.url.includes('binance.com')) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ ok: false, offline: true }), {
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // Estrategia Network-First con revalidación y respaldo en caché para reflejar cambios inmediatamente
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
