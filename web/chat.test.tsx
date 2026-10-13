import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Ask, ChatEntry } from "./api";
import { Net, settle, sleep, specDom } from "./fakes";

GlobalRegistrator.register({ url: "http://localhost/" });
// The sanitizer runs as in a browser, so rendered markdown keeps its figures.
const restoreDom = specDom();
afterAll(async () => {
  restoreDom();
  await GlobalRegistrator.unregister();
});

// mermaid (~1 MB) stands in as a renderer that fails on sources containing "bad", leaving the
// scratch node a real failed render leaves behind.
const rendered: string[] = [];
mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (id: string, src: string) => {
      rendered.push(src);
      if (src.includes("bad")) {
        const scratch = document.createElement("div");
        scratch.id = `d${id}`;
        document.body.append(scratch);
        throw new Error("parse error");
      }
      return { svg: `<svg data-diagram="${id}"></svg>` };
    },
  },
}));

// Dynamic on purpose: preact binds to the DOM globals present when it loads.
const { render } = await import("preact");
const { act } = await import("preact/test-utils");
const { Chat, Markdown } = await import("./chat");

const net = new Net();
const buzzes: number[] = [];
let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  net.install();
  buzzes.length = 0;
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => buzzes.push(ms) });
});
afterEach(() => {
  render(null, root);
  root.remove();
});
afterAll(() => net.restore());

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
    await settle();
  });
};
const texts = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent);
const button = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label));
const show = (entries: ChatEntry[], readOnly = false) => act(() => render(<Chat entries={entries} block="5" rewind readOnly={readOnly} />, root));

const TS = new Date(2026, 0, 1, 14, 3).getTime();
const user = (text: string): ChatEntry => ({ role: "user", id: `u-${text}`, text, images: [], ts: TS });
const said = (text: string): ChatEntry => ({ role: "assistant", text, ts: TS });

describe("transcript lines", () => {
  test("prompts, answers and the turn footer with its 24-hour time", async () => {
    await show([
      user("fix it"),
      said("**Done.**"),
      { role: "turn", ms: 65_000, model: "anthropic/claude-opus-5-5", ts: new Date(2026, 0, 1, 21, 7).getTime() },
      { role: "turn", ms: 4_000, model: "", ts: TS },
    ]);
    expect(texts(".user-text")).toEqual(["fix it"]);
    expect(root.querySelector(".msg.assistant strong")!.textContent).toBe("Done.");
    expect(texts(".turn")).toEqual(["1m05s · Opus 5.5 · 21:07", "4s · 14:03"]);
  });

  test("a subagent's transcript has no prompt actions", async () => {
    await show([user("fix it")], true);
    expect(root.querySelector(".user-acts")).toBeNull();
  });
});

describe("Markdown", () => {
  test("marks Hungarian text for the right hyphenation and fonts", async () => {
    await act(() => render(<Markdown class="md" text="Kész, a bejelentkezés működik." />, root));
    expect(root.querySelector(".md")!.getAttribute("lang")).toBe("hu");
    await act(() => render(<Markdown class="md" text="Done, login works." />, root));
    expect(root.querySelector(".md")!.getAttribute("lang")).toBe("en");
  });

  test("mermaid fences become diagrams; one that fails keeps its source and leaves no scratch node", async () => {
    const text = "```mermaid\nsequenceDiagram\nAlice->>Bob: hi\n```\n\n```mermaid\nbad graph\n```";
    const draw = async () => {
      await act(() => render(<Markdown class="md" text={text} />, root));
      await act(() => sleep(30));
    };
    await draw();
    expect(rendered).toEqual(["sequenceDiagram\nAlice->>Bob: hi", "bad graph"]);
    expect(root.querySelectorAll(".figure svg").length).toBe(1);
    expect(root.querySelector(".mermaid-src")).toBeNull();
    const figures = [...root.querySelectorAll(".figure")];
    expect(figures[1].querySelector("pre")!.textContent).toBe("bad graph");
    expect(document.querySelector('[id^="dmmd"]')).toBeNull();
    // The same source drawn again comes from the cache, not a second render.
    const before = rendered.length;
    render(null, root);
    await draw();
    expect(rendered.length).toBe(before);
    expect(root.querySelectorAll(".figure svg").length).toBe(1);
  });
});

describe("tool groups", () => {
  const tools = (over: Partial<Extract<ChatEntry, { role: "tools" }>> = {}): ChatEntry => ({
    role: "tools",
    calls: [
      { name: "read", intent: "Reading the router" },
      { name: "bash", intent: "Running tests", error: true },
      { name: "edit", intent: "" },
    ],
    images: [],
    todo: null,
    ts: TS,
    ...over,
  });

  test("one line with the count, failures and the last call; a tap lists every call", async () => {
    await show([tools()]);
    expect(root.querySelector(".tools-head")!.textContent).toBe("▸3 tools· 1 failededit");
    expect(root.querySelector(".tools li")).toBeNull();
    await click(root.querySelector(".tools"));
    expect(texts(".tools li")).toEqual(["read Reading the router", "bash Running tests", "edit "]);
    expect([...root.querySelectorAll(".tools li")].map((l) => l.className)).toEqual(["", "err", ""]);
    await click(root.querySelector(".tools"));
    expect(root.querySelector(".tools li")).toBeNull();
  });

  test("a single call that went fine says so without a failure count", async () => {
    await show([tools({ calls: [{ name: "read", intent: "Reading" }] })]);
    expect(root.querySelector(".tools-head")!.textContent).toBe("▸1 toolReading");
    expect(root.querySelector(".tools-head .err")).toBeNull();
  });

  test("screenshots open in a lightbox without toggling the group", async () => {
    await show([tools({ images: [{ src: "/img/1.png" }, { src: "/img/2.png" }] })]);
    const thumbs = root.querySelectorAll(".thumb");
    expect(thumbs.length).toBe(2);
    await click(thumbs[1]);
    expect(root.querySelector(".lightbox img")!.getAttribute("src")).toBe("/img/2.png");
    expect(root.querySelector(".tools li")).toBeNull();
    await click(root.querySelector(".lightbox"));
    expect(root.querySelector(".lightbox")).toBeNull();
  });

  test("only the newest todo list is open; older ones show their progress line", async () => {
    const todo = (current: string) => [{ name: "Work", tasks: [{ content: "Done one", status: "completed" }, { content: current, status: "in_progress" }] }];
    await show([tools({ todo: todo("Old step") }), said("next"), tools({ todo: null }), tools({ todo: todo("New step") })]);
    const lists = root.querySelectorAll(".todo");
    expect(lists.length).toBe(2);
    expect(lists[0].querySelector(".todo-task")).toBeNull();
    expect(lists[0].querySelector(".todo-head")!.textContent).toBe("1/2Old step");
    expect([...lists[1].querySelectorAll(".todo-task")].map((t) => t.textContent)).toEqual(["✓Done one", "▸New step"]);
  });
});

describe("advisor notes", () => {
  const notes = [
    { advisor: "security", severity: "high", note: "Key: Token in URL\nEvidence: server.ts:12 logs it\nFix: move it to a header" },
    { advisor: "perf", severity: "low", note: "Slow loop\nplain detail" },
  ];

  test("one line per note with its severity; a tap shows labeled lines and who wrote it", async () => {
    await show([{ role: "advisor", notes, ts: TS }]);
    expect(root.querySelector(".advisor-head")!.textContent).toBe("▸Advisor2 notes");
    expect(texts(".advisor-key")).toEqual(["Token in URL", "Slow loop"]);
    expect([...root.querySelectorAll(".sev")].map((s) => s.className)).toEqual(["sev sev-high", "sev sev-low"]);
    expect(root.querySelector(".advisor-body")).toBeNull();
    await click(root.querySelector(".advisor"));
    const bodies = root.querySelectorAll(".advisor-body");
    expect([...bodies[0].querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Evidence: server.ts:12 logs it", "Fix: move it to a header"]);
    expect(bodies[0].querySelector("p b")!.textContent).toBe("Evidence:");
    expect(bodies[0].querySelector(".muted")!.textContent).toBe("security");
    // Without a Key: line, the headline is the first line and it stays in the body.
    expect([...bodies[1].querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Slow loop", "plain detail"]);
  });

  test("a single note is counted in the singular", async () => {
    await show([{ role: "advisor", notes: notes.slice(1), ts: TS }]);
    expect(root.querySelector(".advisor-head")!.textContent).toBe("▸Advisor1 note");
  });
});

describe("ask cards", () => {
  const ask = (questions: Ask["questions"], answer: string | null = null): Ask => ({ role: "ask", id: "a1", questions, answer, ts: TS });
  const which = { question: "Which DB?", options: [{ label: "Postgres", description: "the usual" }, { label: "SQLite", description: "" }], multi: false, recommended: 1 };
  const extras = { question: "Extras?", options: [{ label: "Cache", description: "" }, { label: "Logs", description: "" }, { label: "Metrics", description: "" }], multi: true, recommended: -1 };
  const answers = () => net.to("/api/blocks/5/answer");

  test("one single-choice question sends on the first tap and then locks", async () => {
    await show([user("go"), ask([which])]);
    expect(texts(".opt-label")).toEqual(["Postgres", "SQLiterecommended", "Other…"]);
    expect(button("Send answer")).toBeUndefined();
    await click(button("SQLite"));
    expect(answers()).toEqual([{ id: "a1", answers: [{ option: 1, picks: [] }] }]);
    expect(root.querySelector(".ask.sent")).not.toBeNull();
    expect(root.textContent).toContain("Sent, waiting for omp…");
    expect([...root.querySelectorAll<HTMLButtonElement>(".opt")].every((b) => b.disabled)).toBe(true);
    expect(buzzes).toEqual([12]);
  });

  test("Other… opens a text answer that sends on Enter only once typed", async () => {
    await show([ask([which])]);
    await click(button("Other…"));
    const send = button("Send answer")!;
    expect(send.disabled).toBe(true);
    const input = root.querySelector<HTMLInputElement>(".other-input")!;
    await act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(answers()).toEqual([]);
    input.value = "  MySQL ";
    await act(() => void input.dispatchEvent(new Event("input", { bubbles: true })));
    expect(button("Send answer")!.disabled).toBe(false);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle();
    });
    expect(answers()).toEqual([{ id: "a1", answers: [{ other: "MySQL", picks: [] }] }]);
  });

  test("Other answers submit once while pending and after success, but can retry a refusal", async () => {
    const held = Promise.withResolvers<Response>();
    net.reply = () => held.promise;
    await show([ask([which])]);
    await click(button("Other…"));
    const input = root.querySelector<HTMLInputElement>(".other-input")!;
    input.value = "MySQL";
    await act(() => void input.dispatchEvent(new Event("input", { bubbles: true })));
    const enter = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await act(() => {
      enter();
      enter();
    });
    expect(answers()).toHaveLength(1);
    expect(input.disabled).toBe(true);
    await act(async () => {
      held.resolve(Response.json({ error: "try again" }, { status: 409 }));
      await settle();
    });
    expect(input.disabled).toBe(false);
    net.reply = () => Response.json({ ok: true });
    await act(async () => {
      enter();
      enter();
      await settle();
    });
    expect(answers()).toHaveLength(2);
    expect(input.disabled).toBe(true);
    await act(() => void enter());
    expect(answers()).toHaveLength(2);
    expect(buzzes).toEqual([12]);
  });

  test("picking an option closes Other again", async () => {
    await show([ask([which, extras])]);
    await click(button("Other…"));
    expect(root.querySelector(".other-input")).not.toBeNull();
    await click(button("Postgres"));
    expect(root.querySelector(".other-input")).toBeNull();
    expect(root.querySelector(".opt.on")!.textContent).toContain("Postgres");
    expect(answers()).toEqual([]);
  });

  test("several questions: boxes toggle, Send waits until every single choice is made", async () => {
    await show([ask([which, extras])]);
    expect(texts(".muted.small")).toContain("Pick any");
    expect(button("Send answer")!.disabled).toBe(true);
    await click(button("Cache"));
    await click(button("Metrics"));
    await click(button("Cache"));
    expect(button("Send answer")!.disabled).toBe(true);
    await click(button("Postgres"));
    // Picking in a multi-question card never sends by itself.
    expect(answers()).toEqual([]);
    await click(button("Send answer"));
    expect(answers()).toEqual([{ id: "a1", answers: [{ option: 0, picks: [] }, { option: null, picks: [2] }] }]);
  });

  test("Sending… while the answer is in flight; a refusal shows and leaves the card answerable", async () => {
    const held = Promise.withResolvers<Response>();
    net.reply = () => held.promise;
    await show([ask([which, extras])]);
    await click(button("Postgres"));
    await click(button("Send answer"));
    expect(button("Sending…")!.disabled).toBe(true);
    await act(async () => {
      held.resolve(Response.json({ error: "ask expired" }, { status: 409 }));
      await settle();
    });
    expect(root.querySelector(".ask .err")!.textContent).toBe("ask expired");
    expect(root.querySelector(".ask.sent")).toBeNull();
    expect(button("Send answer")!.disabled).toBe(false);
    expect(buzzes).toEqual([]);
  });

  test("answered asks show the answer; one followed by talk shows it went unanswered", async () => {
    await show([ask([which], "SQLite"), { ...ask([extras]), id: "a2" }, user("never mind")]);
    expect(texts(".ask.done .ask-answer")).toEqual(["SQLite", "not answered"]);
    expect(root.querySelector(".opt")).toBeNull();
  });
});
