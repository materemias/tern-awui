// Shows tern-mobile's push notifications and opens the session they are about.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
        // One notification per session: a newer one replaces it and still alerts.
        tag: d.block ? `b${d.block}` : "tern",
        renotify: true,
        icon: "/icon-v2-192.png",
        data: { url: d.block ? `/#/b/${d.block}` : "/" },
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
