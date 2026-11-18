// Service worker: powłoka aplikacji działa też offline.
const VERSION = "v1-20261118";
const SHELL = "status-ai-shell-" + VERSION;
const RUNTIME = "status-ai-runtime-" + VERSION;
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "js/config.js",
  "icons/chatgpt.svg",
  "icons/gemini.svg",
  "icons/grok.svg",
  "icons/grokbot.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "icons/maskable-512.png",
  "icons/favicon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if ((k.startsWith("status-ai-shell-") || k.startsWith("status-ai-runtime-")) && k !== SHELL && k !== RUNTIME) {
          await caches.delete(k);
        }
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isNav = req.mode === "navigate";
  if (isNav) {
    e.respondWith(networkFirst(req, true));
    return;
  }
  e.respondWith(cacheFirst(req));
});

async function networkFirst(req, isNav) {
  const c = await caches.open(SHELL);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(isNav ? "index.html" : req, r.clone());
    return r;
  } catch {
    const hit = await caches.match(isNav ? "index.html" : req, { ignoreSearch: true });
    return hit || (isNav ? caches.match("./") : Response.error());
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r.ok) (await caches.open(RUNTIME)).put(req, r.clone());
    return r;
  } catch {
    return Response.error();
  }
}
