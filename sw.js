// 离线缓存：页面文件先用缓存、后台更新；数据接口一律不经过这里
const CACHE = 'pp-v1.1.0';
const FILES = [
  './', './index.html', './styles.css', './app.js', './core.js', './db.js', './sync.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' 绕过浏览器缓存，保证新版本装进来的是新文件
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = e.request.mode === 'navigate' ? './index.html' : e.request;
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => {
      if (r.ok && e.request.mode !== 'navigate') cache.put(e.request, r.clone());
      return r;
    }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || new Response('离线，且还没缓存这个文件', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
