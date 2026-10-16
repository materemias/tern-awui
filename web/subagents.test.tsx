import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ChatEntry, Item, Job, Subagent } from "./api";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { JobsStrip, SubagentChat, SubagentList } = await import("./subagents");

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const texts = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent);
const hrefs = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.getAttribute("href"));

function item(jobs: Job[]): Item {
  return {
    block: "5",
    icon: null,
    tag: "APP",
    title: "Fix login",
    cwd: "/w",
    project: "w",
    branch: null,
    agent: { sessionId: "s", lastPrompt: "", recap: "", recapStale: false, lastActivity: 0, subagents: 2 },
    live: { model: "m", thinking: "", levels: [], tiers: [], tier: "", context: null, jobs, protocol: 2, caps: null, build: "", mismatch: null, restart: false },
    status: "working",
    since: NOW,
    doc: null,
    unseen: null,
  };
}
const job = (agent: string, type = "task"): Job => ({ id: `j-${agent || type}`, type, label: "", agent, since: NOW - 42_000 });

describe("SubagentChat", () => {
  const entries: ChatEntry[] = [
    { role: "user", id: "e1", text: "Run sleep 20", images: [], ts: NOW - 60_000 },
    { role: "tools", calls: [{ name: "bash", intent: "Sleeping 20 s" }], images: [], todo: null, ts: NOW - 50_000 },
    { role: "ask", id: "a1", questions: [{ question: "Which?", options: [{ label: "A", description: "" }], multi: false, recommended: 0 }], answer: null, ts: NOW - 40_000 },
  ];
  let backs = 0;
  const screen = (jobs: Job[], shown: ChatEntry[] | null = entries) => (
    <SubagentChat block="5" item={item(jobs)} online now={NOW} backHref="#/b/5" onBack={() => backs++} name="ViewA" entries={shown} />
  );

  test("shows the transcript with no composer, no prompt actions and no answerable question", async () => {
    await act(() => render(screen([job("ViewA")]), root));
    expect(root.querySelector(".user-text")!.textContent!.trim()).toBe("Run sleep 20");
    expect(texts(".tools-last")).toEqual(["Sleeping 20 s"]);
    expect(root.querySelector("form, textarea, .composer-wrap")).toBeNull();
    expect(root.querySelector(".user-acts")).toBeNull();
    expect(texts("button").filter((t) => /Rewind|Copy|Send/.test(t ?? ""))).toEqual([]);
    // The open ask shows as a question without options to pick.
    expect(root.querySelector(".ask.done .ask-answer")!.textContent).toBe("not answered");
    expect(root.querySelector(".opt")).toBeNull();
  });

  test("the header names the subagent, its parent and whether it runs", async () => {
    await act(() => render(screen([job("ViewA")]), root));
    expect(root.querySelector(".session-title .title")!.textContent).toBe("ViewA");
    expect(root.querySelector(".sub-parent")!.textContent).toBe("APP: Fix login");
    expect(root.querySelector(".row-meta")!.textContent).toContain("running");
    expect(root.querySelector(".working")!.textContent).toBe("working · 42s");
    await act(() => render(screen([job("Other")]), root));
    expect(root.querySelector(".row-meta")!.textContent).toContain("finished");
    expect(root.querySelector(".working")).toBeNull();
  });

  test("‹ points at the parent and leaves through onBack", async () => {
    backs = 0;
    await act(() => render(screen([]), root));
    const back = root.querySelector<HTMLAnchorElement>("a.back")!;
    expect(back.getAttribute("href")).toBe("#/b/5");
    await act(() => back.click());
    expect(backs).toBe(1);
    expect(location.hash).toBe("");
  });

  test("an empty transcript says why", async () => {
    await act(() => render(screen([job("ViewA")], []), root));
    expect(root.querySelector(".empty")!.textContent).toBe("Starting…");
    await act(() => render(screen([], []), root));
    expect(root.querySelector(".empty")!.textContent).toBe("No transcript for this subagent.");
  });
});

describe("SubagentList", () => {
  const list: Subagent[] = [
    { name: "ViewB", started: NOW - 20_000, lastActivity: NOW - 1000, running: true, summary: "Sleeping in B", messages: 2 },
    { name: "ViewA", started: NOW - 90_000, lastActivity: NOW - 3_600_000, running: false, summary: "Slept.", messages: 5 },
  ];

  test("each subagent links to its chat with its summary, running ones marked", async () => {
    await act(() => render(<SubagentList block="5" item={item([job("ViewB")])} online now={NOW} backHref="#/b/5" onBack={() => {}} list={list} />, root));
    expect(hrefs("a.row")).toEqual(["#/b/5/sub/ViewB", "#/b/5/sub/ViewA"]);
    expect(texts(".row .title")).toEqual(["ViewB", "ViewA"]);
    expect(texts(".row-sub")).toEqual(["Sleeping in B", "Slept."]);
    expect(texts(".row .age")).toEqual(["20s", "1h"]);
    expect(root.querySelectorAll(".row.st-working").length).toBe(1);
    expect(root.querySelector(".row-meta")!.textContent).toContain("2 · 1 running");
    expect(root.querySelector("form, textarea")).toBeNull();
  });

  test("none yet, or loading", async () => {
    await act(() => render(<SubagentList block="5" item={item([])} online now={NOW} backHref="#/b/5" onBack={() => {}} list={[]} />, root));
    expect(root.querySelector(".empty")!.textContent).toBe("No subagents yet.");
    await act(() => render(<SubagentList block="5" item={item([])} online now={NOW} backHref="#/b/5" onBack={() => {}} list={null} />, root));
    expect(root.querySelector(".empty")!.textContent).toBe("Loading…");
  });
});

describe("JobsStrip", () => {
  test("a running subagent opens its chat; other jobs don't; Subagents (N) opens the list", async () => {
    const jobs = [job("ViewA"), job("", "bash"), job("../x")];
    await act(() => render(<JobsStrip block="5" jobs={jobs} subagents={3} now={NOW} />, root));
    expect(hrefs("a.job")).toEqual(["#/b/5/sub/ViewA"]);
    expect(texts("div.job .job-name")).toEqual(["j-bash", "../x"]);
    expect(root.querySelector<HTMLAnchorElement>(".subagents-link")!.getAttribute("href")).toBe("#/b/5/sub");
    expect(root.querySelector(".subagents-link")!.textContent).toContain("Subagents (3)");
  });

  test("once every subagent finished, the entry goes too; a background shell alone gets no entry", async () => {
    await act(() => render(<JobsStrip block="5" jobs={[]} subagents={2} now={NOW} />, root));
    expect(root.innerHTML).toBe("");
    await act(() => render(<JobsStrip block="5" jobs={[job("", "bash")]} subagents={2} now={NOW} />, root));
    expect(texts("div.job .job-name")).toEqual(["j-bash"]);
    expect(root.querySelector(".subagents-link")).toBeNull();
  });
});
