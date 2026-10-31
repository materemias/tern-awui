// Runs before the app (demo.ts imports it first): the page's fetch and EventSource go to the
// in-page DemoServer for /api/*, and the service worker is hidden, so the demo neither registers
// one under the site's origin nor offers notifications.
import { DemoServer, demoEventSource } from "./demo-backend";

const server = new DemoServer();
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" || input instanceof URL) {
    const url = new URL(input, location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) return server.fetch(url, init);
  }
  return realFetch(input, init);
}) as typeof fetch;
window.EventSource = demoEventSource(server) as unknown as typeof EventSource;
// WebIDL attributes are configurable: without it, `"serviceWorker" in navigator` is false everywhere.
Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
