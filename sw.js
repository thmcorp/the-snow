// THM Snow service worker: keeps the app opening with no signal.
// Network first for the app files, cached copy when offline. Database calls are never cached.
const CACHE = "thm-snow-v17";
const SHELL = ["./", "index.html", "app.js", "styles.css", "config.js", "manifest.webmanifest", "icons/icon-192.png",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.url.includes("/rest/v1/") || req.url.includes("nominatim")) return;
  const same = new URL(req.url).origin === self.location.origin;
  e.respondWith(fetch(req, same ? { cache: "no-cache" } : {}).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
