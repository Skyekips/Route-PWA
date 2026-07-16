// Minimal offline cache for the app shell. CDN libs (Leaflet/SheetJS/Tesseract), map tiles, and
// Google APIs are network-first and fall through — the shell itself always works offline.
const CACHE = 'route-pwa2-v3';
const SHELL = [
  './', './index.html', './styles.css',
  './app.js', './logic.js', './db.js', './geo.js', './fuzzy.js', './xlsxio.js', './icons.js',
  './view-drive.js', './view-today.js', './view-stops.js', './view-plan.js',
  './view-scan.js', './view-settings.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // Shell: cache-first, refresh in the background.
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const refresh = fetch(e.request)
          .then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
  // Cross-origin (CDNs, tiles, Google): default network behavior.
});
