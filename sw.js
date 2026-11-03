// غيّر الرقم كل ما تعدل ملفات الموقع، عشان الجوالات تاخذ النسخة الجديدة
const VERSION = "v4";
const SHELL = `tuvex-shell-${VERSION}`;
const ENGINE = "tuvex-engine-0.12.10";

const SHELL_FILES = [
  "./",
  "index.html",
  "assets/style.css",
  "assets/intro.css",
  "assets/app.js",
  "manifest.webmanifest",
  "favicon.ico",
  "icons/icon.svg",
  "icons/icon-small.svg",
  "icons/favicon-32.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "vendor/ffmpeg/index.js",
  "vendor/ffmpeg/classes.js",
  "vendor/ffmpeg/const.js",
  "vendor/ffmpeg/errors.js",
  "vendor/ffmpeg/types.js",
  "vendor/ffmpeg/utils.js",
  "vendor/ffmpeg/worker.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ENGINE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// GitHub Pages ما يسمح نضيف headers، فنضيفها هنا. هذي الـ headers تفعّل
// SharedArrayBuffer اللي يحتاجه المحرك متعدد الأنوية
function isolate(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === location.origin;

  // ملفات المحرك كبيرة (32MB) وما تتغير، نحفظها مرة وحدة
  if (sameOrigin && url.pathname.includes("/vendor/core")) {
    e.respondWith(
      caches.open(ENGINE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return isolate(hit);
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return isolate(res);
      }),
    );
    return;
  }

  // باقي الموقع: الشبكة أولًا، وإذا ما فيه إنترنت نرجع للنسخة المحفوظة
  if (sameOrigin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(e.request, copy));
          }
          return sameOrigin ? isolate(res) : res;
        })
        .catch(async () => {
          const hit = await caches.match(e.request, { ignoreSearch: true });
          return sameOrigin ? isolate(hit) : hit;
        }),
    );
  }
});
