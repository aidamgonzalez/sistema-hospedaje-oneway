/* Trabajador de la app: permite instalarla. Siempre pide la versión más nueva a internet. */
const CACHE = 'hospedaje-ow-v17';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  const fresh = new Request(u.href, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(fetch(fresh).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(u.href, copy)); } return r; })
    .catch(() => caches.match(u.href).then(r => r || caches.match(new URL('./', location).href)).then(r => r || Response.error())));
});
