const CACHE_NAME = "private-ai-suite-v2";
const CORE_SHELL = ["/"];
const SYNC_SUITE_ROUTES = "SYNC_SUITE_ROUTES";

function isCacheableSameOriginUrl(url) {
  return url.origin === self.location.origin &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/__");
}

function normalizeSuiteRoutes(routes) {
  if (!Array.isArray(routes)) return CORE_SHELL;
  const normalized = routes.flatMap((route) => {
    if (typeof route !== "string") return [];
    try {
      const url = new URL(route, self.location.origin);
      return isCacheableSameOriginUrl(url) ? [url.pathname] : [];
    } catch {
      return [];
    }
  });
  return [...new Set([...CORE_SHELL, ...normalized])];
}

function extractSameOriginAssetUrls(html, pageUrl) {
  const assets = [];
  const tags = html.match(/<(?:script|link)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attribute = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag);
    const value = attribute?.[1] || attribute?.[2] || attribute?.[3];
    if (!value) continue;
    try {
      const url = new URL(value, pageUrl);
      url.hash = "";
      if (isCacheableSameOriginUrl(url)) assets.push(url.href);
    } catch {
      // Ignore malformed optional resource hints.
    }
  }
  return [...new Set(assets)];
}

async function cacheAsset(cache, assetUrl) {
  try {
    const response = await fetch(assetUrl, { cache: "reload" });
    if (response.ok) await cache.put(assetUrl, response);
  } catch {
    // A single optional asset must not prevent the remaining spaces from syncing.
  }
}

async function cacheHtmlResponse(cache, request, response) {
  await cache.put(request, response.clone());
  const html = await response.text();
  const assets = extractSameOriginAssetUrls(html, request.url);
  await Promise.all(assets.map((assetUrl) => cacheAsset(cache, assetUrl)));
}

async function prefetchSuiteRoutes(routes) {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(normalizeSuiteRoutes(routes).map(async (route) => {
    const request = new Request(new URL(route, self.location.origin), {
      headers: { accept: "text/html" },
    });
    try {
      const response = await fetch(request, { cache: "reload" });
      if (response.ok) await cacheHtmlResponse(cache, request, response);
    } catch {
      // Keep the last complete cached version when a refresh is unavailable.
    }
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(prefetchSuiteRoutes(CORE_SHELL).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== SYNC_SUITE_ROUTES) return;
  event.waitUntil(prefetchSuiteRoutes(event.data.routes));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!isCacheableSameOriginUrl(url)) return;

  if (request.mode === "navigate") {
    const networkResponse = fetch(request);
    event.waitUntil(
      networkResponse
        .then(async (response) => {
          if (!response.ok) return;
          const cache = await caches.open(CACHE_NAME);
          await cacheHtmlResponse(cache, request, response.clone());
        })
        .catch(() => undefined),
    );
    event.respondWith(
      networkResponse.catch(async () =>
        (await caches.match(request, { ignoreVary: true })) ||
        (await caches.match(url.pathname, { ignoreVary: true })) ||
        (await caches.match("/", { ignoreVary: true }))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (!response.ok || !["script", "style", "worker", "font", "image"].includes(request.destination)) {
        return response;
      }
      return caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, response.clone()))
        .then(() => response);
    })),
  );
});
