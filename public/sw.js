// Zence Draw — Service Worker profesional
// Estrategia: App shell precache + runtime cache, offline first para assets,
// network-first para navegaciones con fallback a shell. Limpieza versionada.

const SHELL_CACHE = "zence-draw-shell-v1";
const RUNTIME_CACHE = "zence-draw-runtime-v1";

// Shell mínimo sin hashes (siempre presente). Los assets hasheados de /assets/
// se cachean bajo demanda en RUNTIME_CACHE.
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-192-maskable.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll puede fallar si una URL 404; lo hacemos tolerante
      await Promise.allSettled(
        SHELL_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok) await cache.put(url, res);
            else {
              // fallback: intenta cache.add (que clona)
              try { await cache.add(url); } catch {}
            }
          } catch {}
        }),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
      // Notifica a las ventanas que ya está activo (útil para mostrar "listo offline")
      const clients = await self.clients.matchAll({ type: "window" });
      for (const c of clients) c.postMessage({ type: "SW_ACTIVATED" });
    })(),
  );
});

// Permite a la página pedir skipWaiting sin recargar a ciegas
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data && event.data.type === "GET_VERSION") {
    event.ports[0]?.postMessage({ version: SHELL_CACHE + " / " + RUNTIME_CACHE });
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Solo mismo origen
  if (url.origin !== location.origin) return;

  // Navegaciones (SPA): network-first con fallback a shell
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Cachea la última navegación exitosa (para offline)
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          // SPA fallback: toda ruta → index.html / "/"
          const shell =
            (await caches.match("/index.html")) ||
            (await caches.match("/")) ||
            (await caches.match(req.url));
          if (shell) return shell;
          // Último recurso: respuesta offline mínima
          return new Response(
            "<!doctype html><meta charset=utf-8><title>Sin conexión — Zence Draw</title><style>html,body{height:100%;margin:0;display:grid;place-items:center;background:#0a0a0a;color:#eee;font:14px system-ui}</style><p>Sin conexión. Abre de nuevo cuando recuperes red.</p>",
            { headers: { "Content-Type": "text/html" }, status: 200 },
          );
        }
      })(),
    );
    return;
  }

  // Assets estáticos hasheados: cache-first + stale-while-revalidate
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".wasm") ||
    req.destination === "script" ||
    req.destination === "style" ||
    req.destination === "font" ||
    req.destination === "image"
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        const fetchAndCache = fetch(req)
          .then(async (res) => {
            if (res.ok) {
              const cache = await caches.open(RUNTIME_CACHE);
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => null);
        if (cached) {
          // Revalida en segundo plano sin bloquear
          event.waitUntil(fetchAndCache);
          return cached;
        }
        const fresh = await fetchAndCache;
        if (fresh) return fresh;
        // Si falla y era imagen, intenta icono fallback
        if (req.destination === "image") {
          const fallback = await caches.match("/icon-192.png");
          if (fallback) return fallback;
        }
        return new Response("", { status: 503, statusText: "Offline" });
      })(),
    );
    return;
  }

  // Resto (manifest, json, etc): stale-while-revalidate genérico
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
        }
        return cached ? cached : fresh;
      } catch {
        if (cached) return cached;
        return new Response("", { status: 504, statusText: "Gateway Timeout" });
      }
    })(),
  );
});
