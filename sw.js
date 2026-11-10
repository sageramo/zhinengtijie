// Service worker with two jobs only, and no caching of the site (assets carry ?v= and must stay fresh):
// 1. Share target: Android's share sheet POSTs text and screenshots to ./share-target. They are parked
//    in a one-shot cache and the page opens 研墨, which reads them (OCR runs in the page) and clears it.
// 2. Notifications: a click on a reminder brings the workbench back to 画卷.
const SCOPE = self.registration.scope;
const SHARE_PATH = new URL('./share-target', SCOPE).pathname;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
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
