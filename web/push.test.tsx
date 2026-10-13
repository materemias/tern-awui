import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Net, settle } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Static imports would bind Preact to the environment before the DOM is registered.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { PUSH_LABEL, usePush } = await import("./push");

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
  expect(alerts).toEqual([]);
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
