// Shows tern-mobile's push notifications and opens the session they are about; takes what another
// app shares to the installed app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The manifest's share target: Android posts the shared text and images to /share. They wait in a
// cache entry the page reads once (web/share.ts), and the app opens with `?share=<id>` to pick the
// session they go to. Only the newest share waits: an older one nobody picked is dropped.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || url.origin !== self.location.origin || url.pathname !== "/share") return;
  e.respondWith(
    (async () => {
      try {
        const form = await e.request.formData();
        const cache = await self.caches.open("tern-share");
        for (const key of await cache.keys()) await cache.delete(key);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await cache.put(`/share/${id}`, new Response(form));
        return Response.redirect(new URL(`/?share=${id}`, self.location.href).href, 303);
      } catch {
        return Response.redirect(new URL("/", self.location.href).href, 303);
      }
    })(),
  );
});

self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : {};
  // The app icon's badge: updates not seen yet, kept current while the app is closed.
  const badge =
    typeof d.badge === "number" && "setAppBadge" in self.navigator
      ? (d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {})
      : Promise.resolve();
  e.waitUntil(
    Promise.all([
      badge,
      self.registration.showNotification(d.title || "tern", {
        body: d.body || "",
        // One notification per session: a newer one replaces it and still alerts. A session with
        // no pane to open (one set aside and closed) brings its own tag and page.
        tag: d.block ? `b${d.block}` : d.tag || "tern",
        renotify: true,
        icon: "/icon-v2-192.png",
        data: { url: d.block ? `/#/b/${d.block}` : d.url || "/" },
      }).then(async () => {
        // A push can finish displaying after SSE already cleared its unseen state.
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const win of windows) win.postMessage({ type: "notification-shown" });
      }),
    ]),
  );
});

// The browser replaced or expired the subscription, possibly while the app is closed: register
// the new one so pushes keep arriving without the app being opened first.
self.addEventListener("pushsubscriptionchange", (e) => {
  const post = (path, sub) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tern-mobile": "1" },
      body: JSON.stringify(sub.toJSON ? sub.toJSON() : sub),
    });
  e.waitUntil(
    (async () => {
      const old = e.oldSubscription;
      const sub =
        e.newSubscription ||
        (await self.registration.pushManager.subscribe(
          old?.options ?? {
            userVisibleOnly: true,
            applicationServerKey: (await (await fetch("/api/push/key")).json()).key,
          },
        ));
      await post("/api/push/subscribe", sub);
      if (old && old.endpoint !== sub.endpoint) await post("/api/push/unsubscribe", old).catch(() => {});
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = open[0];
      if (!win) return self.clients.openWindow(url);
      win.postMessage({ open: url });
      return win.focus();
    })(),
  );
});
