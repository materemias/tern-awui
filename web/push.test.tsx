import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Net, settle } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Static imports would bind Preact to the environment before the DOM is registered.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { APP_BLOCKED_WARNING, PUSH_LABEL, usePush } = await import("./push");

const CHOICE = "tern-mobile:push";
const KEY = new Uint8Array([1, 2, 3]);
class Subscription implements PushSubscription {
  readonly endpoint = "https://push.example/device";
  readonly expirationTime = null;
  readonly options: PushSubscriptionOptions;
  constructor(owner: Manager, key: ArrayBuffer | null = KEY.buffer) {
    this.options = { userVisibleOnly: true, applicationServerKey: key };
    this.unsubscribe = mock(async () => {
      owner.current = null;
      return true;
    });
  }
  readonly unsubscribe;
  getKey(_name: PushEncryptionKeyName): ArrayBuffer | null { return null; }
  toJSON(): PushSubscriptionJSON {
    return { endpoint: this.endpoint, expirationTime: null, keys: { auth: "auth-key", p256dh: "public-key" } };
  }
}
class Manager {
  current: Subscription | null = null;
  getSubscription = mock(async () => this.current);
  subscribe = mock(async (_options?: PushSubscriptionOptionsInit) => {
    this.current = new Subscription(this);
    return this.current;
  });
}

let root: HTMLElement;
let manager: Manager;
let ready: { promise: Promise<{ pushManager: Manager }>; resolve(value: { pushManager: Manager }): void };
let permission: NotificationPermission;
let requestedPermission: NotificationPermission;
const requestPermission = mock(async (): Promise<NotificationPermission> => {
  permission = requestedPermission;
  return permission;
});
const alerts: string[] = [];
const net = new Net();
const restore: (() => void)[] = [];
function property(target: object, key: PropertyKey, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (old) Object.defineProperty(target, key, old);
    else Reflect.deleteProperty(target, key);
  });
}
function reply(url: string) {
  return url === "/api/push/key" ? Response.json({ key: "AQID" }) : Response.json({ ok: true });
}
beforeEach(() => {
  jest.useFakeTimers();
  root = document.createElement("div");
  document.body.append(root);
  localStorage.clear();
  alerts.length = 0;
  permission = "granted";
  requestedPermission = "granted";
  requestPermission.mockReset();
  requestPermission.mockImplementation(async () => {
    permission = requestedPermission;
    return permission;
  });
  manager = new Manager();
  ready = Promise.withResolvers<{ pushManager: Manager }>();
  property(navigator, "serviceWorker", { ready: ready.promise });
  property(window, "PushManager", Manager);
  property(globalThis, "Notification", { get permission() { return permission; }, requestPermission });
  property(globalThis, "alert", (message: unknown) => { alerts.push(String(message)); });
  net.install();
  net.reply = (call) => reply(call.url);
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const undo of restore.splice(0).reverse()) undo();
});

function PushHost() {
  const [state, toggle] = usePush();
  return <button data-state={state} onClick={toggle}>{PUSH_LABEL[state]}</button>;
}
function button(): HTMLButtonElement {
  const button = root.querySelector("button");
  if (!button) throw new Error("missing notification button");
  return button;
}
function expectState(state: keyof typeof PUSH_LABEL) {
  expect(button().dataset.state).toBe(state);
  expect(button().textContent).toBe(PUSH_LABEL[state]);
}
async function flush() { await act(async () => { await settle(40); }); }
async function mount() {
  ready.resolve({ pushManager: manager });
  await act(() => render(<PushHost />, root));
  await flush();
}
async function click() {
  await act(async () => {
    button().click();
    await settle(40);
  });
}
function existing(key: ArrayBuffer | null = KEY.buffer) {
  const sub = new Subscription(manager, key);
  manager.current = sub;
  return sub;
}

test("pending readiness ignores toggles, then a new device settles off without subscribing", async () => {
  await act(() => render(<PushHost />, root));
  expectState("pending");
  await click();
  expect(requestPermission).not.toHaveBeenCalled();
  expect(net.calls).toEqual([]);
  ready.resolve({ pushManager: manager });
  await flush();
  expectState("off");
  expect(localStorage.getItem(CHOICE)).toBeNull();
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(net.calls).toEqual([]);
});

test("enabling waits for permission and server confirmation before remembering on", async () => {
  permission = "default";
  await mount();
  expectState("off");
  const prompt = Promise.withResolvers<NotificationPermission>();
  const saved = Promise.withResolvers<Response>();
  requestPermission.mockImplementationOnce(() => prompt.promise);
  net.reply = (call) => call.url === "/api/push/subscribe" ? saved.promise : reply(call.url);
  await click();
  expectState("pending");
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(net.calls).toEqual([]);
  await click();
  expect(requestPermission).toHaveBeenCalledTimes(1);
  permission = "granted";
  prompt.resolve("granted");
  await flush();
  expectState("pending");
  expect(localStorage.getItem(CHOICE)).toBeNull();
  expect(manager.subscribe.mock.calls).toEqual([[{ userVisibleOnly: true, applicationServerKey: KEY }]]);
  expect(net.calls).toEqual([
    { url: "/api/push/key", method: "GET", body: undefined, headers: {} },
    { url: "/api/push/subscribe", method: "POST", body: manager.current?.toJSON(), headers: { "content-type": "application/json", "x-tern-mobile": "1" } },
  ]);
  saved.resolve(Response.json({ ok: true }));
  await flush();
  expectState("on");
  expect(localStorage.getItem(CHOICE)).toBe("on");
  expect(alerts).toEqual([]);
});

test("an existing subscription migrates an unset choice and is re-registered with the server", async () => {
  const sub = existing();
  await mount();
  expectState("on");
  expect(localStorage.getItem(CHOICE)).toBe("on");
  expect(net.to("/api/push/subscribe")).toEqual([sub.toJSON()]);
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(sub.unsubscribe).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
});

test("remembered on silently renews a browser-dropped subscription", async () => {
  localStorage.setItem(CHOICE, "on");
  await mount();
  expectState("on");
  expect(manager.subscribe).toHaveBeenCalledTimes(1);
  expect(net.to("/api/push/subscribe")).toEqual([manager.current?.toJSON()]);
  expect(requestPermission).not.toHaveBeenCalled();
});

test("returning to the foreground or the network re-registers a remembered device; a failed recheck stays on", async () => {
  const sub = existing();
  await mount();
  expectState("on");
  // The server pruned it while the app sat in the background.
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(40);
  });
  expectState("on");
  expect(net.to("/api/push/subscribe")).toEqual([sub.toJSON(), sub.toJSON()]);
  net.reply = (call) => call.url === "/api/push/subscribe" ? Response.json({ error: "offline" }, { status: 503 }) : reply(call.url);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await settle(40);
  });
  expectState("on");
  expect(net.to("/api/push/subscribe")).toHaveLength(3);
  expect(requestPermission).not.toHaveBeenCalled();
});

test("a failed start is retried when the network returns", async () => {
  existing();
  localStorage.setItem(CHOICE, "on");
  net.reply = (call) => call.url === "/api/push/subscribe" ? Response.json({ error: "offline" }, { status: 503 }) : reply(call.url);
  await mount();
  expectState("off");
  net.reply = (call) => reply(call.url);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await settle(40);
  });
  expectState("on");
});

test("a device that chose on retries a failed start on its own, spaced out, until the server takes it", async () => {
  existing();
  localStorage.setItem(CHOICE, "on");
  let down = 2;
  net.reply = (call) => call.url === "/api/push/subscribe" && down-- > 0 ? Response.json({ error: "restarting" }, { status: 503 }) : reply(call.url);
  await mount();
  expectState("off");
  await act(async () => { jest.advanceTimersByTime(4_999); await settle(40); });
  expect(net.to("/api/push/subscribe")).toHaveLength(1);
  await act(async () => { jest.advanceTimersByTime(1); await settle(40); });
  expect(net.to("/api/push/subscribe")).toHaveLength(2);
  expectState("off");
  // The second retry waits twice as long.
  await act(async () => { jest.advanceTimersByTime(9_999); await settle(40); });
  expect(net.to("/api/push/subscribe")).toHaveLength(2);
  await act(async () => { jest.advanceTimersByTime(1); await settle(40); });
  expectState("on");
  expect(alerts).toEqual([]);
  expect(requestPermission).not.toHaveBeenCalled();
});

test("a retry that comes due during a manual enable waits for it, and still runs when the enable fails", async () => {
  existing();
  localStorage.setItem(CHOICE, "on");
  const held = Promise.withResolvers<Response>();
  let calls = 0;
  net.reply = (call) => {
    if (call.url !== "/api/push/subscribe") return reply(call.url);
    calls++;
    return calls === 1 ? Response.json({ error: "restarting" }, { status: 503 }) : calls === 2 ? held.promise : reply(call.url);
  };
  await mount();
  expectState("off");
  await click();
  expectState("pending");
  await act(async () => { jest.advanceTimersByTime(5_000); await settle(40); });
  expect(calls).toBe(2);
  held.resolve(Response.json({ error: "restarting" }, { status: 503 }));
  await flush();
  expectState("off");
  expect(alerts).toHaveLength(1);
  await act(async () => { jest.advanceTimersByTime(5_000); await settle(40); });
  expectState("on");
  expect(calls).toBe(3);
});

test("a device without a choice does not retry a failed start", async () => {
  net.reply = (call) => call.url === "/api/push/subscribe" ? Response.json({ error: "restarting" }, { status: 503 }) : reply(call.url);
  manager.getSubscription.mockRejectedValueOnce(new Error("storage unavailable"));
  await mount();
  expectState("off");
  await act(async () => { jest.advanceTimersByTime(120_000); await settle(40); });
  expect(manager.getSubscription).toHaveBeenCalledTimes(1);
});

test("a permission the browser forgot is asked again on the first tap anywhere, and the device subscribes", async () => {
  localStorage.setItem(CHOICE, "on");
  permission = "default";
  await mount();
  expectState("off");
  expect(requestPermission).not.toHaveBeenCalled();
  const elsewhere = document.createElement("div");
  document.body.append(elsewhere);
  await act(async () => {
    elsewhere.click();
    await settle(40);
  });
  elsewhere.remove();
  expectState("on");
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(net.to("/api/push/subscribe")).toEqual([manager.current?.toJSON()]);
});

test("a permission lost again after a restore is asked again on the next tap", async () => {
  localStorage.setItem(CHOICE, "on");
  permission = "default";
  await mount();
  const tap = () => act(async () => { document.body.click(); await settle(40); });
  await tap();
  expectState("on");
  permission = "default";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(40);
  });
  expectState("off");
  await tap();
  expectState("on");
  expect(requestPermission).toHaveBeenCalledTimes(2);
});

test("a dismissed restore prompt is not asked again on every tap", async () => {
  localStorage.setItem(CHOICE, "on");
  permission = "default";
  requestedPermission = "default";
  await mount();
  for (let i = 0; i < 3; i++) await act(async () => { document.body.click(); await settle(40); });
  expectState("off");
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(alerts).toEqual([]);
});

describe("installed Android app without Android's notification permission", () => {
  const BLOCKED = "tern-mobile:push-app-blocked";
  beforeEach(() => {
    property(navigator, "userAgent", "Mozilla/5.0 (Linux; Android 16) Chrome/155.0 Mobile");
    property(window, "matchMedia", (query: string) => ({ matches: query === "(display-mode: standalone)" }));
  });

  test("a launch that lost the permission and subscription shows stopped, and only the bell asks", async () => {
    localStorage.setItem(CHOICE, "on");
    permission = "default";
    await mount();
    expectState("stopped");
    expect(localStorage.getItem(BLOCKED)).toBe("1");
    // A tap elsewhere doesn't ask: the request would hang or borrow another app's permission.
    await act(async () => { document.body.click(); await settle(40); });
    expect(requestPermission).not.toHaveBeenCalled();
    // A grant (borrowed from another installed app of the host) turns them on, with a warning.
    await click();
    expectState("on");
    expect(alerts).toEqual([APP_BLOCKED_WARNING]);
    expect(net.to("/api/push/subscribe")).toEqual([manager.current?.toJSON()]);
  });

  test("a load with the permission granted and a subscription (a borrowed grant, or opened from a notification) keeps the warning", async () => {
    existing();
    localStorage.setItem(CHOICE, "on");
    localStorage.setItem(BLOCKED, "1");
    await mount();
    expectState("on");
    expect(localStorage.getItem(BLOCKED)).toBe("1");
  });

  test("a dropped subscription with the permission still granted is renewed, not stopped", async () => {
    localStorage.setItem(CHOICE, "on");
    await mount();
    expectState("on");
    expect(localStorage.getItem(BLOCKED)).toBeNull();
  });

  test("turning off forgets the warning", async () => {
    existing();
    localStorage.setItem(CHOICE, "on");
    localStorage.setItem(BLOCKED, "1");
    permission = "granted";
    await mount();
    localStorage.setItem(BLOCKED, "1");
    await click();
    expectState("off");
    expect(localStorage.getItem(BLOCKED)).toBeNull();
  });

  test("a tap on the stopped bell that gets no answer keeps it stopped", async () => {
    localStorage.setItem(CHOICE, "on");
    permission = "default";
    requestPermission.mockImplementation(() => new Promise<NotificationPermission>(() => {}));
    await mount();
    expectState("stopped");
    await click();
    await act(async () => { jest.advanceTimersByTime(10_000); await settle(40); });
    expectState("stopped");
    expect(alerts).toHaveLength(1);
  });

  test("a late grant from the stopped bell warns once the subscription is confirmed", async () => {
    localStorage.setItem(CHOICE, "on");
    permission = "default";
    const prompt = Promise.withResolvers<NotificationPermission>();
    requestPermission.mockImplementation(() => prompt.promise);
    await mount();
    await click();
    await act(async () => { jest.advanceTimersByTime(10_000); await settle(40); });
    expectState("stopped");
    alerts.length = 0;
    permission = "granted";
    prompt.resolve("granted");
    await flush();
    expectState("on");
    expect(alerts).toEqual([APP_BLOCKED_WARNING]);
    // A later ordinary check doesn't warn again.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle(40);
    });
    expect(alerts).toEqual([APP_BLOCKED_WARNING]);
  });
});

test("a grant that comes after the bell gave up still turns notifications on", async () => {
  permission = "default";
  const prompt = Promise.withResolvers<NotificationPermission>();
  requestPermission.mockImplementation(() => prompt.promise);
  await mount();
  await click();
  await act(async () => { jest.advanceTimersByTime(10_000); await settle(40); });
  expectState("off");
  expect(localStorage.getItem(CHOICE)).toBeNull();
  permission = "granted";
  prompt.resolve("granted");
  await flush();
  expectState("on");
  expect(localStorage.getItem(CHOICE)).toBe("on");
  expect(net.to("/api/push/subscribe")).toEqual([manager.current?.toJSON()]);
});

test("a late grant after a newer tap on the bell is ignored", async () => {
  permission = "default";
  const prompt = Promise.withResolvers<NotificationPermission>();
  requestPermission.mockImplementationOnce(() => prompt.promise);
  requestedPermission = "default";
  await mount();
  await click();
  await act(async () => { jest.advanceTimersByTime(10_000); await settle(40); });
  await click();
  prompt.resolve("granted");
  await flush();
  expectState("off");
  expect(localStorage.getItem(CHOICE)).toBeNull();
  expect(manager.subscribe).not.toHaveBeenCalled();
});

test("in the installed Android app a prompt that never settles frees the bell after 10 s and says where to allow it", async () => {
  property(navigator, "userAgent", "Mozilla/5.0 (Linux; Android 16) Chrome/155.0 Mobile");
  property(window, "matchMedia", (query: string) => ({ matches: query === "(display-mode: standalone)" }));
  permission = "default";
  requestPermission.mockImplementation(() => new Promise<NotificationPermission>(() => {}));
  await mount();
  await click();
  expectState("pending");
  await act(async () => { jest.advanceTimersByTime(9_999); await settle(40); });
  expectState("pending");
  await act(async () => { jest.advanceTimersByTime(1); await settle(40); });
  expectState("off");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("If no prompt appeared, Android blocks them for this app");
});

test("after a dismissed restore, a grant from the bell lets a later loss be asked again", async () => {
  localStorage.setItem(CHOICE, "on");
  permission = "default";
  requestedPermission = "default";
  await mount();
  const tap = () => act(async () => { document.body.click(); await settle(40); });
  await tap();
  expectState("off");
  requestedPermission = "granted";
  await click();
  expectState("on");
  permission = "default";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(40);
  });
  expectState("off");
  await tap();
  expectState("on");
  expect(requestPermission).toHaveBeenCalledTimes(3);
});

test.each(["/api/push/key", "/api/push/subscribe"])("turning off during a recheck held at %s leaves browser and server unsubscribed", async (held) => {
  existing();
  await mount();
  const gate = Promise.withResolvers<void>();
  let holds = 1;
  net.reply = async (call) => {
    if (call.url === held && holds-- > 0) await gate.promise;
    return reply(call.url);
  };
  // A second trigger while the first check is held must not start a check off waits for in vain.
  for (const [target, type] of [[document, "visibilitychange"], [window, "online"]] as const)
    await act(async () => {
      target.dispatchEvent(new Event(type));
      await settle(40);
    });
  await click();
  // Turning off waits for the recheck rather than racing it.
  expectState("pending");
  gate.resolve();
  await flush();
  expectState("off");
  expect(localStorage.getItem(CHOICE)).toBe("off");
  expect(manager.current).toBeNull();
  expect(net.to("/api/push/unsubscribe")).toHaveLength(1);
});

test.each([
  ["missing", null],
  ["different length", new Uint8Array([1, 2]).buffer],
  ["different bytes", new Uint8Array([1, 2, 4]).buffer],
] as const)("a subscription with a %s key is removed before renewal", async (_name, key) => {
  const old = existing(key);
  localStorage.setItem(CHOICE, "on");
  await mount();
  expectState("on");
  expect(old.unsubscribe).toHaveBeenCalledTimes(1);
  expect(manager.subscribe).toHaveBeenCalledTimes(1);
  expect(manager.current).not.toBe(old);
  expect(manager.current?.options.applicationServerKey).toEqual(KEY.buffer);
  expect(net.to("/api/push/subscribe")).toEqual([manager.current?.toJSON()]);
  expect(requestPermission).not.toHaveBeenCalled();
});

test("remembered off does not reactivate a surviving browser subscription", async () => {
  const sub = existing();
  localStorage.setItem(CHOICE, "off");
  await mount();
  expectState("off");
  expect(manager.current).toBe(sub);
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(net.calls).toEqual([]);
  expect(requestPermission).not.toHaveBeenCalled();
});

test.each(["denied", "default"] as const)("%s permission never silently resubscribes, even with a remembered choice", async (value) => {
  existing();
  permission = value;
  requestedPermission = value;
  localStorage.setItem(CHOICE, "on");
  await mount();
  expectState(value === "denied" ? "denied" : "off");
  await click();
  expectState(value === "denied" ? "denied" : "off");
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(net.calls).toEqual([]);
  // A dismissed prompt can simply be asked again from the bell: nothing to explain.
  expect(alerts).toEqual(value === "denied" ? ["Notifications are blocked: allow them in the site settings, then tap the bell again."] : []);
});

test.each([
  [true, "denied", "Long-press the app's icon → App info → Notifications"],
  [false, "denied", "Tap the icon left of the address → Permissions → Notifications"],
  // In the installed app a request can also return default with no prompt, when Android blocks it.
  [true, "default", "If no prompt appeared, Android blocks them for this app"],
  [false, "default", null],
] as const)("on Android a refused enable explains where to allow notifications (installed app: %s, result: %s)", async (installed, result, where) => {
  property(navigator, "userAgent", "Mozilla/5.0 (Linux; Android 16) Chrome/155.0 Mobile");
  property(window, "matchMedia", (query: string) => ({ matches: installed && query === "(display-mode: standalone)" }));
  permission = "default";
  requestedPermission = result;
  await mount();
  await click();
  expectState(result === "denied" ? "denied" : "off");
  if (where === null) expect(alerts).toEqual([]);
  else {
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(where);
  }
  expect(manager.subscribe).not.toHaveBeenCalled();
});

test.each(["serviceWorker", "PushManager"] as const)("without %s, notifications are unsupported and toggles do nothing", async (missing) => {
  if (missing === "serviceWorker") Reflect.deleteProperty(navigator, "serviceWorker");
  else Reflect.deleteProperty(window, "PushManager");
  await mount();
  expectState("unsupported");
  await click();
  expectState("unsupported");
  expect(manager.getSubscription).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
  expect(net.calls).toEqual([]);
});

describe("failures remain retryable", () => {
  test("initial server failure leaves the remembered choice intact and a tap retries", async () => {
    const sub = existing();
    localStorage.setItem(CHOICE, "on");
    net.reply = (call) => call.url === "/api/push/subscribe" ? Response.json({ error: "temporarily offline" }, { status: 503 }) : reply(call.url);
    await mount();
    expectState("off");
    expect(localStorage.getItem(CHOICE)).toBe("on");
    expect(alerts).toEqual([]);
    net.reply = (call) => reply(call.url);
    await click();
    expectState("on");
    expect(net.to("/api/push/subscribe")).toEqual([sub.toJSON(), sub.toJSON()]);
  });

  test("initial subscription lookup failure settles off without asking permission", async () => {
    manager.getSubscription.mockRejectedValueOnce(new Error("storage unavailable"));
    await mount();
    expectState("off");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
    await click();
    expectState("on");
  });

  test.each(["key", "browser", "server"] as const)("a %s subscribe failure settles off, reports the error and permits retry", async (failure) => {
    await mount();
    if (failure === "browser") manager.subscribe.mockRejectedValueOnce(new Error("subscribe failed"));
    else net.reply = (call) => {
      if (failure === "key" && call.url === "/api/push/key") throw new Error("key unavailable");
      if (failure === "server" && call.url === "/api/push/subscribe") return Response.json({ error: "save failed" }, { status: 503 });
      return reply(call.url);
    };
    await click();
    expectState("off");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(failure === "key" ? "key unavailable" : failure === "browser" ? "subscribe failed" : "save failed");
    expect(localStorage.getItem(CHOICE)).toBeNull();
    net.reply = (call) => reply(call.url);
    await click();
    expectState("on");
    expect(localStorage.getItem(CHOICE)).toBe("on");
  });

  test("failed browser unsubscribe still settles off and the bell can enable then disable again", async () => {
    const sub = existing();
    await mount();
    sub.unsubscribe.mockRejectedValueOnce(new Error("unsubscribe failed"));
    await click();
    expectState("off");
    expect(localStorage.getItem(CHOICE)).toBe("off");
    expect(alerts).toEqual(["Notifications failed: Error: unsubscribe failed"]);
    expect(net.to("/api/push/unsubscribe")).toEqual([sub.toJSON()]);
    expect(manager.current).toBe(sub);
    await click();
    expectState("on");
    expect(localStorage.getItem(CHOICE)).toBe("on");
    await click();
    expectState("off");
    expect(manager.current).toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(2);
  });

  test("worker readiness times out, and both the failed toggle and later ready retry settle", async () => {
    await act(() => render(<PushHost />, root));
    expectState("pending");
    await act(async () => { jest.advanceTimersByTime(9999); await settle(); });
    expectState("pending");
    await act(async () => { jest.advanceTimersByTime(1); await settle(); });
    expectState("off");
    expect(alerts).toEqual([]);
    await click();
    expectState("pending");
    await act(async () => { jest.advanceTimersByTime(10_000); await settle(); });
    expectState("off");
    expect(alerts).toEqual(["Notifications failed: Error: service worker not active"]);
    expect(net.calls).toEqual([]);
    ready.resolve({ pushManager: manager });
    await flush();
    expectState("off");
    await click();
    expectState("on");
  });
});

test("disabling records off, waits for browser unsubscribe and removes the server subscription", async () => {
  const sub = existing();
  await mount();
  const removed = Promise.withResolvers<boolean>();
  sub.unsubscribe.mockImplementationOnce(() => removed.promise);
  await click();
  expectState("pending");
  expect(localStorage.getItem(CHOICE)).toBe("off");
  expect(net.to("/api/push/unsubscribe")).toEqual([sub.toJSON()]);
  expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  await click();
  expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  removed.resolve(true);
  await flush();
  expectState("off");
  expect(alerts).toEqual([]);
});

test("disabling handles a subscription already dropped by the browser", async () => {
  existing();
  await mount();
  manager.current = null;
  await click();
  expectState("off");
  expect(localStorage.getItem(CHOICE)).toBe("off");
  expect(net.to("/api/push/unsubscribe")).toEqual([]);
});

test("server unsubscribe failure does not prevent removal of the browser subscription", async () => {
  const sub = existing();
  await mount();
  net.reply = (call) => call.url === "/api/push/unsubscribe" ? Response.json({ error: "unavailable" }, { status: 503 }) : reply(call.url);
  await click();
  expectState("off");
  expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  expect(manager.current).toBeNull();
  expect(localStorage.getItem(CHOICE)).toBe("off");
  expect(alerts).toEqual([]);
});
