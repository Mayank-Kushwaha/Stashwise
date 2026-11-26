// PWA service worker: caches only this app's own files (stale-while-revalidate). API calls are never cached.
const V = 'vault-v5';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', '../core/util.js', '../core/images.js', '../core/kv.js', '../core/vec.js', '../core/merge.js', '../core/search.js', '../core/topics.js', '../core/gist.js', '../core/ai.js', '../core/store.js', '../core/save.js', '../icons/icon192.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
