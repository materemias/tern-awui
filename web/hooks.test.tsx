import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Btw, ChatEntry, Doc, Subagent } from "./api";
import type { View } from "./hooks";
import { FakeEventSource, item, settle, state } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Static imports would bind Preact to the environment before the DOM is registered.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { goBack, origins, useExitGuard, useNow, useRoute, useStream, useWide } = await import("./hooks");

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

describe("useStream", () => {
  test("server events update the rendered state, connection status and app badge", async () => {
    const badge = mock(async (_count: number) => {});
    const clear = mock(async () => {});
    property(navigator, "setAppBadge", badge);
    property(navigator, "clearAppBadge", clear);
    await act(() => render(<StreamHost block="5" />, root));
    expect(snapshot()).toEqual({ state: null, chat: null, subagents: null, live: null, queued: [], btw: null, screen: null, draft: null, doc: null, online: false });
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
    expect(snapshot()).toMatchObject({ chat: entries, screen: { text: "<pre>shell</pre>", html: true }, draft: { text: "Not sent", live: true }, doc, subagents });
    await emit("chat", null);
    expect(snapshot()).toMatchObject({ chat: [] });
    await act(() => FakeEventSource.last.fail());
    expect(snapshot()).toMatchObject({ online: false });
    await act(() => FakeEventSource.last.open());
    expect(snapshot()).toMatchObject({ online: true });
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

  test("quick switches retain the stream; a hidden grace closes it and reopening discards stale live and queue", async () => {
    await act(() => render(<StreamHost block="5" />, root));
    const first = FakeEventSource.last;
    await act(() => first.open());
    await visibility("hidden");
    await advance(9999);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    await visibility("visible");
    await advance(1);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(first.readyState).toBe(FakeEventSource.OPEN);
    await emit("live", { text: "Stale", done: false });
    await emit("queued", [{ text: "Stale prompt", followUp: false }]);
    await visibility("hidden");
    await advance(10_000);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(snapshot()).toMatchObject({ online: false });
    await visibility("visible");
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.last.url).toBe(first.url);
    expect(snapshot()).toMatchObject({ live: null, queued: [] });
    await act(() => FakeEventSource.last.open());
    expect(snapshot()).toMatchObject({ online: true });
    FakeEventSource.last.close();
    await visibility("visible");
    expect(FakeEventSource.all).toHaveLength(3);
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
