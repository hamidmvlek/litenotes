// Offline support. App files come from the network first (so updates show up right away)
// and fall back to the cached copy when offline. Bump CACHE on every release.
const CACHE = 'litenotes-v3';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'fonts/Overpass-Regular.ttf', 'fonts/Overpass-Bold.ttf',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isFont = url.pathname.includes('/fonts/') || url.pathname.includes('/icons/');
  if (isFont) {
    // Fonts and icons never change between releases: cache first.
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
