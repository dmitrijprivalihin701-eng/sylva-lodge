/* Sylva Lodge — сервис-воркер приложения (PWA).
   Страница: сначала сеть (чтобы правки сайта сразу были видны), без сети — из кэша.
   Картинки, шрифты, иконки: из кэша (быстрая повторная загрузка), обновляются в фоне.
   При изменении сайта поднимите VERSION, чтобы сбросить старый кэш. */
const VERSION = 'sylva-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './img/icon-192.png', './img/icon-512.png', './img/hero-m.jpg', './img/hero.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // заявки (POST) идут напрямую, без кэша
  const url = new URL(req.url);
  const isPage = req.mode === 'navigate' || (url.origin === location.origin && url.pathname.endsWith('.html'));
  const isAsset = /\.(jpg|jpeg|png|webp|svg|woff2?|css|js|webmanifest)$/i.test(url.pathname) || url.hostname.includes('fonts.g');

  if (isPage) {
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match('./')))
    );
  } else if (isAsset) {
    e.respondWith(
      caches.match(req).then(cached => {
        const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; }).catch(() => cached);
        return cached || net;
      })
    );
  }
});
