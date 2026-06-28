// Minimal offline cache for the app shell. CDN libs + Google Maps are network-first (fall through).
const CACHE = 'route-pwa-v4';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './db.js', './fuzzy.js', './geo.js',
  './xlsxio.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only cache-first our own same-origin shell files; let everything else hit the network.
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
  }
});
