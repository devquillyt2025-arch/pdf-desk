// PageDesk service worker: after the first visit the app opens instantly and keeps working offline
// (the editor runs entirely in the browser). It never touches /api and never caches anything but GET.
const CACHE = 'pagedesk-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || req.headers.has('range')) return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) return
  event.respondWith(answer(req, url))
})

async function answer(req, url) {
  const cache = await caches.open(CACHE)
  // /assets/* have content hashes in their names: what is cached under a name can never be out of date
  if (url.pathname.startsWith('/assets/')) {
    const hit = await cache.match(req)
    if (hit) return hit
  }
  try {
    const res = await fetch(req)
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {})
    return res
  } catch (err) {
    // offline: the last copy we saw (the start page stands in for any page you navigate to)
    const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/') : undefined)
    if (hit) return hit
    throw err
  }
}
