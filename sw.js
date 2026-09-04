'use strict';

const CACHE_NAME = 'portariasync-shell-v4';
const SHELL = [
  '/index.html',
  '/manifest.json',
  '/pwa.js',
  '/local-ocr.js',
  '/label-capture.js',
  '/recipient-matching.js',
  '/recipient-memory.js',
  '/barcode-reader.js',
  '/recipient-review-ui.js',
  '/ocr-metrics.js',
  '/whatsapp-client.js',
  '/withdrawal-pin.js',
  '/withdrawal-authorization.js',
  '/custody-chain-client.js',
  '/package-alerts-client.js',
  '/withdrawal-receipt-client.js',
  '/icons/portariasync-192.svg',
  '/icons/portariasync-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL.map(async url => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response.ok) await cache.put(url, response.clone());
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('portariasync-shell-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function cacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/data/')) return false;
  if (url.pathname === '/sw.js') return false;
  return request.mode === 'navigate' || /\.(?:html|js|json|css|svg)$/i.test(url.pathname) || url.pathname === '/';
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (!cacheable(request, url)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
