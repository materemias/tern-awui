import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Item } from "./api";
import { FakeEventSource, Net, item, live, settle, specDom, state } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
const restoreDom = specDom();
afterAll(async () => {
  restoreDom();
  await GlobalRegistrator.unregister();
});
// Preact and DOMPurify must bind to the DOM installed above, not the environment before it.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { Session, SubagentScreen } = await import("./session");
const { origins, useRoute } = await import("./hooks");

const net = new Net();
const originalSource = globalThis.EventSource;
let root: HTMLElement;
let confirmed = true;
const alerts: string[] = [];
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  origins.clear();
  FakeEventSource.all = [];
  // Only the EventSource surface the stream hook uses is needed in this browser double.
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  net.install();
  alerts.length = 0;
  confirmed = true;
  window.confirm = () => confirmed;
  window.alert = (message) => alerts.push(String(message));
  history.replaceState(null, "", "#/b/5");
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
  globalThis.EventSource = originalSource;
});

const click = async (selector: string) => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  await act(async () => {
    el.click();
    await settle();
  });
};
async function emit(type: string, data: unknown) {
  await act(() => FakeEventSource.last.emit(type, data));
}
async function open(row?: Item) {
  await act(() => render(<Session block="5" />, root));
  if (row) await emit("state", state([row]));
}

test("session header, transcript, live text and queued steer/follow-up marks", async () => {
  await open(item({ tag: "APP", branch: "fix", status: "working", since: Date.now() - 20_000 }));
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=chat");
  expect(root.querySelector(".session-title .title")!.textContent).toBe("Fix login");
  expect(root.querySelector(".branch")!.textContent).toContain("fix");
  expect(root.querySelector(".row-meta")!.textContent).toContain("offline");
  await act(() => FakeEventSource.last.open());
  expect(root.querySelector(".row-meta")!.textContent).not.toContain("offline");
  await emit("chat", { entries: [{ role: "assistant", text: "Earlier answer", ts: 1 }] });
  await emit("live", { text: "**Writing now**", done: false });
  await emit("queued", [{ text: "steer this", followUp: false }, { text: "next turn", followUp: true }]);
  expect(root.querySelector(".live strong")!.textContent).toBe("Writing now");
  expect([...root.querySelectorAll(".queued-mark")].map((e) => e.textContent)).toEqual(["↳", "→"]);
  expect([...root.querySelectorAll(".queued")].map((e) => e.getAttribute("title"))).toEqual(["Steers the running turn", "Sent once the running turn ends"]);
  expect(root.querySelector(".working")!.textContent).toMatch(/^working · \d+s$/);
  await emit("live", { text: "Writing now", done: true });
  expect(root.querySelector(".live")).not.toBeNull();
  await emit("chat", { entries: [{ role: "assistant", text: "Writing now", ts: 2 }] });
  expect(root.querySelector(".live")).toBeNull();
  expect(root.querySelectorAll(".msg.assistant").length).toBe(1);
});

test("unknown block loads, then reports it disappeared", async () => {
  await open();
  expect(root.querySelector(".row-title")!.textContent).toBe("5");
  expect(root.querySelector(".empty")!.textContent).toBe("Loading…");
  await emit("state", state([]));
  expect(root.textContent).toContain("This block is gone.");
});

test("a note has no composer and shows loading, markdown, plain text, clipping and missing states", async () => {
  await open(item({ agent: null, live: null, status: null, doc: "/w/.local/state/tern/notes/note.md" }));
  expect(root.querySelector("textarea")).toBeNull();
  expect(root.querySelector(".row-meta")!.textContent).toContain("note");
  expect(root.querySelector(".empty")!.textContent).toBe("Loading…");
  await emit("doc", { text: "# Notes", markdown: true, missing: false, clipped: true });
  expect(root.querySelector(".doc h1")!.textContent).toBe("Notes");
  expect(root.textContent).toContain("Showing the first 512 KB.");
  await emit("doc", { text: "literal <tag>", markdown: false, missing: false, clipped: false });
  expect(root.querySelector("pre.term")!.textContent).toBe("literal <tag>");
  expect(root.querySelector("pre.term tag")).toBeNull();
  expect(root.textContent).not.toContain("Showing the first");
  await emit("doc", { text: "", markdown: false, missing: true, clipped: false });
  expect(root.querySelector(".empty")!.textContent).toBe("The file is gone.");
});

/** Lets the highlighter's lazy import resolve and its result render. */
const highlighted = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

test("an opened file is colored by its extension, as are fences in an opened markdown file", async () => {
  await open(item({ agent: null, live: null, status: null, doc: "/w/src/app.ts" }));
  await emit("doc", { text: "const a = 1; // <x>", markdown: false, missing: false, clipped: false });
  await highlighted();
  expect(root.querySelector("pre.term .hljs-keyword")!.textContent).toBe("const");
  expect(root.querySelector("pre.term .hljs-comment")!.textContent).toBe("// <x>");
  expect(root.querySelector("pre.term")!.textContent).toBe("const a = 1; // <x>");
  // An unknown extension stays plain.
  await emit("state", state([item({ agent: null, live: null, status: null, doc: "/w/notes.xyz" })]));
  await emit("doc", { text: "const b", markdown: false, missing: false, clipped: false });
  await highlighted();
  expect(root.querySelector("pre.term")!.textContent).toBe("const b");
  expect(root.querySelector("pre.term span")).toBeNull();
  await emit("doc", { text: "```py\ndef f(): pass\n```\n\n```nolang\ndef g\n```", markdown: true, missing: false, clipped: false });
  await highlighted();
  const [py, unknown] = root.querySelectorAll(".doc pre code");
  expect(py.querySelector(".hljs-keyword")!.textContent).toBe("def");
  expect(unknown.querySelector("span")).toBeNull();
});

test("shell screen supports plain and sanitized colored capture", async () => {
  await open(item({ agent: null, live: null, status: null }));
  await emit("screen", { text: "prompt $", html: false });
  expect(root.querySelector("pre.term")!.textContent).toBe("prompt $");
  expect(root.querySelector(".row-meta")!.textContent).toContain("shell");
  await emit("screen", { text: '<pre><span style="color:red">red</span><a href="/bad">no link</a><script>alert(1)</script></pre>', html: true });
  expect(root.querySelector(".term span")!.getAttribute("style")).toBe("color:red");
  expect(root.querySelector(".term a, .term script")).toBeNull();
});

test("Raw switches the stream, and its banner returns to chat", async () => {
  await open(item());
  const initial = FakeEventSource.last;
  await click('[aria-label="Keys"]');
  const raw = [...root.querySelectorAll<HTMLButtonElement>(".keys button")].find((b) => b.textContent === "Raw")!;
  await act(() => raw.click());
  expect(initial.readyState).toBe(FakeEventSource.CLOSED);
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=screen");
  expect(root.querySelector(".raw-note")!.textContent).toContain("back to chat");
  await emit("screen", { text: "raw capture", html: false });
  expect(root.querySelector(".term")!.textContent).toBe("raw capture");
  await click(".raw-note");
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=chat");
});

test("focus posts the pane action; cancel close does nothing and failed close reports the reason", async () => {
  await open(item({ status: "working", tag: "APP" }));
  await click('[title="Show this pane on the desktop"]');
  expect(net.to("/api/blocks/5/focus")).toEqual([{}]);
  confirmed = false;
  await click('[aria-label="Close this block"]');
  expect(net.to("/api/blocks/5/close")).toEqual([]);
  const prompts: string[] = [];
  window.confirm = (message) => { prompts.push(String(message)); return true; };
  net.reply = () => Response.json({ error: "pane is busy" }, { status: 409 });
  await click('[aria-label="Close this block"]');
  expect(prompts[0]).toContain("APP: Fix login");
  expect(prompts[0]).toContain("running turn stops");
  expect(alerts).toEqual(["Close failed: pane is busy"]);
  expect(location.hash).toBe("#/b/5");
});

test("closing a waiting block warns and returns to the list on success", async () => {
  await open(item({ status: "blocked" }));
  const prompts: string[] = [];
  window.confirm = (message) => { prompts.push(String(message)); return true; };
  await click('[aria-label="Close this block"]');
  expect(prompts[0]).toContain("waiting on you");
  expect(net.to("/api/blocks/5/close")).toEqual([{}]);
  expect(location.hash).toBe("#/");
});

test("a delayed close reply does not leave a different session opened in the meantime", async () => {
  await open(item());
  const pending = Promise.withResolvers<Response>();
  net.reply = () => pending.promise;
  await click('[aria-label="Close this block"]');
  expect(net.to("/api/blocks/5/close")).toEqual([{}]);
  history.replaceState(null, "", "#/b/6");
  await act(() => render(<Session key="6" block="6" />, root));
  await emit("state", state([item({ block: "6", title: "Second session" })]));
  await act(async () => { pending.resolve(Response.json({ ok: true })); await settle(); });
  expect(location.hash).toBe("#/b/6");
  expect(root.querySelector(".session-title .title")?.textContent).toBe("Second session");
  expect(alerts).toEqual([]);
});

test("back leaves the session and the jobs strip links its running subagents", async () => {
  await open(item({ live: live({ jobs: [{ id: "j1", type: "task", agent: "Fixer", label: "fixing", since: Date.now() }] }) }));
  expect(root.querySelector("a.job")!.getAttribute("href")).toBe("#/b/5/sub/Fixer");
  await click("a.back");
  expect(location.hash).toBe("#/");
});

test("scrolling away preserves position when a transcript update arrives", async () => {
  await open(item());
  await emit("chat", { entries: [] });
  const scroll = root.querySelector<HTMLElement>(".scroll")!;
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  scroll.scrollTop = 100;
  await act(() => void scroll.dispatchEvent(new Event("scroll")));
  await emit("chat", { entries: [{ role: "assistant", text: "do not jump", ts: 1 }] });
  expect(scroll.scrollTop).toBe(100);
  scroll.scrollTop = 790;
  await act(() => void scroll.dispatchEvent(new Event("scroll")));
  await emit("chat", { entries: [{ role: "assistant", text: "keep bottom pinned", ts: 2 }] });
  expect(scroll.scrollTop).toBe(1000);
});

test("subagent list and read-only transcript subscribe to their distinct streams", async () => {
  await act(() => render(<SubagentScreen route={{ view: "subagents", block: "5" }} />, root));
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=subagents");
  await emit("state", state([item()]));
  await emit("subagents", [{ name: "Fixer", started: 1, lastActivity: 2, running: false, summary: "fixed", messages: 2 }]);
  expect(root.querySelector('a[href="#/b/5/sub/Fixer"]')!.textContent).toContain("fixed");
  history.replaceState(null, "", "#/b/5/sub/Fixer");
  await act(() => render(<SubagentScreen route={{ view: "subagent", block: "5", name: "Fixer" }} />, root));
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=chat&sub=Fixer");
  await emit("chat", { entries: [{ role: "user", id: "u1", text: "fix this", images: [], ts: 1 }] });
  expect(root.querySelector(".user-text p")!.textContent).toBe("fix this");
  expect(root.querySelector("textarea, .user-acts")).toBeNull();
  await click("a.back");
  // No list-to-chat navigation happened: a deep link returns to its parent session.
  expect(location.hash).toBe("#/b/5");
});

test("a child opened from the subagent list returns there through real hash navigation", async () => {
  function RoutedSubagent() {
    const route = useRoute();
    return route.view === "subagent" || route.view === "subagents" ? <SubagentScreen route={route} /> : <div>Outside subagents</div>;
  }
  async function follow(selector: string) {
    const { promise, resolve } = Promise.withResolvers<void>();
    addEventListener("hashchange", () => resolve(), { once: true });
    await click(selector);
    await act(() => promise);
  }
  history.replaceState(null, "", "#/b/5/sub");
  await act(() => render(<RoutedSubagent />, root));
  await emit("state", state([item()]));
  await emit("subagents", [{ name: "Fixer", started: 1, lastActivity: 2, running: false, summary: "fixed", messages: 2 }]);
  await follow('a[href="#/b/5/sub/Fixer"]');
  expect(location.hash).toBe("#/b/5/sub/Fixer");
  expect(origins.get("#/b/5/sub/Fixer")).toBe("#/b/5/sub");
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=chat&sub=Fixer");
  await follow("a.back");
  expect(location.hash).toBe("#/b/5/sub");
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=subagents");
});

test("stretches: the pane's open ones show; once the pane stops reporting them they close, but local taps stay", async () => {
  await open(item());
  const reply = { role: "assistant", text: "A {{b|b long}} c.", block: "9.0", ts: 1 };
  await emit("chat", { entries: [reply] });
  const closes = () => root.querySelectorAll("a[href^='#stretch/close/']").length;
  await emit("stretch", { off: false, open: { "9.0": ["b"] } });
  expect(closes()).toBe(1);
  // Reconnected after omp restarted without stretch.ts: the server's snapshot is null.
  await emit("stretch", null);
  expect(closes()).toBe(0);
  // With no pane state, a tap opens it on this page only.
  await click("a[href='#stretch/open/0']");
  expect(closes()).toBe(1);
  await emit("stretch", null);
  expect(closes()).toBe(1);
  expect(net.calls.filter((c) => c.url.endsWith("/stretch"))).toEqual([]);
});
