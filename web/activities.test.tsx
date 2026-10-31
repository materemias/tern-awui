import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ChatEntry, Item, Job } from "./api";
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
const { Session } = await import("./session");

const net = new Net();
const originalSource = globalThis.EventSource;
const originalMedia = window.matchMedia;
let root: HTMLElement;
let wide = false;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  localStorage.clear();
  FakeEventSource.all = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  net.install();
  wide = false;
  window.matchMedia = ((query: string) =>
    ({ matches: wide && query === "(min-width: 1000px)", addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList) as typeof matchMedia;
  history.replaceState(null, "", "#/b/5");
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
  globalThis.EventSource = originalSource;
  window.matchMedia = originalMedia;
});

const NOW = Date.now();
const job = (agent: string, type = "task"): Job => ({ id: `j-${agent || type}`, type, label: "", agent, since: NOW - 42_000 });
const todo = (current: string): ChatEntry => ({
  role: "tools",
  calls: [{ name: "todo", intent: "Updating todos" }],
  images: [],
  todo: [{ name: "Work", tasks: [{ content: "Done one", status: "completed" }, { content: current, status: "in_progress" }] }],
  ts: 1,
});
const said = (text: string): ChatEntry => ({ role: "assistant", text, ts: 2 });
const busyItem = (jobs: Job[], subagents: number): Item =>
  item({ status: "working", live: live({ jobs }), agent: { sessionId: "s", lastPrompt: "", recap: "", recapStale: false, lastActivity: 0, subagents } });

async function open(row: Item, entries: ChatEntry[] = []) {
  await act(() => render(<Session block="5" />, root));
  await act(() => FakeEventSource.last.emit("state", state([row])));
  await act(() => FakeEventSource.last.emit("chat", { entries }));
}
const button = () => root.querySelector<HTMLButtonElement>('.session-bar button[aria-label="Activities"]');
const panel = () => root.querySelector(".acts");
const click = async (el: Element | null) => {
  if (!el) throw new Error("missing element");
  await act(async () => {
    (el as HTMLElement).click();
    await settle();
  });
};

test("the header's Activities button shows only for an omp session with something going on", async () => {
  await open(item(), [said("hi")]);
  expect(button()).toBeNull();
  await act(() => FakeEventSource.last.emit("chat", { entries: [said("hi"), todo("Step")] }));
  expect(button()).not.toBeNull();
  // It sits before the monitor button and counts nothing while no job runs.
  expect(button()!.nextElementSibling!.getAttribute("aria-label")).toBe("Show this pane on the desktop");
  expect(button()!.querySelector(".acts-count")).toBeNull();
  await act(() => FakeEventSource.last.emit("state", state([busyItem([job("ViewA"), job("", "bash")], 0)])));
  expect(button()!.querySelector(".acts-count")!.textContent).toBe("2");
  await act(() => FakeEventSource.last.emit("state", state([item({ agent: null, live: null })])));
  expect(button()).toBeNull();
});

test("the panel shows the newest todo list, the running jobs and the subagent list; × closes it", async () => {
  await open(busyItem([job("ViewA"), job("", "bash")], 3), [todo("Old step"), said("next"), todo("New step")]);
  expect(panel()).toBeNull();
  expect(button()!.getAttribute("aria-expanded")).toBe("false");
  await click(button());
  expect(button()!.getAttribute("aria-expanded")).toBe("true");
  expect([...panel()!.querySelectorAll(".acts-label")].map((e) => e.textContent)).toEqual(["Todo", "Running"]);
  expect(panel()!.querySelectorAll(".todo").length).toBe(1);
  expect(panel()!.querySelector(".todo-current")!.textContent).toBe("New step");
  expect([...panel()!.querySelectorAll(".todo-task")].map((e) => e.textContent)).toEqual(["✓Done one", "▸New step"]);
  expect([...panel()!.querySelectorAll("a.job")].map((e) => e.getAttribute("href"))).toEqual(["#/b/5/sub/ViewA"]);
  expect([...panel()!.querySelectorAll("div.job .job-name")].map((e) => e.textContent)).toEqual(["j-bash"]);
  expect(panel()!.querySelector(".job-age")!.textContent).toBe("42s");
  expect(panel()!.querySelector(".subagents-link")!.getAttribute("href")).toBe("#/b/5/sub");
  expect(panel()!.querySelector(".subagents-link")!.textContent).toContain("Subagents (3)");
  // The strip under the transcript stays as it was.
  expect(root.querySelector(".scroll .jobs a.job")!.getAttribute("href")).toBe("#/b/5/sub/ViewA");
  await click(panel()!.querySelector('[aria-label="Close activities"]'));
  expect(panel()).toBeNull();
  expect(button()!.getAttribute("aria-expanded")).toBe("false");
});

test("Subagents (N) shows with no running job; on a phone, a followed link, the backdrop and Escape close the panel", async () => {
  await open(busyItem([], 2));
  expect(root.querySelector(".scroll .subagents-link")).toBeNull();
  await click(button());
  expect(panel()!.classList.contains("overlay")).toBe(true);
  expect(panel()!.querySelector(".acts-label")).toBeNull();
  expect(panel()!.querySelector(".subagents-link")!.textContent).toContain("Subagents (2)");
  await click(panel()!.querySelector(".subagents-link"));
  expect(panel()).toBeNull();
  await click(button());
  await click(root.querySelector(".acts-backdrop"));
  expect(panel()).toBeNull();
  await click(button());
  await act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(panel()).toBeNull();
  // The panel lives outside the swipe area, so touches in it never switch sessions.
  await click(button());
  expect(panel()!.closest(".swipe")).toBeNull();
});

test("on a phone, Tab and Shift+Tab cycle inside the sheet, and closing it hands focus back to the button", async () => {
  await open(busyItem([], 2));
  await click(button());
  const close = panel()!.querySelector<HTMLElement>('[aria-label="Close activities"]')!;
  const link = panel()!.querySelector<HTMLElement>(".subagents-link")!;
  expect(document.activeElement).toBe(close);
  const tab = (shiftKey = false) => {
    const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  };
  expect(tab(true)).toBe(true);
  expect(document.activeElement).toBe(link);
  expect(tab()).toBe(true);
  expect(document.activeElement).toBe(close);
  // Between the first and last stop, the browser moves focus as usual.
  expect(tab()).toBe(false);
  await act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(button());
});

test("the todo list stays through the Raw view, and goes with the omp session", async () => {
  await open(item(), [said("hi"), todo("Step")]);
  await click(root.querySelector('[aria-label="Keys"]'));
  await click([...root.querySelectorAll(".keys button")].find((b) => b.textContent === "Raw") ?? null);
  expect(FakeEventSource.last.url).toBe("/api/stream?block=5&view=screen");
  await act(() => FakeEventSource.last.emit("state", state([item()])));
  await act(() => FakeEventSource.last.emit("screen", { text: "raw capture", html: false }));
  await click(button());
  expect(panel()!.querySelector(".todo-current")!.textContent).toBe("Step");
  await click(panel()!.querySelector('[aria-label="Close activities"]'));
  const restarted = item();
  restarted.agent!.sessionId = "other";
  await act(() => FakeEventSource.last.emit("state", state([restarted])));
  expect(button()).toBeNull();
});

test("on the desktop the panel docks, stays open across sessions and says when nothing goes on", async () => {
  wide = true;
  await open(busyItem([job("ViewA")], 1));
  await click(button());
  expect(panel()!.classList.contains("docked")).toBe(true);
  expect(root.querySelector(".acts-backdrop")).toBeNull();
  expect(localStorage.getItem("tern-awui.activities")).toBe("on");
  // A column beside the transcript, not a dialog: Tab leaves it as usual.
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  document.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  // Following a subagent link leaves the desktop's column open.
  await click(panel()!.querySelector("a.job"));
  expect(panel()).not.toBeNull();
  await act(() => render(null, root));
  await open(item({ block: "5" }), [said("done")]);
  expect(button()).toBeNull();
  expect(panel()!.querySelector(".acts-body")!.textContent).toBe("Nothing running and no todo list.");
  await click(panel()!.querySelector('[aria-label="Close activities"]'));
  expect(localStorage.getItem("tern-awui.activities")).toBe("off");
});
