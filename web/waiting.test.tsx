import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Item, Waiting } from "./api";
import { parseView } from "../lib/waiting-view";
import { FakeEventSource, item, Net, settle, state } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Preact and the component must bind to the registered browser globals, not Bun's initial globals.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { WaitingIcon, WaitingPopup, WaitingStrip, parseThread, standing } = await import("./waiting");
const { Home } = await import("./home");
const { origins } = await import("./hooks");

const net = new Net();
let root: HTMLElement;
let alerts: string[];
let closed: number;
const original = { EventSource: globalThis.EventSource, alert: globalThis.alert, confirm: globalThis.confirm };

/** A wait as `codexbar_waiting.py list` prints it. */
const wait = (id: string, ball = "on_machine", over: Record<string, unknown> = {}) => ({
  id, kind: "pr", label: `Label ${id}`, summary: `Summary ${id}`, state: "waiting", ball, overdue: false, outcome: null,
  reason: null, created_at: "2026-11-03T14:10:00Z", due_at: null, has_prompt: true, repeat: null, mark: "⏳ ", ...over,
});
/** A session row as the CLI prints it: closed, on the machine, with one PR wait. */
const session = (id: string, over: Record<string, unknown> = {}) => ({
  session_id: id, title: `Session ${id}`, project: "app", cwd: "/w/app", live: false, pane: null, ball: "on_machine",
  outcome: null, headline: null, threads: [`⏳ Summary w1 of ${id}`], still_waiting: [], waiting_for: null, due_at: null,
  unseen: false, note: null, suggested_note: null, line: `line ${id}`, next_step: null, recap: null, recap_at: null,
  recap_stale: false, pinned: false, size: null, set_aside_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  waits: [wait("w1")], history: [], prs: [], ...over,
});
function view(...sessions: unknown[]): Extract<Waiting, { available: true }> {
  const parsed = parseView({ ok: true, counts: {}, sessions, panes: [] });
  if (!parsed) throw new Error("not a view");
  return { available: true, ...parsed };
}
/** An omp in block 7, running session "live". */
const block7 = item({ block: "7", agent: { sessionId: "live", lastPrompt: "", recap: "", recapStale: false, lastActivity: 0, subagents: 0 } });

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  location.hash = "#/waiting";
  localStorage.clear();
  alerts = [];
  closed = 0;
  net.install();
  FakeEventSource.all = [];
  Object.assign(globalThis, { EventSource: FakeEventSource, alert: (m: string) => alerts.push(m), confirm: () => true });
});
afterEach(() => {
  render(null, root);
  root.remove();
  net.restore();
  Object.assign(globalThis, original);
});

async function mount(waiting: Waiting | null, items: Item[] = [block7], card: string | null = null) {
  await act(() => render(<WaitingPopup waiting={waiting} card={card} items={items} onClose={() => closed++} />, root));
  await act(() => settle());
}
function button(label: string, within: Element = root) {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}
const rowsShown = () => [...root.querySelectorAll<HTMLElement>("li.wrow")];
const titles = () => rowsShown().map((r) => r.querySelector(".wname-title")?.textContent);
const rowOf = (title: string) => {
  const found = rowsShown().find((r) => r.querySelector(".wname-title")?.textContent === title);
  if (!found) throw new Error(`no row ${title}`);
  return found;
};
const hasButton = (label: string) => [...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);
const esc = () => act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
const rowsOf = (...sessions: unknown[]) => view(...sessions).rows;
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await settle();
  });
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
}

describe("the way in", () => {
  test("the strip shows only with waits, one tap target with what's on you", async () => {
    await act(() => render(<WaitingStrip waiting={{ available: false }} />, root));
    expect(root.querySelector("a")).toBeNull();
    await act(() => render(<WaitingStrip waiting={null} />, root));
    expect(root.querySelector("a")).toBeNull();
    await act(() => render(<WaitingStrip waiting={view()} />, root));
    expect(root.querySelector("a")).toBeNull();
    await act(() => render(<WaitingStrip waiting={view(session("a"), session("b"))} />, root));
    const strip = root.querySelector("a.wait-strip")!;
    expect(strip.getAttribute("href")).toBe("#/waiting");
    expect(strip.className).not.toContain("on-me");
    expect(strip.textContent).toBe("Waiting2 set aside›");
    await act(() => render(<WaitingStrip waiting={view(session("a", { ball: "on_me" }), session("b"), session("c"))} />, root));
    expect(root.querySelector("a.wait-strip")!.className).toContain("on-me");
    expect(root.querySelector(".wait-strip-me")?.textContent).toBe("1 on you");
    expect(root.querySelector("a")?.getAttribute("aria-label")).toBe("Waiting, 1 on you, 2 more");
  });

  test("the rail's hourglass carries the on-you badge", async () => {
    await act(() => render(<WaitingIcon waiting={view(session("a"))} />, root));
    expect(root.querySelector("a")?.getAttribute("aria-label")).toBe("Waiting");
    expect(root.querySelector(".waiting-count")).toBeNull();
    await act(() => render(<WaitingIcon waiting={view(session("a", { ball: "on_me" }), session("b", { ball: "on_me" }))} />, root));
    expect(root.querySelector(".waiting-count")?.textContent).toBe("2");
  });

  test("the list's header has no hourglass; the strip sits under the header (or beside the Tern session chips), and #/waiting opens the popup over the list", async () => {
    localStorage.setItem("tern-mobile:guide", "done");
    await act(() => render(<Home push={["unsupported", () => {}]} waitingOpen />, root));
    await act(() => {
      FakeEventSource.last.open();
      FakeEventSource.last.emit("state", state([block7]));
      FakeEventSource.last.emit("waiting", view(session("a", { ball: "on_me" })));
    });
    await act(() => settle());
    expect(root.querySelector(".list-bar .waiting-btn, .list-bar [href='#/waiting']")).toBeNull();
    expect(root.querySelector(".list-bar + .wait-strip, .list-tools > .wait-strip.compact")).not.toBeNull();
    expect(root.querySelector(".wait-sheet[role=dialog]")).not.toBeNull();
    expect(root.querySelector(".list")).not.toBeNull();
  });

  test("a tap beside an open session closes the whole popup: back past the session and the list", async () => {
    localStorage.setItem("tern-mobile:guide", "done");
    origins.clear();
    origins.set("#/waiting", "#/");
    origins.set("#/waiting/a", "#/waiting");
    const steps: number[] = [];
    const go = history.go;
    history.go = (n?: number) => void steps.push(n ?? 0);
    try {
      await act(() => render(<Home push={["unsupported", () => {}]} waitingOpen waitingCard="a" />, root));
      await act(() => {
        FakeEventSource.last.open();
        FakeEventSource.last.emit("state", state([block7]));
        FakeEventSource.last.emit("waiting", view(session("a")));
      });
      await act(() => settle());
      expect(root.querySelector(".wd-head")).not.toBeNull();
      await click(root.querySelector(".wait-backdrop")!);
      expect(steps).toEqual([-2]);
    } finally {
      history.go = go;
      origins.clear();
    }
  });
});

describe("parseThread", () => {
  test("a leading mark gives the kind; the rest is the text", () => {
    expect(parseThread("⏳ PR#12 review on head")).toEqual({ kind: "waiting", text: "PR#12 review on head" });
    expect(parseThread("✅ 4h passed")).toEqual({ kind: "done", text: "4h passed" });
    expect(parseThread("⚠️ CI failed")).toEqual({ kind: "attention", text: "CI failed" });
    expect(parseThread("⏰ late")).toEqual({ kind: "overdue", text: "late" });
    expect(parseThread("⏲ 24h check")).toEqual({ kind: "timer", text: "24h check" });
    expect(parseThread("🔧 running")).toEqual({ kind: "working", text: "running" });
  });

  test("an unknown mark still drops; a leading word is no mark; a lone token stays whole", () => {
    expect(parseThread("★ odd")).toEqual({ kind: "waiting", text: "odd" });
    expect(parseThread("PR#12 review")).toEqual({ kind: "waiting", text: "PR#12 review" });
    expect(parseThread("⏳")).toEqual({ kind: "waiting", text: "⏳" });
  });
});

describe("standing", () => {
  test("the free-text wait is no thread: it stands alone as the manual wait", () => {
    const [r] = rowsOf(session("a", { ball: "on_someone", threads: ["⏳ Anna's reply"], waiting_for: "Anna's reply" }));
    expect(standing(r)).toEqual({ kind: "manual", text: "Anna's reply", detail: "", rest: [] });
    const [r2] = rowsOf(session("b", { ball: "on_someone", threads: ["⏳ PR#1", "⏳ Anna's reply"], waiting_for: "Anna's reply" }));
    expect(standing(r2)).toEqual({ kind: "waiting", text: "PR#1", detail: "", rest: [] });
  });

  test("on my time drops the 'When I have time' thread; only a size is news", () => {
    expect(standing(rowsOf(session("a", { ball: "on_my_time", threads: ["📌 When I have time"] }))[0])).toEqual({ kind: "later", text: "", detail: "", rest: [] });
    expect(standing(rowsOf(session("a", { ball: "on_my_time", threads: ["📌 when I have time"], size: "M" }))[0]).text).toBe("Size M");
    // Elsewhere the same words are a thread like any other.
    expect(standing(rowsOf(session("a", { ball: "on_someone", threads: ["📌 When I have time"] }))[0]).text).toBe("When I have time");
  });

  test("on me without an outcome: the wait's reason, its label as detail; else its label; else Needs you", () => {
    const reasoned = rowsOf(session("a", { ball: "on_me", threads: [], waits: [wait("w1", "on_me", { reason: "Pick a fix" })] }))[0];
    expect(standing(reasoned)).toEqual({ kind: "attention", text: "Pick a fix", detail: "Label w1", rest: [] });
    const labelled = rowsOf(session("a", { ball: "on_me", threads: [], waits: [wait("w1", "on_me")] }))[0];
    expect(standing(labelled)).toMatchObject({ text: "Label w1", detail: "" });
    expect(standing(rowsOf(session("a", { ball: "on_me", threads: [], waits: [wait("w1")] }))[0]).text).toBe("Needs you");
    // The threads stay as the rest.
    expect(standing(rowsOf(session("a", { ball: "on_me", threads: ["⏳ x"], waits: [wait("w1")] }))[0])).toMatchObject({ text: "x", rest: [{ kind: "waiting", text: "x" }] });
  });

  test("an outcome: the headline without its mark, else the first thread; the rest follow; the wait that came is the detail", () => {
    const r = rowsOf(session("a", {
      ball: "on_me", outcome: "fulfilled", headline: "✅ 4h passed", threads: ["✅ 4h passed", "⏲ 24h check"], still_waiting: ["⏲ 24h check"],
      waits: [wait("w1", "on_me", { outcome: "fulfilled", reason: "check it" }), wait("w2", "on_me")],
    }))[0];
    expect(standing(r)).toEqual({ kind: "done", text: "4h passed", detail: "Label w1: check it", rest: [{ kind: "timer", text: "24h check" }] });
    const bare = rowsOf(session("a", { ball: "on_me", outcome: "overdue", threads: ["⏰ late", "⏳ b"], still_waiting: ["⏳ b"] }))[0];
    expect(standing(bare)).toMatchObject({ kind: "overdue", text: "late", rest: [{ kind: "waiting", text: "b" }] });
  });
});

describe("the list", () => {
  test("rows sit in their groups, in order; On me leads with what needs a look, then overdue, then what came", async () => {
    await mount(view(
      session("later", { ball: "on_my_time" }),
      session("someone", { ball: "on_someone" }),
      session("machine"),
      session("came", { ball: "on_me", outcome: "fulfilled" }),
      session("late", { ball: "on_me", outcome: "overdue" }),
      session("look", { ball: "on_me", outcome: "attention" }),
    ));
    expect([...root.querySelectorAll(".wait-group h3")].map((h) => h.textContent)).toEqual(["On me 3", "Machine watching 1", "Waiting on something 1", "When I have time 1"]);
    expect(titles()).toEqual(["Session look", "Session late", "Session came", "Session machine", "Session someone", "Session later"]);
    expect(root.querySelector(".wait-head")?.textContent).toContain("3 on you, 6 set aside");
  });

  test("a row: project, tag split from the title, time, where it stands, how many more, the note", async () => {
    const due = new Date(Date.now() + 3 * 3600_000 - 60_000).toISOString();
    await mount(view(
      session("a", {
        title: "RDP: Diagnose login", ball: "on_me", outcome: "fulfilled", headline: "✅ 4h passed",
        threads: ["✅ 4h passed", "⏲ 24h check", "⏳ Anna's reply"], still_waiting: ["⏲ 24h check", "⏳ Anna's reply"], waiting_for: "Anna's reply", note: "check RM", due_at: due, project: "shiftmaqt",
      }),
      session("b", { waits: [wait("w1", "on_machine", { overdue: true })] }),
    ));
    const a = rowOf("Diagnose login");
    expect(a.querySelector(".wname-project")?.textContent).toBe("shiftmaqt");
    expect(a.querySelector(".tag")?.textContent).toBe("RDP");
    expect(a.querySelector(".wrow-time")?.textContent).toBe("in 3h");
    expect(a.querySelector(".wrow-state .wglyph")?.getAttribute("class")).toContain("k-done");
    expect(a.querySelector(".wrow-text")?.textContent).toBe("4h passed");
    // The 24h check and Anna's reply.
    expect(a.querySelector(".wrow-more")?.textContent).toBe("+2");
    expect(a.querySelector(".wrow-note")?.textContent).toBe("check RM");
    const b = rowOf("Session b");
    expect(b.querySelector(".wrow-text")?.textContent).toBe("Summary w1 of b");
    expect(b.querySelector(".wrow-more")).toBeNull();
    expect(b.querySelector(".wrow-note")).toBeNull();
    expect(b.querySelector(".wrow-time")?.textContent).toBe("overdue");
  });

  test("time left never reads 60m or 24h, nor jumps a unit at its edge", async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    await mount(view(
      session("a", { due_at: at(59 * 60_000 + 50_000) }),
      session("b", { due_at: at(3600_000 + 60_000) }),
      session("c", { due_at: at(23 * 3600_000 + 50 * 60_000) }),
    ));
    expect(["Session a", "Session b", "Session c"].map((t) => rowOf(t).querySelector(".wrow-time")?.textContent)).toEqual(["in 1h", "in 1h", "in 1d"]);
  });

  test("a row links to its session in full; a pane's id is encoded", async () => {
    const pane = { pane: 7, label: "bun test", ball: "on_machine", line: "job", waits: [wait("w9", "on_machine", { kind: "job" })] };
    const parsed = parseView({ ok: true, counts: {}, sessions: [session("a b")], panes: [pane] })!;
    await mount({ available: true, ...parsed });
    expect(rowsShown().map((r) => r.querySelector("a.wrow-main")?.getAttribute("href"))).toEqual(["#/waiting/a%20b", "#/waiting/pane%3A7"]);
  });

  test("Seen sits only on rows with something on you and closes what came", async () => {
    const onYou = [{ id: "w1", label: "Label w1", mark: "✅", text: "PR merged", report: null }];
    await mount(view(session("a", { ball: "on_me", waits: [wait("w1", "on_me"), wait("w2")], on_you: onYou, stoppable: 2 }), session("b", { ball: "on_me", stoppable: 1 })));
    expect(rowOf("Session b").querySelector("button.wrow-done")).toBeNull();
    await click(rowOf("Session a").querySelector('button[aria-label="Seen"]')!);
    expect(net.to("/api/waiting/mark-seen")).toEqual([{ session: "a" }]);
  });

  test("the filter hides until asked; every word must match; no match offers Clear; closing it clears", async () => {
    await mount(view(session("a", { note: "check RM" }), session("b", { project: "meridian" })));
    expect(root.querySelector(".wait-sheet input")).toBeNull();
    await click(root.querySelector('button[aria-label="Filter"]')!);
    const filter = () => root.querySelector<HTMLInputElement>('input[aria-label="Filter waits"]')!;
    await type(filter(), "meridian session");
    expect(titles()).toEqual(["Session b"]);
    await type(filter(), "nope");
    expect(root.textContent).toContain("No wait matches.");
    await click(button("Clear"));
    expect(titles()).toHaveLength(2);
    await type(filter(), "meridian");
    await click(root.querySelector('button[aria-label="Filter"]')!);
    expect(root.querySelector('input[aria-label="Filter waits"]')).toBeNull();
    expect(titles()).toHaveLength(2);
  });

  test("Escape closes an open filter first, then the popup; × and the backdrop close, the sheet doesn't", async () => {
    await mount(view(session("a")));
    await click(root.querySelector('button[aria-label="Filter"]')!);
    await type(root.querySelector<HTMLInputElement>('input[aria-label="Filter waits"]')!, "x");
    await esc();
    expect(root.querySelector('input[aria-label="Filter waits"]')).toBeNull();
    expect(titles()).toEqual(["Session a"]);
    expect(closed).toBe(0);
    await esc();
    expect(closed).toBe(1);
    await click(root.querySelector('button[aria-label="Close"]')!);
    expect(closed).toBe(2);
    await click(root.querySelector(".wait-sheet")!);
    expect(closed).toBe(2);
    await click(root.querySelector(".wait-backdrop")!);
    expect(closed).toBe(3);
  });

  test("connecting, off, nothing set aside and failing each say so", async () => {
    await mount(null);
    expect(root.textContent).toContain("Connecting…");
    await mount({ available: false });
    expect(root.textContent).toContain("needs CodexBar AgentView");
    await mount(view());
    expect(root.textContent).toContain("Nothing is set aside.");
    expect(root.querySelector('button[aria-label="Filter"]')).toBeNull();
    await mount({ ...view(session("a")), error: "no answer" });
    expect(root.textContent).toContain("Couldn't refresh the list (no answer).");
    expect(titles()).toEqual(["Session a"]);
  });

  test("a session no longer set aside says so and shows the list", async () => {
    await mount(view(session("a")), [block7], "gone");
    expect(root.textContent).toContain("That session isn't set aside any more.");
    expect(titles()).toEqual(["Session a"]);
  });

  test("the list alone marks nothing seen", async () => {
    await mount(view(session("a", { ball: "on_me", unseen: true })));
    expect(net.to("/api/waiting/seen")).toEqual([]);
  });
});

describe("a session in full", () => {
  const detail = (sel: string) => root.querySelector(sel);

  test("says where it stands and what the wait asks; the back button and Escape return to the list", async () => {
    await mount(view(session("a", {
      ball: "on_me", outcome: "attention", headline: "⚠️ CI failed", threads: ["⚠️ CI failed"],
      waits: [wait("w1", "on_me", { outcome: "attention", reason: "fix the test" })], next_step: "rebase",
    })), [block7], "a");
    expect(titles()).toEqual([]);
    expect(detail(".wd-state")?.textContent).toBe("CI failed");
    expect(detail(".wd-detail")?.textContent).toBe("Label w1: fix the test");
    expect(root.textContent).toContain("Next step");
    expect(root.textContent).toContain("rebase");
    location.hash = "#/waiting/a";
    await esc();
    expect(location.hash).toBe("#/waiting");
    expect(closed).toBe(0);
    location.hash = "#/waiting/a";
    await click(root.querySelector('button[aria-label="Back to Waiting"]')!);
    expect(location.hash).toBe("#/waiting");
  });

  test("three or more waits are counted and each named", async () => {
    await mount(view(session("a", { threads: ["⏳ PR#1", "⏲ 24h check", "🔧 build"] })), [block7], "a");
    expect(detail(".wd-state")?.textContent).toBe("Waiting on 3 things");
    expect([...root.querySelectorAll(".wd-waits li")].map((l) => l.textContent)).toEqual(["PR#1", "24h check", "build"]);
  });

  test("two waits: the first is the sentence, the other is also waited on", async () => {
    await mount(view(session("a", { threads: ["⏳ PR#1", "⏲ 24h check"] })), [block7], "a");
    expect(detail(".wd-state")?.textContent).toBe("PR#1");
    expect(root.textContent).toContain("Also waiting on");
    expect([...root.querySelectorAll(".wd-waits li")].map((l) => l.textContent)).toEqual(["24h check"]);
  });

  test("what came heads an outcome; only what is still awaited, the free-text wait among it, is listed", async () => {
    await mount(view(session("a", {
      ball: "on_me", outcome: "fulfilled", headline: "✅ came", threads: ["✅ came", "✅ also came", "⏲ later", "⏳ Anna"], still_waiting: ["⏲ later", "⏳ Anna"], waiting_for: "Anna",
    })), [block7], "a");
    expect(detail(".wd-state")?.textContent).toBe("came");
    expect(root.textContent).toContain("Still waiting on");
    expect([...root.querySelectorAll(".wd-waits li")].map((l) => l.textContent)).toEqual(["later", "Anna"]);
  });

  test("nothing to tell on my time: When I have time", async () => {
    await mount(view(session("a", { ball: "on_my_time", threads: [], waits: [wait("w1", "on_my_time", { kind: "later" })] })), [block7], "a");
    expect(detail(".wd-state")?.textContent).toBe("When I have time");
  });

  test("its PRs, with where each came from and its state", async () => {
    const pr = { repo: "o/r", number: 74, url: "https://github.com/o/r/pull/74", source: "wait", title: "fix: y", state: "open", review: "changes_requested", checks: "failing" };
    await mount(view(session("a", {
      prs: [pr, { ...pr, number: 9, url: "https://github.com/o/r/pull/9", source: "mentioned", title: null, state: "merged", review: null, checks: null }],
    })), [block7], "a");
    const prs = [...root.querySelectorAll(".wd-prs li")];
    expect(prs[0].querySelector("a")?.getAttribute("href")).toBe("https://github.com/o/r/pull/74");
    expect(prs[0].querySelector("a")?.textContent).toBe("#74 fix: y");
    expect(prs[0].querySelector(".wpr-facts")?.textContent).toBe("o/r · waiting on it · open · changes requested · checks fail");
    expect(prs[1].querySelector("a")?.textContent).toBe("#9 o/r");
    expect(prs[1].querySelector(".wpr-facts")?.textContent).toBe("o/r · mentioned · merged");
  });

  test("history newest first, four of it until Show all", async () => {
    const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const history = [6, 5, 4, 3, 2, 1].map((h) => ({ kind: h === 1 ? "fired" : null, at: at(h), text: `${h}h ago` }));
    await mount(view(session("a", { history })), [block7], "a");
    const events = () => [...root.querySelectorAll("ol.wd-history li span")].map((s) => s.textContent);
    expect(events()).toEqual(["1h ago", "2h ago", "3h ago", "4h ago"]);
    await click(button("Show all 6"));
    expect(events()).toEqual(["1h ago", "2h ago", "3h ago", "4h ago", "5h ago", "6h ago"]);
    await click(button("Show fewer"));
    expect(events()).toHaveLength(4);
  });

  test("short history has no Show all", async () => {
    const history = [{ kind: null, at: new Date().toISOString(), text: "one" }];
    await mount(view(session("a", { history })), [block7], "a");
    expect(root.querySelectorAll("ol.wd-history li")).toHaveLength(1);
    expect(root.textContent).not.toContain("Show all");
  });

  test("the recap folds away, saying how old it is", async () => {
    await mount(view(session("a", { recap: "Ported it.", recap_at: new Date(Date.now() - 5 * 3600_000).toISOString(), recap_stale: true })), [block7], "a");
    const recap = root.querySelector("details.wd-recap")!;
    expect(recap.querySelector("summary")?.textContent).toBe("omp's earlier recap, 5h ago");
    expect(recap.querySelector("p")?.textContent).toBe("Ported it.");
  });

  test("an unseen session counts as seen once, when it opens", async () => {
    const v = view(session("a", { ball: "on_me", unseen: true }), session("b", { unseen: true }));
    await mount(v, [block7], "a");
    await mount(v, [block7], "a");
    expect(net.to("/api/waiting/seen")).toEqual([{ session: "a" }]);
    await mount(v, [block7], "b");
    expect(net.to("/api/waiting/seen")).toEqual([{ session: "a" }, { session: "b" }]);
  });

  test("a session in a Tern pane opens through the app's own link", async () => {
    await mount(view(session("live", { ball: "on_me", live: true, pane: 7 })), [block7], "live");
    const open = root.querySelector<HTMLAnchorElement>('.wd-bar a[href="#/b/7"]');
    expect(open?.textContent?.trim()).toBe("Open");
    expect(hasButton("Resume")).toBe(false);
    expect(detail(".wd-facts")?.textContent).toContain("Open in Tern");
  });

  test("a closed session resumes on the Closed list's path, and jumps to the block", async () => {
    net.reply = () => Response.json({ block: "33" });
    await mount(view(session("s1", { ball: "on_me" })), [block7], "s1");
    expect(detail(".wd-facts")?.textContent).toContain("Closed");
    await click(button("Resume"));
    expect(net.to("/api/closed/resume")).toEqual([expect.objectContaining({ id: "s1", agent: "omp" })]);
    expect(location.hash).toBe("#/b/33");
  });

  test("a session live outside Tern can be neither opened nor resumed", async () => {
    await mount(view(session("x", { ball: "on_me", live: true })), [block7], "x");
    expect(hasButton("Resume")).toBe(false);
    expect(root.querySelector(".wd-bar a")).toBeNull();
    expect(detail(".wd-facts")?.textContent).toContain("Runs outside Tern");
  });

  test("Snooze 1d pushes the wait AgentView picks; the On you block shows what came, and Seen closes it", async () => {
    const onYou = [{ id: "w2", label: "Review", mark: "⚠️", text: "ran, take a look", report: "Fixed the flaky test" }];
    await mount(view(session("a", { ball: "on_me", on_you: onYou, stoppable: 2, waits: [wait("w1", "on_machine", { due_at: "2026-11-20T10:00:00Z" }), wait("w2", "on_me", { snoozable: true })] })), [block7], "a");
    expect(detail(".wd-onyou")?.textContent).toContain("Review: ran, take a lookFixed the flaky test");
    await click(button("Snooze 1d"));
    await click(button("Seen"));
    expect(net.to("/api/waiting/snooze")).toEqual([{ session: "a", wait: "w2" }]);
    expect(net.to("/api/waiting/mark-seen")).toEqual([{ session: "a" }]);
    await act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
    await act(() => settle());
    expect(net.to("/api/waiting/mark-seen")).toHaveLength(2);
  });

  test("nothing on you: no Seen, and Del does nothing", async () => {
    await mount(view(session("a", { ball: "on_my_time", stoppable: 1, waits: [wait("w1", "on_my_time", { kind: "later" })] })), [block7], "a");
    expect(hasButton("Snooze 1d")).toBe(false);
    expect(hasButton("Seen")).toBe(false);
    expect(detail(".wd-onyou")).toBeNull();
    await act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
    expect(net.to("/api/waiting/mark-seen")).toEqual([]);
  });

  test("each watched wait stops on its own, without asking", async () => {
    await mount(view(session("a", { stoppable: 1, waits: [wait("w1"), wait("w2", "on_machine", { state: "done" })] })), [block7], "a");
    expect(root.querySelectorAll(".wd-stop")).toHaveLength(1);
    await click(root.querySelector('button[aria-label="Stop Label w1"]')!);
    expect(net.to("/api/waiting/stop")).toEqual([{ session: "a", wait: "w1" }]);
  });

  test("Stop N waits… needs a second tap", async () => {
    await mount(view(session("a", { stoppable: 2, waits: [wait("w1"), wait("w2")] })), [block7], "a");
    await click(button("Stop 2 waits…"));
    expect(net.to("/api/waiting/stop")).toEqual([]);
    await click(button("Press again to stop 2 waits"));
    expect(net.to("/api/waiting/stop")).toEqual([{ session: "a", all: true }]);
    expect(hasButton("Stop 2 waits…")).toBe(true);
  });

  test("no open waits: no Stop", async () => {
    await mount(view(session("a", { waits: [], threads: [] })), [block7], "a");
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Stop"))).toBe(false);
  });

  test("a refused action says why", async () => {
    net.reply = () => Response.json({ error: "w1 has not started yet" }, { status: 502 });
    await mount(view(session("a", { ball: "on_me", waits: [wait("w1", "on_me", { snoozable: true })] })), [block7], "a");
    await click(button("Snooze 1d"));
    expect(alerts).toEqual(["w1 has not started yet"]);
  });

  test("a plain pane acts as a pane", async () => {
    const pane = { pane: 7, label: "bun test", ball: "on_me", line: "job failed", waits: [wait("w9", "on_me", { kind: "job", overdue: true, snoozable: true })] };
    const parsed = parseView({ ok: true, counts: {}, sessions: [], panes: [pane] })!;
    await mount({ available: true, ...parsed }, [item({ block: "7" })], "pane:7");
    expect(root.querySelector('.wd-bar a[href="#/b/7"]')).not.toBeNull();
    await click(button("Snooze 1d"));
    expect(net.to("/api/waiting/snooze")).toEqual([{ pane: 7, wait: "w9" }]);
  });

  test("the note edits in place; Cancel leaves it; empty clears it", async () => {
    await mount(view(session("a", { note: "old" })), [block7], "a");
    await click(root.querySelector(".wd-note")!);
    const field = () => root.querySelector<HTMLTextAreaElement>('form.wedit textarea[aria-label="Your note"]')!;
    expect(field().value).toBe("old");
    await click(button("Cancel"));
    expect(root.querySelector("form.wedit")).toBeNull();
    await click(root.querySelector(".wd-note")!);
    await type(field(), " new ");
    await submit();
    expect(root.querySelector("form.wedit")).toBeNull();
    await click(root.querySelector(".wd-note")!);
    await type(field(), "  ");
    await submit();
    expect(net.to("/api/waiting/note")).toEqual([{ session: "a", text: "new" }, { session: "a", text: "" }]);
  });

  test("a failed save keeps the editor open", async () => {
    net.reply = () => Response.json({ error: "nope" }, { status: 502 });
    await mount(view(session("a")), [block7], "a");
    await click(button("Add a note"));
    await type(root.querySelector<HTMLTextAreaElement>("form.wedit textarea")!, "x");
    await submit();
    expect(alerts).toEqual(["nope"]);
    expect(root.querySelector("form.wedit")).not.toBeNull();
  });

  test("the suggestion: Use it accepts it; it hides while the note is edited", async () => {
    await mount(view(session("a", { suggested_note: "wait for the bot" })), [block7], "a");
    expect(detail(".wd-suggest")?.textContent).toContain("wait for the bot");
    await click(button("Use it"));
    expect(net.to("/api/waiting/accept-suggested")).toEqual([{ session: "a" }]);
    await click(button("Add a note"));
    expect(detail(".wd-suggest")).toBeNull();
  });

  test("a manual wait: added, edited where it stands, edited as part of the list, cleared when empty", async () => {
    await mount(view(session("a", { ball: "on_someone", threads: [] })), [block7], "a");
    await click(button("Add a manual wait"));
    const field = () => root.querySelector<HTMLTextAreaElement>('form.wedit textarea[aria-label="Manual wait"]')!;
    expect(field().value).toBe("");
    await type(field(), "Anna");
    await submit();

    await mount(view(session("b", { ball: "on_someone", threads: [], waiting_for: "Anna" })), [block7], "b");
    expect(detail(".wd-state")?.textContent).toBe("Anna");
    await click(button("Edit the manual wait"));
    expect(field().value).toBe("Anna");
    await type(field(), " ");
    await submit();

    await mount(view(session("c", { threads: ["⏳ PR#1", "⏳ Bob"], waiting_for: "Bob" })), [block7], "c");
    expect(hasButton("Add a manual wait")).toBe(false);
    await click(root.querySelector(".wd-waits button")!);
    expect(field().value).toBe("Bob");
    await click(button("Cancel"));
    expect(root.querySelector("form.wedit")).toBeNull();
    expect(net.to("/api/waiting/what")).toEqual([{ session: "a", text: "Anna" }, { session: "b", text: "" }]);
  });
});

describe("safe to close", () => {
  const verdict = (v: string, text: string) => ({ close: { verdict: v, reason: v === "park" ? "job" : "prompt", text } });
  const checked = (at: number, over: Record<string, unknown> = {}) => ({ checked_at: new Date(at).toISOString(), error: null, error_kind: null, ...over });
  function withHealth(health: unknown, ...sessions: unknown[]): Extract<Waiting, { available: true }> {
    const parsed = parseView({ ok: true, counts: {}, sessions, panes: [], health });
    if (!parsed) throw new Error("not a view");
    return { available: true, ...parsed };
  }
  const tagOf = (title: string) => rowOf(title).querySelector<HTMLElement>(".wclose");

  test("each row tags its verdict: safe and manual muted, park a warning, the full text on hover", async () => {
    await mount(withHealth(checked(Date.now()),
      session("s", verdict("safe", "closable")),
      session("m", verdict("manual", "closable · you reopen")),
      session("p", verdict("park", "park only: job runs in this pane")),
      session("n")));
    expect(tagOf("Session s")?.textContent).toBe("closable");
    expect(tagOf("Session s")?.className).not.toContain("t-warn");
    expect(tagOf("Session m")?.textContent).toBe("you reopen");
    expect(tagOf("Session m")?.title).toBe("closable · you reopen");
    expect(tagOf("Session p")?.textContent).toBe("park only");
    expect(tagOf("Session p")?.className).toContain("t-warn");
    expect(tagOf("Session p")?.title).toBe("park only: job runs in this pane");
    expect(tagOf("Session n")).toBeNull();
  });

  test("the detail spells the verdict out", async () => {
    await mount(withHealth(checked(Date.now()), session("p", verdict("park", "park only: job runs in this pane"))), [block7], "p");
    expect(root.querySelector(".wd-close")?.textContent).toBe("park only: job runs in this pane");
    expect(root.querySelector(".wd-close")?.className).toContain("t-warn");
  });

  test("while nothing checks the waits, every row reads park, whatever its verdict", async () => {
    const safe = session("s", verdict("safe", "closable"));
    const park = "park only: nothing checks waits";
    for (const health of [checked(Date.now() - 16 * 60_000), checked(Date.now(), { error: "tern: no daemon", error_kind: "failed" }), { checked_at: null, error: null }]) {
      await mount(withHealth(health, safe));
      expect(tagOf("Session s")?.textContent).toBe("park only");
      expect(tagOf("Session s")?.title).toBe(park);
    }
    // A last check's partial error is no override.
    await mount(withHealth(checked(Date.now(), { error: "PR checks: 502", error_kind: "partial" }), safe));
    expect(tagOf("Session s")?.textContent).toBe("closable");
    await mount(withHealth(checked(Date.now() - 16 * 60_000), safe), [block7], "s");
    expect(root.querySelector(".wd-close")?.textContent).toBe(park);
  });
});
