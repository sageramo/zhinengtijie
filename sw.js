// Service worker with three jobs:
// 1. Share target: Android's share sheet POSTs text and screenshots to ./share-target. They are parked
//    in a one-shot cache and the page opens 研墨, which reads them (OCR runs in the page) and clears it.
// 2. Notifications: a click on a reminder brings the workbench back to 画卷.
// 3. A static cache, so a second visit does not wait on the network for files it already has:
//    - files whose URL carries ?v= never change under that URL: served from the cache, fetched once;
//      a new release has new URLs, and the older copies of the same file are dropped when it lands;
//    - other same-origin files (images, fonts, the OCR engine): the cached copy at once, refreshed behind it;
//    - the page itself goes to the network first (a release must show), the cached page only if the
//      network fails or takes longer than 4 seconds. The API (another origin), POSTs and video ranges pass through.
const SCOPE = self.registration.scope;
const SHARE_PATH = new URL('./share-target', SCOPE).pathname;
const STATIC = 'sixu-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('sixu-static-') && name !== STATIC) await caches.delete(name);
  await self.clients.claim();
})()));

async function versioned(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const path = new URL(request.url).pathname;
    for (const old of await cache.keys()) { const u = new URL(old.url); if (u.pathname === path && u.search !== new URL(request.url).search) await cache.delete(old); }
    await cache.put(request, response.clone());
  }
  return response;
}
async function refreshed(event) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(event.request);
  const update = fetch(event.request).then(response => { if (response.ok && response.status === 200) return cache.put(event.request, response.clone()).then(() => response); return response; });
  if (hit) { event.waitUntil(update.catch(() => {})); return hit; }
  return update;
}
async function page(event) {
  const cache = await caches.open(STATIC);
  const key = new URL(event.request.url); key.search = ''; key.hash = '';
  const network = fetch(event.request).then(response => {
    if (response.ok && response.status === 200) event.waitUntil(cache.put(key.href, response.clone()));
    return response;
  });
  network.catch(() => {});
  const late = new Promise(resolve => setTimeout(resolve, 4000)).then(() => cache.match(key.href));
  try {
    return (await Promise.race([network, late])) || await network;
  } catch {
    return (await cache.match(key.href)) || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith(new URL(SCOPE).pathname)
    && !event.request.headers.has('range') && !/\.(mp4|webm)$/.test(url.pathname) && !url.pathname.endsWith('/sw.js')) {
    if (event.request.mode === 'navigate') event.respondWith(page(event));
    else if (url.searchParams.has('v')) event.respondWith(versioned(event.request));
    else event.respondWith(refreshed(event));
    return;
  }
  if (event.request.method !== 'POST' || url.pathname !== SHARE_PATH) return;
  event.respondWith((async () => {
    const form = await event.request.formData();
    const text = ['title', 'text', 'url'].map(key => form.get(key)).filter(value => typeof value === 'string' && value.trim()).join('\n');
    const files = form.getAll('images').filter(file => file && typeof file !== 'string' && file.type.startsWith('image/')).slice(0, 9);
    await caches.delete('sixu-share');
    const cache = await caches.open('sixu-share');
    await cache.put(new URL('share/meta', SCOPE), new Response(JSON.stringify({ text, count: files.length }), { headers: { 'Content-Type': 'application/json' } }));
    await Promise.all(files.map((file, index) => cache.put(new URL(`share/file-${index}`, SCOPE), new Response(file, { headers: { 'Content-Type': file.type } }))));
    return Response.redirect(new URL('./#/import?shared=1', SCOPE).href, 303);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#/calendar', SCOPE).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => client.url.startsWith(SCOPE));
    if (open) { await open.focus(); return open.navigate ? open.navigate(target) : undefined; }
    return self.clients.openWindow(target);
  })());
});
