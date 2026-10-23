/* Trabajador de la app: permite instalarla. Siempre busca la versión más nueva en internet. */
const CACHE = 'hospedaje-ow-v7';
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return; // Supabase y librerías: directo a internet
  e.respondWith(fetch(req).then(r => { if (r && r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
    .catch(() => caches.match(req).then(r => r || caches.match('./') || Response.error())));
});
