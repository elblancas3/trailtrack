// TrailTrack Service Worker
// Estrategia:
//   - App shell (index, manifest): Cache-first, actualiza en background
//   - Map tiles (*.tile.*): Cache-first, guarda on-the-fly (precache de área)
//   - Todo lo demás: Network-first con fallback a cache

const APP_CACHE  = 'trailtrack-app-v1';
const TILE_CACHE = 'trailtrack-tiles-v1';
const MAX_TILES  = 2000; // ~40 MB estimado en tiles 256x256

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

const TILE_HOSTS = [
  'tile.opentopomap.org',
  'tile.openstreetmap.org',
  'server.arcgisonline.com',
  'basemaps.cartocdn.com',
];

// ─── INSTALL: pre-cache app shell ───────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(APP_CACHE)
      .then(c => c.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE: limpiar caches viejos ────────────
self.addEventListener('activate', e => {
  const keep = [APP_CACHE, TILE_CACHE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ──────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Tiles → Cache-first, guarda offline
  if (TILE_HOSTS.some(h => url.hostname.includes(h))) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // App shell → Cache-first
  if (APP_SHELL.includes(e.request.url) || url.pathname === '/') {
    e.respondWith(
      caches.match(e.request)
        .then(cached => {
          if (cached) {
            // Background refresh
            fetch(e.request).then(r => {
              if (r && r.ok) caches.open(APP_CACHE).then(c => c.put(e.request, r));
            }).catch(() => {});
            return cached;
          }
          return fetch(e.request).then(r => {
            if (r && r.ok) caches.open(APP_CACHE).then(c => c.put(e.request, r.clone()));
            return r;
          });
        })
    );
    return;
  }

  // WebSocket y el resto → red normal
  if (e.request.url.startsWith('ws://') || e.request.url.startsWith('wss://')) return;

  // Demás recursos → Network-first
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      // Trim cache si excede límite
      const keys = await cache.keys();
      if (keys.length >= MAX_TILES) {
        // Eliminar los primeros 200 (más viejos)
        await Promise.all(keys.slice(0, 200).map(k => cache.delete(k)));
      }
      cache.put(request, response.clone());
      return response;
    }
    return response;
  } catch (_) {
    // Sin red y sin cache → tile vacío transparente 1x1
    return new Response(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

// ─── MENSAJE desde cliente: precache área ───────
// El cliente puede pedir: { type:'precache', tiles:[url,...] }
self.addEventListener('message', async e => {
  if (e.data?.type !== 'precache') return;
  const cache = await caches.open(TILE_CACHE);
  const urls = e.data.tiles || [];
  let done = 0;
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (r.ok) { await cache.put(url, r); done++; }
    } catch (_) {}
  }
  e.ports[0]?.postMessage({ done, total: urls.length });
});
