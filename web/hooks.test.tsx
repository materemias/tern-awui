import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Btw, ChatEntry, Doc, State, Subagent } from "./api";
import type { View } from "./hooks";
import { FakeEventSource, item, Net, settle, state } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Static imports would bind Preact to the environment before the DOM is registered.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { goBack, origins, useExitGuard, useNow, useRoute, useStream, useWakeLock, useWide } = await import("./hooks");

let root: HTMLElement;
const restore: (() => void)[] = [];
function property(target: object, key: PropertyKey, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (old) Object.defineProperty(target, key, old);
    else Reflect.deleteProperty(target, key);
  });
}
beforeEach(() => {
  jest.useFakeTimers({ now: 2_000_000_000_000 });
  root = document.createElement("div");
  document.body.append(root);
  origins.clear();
  history.replaceState(null, "", "#/");
  FakeEventSource.all = [];
  property(globalThis, "EventSource", FakeEventSource);
  property(document, "visibilityState", "visible");
});
afterEach(() => {
  render(null, root);
  root.remove();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const undo of restore.splice(0).reverse()) undo();
});

const question: Btw = { id: "question-1", question: "Why this change?", text: "", done: false, error: "" };
function StreamHost({ block = null, view = "chat", sub = null }: { block?: string | null; view?: View; sub?: string | null }) {
  const { setBtw, ...stream } = useStream(block, view, sub);
  return <>
    <pre>{JSON.stringify(stream)}</pre>
    <button onClick={() => setBtw(question)}>Ask</button>
    <button onClick={() => setBtw(null)}>Dismiss</button>
  </>;
}
function snapshot(): unknown {
  const text = root.querySelector("pre")?.textContent;
  if (!text) throw new Error("missing stream output");
  return JSON.parse(text);
}
async function click(label: string) {
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`missing button: ${label}`);
  await act(() => button.click());
}
async function emit(type: string, data: unknown) {
  await act(async () => {
    FakeEventSource.last.emit(type, data);
    await settle();
  });
}
async function advance(ms: number) {
  await act(() => { jest.advanceTimersByTime(ms); });
}
async function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  await act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

function notificationBrowser(tags: string[]) {
  const notifications = tags.map((tag) => ({ tag, close: mock(() => {}) }));
  const getNotifications = mock(async () => notifications);
  const getRegistration = mock(async (): Promise<{ getNotifications: typeof getNotifications } | undefined> => ({ getNotifications }));
  const serviceWorker = Object.assign(new EventTarget(), { getRegistration });
  property(navigator, "serviceWorker", serviceWorker);
  const shown = () => serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "notification-shown" } }));
  return { notifications, getNotifications, getRegistration, serviceWorker, shown };
}

describe("session notification dismissal", () => {
  const net = new Net();
  let serverState: State;
  beforeEach(() => {
    net.install();
    restore.push(() => net.restore());
    serverState = state([]);
    net.reply = () => Response.json(serverState);
  });

  test("fresh state and patches close seen or deleted sessions but retain unseen and unrelated notifications", async () => {
    const browser = notificationBrowser(["b5", "b6", "b7", "tern", "other", "build"]);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    const waiting = item({ block: "5", unseen: "blocked" });
    const finished = item({ block: "6", unseen: "done" });
    serverState = state([waiting, finished], { badge: 2 });
    await emit("state", serverState);
    expect(browser.notifications.map((n) => n.close.mock.calls.length)).toEqual([0, 0, 1, 0, 0, 0]);
    serverState = state([{ ...waiting, unseen: null }]);
    const { projects, ...rest } = serverState;
    await emit("patch", { ...rest, order: [[projects[0].name, ["5"]]], changed: projects[0].items });
    expect(browser.notifications.map((n) => n.close.mock.calls.length)).toEqual([1, 1, 2, 0, 0, 0]);
  });

  test.each(["stream", "response"] as const)("incomplete %s pane listings preserve unread notifications until an authoritative list arrives", async (incomplete) => {
    const browser = notificationBrowser(["b5"]);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    const unread = state([item({ unseen: "done" })], { badge: 1 });
    serverState = unread;
    await emit("state", unread);
    serverState = incomplete === "response" ? state([], { badge: 1 }) : state([]);
    await emit("state", incomplete === "stream" ? state([], { badge: 1 }) : state([]));
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
    serverState = state([]);
    await emit("state", state([]));
    expect(browser.notifications[0].close).toHaveBeenCalledTimes(1);
  });

  test("a worker display message reconciles delayed pushes using the current unseen state", async () => {
    const browser = notificationBrowser([]);
    await act(() => render(<StreamHost block="5" />, root));
    await act(() => FakeEventSource.last.open());
    serverState = state([item(), item({ block: "6", unseen: "done" })], { badge: 1 });
    await emit("state", serverState);
    const seen = { tag: "b5", close: mock(() => {}) };
    const unseen = { tag: "b6", close: mock(() => {}) };
    browser.notifications.push(seen, unseen);
    await act(async () => { browser.shown(); await settle(); });
    expect(seen.close).not.toHaveBeenCalled();
    await act(() => FakeEventSource.last.open());
    await emit("state", serverState);
    expect(seen.close).toHaveBeenCalledTimes(1);
    expect(unseen.close).not.toHaveBeenCalled();
    await act(async () => {
      browser.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { open: "/#/b/5" } }));
      await settle();
    });
    expect(seen.close).toHaveBeenCalledTimes(1);
  });

  test("push delivery before its unseen SSE update waits for a fresh snapshot and retains the unread notification", async () => {
    const browser = notificationBrowser([]);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    const notification = { tag: "b5", close: mock(() => {}) };
    browser.notifications.push(notification);
    const old = FakeEventSource.last;
    await act(async () => { browser.shown(); await settle(); });
    expect(old.readyState).toBe(FakeEventSource.CLOSED);
    expect(notification.close).not.toHaveBeenCalled();
    // Another push while the replacement stream is connecting also needs a newer snapshot.
    const connecting = FakeEventSource.last;
    await act(async () => { browser.shown(); await settle(); });
    expect(connecting.readyState).toBe(FakeEventSource.CLOSED);
    await act(() => FakeEventSource.last.open());
    serverState = state([item({ unseen: "done" })], { badge: 1 });
    await emit("state", serverState);
    expect(notification.close).not.toHaveBeenCalled();
    serverState = state([item()]);
    await emit("state", serverState);
    expect(notification.close).toHaveBeenCalledTimes(1);
  });

  test("a notification displayed during enumeration stays unread before its worker message and SSE update arrive", async () => {
    const browser = notificationBrowser([]);
    const notifications = Promise.withResolvers<typeof browser.notifications>();
    browser.getNotifications.mockImplementationOnce(() => notifications.promise);
    const fetchState = spyOn(globalThis, "fetch");
    const timeout = spyOn(AbortSignal, "timeout");
    serverState = state([item()]);
    await act(() => render(<StreamHost />, root));
    const source = FakeEventSource.last;
    await act(() => source.open());
    await emit("state", serverState);
    expect(browser.getNotifications).toHaveBeenCalledTimes(1);
    expect(net.calls).toHaveLength(0);

    serverState = state([item({ unseen: "done" })], { badge: 1 });
    const notification = { tag: "b5", close: mock(() => {}) };
    browser.notifications.push(notification);
    await act(async () => { notifications.resolve(browser.notifications); await settle(); });

    expect(net.calls).toEqual([{ url: "/api/state", method: "GET", body: undefined, headers: {} }]);
    expect(fetchState).toHaveBeenCalledWith("/api/state", {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(FakeEventSource.last).toBe(source);
    expect(snapshot()).toMatchObject({ state: state([item()]), online: true });
    expect(notification.close).not.toHaveBeenCalled();

    await act(async () => { browser.shown(); await settle(); });
    await act(() => FakeEventSource.last.open());
    await emit("state", serverState);
    expect(notification.close).not.toHaveBeenCalled();
    serverState = state([item()]);
    await emit("state", serverState);
    expect(notification.close).toHaveBeenCalledTimes(1);
  });

  test("newer unseen SSE state preserves notifications while an older state request is pending", async () => {
    const browser = notificationBrowser(["b5"]);
    const response = Promise.withResolvers<Response>();
    net.reply = () => response.promise;
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    expect(net.calls).toHaveLength(1);

    // Older HTTP replies must not override the latest unread SSE state.
    net.reply = () => Response.json(state([item()]));
    await emit("state", state([item({ unseen: "blocked" })], { badge: 1 }));
    expect(net.calls).toHaveLength(2);
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
    await act(async () => { response.resolve(Response.json(state([item()]))); await settle(); });
    expect(browser.notifications[0].close).not.toHaveBeenCalled();

    await emit("state", state([item()]));
    expect(browser.notifications[0].close).toHaveBeenCalledTimes(1);
  });

  test.each(["network", "http", "json", "shape", "missing rows", "undercount"] as const)("a failed or inconsistent state request preserves notifications: %s", async (failure) => {
    const browser = notificationBrowser(["b5"]);
    net.reply = () => {
      if (failure === "network") return Promise.reject(new Error("offline"));
      if (failure === "http") return new Response("unavailable", { status: 503 });
      if (failure === "json") return new Response("not json");
      if (failure === "shape") return Response.json({ badge: 0, projects: [{ items: [{ block: "6" }] }] });
      if (failure === "missing rows") return Response.json(state([], { badge: 1 }));
      return Response.json(state([item({ block: "6", unseen: "done" })]));
    };
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    expect(net.calls).toHaveLength(1);
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
    expect(snapshot()).toMatchObject({ state: state([item()]), online: true });

    net.reply = () => Response.json(state([item()]));
    await emit("state", state([item()]));
    expect(browser.notifications[0].close).toHaveBeenCalledTimes(1);
  });

  test.each(["hidden", "disconnected", "unmounted", "reconnected"] as const)("an in-flight state request cannot close notifications after becoming %s", async (lifecycle) => {
    const browser = notificationBrowser(["b5"]);
    const response = Promise.withResolvers<Response>();
    net.reply = () => response.promise;
    await act(() => render(<StreamHost />, root));
    const source = FakeEventSource.last;
    await act(() => source.open());
    await emit("state", state([item()]));
    expect(net.calls).toHaveLength(1);

    if (lifecycle === "hidden") await visibility("hidden");
    else if (lifecycle === "unmounted") await act(() => render(null, root));
    else {
      await act(() => source.fail());
      if (lifecycle === "reconnected") {
        browser.getNotifications.mockResolvedValueOnce([]);
        await act(() => source.open());
        await emit("state", state([item()]));
      }
    }
    await act(async () => { response.resolve(Response.json(state([item()]))); await settle(); });
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
    expect(net.calls).toHaveLength(1);
  });

  test("discovery without numeric session notifications does not request state", async () => {
    const browser = notificationBrowser(["tern", "other", "b", "bfoo", "b-5"]);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    expect(browser.getNotifications).toHaveBeenCalledTimes(1);
    expect(net.calls).toHaveLength(0);
    expect(browser.notifications.every((n) => n.close.mock.calls.length === 0)).toBe(true);
  });

  test("reconnecting cancels an older notification enumeration even after a fresh state arrives", async () => {
    const browser = notificationBrowser(["b5"]);
    const notifications = Promise.withResolvers<typeof browser.notifications>();
    browser.getNotifications.mockImplementationOnce(() => notifications.promise);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    browser.getNotifications.mockResolvedValueOnce([]);
    await act(async () => { browser.shown(); await settle(); });
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    await act(async () => { notifications.resolve(browser.notifications); await settle(); });
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
  });

  test("hidden and disconnected pages wait for fresh visible state, including native reconnects", async () => {
    const browser = notificationBrowser([]);
    await act(() => render(<StreamHost />, root));
    const source = FakeEventSource.last;
    await act(() => source.open());
    await emit("state", state([item()]));
    const notification = { tag: "b5", close: mock(() => {}) };
    browser.notifications.push(notification);
    await visibility("hidden");
    await emit("state", state([item()]));
    await act(async () => { browser.shown(); await settle(); });
    await visibility("visible");
    await act(async () => { browser.shown(); await settle(); });
    await act(() => FakeEventSource.last.open());
    expect(notification.close).not.toHaveBeenCalled();
    await emit("state", state([item({ unseen: "done" })], { badge: 1 }));
    const reconnected = FakeEventSource.last;
    await act(() => reconnected.fail());
    await act(async () => { browser.shown(); await settle(); });
    await act(() => reconnected.open());
    await act(async () => { browser.shown(); await settle(); });
    expect(notification.close).not.toHaveBeenCalled();
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    expect(notification.close).toHaveBeenCalledTimes(1);
  });

  test("returning before the hidden grace expires requests fresh state and dismisses seen notifications", async () => {
    const browser = notificationBrowser([]);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    const first = FakeEventSource.last;
    await visibility("hidden");
    const notification = { tag: "b5", close: mock(() => {}) };
    browser.notifications.push(notification);
    await act(async () => { browser.shown(); await settle(); });
    await advance(1000);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    await visibility("visible");
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(notification.close).not.toHaveBeenCalled();
    await act(() => FakeEventSource.last.open());
    expect(notification.close).not.toHaveBeenCalled();
    await emit("state", state([item()]));
    expect(notification.close).toHaveBeenCalledTimes(1);
  });

  test("async browser lookups use the latest state rather than the state that started them", async () => {
    const browser = notificationBrowser(["b5"]);
    const registration = Promise.withResolvers<{ getNotifications: typeof browser.getNotifications }>();
    browser.getRegistration.mockImplementationOnce(() => registration.promise);
    const notifications = Promise.withResolvers<typeof browser.notifications>();
    browser.getNotifications.mockImplementationOnce(() => notifications.promise);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    await emit("state", state([item({ unseen: "blocked" })], { badge: 1 }));
    await act(async () => {
      registration.resolve({ getNotifications: browser.getNotifications });
      await settle();
      notifications.resolve(browser.notifications);
      await settle();
    });
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
  });

  test.each(["hidden", "disconnected", "unmounted"] as const)("an in-flight notification lookup cannot close after becoming %s", async (lifecycle) => {
    const browser = notificationBrowser(["b5"]);
    const notifications = Promise.withResolvers<typeof browser.notifications>();
    browser.getNotifications.mockImplementationOnce(() => notifications.promise);
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    if (lifecycle === "hidden") await visibility("hidden");
    else if (lifecycle === "disconnected") await act(() => FakeEventSource.last.fail());
    else await act(() => render(null, root));
    await act(async () => { notifications.resolve(browser.notifications); await settle(); });
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
    if (lifecycle === "unmounted") {
      const calls = browser.getRegistration.mock.calls.length;
      browser.shown();
      expect(browser.getRegistration).toHaveBeenCalledTimes(calls);
    }
  });

  test("missing registration and rejected browser APIs do not interrupt stream state", async () => {
    const browser = notificationBrowser(["b5"]);
    browser.getRegistration.mockRejectedValueOnce(new Error("registration unavailable"));
    await act(() => render(<StreamHost />, root));
    await act(() => FakeEventSource.last.open());
    await emit("state", state([item()]));
    browser.getNotifications.mockRejectedValueOnce(new Error("notifications unavailable"));
    await emit("state", state([item()]));
    browser.getRegistration.mockResolvedValueOnce(undefined);
    await emit("state", state([item()]));
    expect(snapshot()).toMatchObject({ state: state([item()]), online: true });
    expect(browser.notifications[0].close).not.toHaveBeenCalled();
  });
});

describe("useStream", () => {
  test("server events update the rendered state, connection status and app badge", async () => {
    const badge = mock(async (_count: number) => {});
    const clear = mock(async () => {});
    property(navigator, "setAppBadge", badge);
    property(navigator, "clearAppBadge", clear);
    await act(() => render(<StreamHost block="5" />, root));
    expect(snapshot()).toEqual({ state: null, chat: null, subagents: null, live: null, queued: [], run: null, context: null, btw: null, screen: null, draft: null, doc: null, online: false, stretch: null, voice: null });
    await act(() => FakeEventSource.last.open());
    expect(snapshot()).toMatchObject({ online: true });
    const current = state([item()], { badge: 2 });
    await emit("state", current);
    expect(snapshot()).toMatchObject({ state: current });
    expect(badge.mock.calls).toEqual([[2]]);
    await emit("state", { ...current, badge: 0 });
    expect(clear).toHaveBeenCalledTimes(1);
    badge.mockRejectedValueOnce(new Error("badge unavailable"));
    await emit("state", current);
    expect(snapshot()).toMatchObject({ state: current });

    const entries: ChatEntry[] = [{ role: "assistant", text: "Saved answer", ts: 1 }];
    const doc: Doc = { text: "# Notes", markdown: true, missing: false, clipped: true };
    const subagents: Subagent[] = [{ name: "Reviewer", started: 1, lastActivity: 2, running: true, summary: "Checking", messages: 3 }];
    await emit("chat", { entries });
    await emit("screen", { text: "<pre>shell</pre>", html: true });
    await emit("draft", { text: "Not sent", live: true });
    await emit("doc", doc);
    await emit("subagents", subagents);
    await emit("stretch", { off: false, open: { "1.0": ["cache"] } });
    const context = { tokens: 1000, window: 200000, percent: 1, compactAt: 80 };
    await emit("context", context);
    expect(snapshot()).toMatchObject({ chat: entries, screen: { text: "<pre>shell</pre>", html: true }, draft: { text: "Not sent", live: true }, doc, subagents, stretch: { off: false, open: { "1.0": ["cache"] } }, context });
    await emit("chat", null);
    expect(snapshot()).toMatchObject({ chat: [] });
    await act(() => FakeEventSource.last.fail());
    expect(snapshot()).toMatchObject({ online: false });
    await act(() => FakeEventSource.last.open());
    expect(snapshot()).toMatchObject({ online: true });
  });

  test("a patch updates changed rows and the order; one the page can't apply reconnects for a full list", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    const a = item({ block: "1", title: "A" });
    const b = item({ block: "2", title: "B" });
    await emit("state", state([a, b]));
    const { projects, ...rest } = state([a, b], { badge: 1 });
    const renamed = { ...b, title: "B2" };
    await emit("patch", { ...rest, order: [[projects[0].name, ["2", "1"]]], changed: [renamed] });
    expect(snapshot()).toMatchObject({ state: { badge: 1, projects: [{ name: projects[0].name, items: [renamed, a] }] } });
    const before = FakeEventSource.all.length;
    await emit("patch", { ...rest, order: [[projects[0].name, ["9"]]], changed: [] });
    expect(FakeEventSource.all.length).toBe(before + 1);
    expect(FakeEventSource.all.at(-2)!.readyState).toBe(FakeEventSource.CLOSED);
  });

  test("live text stays until the finished transcript arrives, but not for an unrelated chat update", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    await emit("state", state([]));
    await emit("live", { text: "First", done: false });
    await emit("live", { text: "First and second", done: false });
    await emit("chat", { entries: [] });
    expect(snapshot()).toMatchObject({ live: "First and second", chat: [] });
    await emit("live", { text: "", done: true });
    expect(snapshot()).toMatchObject({ live: "First and second" });
    const entries: ChatEntry[] = [{ role: "assistant", text: "First and second", ts: 2 }];
    await emit("chat", { entries });
    expect(snapshot()).toMatchObject({ live: null, chat: entries });
  });

  test("finished live text expires after three seconds and a new turn cancels the old expiry", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    await emit("live", { text: "Not yet saved", done: false });
    await emit("live", { text: "", done: true });
    await advance(2999);
    expect(snapshot()).toMatchObject({ live: "Not yet saved" });
    await advance(1);
    expect(snapshot()).toMatchObject({ live: null });
    await emit("live", { text: "Previous turn", done: false });
    await emit("live", { text: "", done: true });
    await advance(1000);
    await emit("live", { text: "Next turn", done: false });
    await advance(3000);
    await emit("chat", { entries: [] });
    expect(snapshot()).toMatchObject({ live: "Next turn" });
  });

  test("native reconnect discards live text and queued prompts completed while disconnected", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    const source = FakeEventSource.last;
    await act(() => source.open());
    await emit("live", { text: "Unfinished before disconnect", done: false });
    await emit("queued", [{ text: "Processed while offline", followUp: true }]);
    await act(() => { source.fail(); source.open(); });
    const entries: ChatEntry[] = [{ role: "assistant", text: "Finished while offline", ts: 2 }];
    await emit("chat", { entries });
    expect(FakeEventSource.all).toHaveLength(1);
    expect(snapshot()).toMatchObject({ online: true, chat: entries, live: null, queued: [] });
  });

  test("native reconnect cancels the previous live expiry before a fresh snapshot arrives", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    await act(() => FakeEventSource.last.open());
    await emit("live", { text: "Old answer", done: false });
    await emit("live", { text: "", done: true });
    expect(jest.getTimerCount()).toBe(1);
    await act(() => { FakeEventSource.last.fail(); FakeEventSource.last.open(); });
    expect(jest.getTimerCount()).toBe(0);
    await emit("live", { text: "Current answer", done: false });
    await emit("queued", [{ text: "Current prompt", followUp: false }]);
    await emit("chat", { entries: [] });
    await advance(3000);
    expect(snapshot()).toMatchObject({ live: "Current answer", queued: [{ text: "Current prompt", followUp: false }] });
  });

  test("queued prompts replace the queue and only the active side question receives its answer", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    const queued = [{ text: "Steer", followUp: false }, { text: "Then this", followUp: true }];
    await emit("queued", queued);
    expect(snapshot()).toMatchObject({ queued });
    await emit("queued", []);
    await emit("btw", { id: "question-1", text: "Too early", done: false, error: "" });
    expect(snapshot()).toMatchObject({ queued: [], btw: null });
    await click("Ask");
    await emit("btw", { id: "other", text: "Wrong answer", done: true, error: "" });
    expect(snapshot()).toMatchObject({ btw: question });
    await emit("btw", { id: question.id, text: "Because it fixes login", done: false, error: "" });
    expect(snapshot()).toMatchObject({ btw: { ...question, text: "Because it fixes login" } });
    await emit("btw", { id: question.id, text: "Partial answer", done: true, error: "Cancelled" });
    expect(snapshot()).toMatchObject({ btw: { ...question, text: "Partial answer", done: true, error: "Cancelled" } });
    await click("Dismiss");
    await emit("btw", { id: question.id, text: "Late answer", done: true, error: "" });
    expect(snapshot()).toMatchObject({ btw: null });
  });

  test("route changes close the old stream, reset route content and select each URL variant", async () => {
    await act(() => render(<StreamHost />, root));
    expect(FakeEventSource.last.url).toBe("/api/stream");
    await act(() => render(<StreamHost block="5" />, root));
    expect(FakeEventSource.all[0]?.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=chat");
    await emit("chat", { entries: [{ role: "assistant", text: "Old chat", ts: 1 }] });
    await emit("screen", { text: "Old screen", html: false });
    await emit("subagents", [{ name: "Old" }]);
    await emit("live", { text: "Old live", done: false });
    await emit("queued", [{ text: "Old queue", followUp: true }]);
    const old = FakeEventSource.last;
    await act(() => render(<StreamHost block="6" view="screen" />, root));
    expect(old.readyState).toBe(FakeEventSource.CLOSED);
    expect(snapshot()).toMatchObject({ chat: null, screen: null, subagents: null, live: null, queued: [] });
    expect(FakeEventSource.last.url).toBe("/api/stream?block=6&view=screen");
    await act(() => render(<StreamHost block="6" view="subagents" />, root));
    expect(FakeEventSource.last.url).toBe("/api/stream?block=6&view=subagents");
    await act(() => render(<StreamHost block="6" sub="review & check/one" />, root));
    expect(FakeEventSource.last.url).toBe("/api/stream?block=6&view=chat&sub=review%20%26%20check%2Fone");
  });

  test("quick switches refresh the stream; a hidden grace closes it and reopening discards stale live and queue", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    const first = FakeEventSource.last;
    await act(() => first.open());
    await visibility("hidden");
    await advance(9999);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    await visibility("visible");
    await advance(1);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    const second = FakeEventSource.last;
    await act(() => second.open());
    await emit("live", { text: "Stale", done: false });
    await emit("queued", [{ text: "Stale prompt", followUp: false }]);
    await visibility("hidden");
    await advance(10_000);
    expect(second.readyState).toBe(FakeEventSource.CLOSED);
    expect(snapshot()).toMatchObject({ online: false });
    await visibility("visible");
    expect(FakeEventSource.all).toHaveLength(3);
    expect(FakeEventSource.last.url).toBe(first.url);
    expect(snapshot()).toMatchObject({ live: null, queued: [] });
    await act(() => FakeEventSource.last.open());
    expect(snapshot()).toMatchObject({ online: true });
    FakeEventSource.last.close();
    await visibility("visible");
    expect(FakeEventSource.all).toHaveLength(4);
  });

  test("an HTTP error that closes the stream reopens it with a growing delay", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    const first = FakeEventSource.last;
    // A 502 while the server restarts: EventSource gives up and won't retry by itself.
    first.close();
    await act(() => first.fail());
    expect(snapshot()).toMatchObject({ online: false });
    await advance(999);
    expect(FakeEventSource.all).toHaveLength(1);
    await advance(1);
    expect(FakeEventSource.all).toHaveLength(2);
    FakeEventSource.last.close();
    await act(() => FakeEventSource.last.fail());
    await advance(1999);
    expect(FakeEventSource.all).toHaveLength(2);
    await advance(1);
    expect(FakeEventSource.all).toHaveLength(3);
    await act(() => FakeEventSource.last.open());
    expect(snapshot()).toMatchObject({ online: true });
  });

  test("initially hidden mounting waits for visibility and unmount clears timers and listeners", async () => {
    await visibility("hidden");
    await act(() => render(<StreamHost block="5" />, root));
    expect(FakeEventSource.all).toHaveLength(0);
    await visibility("visible");
    const source = FakeEventSource.last;
    await emit("live", { text: "Finishing", done: false });
    await emit("live", { text: "", done: true });
    await visibility("hidden");
    expect(jest.getTimerCount()).toBe(2);
    await act(() => render(null, root));
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(jest.getTimerCount()).toBe(0);
    await advance(10_000);
    await visibility("visible");
    expect(FakeEventSource.all).toHaveLength(1);
  });
});

function RouteHost() {
  const route = useRoute();
  return <><pre>{JSON.stringify(route)}</pre><button onClick={() => goBack(route)}>Back</button></>;
}
async function navigate(hash: string) {
  const oldURL = location.href;
  history.replaceState(null, "", hash);
  await act(() => { dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: location.href })); });
}

test("route changes track the entry screen, Back pops it, and deep links replace instead of stacking", async () => {
  await act(() => render(<RouteHost />, root));
  expect(snapshot()).toEqual({ view: "list" });
  await navigate("#/b/5");
  expect(snapshot()).toEqual({ view: "session", block: "5" });
  expect(origins.get("#/b/5")).toBe("#/");
  const back = spyOn(history, "back").mockImplementation(() => {});
  await click("Back");
  expect(back).toHaveBeenCalledTimes(1);
  await navigate("#/b/5/sub/Reviewer");
  expect(snapshot()).toEqual({ view: "subagent", block: "5", name: "Reviewer" });
  origins.clear();
  const replace = spyOn(location, "replace").mockImplementation(() => {});
  await click("Back");
  expect(replace).toHaveBeenCalledWith("#/b/5");
  await navigate("#/not-a-route");
  expect(snapshot()).toEqual({ view: "list" });
  const remove = spyOn(globalThis, "removeEventListener");
  await act(() => render(null, root));
  expect(remove.mock.calls.some(([type]) => type === "hashchange")).toBe(true);
});

test("wide layout follows media-query changes and removes its listener on unmount", async () => {
  const media = new EventTarget();
  let matches = false;
  Object.defineProperty(media, "matches", { get: () => matches });
  const match = mock((_query: string) => media);
  property(globalThis, "matchMedia", match);
  const remove = spyOn(media, "removeEventListener");
  function WideHost() { return <output>{useWide() ? "wide" : "narrow"}</output>; }
  await act(() => render(<WideHost />, root));
  expect(root.textContent).toBe("narrow");
  expect(match.mock.calls).toEqual([["(min-width: 1000px)"], ["(min-width: 1000px)"]]);
  matches = true;
  await act(() => { media.dispatchEvent(new Event("change")); });
  expect(root.textContent).toBe("wide");
  matches = false;
  await act(() => { media.dispatchEvent(new Event("change")); });
  expect(root.textContent).toBe("narrow");
  await act(() => render(null, root));
  expect(remove.mock.calls[0]?.[0]).toBe("change");
});

test("clock ticks at its interval, reschedules when changed and stops on unmount", async () => {
  function Clock({ interval }: { interval: number }) { return <output>{useNow(interval)}</output>; }
  const start = Date.now();
  await act(() => render(<Clock interval={1000} />, root));
  expect(root.textContent).toBe(String(start));
  await advance(999);
  expect(root.textContent).toBe(String(start));
  await advance(1);
  expect(root.textContent).toBe(String(Date.now()));
  expect(root.textContent).not.toBe(String(start));
  await act(() => render(<Clock interval={200} />, root));
  expect(jest.getTimerCount()).toBe(1);
  await advance(200);
  expect(root.textContent).toBe(String(Date.now()));
  await act(() => render(null, root));
  expect(jest.getTimerCount()).toBe(0);
});

function LockHost({ on }: { on: boolean }) {
  useWakeLock(on);
  return null;
}
test("wake lock: held while on, taken again after the page returns, released when off", async () => {
  const locks: { released: boolean; release: () => Promise<void> }[] = [];
  const request = mock(async () => {
    const lock = { released: false, release: async () => { lock.released = true; } };
    locks.push(lock);
    return lock;
  });
  property(navigator, "wakeLock", { request });
  await act(() => render(<LockHost on={false} />, root));
  expect(request).not.toHaveBeenCalled();
  await act(async () => { render(<LockHost on />, root); await settle(); });
  expect(request).toHaveBeenCalledTimes(1);
  // The browser drops the lock while hidden; a held lock is not asked for twice.
  await visibility("hidden");
  locks[0].released = true;
  await act(async () => { await visibility("visible"); await settle(); });
  await act(async () => { await visibility("visible"); await settle(); });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { render(<LockHost on={false} />, root); await settle(); });
  expect(locks[1].released).toBe(true);
  await visibility("visible");
  expect(request).toHaveBeenCalledTimes(2);
});

function ExitHost({ enabled = true }: { enabled?: boolean }) {
  return <output>{useExitGuard(enabled) ? "Back again to exit" : "No hint"}</output>;
}
async function pop(guard = false) {
  history.replaceState(guard ? { guard: true } : null, "");
  await act(() => { dispatchEvent(new PopStateEvent("popstate")); });
}

describe("exit guard", () => {
  test("first back arms a hint and second back within the window leaves", async () => {
    const push = spyOn(history, "pushState");
    const back = spyOn(history, "back").mockImplementation(() => {});
    await act(() => render(<ExitHost />, root));
    expect(history.state).toEqual({ guard: true });
    expect(push).toHaveBeenCalledTimes(1);
    await pop(true);
    expect(root.textContent).toBe("No hint");
    await pop();
    expect(root.textContent).toBe("Back again to exit");
    expect(history.state).toEqual({ guard: true });
    await advance(1999);
    await pop();
    expect(back).toHaveBeenCalledTimes(1);
  });

  test("expired hint requires a fresh first back, and disabling cancels listeners and timers", async () => {
    const back = spyOn(history, "back").mockImplementation(() => {});
    await act(() => render(<ExitHost />, root));
    await pop();
    await advance(2000);
    expect(root.textContent).toBe("No hint");
    await pop();
    expect(root.textContent).toBe("Back again to exit");
    expect(back).not.toHaveBeenCalled();
    await act(() => render(<ExitHost enabled={false} />, root));
    expect(jest.getTimerCount()).toBe(0);
    await pop();
    expect(history.state).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });

  test("disabled and non-list routes do not guard pops, and an existing guard is not pushed twice", async () => {
    const push = spyOn(history, "pushState");
    await act(() => render(<ExitHost enabled={false} />, root));
    expect(history.state).toBeNull();
    await pop();
    expect(push).not.toHaveBeenCalled();
    history.replaceState({ guard: true }, "", "#/b/5");
    await act(() => render(<ExitHost />, root));
    expect(push).not.toHaveBeenCalled();
    await pop();
    expect(root.textContent).toBe("No hint");
    expect(push).not.toHaveBeenCalled();
  });
});
