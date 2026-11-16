import { describe, expect, test } from "bun:test";

const SOURCE = await Bun.file(new URL("./sw.js", import.meta.url)).text();

type Listener = (e: Record<string, unknown>) => void;
type Win = { postMessage: (m: unknown) => void; focus: () => Promise<unknown>; messages: unknown[]; focused: number };

/** Runs sw.js against a fake worker scope and records what it asks the browser to do. */
function worker(opts: { badgeApi?: boolean; windows?: number; badgeFails?: boolean; display?: Promise<void> } = {}) {
  const listeners: Record<string, Listener> = {};
  const calls = {
    notifications: [] as { title: string; options: Record<string, any> }[],
    badge: [] as (number | "clear")[],
    opened: [] as string[],
    matchAll: [] as unknown[],
    skipWaiting: 0,
    claimed: 0,
  };
  const windows: Win[] = Array.from({ length: opts.windows ?? 0 }, () => {
    const w: Win = {
      messages: [],
      focused: 0,
      postMessage: (m) => w.messages.push(m),
      focus: async () => w.focused++,
    };
    return w;
  });
  const navigator: Record<string, unknown> = {};
  if (opts.badgeApi !== false) {
    navigator.setAppBadge = async (n: number) => {
      calls.badge.push(n);
      if (opts.badgeFails) throw new Error("not installed");
    };
    navigator.clearAppBadge = async () => {
      calls.badge.push("clear");
    };
  }
  /** The share cache sw.js writes to. */
  const stash = new Map<string, Response>();
  const self = {
    navigator,
    location: { href: "https://tern.example/sw.js", origin: "https://tern.example" },
    caches: {
      open: async () => ({
        keys: async () => [...stash.keys()],
        delete: async (key: string) => stash.delete(key),
        put: async (key: string, res: Response) => void stash.set(key, res),
      }),
    },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => calls.skipWaiting++,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        calls.notifications.push({ title, options });
        await opts.display;
      },
    },
    clients: {
      claim: async () => calls.claimed++,
      matchAll: async (q: unknown) => {
        calls.matchAll.push(q);
        return windows;
      },
      openWindow: async (url: string) => calls.opened.push(url),
    },
  };
  new Function("self", SOURCE)(self);

  /** Fires an event; resolves once everything it passed to waitUntil settles. */
  async function fire(type: string, event: Record<string, unknown>) {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => (waited = p) });
    return waited;
  }
  const push = (payload?: unknown) =>
    fire("push", { data: payload === undefined ? null : { json: () => payload } });
  const click = (data: unknown) => {
    const notification = { closed: false, data, close: () => (notification.closed = true) };
    return { notification, done: fire("notificationclick", { notification }) };
  };
  /** Posts a share as Android does; resolves to the worker's answer, or null when it let it pass. */
  async function share(form: FormData, path = "/share", method = "POST"): Promise<Response | null> {
    let answer: Promise<Response> | null = null;
    const request = new Request(`https://tern.example${path}`, { method, ...(method === "POST" && { body: form }) });
    listeners.fetch({ request, respondWith: (p: Promise<Response>) => (answer = p) });
    return answer;
  }
  return { calls, windows, fire, push, click, share, stash };
}

describe("push", () => {
  test("one notification per block, opening that block", async () => {
    const w = worker();
    await w.push({ title: "app: Fix login", body: "Done.", block: "42", badge: 3 });
    expect(w.calls.notifications).toEqual([
      {
        title: "app: Fix login",
        options: { body: "Done.", tag: "b42", renotify: true, icon: "/icon-v2-192.png", data: { url: "/#/b/42" } },
      },
    ]);
  });

  test("a newer push for the same block reuses its tag; other blocks get their own", async () => {
    const w = worker();
    await w.push({ title: "a", block: "1" });
    await w.push({ title: "b", block: "1" });
    await w.push({ title: "c", block: "2" });
    expect(w.calls.notifications.map((n) => n.options.tag)).toEqual(["b1", "b1", "b2"]);
  });

  test("an empty or block-less push still notifies, opening the list", async () => {
    const w = worker();
    await w.push();
    await w.push({ body: "x" });
    expect(w.calls.notifications.map((n) => [n.title, n.options.body, n.options.tag, n.options.data.url])).toEqual([
      ["tern", "", "tern", "/"],
      ["tern", "x", "tern", "/"],
    ]);
  });

  test("a push without a block can bring its own tag and page", async () => {
    const w = worker();
    await w.push({ title: "Set aside", tag: "ws1", url: "/#/waiting" });
    expect(w.calls.notifications[0].options).toMatchObject({ tag: "ws1", data: { url: "/#/waiting" } });
  });

  test("sets the app badge to the count, clears it at zero, leaves it without one", async () => {
    const w = worker();
    await w.push({ title: "a", badge: 5 });
    await w.push({ title: "b", badge: 0 });
    await w.push({ title: "c" });
    await w.push({ title: "d", badge: "7" });
    expect(w.calls.badge).toEqual([5, "clear"]);
    expect(w.calls.notifications.length).toBe(4);
  });

  test("a failing or missing badge API never blocks the notification", async () => {
    const failing = worker({ badgeFails: true });
    await failing.push({ title: "a", badge: 2 });
    expect(failing.calls.notifications.length).toBe(1);
    const none = worker({ badgeApi: false });
    await none.push({ title: "a", badge: 2 });
    expect(none.calls.notifications.length).toBe(1);
  });

  test("only after display completes, all pages receive a reconciliation message without focus or navigation", async () => {
    const display = Promise.withResolvers<void>();
    const w = worker({ windows: 2, display: display.promise });
    const done = w.push({ title: "Finished", block: "42" });
    expect(w.calls.notifications).toHaveLength(1);
    expect(w.calls.matchAll).toEqual([]);
    expect(w.windows.map((win) => win.messages)).toEqual([[], []]);
    display.resolve();
    await done;
    expect(w.calls.matchAll).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(w.windows.map((win) => win.messages)).toEqual([[{ type: "notification-shown" }], [{ type: "notification-shown" }]]);
    expect(w.windows.map((win) => win.focused)).toEqual([0, 0]);
    expect(w.calls.opened).toEqual([]);
  });
});

describe("notificationclick", () => {
  test("with the app open: focuses it and tells it which session to open", async () => {
    const w = worker({ windows: 2 });
    const { notification, done } = w.click({ url: "/#/b/42" });
    await done;
    expect(notification.closed).toBe(true);
    expect(w.calls.matchAll).toEqual([{ type: "window", includeUncontrolled: true }]);
    expect(w.windows[0].messages).toEqual([{ open: "/#/b/42" }]);
    expect(w.windows[0].focused).toBe(1);
    expect(w.windows[1].focused).toBe(0);
    expect(w.calls.opened).toEqual([]);
  });

  test("with the app closed: opens a window at the session", async () => {
    const w = worker();
    await w.click({ url: "/#/b/7" }).done;
    expect(w.calls.opened).toEqual(["/#/b/7"]);
  });

  test("a notification without a URL opens the list", async () => {
    const w = worker();
    await w.click(undefined).done;
    expect(w.calls.opened).toEqual(["/"]);
  });

  test("a push's notification opens the session it is about", async () => {
    const w = worker();
    await w.push({ title: "a", block: "9" });
    await w.click(w.calls.notifications[0].options.data).done;
    expect(w.calls.opened).toEqual(["/#/b/9"]);
  });
});

test("a new worker takes over at once", async () => {
  const w = worker();
  await w.fire("install", {}).catch(() => {});
  await w.fire("activate", {});
  expect(w.calls.skipWaiting).toBe(1);
  expect(w.calls.claimed).toBe(1);
});

describe("share target", () => {
  test("a share waits in the cache for the page and opens the app on it; only the newest waits", async () => {
    const w = worker();
    const first = new FormData();
    first.set("text", "older");
    await w.share(first);
    const form = new FormData();
    form.set("title", "Bug");
    form.set("text", "look at this");
    form.append("images", new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    const r = (await w.share(form))!;
    expect(r.status).toBe(303);
    const id = new URL(r.headers.get("location")!).searchParams.get("share");
    expect(r.headers.get("location")).toBe(`https://tern.example/?share=${id}`);
    expect([...w.stash.keys()]).toEqual([`/share/${id}`]);
    const stored = await w.stash.get(`/share/${id}`)!.formData();
    expect(stored.get("text")).toBe("look at this");
    const image = stored.get("images") as File;
    expect(image.type).toBe("image/png");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test("other requests pass through to the network", async () => {
    const w = worker();
    expect(await w.share(new FormData(), "/share", "GET")).toBeNull();
    expect(await w.share(new FormData(), "/api/push/subscribe")).toBeNull();
  });
});
