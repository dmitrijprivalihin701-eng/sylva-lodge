/* Sylva Lodge — приложение бронирования (PWA).
   Страница — сначала сеть; картинки и шрифты — из кэша. Запросы к серверу (Google) никогда не кэшируются:
   занятые даты и брони всегда свежие. При изменении приложения поднимите VERSION. */
const VERSION = 'sylva-app-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './img/icon-192.png', './img/icon-512.png',
              './img/hero.jpg', './img/pine.jpg', './img/grand.jpg', './img/family.jpg'];

self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== VERSION).map(x => caches.delete(x)))).then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('./'))));
    return;
  }
  if (/\.(jpg|png|webmanifest|woff2?|css)$/i.test(url.pathname) || url.hostname.includes('fonts.g')) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); } return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
