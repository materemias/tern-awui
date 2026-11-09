import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Ask, ChatEntry } from "./api";
import { Net, settle, sleep, specDom } from "./fakes";
import { parseAskForm } from "../lib/ask-form";
import { answerSteps } from "../lib/input";

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
const { Chat, Markdown, StretchContext } = await import("./chat");
type StretchSync = import("./chat").StretchSync;

const net = new Net();
const buzzes: number[] = [];
let root: HTMLElement;
// The lightbox pops its history entry; a real back would land in a later test as a stray popstate.
let back: Mock<History["back"]>;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  net.install();
  buzzes.length = 0;
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: (ms: number) => buzzes.push(ms) });
  history.replaceState(null, "");
  back = spyOn(history, "back").mockImplementation(() => {});
});
afterEach(() => {
  render(null, root);
  root.remove();
  back.mockRestore();
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

  test("a subagent's prompt has no actions and renders as Markdown with its stretches open", async () => {
    await show([user("### Session update\n**agent**: it {{fails|fails on a stale cache}}.")], true);
    expect(root.querySelector(".user-acts")).toBeNull();
    expect(root.querySelector(".sub-prompt h3")!.textContent).toBe("Session update");
    expect(root.querySelector(".sub-prompt strong")!.textContent).toBe("agent");
    expect(root.querySelector(".sub-prompt")!.textContent).toContain("it fails on a stale cache.");
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
    expect(root.querySelector(".lightbox-count")!.textContent).toBe("2 / 2");
    expect(root.querySelector(".tools li")).toBeNull();
    await click(root.querySelector(".lightbox"));
    expect(root.querySelector(".lightbox")).toBeNull();
  });

  test("the lightbox pages through every image of the turn, and only that turn", async () => {
    await show([
      { role: "user", id: "u1", text: "old", images: [{ src: "/img/old.png" }], ts: TS },
      { role: "user", id: "u2", text: "look", images: [{ src: "/img/prompt.png" }], ts: TS },
      tools({ images: [{ src: "/img/a.png" }] }),
      said("checking"),
      tools({ images: [{ src: "/img/b.png" }] }),
    ]);
    await click(root.querySelectorAll(".thumb")[2]);
    expect([...root.querySelectorAll(".lightbox img")].map((i) => i.getAttribute("src"))).toEqual(["/img/prompt.png", "/img/a.png", "/img/b.png"]);
    expect(root.querySelector(".lightbox-count")!.textContent).toBe("2 / 3");
    await click(root.querySelector("[aria-label='Next image']"));
    expect(root.querySelector(".lightbox-count")!.textContent).toBe("3 / 3");
    expect(root.querySelector<HTMLButtonElement>("[aria-label='Next image']")!.disabled).toBe(true);
    await act(() => { dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" })); });
    expect(root.querySelector(".lightbox-count")!.textContent).toBe("2 / 3");
  });

  test("a screenshot arriving while the lightbox is open is one arrow key away", async () => {
    const prompt: ChatEntry = { role: "user", id: "u1", text: "look", images: [{ src: "/img/1.png" }], ts: TS };
    await show([prompt]);
    await click(root.querySelector(".thumb"));
    await show([prompt, tools({ images: [{ src: "/img/2.png" }] })]);
    await act(() => { dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); });
    expect(root.querySelector(".lightbox-count")!.textContent).toBe("2 / 2");
  });

  test("back closes the lightbox, forward reopens it, and closing it by tap pops its history entry", async () => {
    await show([tools({ images: [{ src: "/img/1.png" }] })]);
    await click(root.querySelector(".thumb"));
    expect(history.state).toEqual({ lightbox: "/img/1.png" });
    history.replaceState(null, "");
    await act(() => { dispatchEvent(new PopStateEvent("popstate")); });
    expect(root.querySelector(".lightbox")).toBeNull();
    history.replaceState({ lightbox: "/img/1.png" }, "");
    await act(() => { dispatchEvent(new PopStateEvent("popstate")); });
    expect(root.querySelector(".lightbox img")!.getAttribute("src")).toBe("/img/1.png");
    expect(back).toHaveBeenCalledTimes(0);
    await click(root.querySelector(".lightbox"));
    expect(back).toHaveBeenCalledTimes(1);
  });

  test("an open image rewound out of the transcript closes and pops its history entry", async () => {
    const entries: ChatEntry[] = [
      { role: "user", id: "u1", text: "one", images: [{ src: "/img/1.png" }], ts: TS },
      { role: "user", id: "u2", text: "two", images: [{ src: "/img/2.png" }], ts: TS },
    ];
    await show(entries);
    await click(root.querySelectorAll(".thumb")[1]);
    // The second prompt is gone; the first one's thumbnails must not inherit the open view.
    await show([entries[0]!, tools({ images: [{ src: "/img/3.png" }] })]);
    expect(root.querySelector(".lightbox")).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
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
    { advisor: "perf", severity: "low", note: "Slow loop in `poll()`\nplain detail" },
  ];

  test("one line per note with its severity; a tap shows labeled lines and who wrote it", async () => {
    await show([{ role: "advisor", notes, ts: TS }]);
    expect(root.querySelector(".advisor-head")!.textContent).toBe("▸Advisor2 notes");
    expect(texts(".advisor-key")).toEqual(["Token in URL"]);
    // Without a Key: line, the note's own text is the line, as markdown, folded.
    expect(root.querySelector(".advisor-text.clamp code")!.textContent).toBe("poll()");
    expect([...root.querySelectorAll(".sev")].map((s) => s.className)).toEqual(["sev sev-high", "sev sev-low"]);
    expect(root.querySelector(".advisor-body")).toBeNull();
    await click(root.querySelector(".advisor"));
    const bodies = root.querySelectorAll(".advisor-body");
    expect(bodies).toHaveLength(1);
    expect([...bodies[0].querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Evidence: server.ts:12 logs it", "Fix: move it to a header"]);
    expect(bodies[0].querySelector("p b")!.textContent).toBe("Evidence:");
    expect(bodies[0].querySelector(".muted")!.textContent).toBe("security");
    expect(root.querySelector(".advisor-text.clamp")).toBeNull();
    expect(root.querySelector(".advisor-text p")!.innerHTML).toBe("Slow loop in <code>poll()</code><br>plain detail");
    expect(root.querySelector(".advisor-by")!.textContent).toBe("perf");
  });

  test("a single note is counted in the singular", async () => {
    await show([{ role: "advisor", notes: notes.slice(1), ts: TS }]);
    expect(root.querySelector(".advisor-head")!.textContent).toBe("▸Advisor1 note");
  });

  test("a link inside a note opens without folding or unfolding the notes", async () => {
    await show([{ role: "advisor", notes: [{ advisor: "docs", severity: "low", note: "See [the spec](https://example.test/spec)" }], ts: TS }]);
    // Keep happy-dom from navigating; the card's handler still sees the click.
    root.addEventListener("click", (e) => e.preventDefault(), { capture: true });
    await click(root.querySelector(".advisor-text a"));
    expect(root.querySelector(".advisor-text.clamp")).not.toBeNull();
    await click(root.querySelector(".advisor-head"));
    await click(root.querySelector(".advisor-text a"));
    expect(root.querySelector(".advisor-text.clamp")).toBeNull();
  });
});

describe("injected rules", () => {
  test("names with the body's first line; a tap shows the whole rule; a name-only rule has no body", async () => {
    const rules = [{ name: "no-cast", text: "## Don't cast\n\nUse **narrowing**." }, { name: "no-any", text: "" }];
    await show([{ role: "rule", rules, ts: TS }]);
    expect(texts(".rule-line")).toEqual(["• inject: no-cast", "• inject: no-any"]);
    expect(texts(".rule-gist")).toEqual(["Don't cast"]);
    await click(root.querySelector(".rule"));
    expect(root.querySelector(".rule-gist")).toBeNull();
    expect(root.querySelectorAll(".rule-body")).toHaveLength(1);
    expect(root.querySelector(".rule-body strong")!.textContent).toBe("narrowing");
  });

  test("a link inside an opened rule opens without folding the rules", async () => {
    await show([{ role: "rule", rules: [{ name: "docs", text: "Read [the guide](https://example.test/guide)." }], ts: TS }]);
    // Keep happy-dom from navigating; the block's handler still sees the click.
    root.addEventListener("click", (e) => e.preventDefault(), { capture: true });
    await click(root.querySelector(".rule"));
    await click(root.querySelector(".rule-body a"));
    expect(root.querySelector(".rule-body")).not.toBeNull();
  });
});

describe("ask cards", () => {
  const ask = (html: string, answer: string | null = null): Ask => {
    const fields = parseAskForm(html);
    return { role: "ask", id: "a1", html, fields, question: fields[0]?.question ?? "", answer, ts: TS };
  };
  const DB = `<fieldset><legend>Which DB?</legend>
    <label><input type="radio" name="db" value="pg"> Postgres</label>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label></fieldset>`;
  const FULL = `<form action="https://evil.example"><script>window.hacked = 1</script>${DB}
    <label>Days <input type="number" name="action" value="30" required></label>
    <p>Extras?</p>
    <label><input type="checkbox" name="x" value="cache" checked> Cache</label>
    <label><input type="checkbox" name="x" value="logs"> Logs</label>
    <label for="s">Size</label><select id="s" name="size"><option>s<option selected>m</select>
    <button>Go</button></form>`;
  const answers = () => net.to("/api/blocks/5/answer");
  const input = (sel: string) => root.querySelector<HTMLInputElement>(sel)!;
  const radio = (value: string) => input(`input[type=radio][value="${value}"]`);
  const type = async (el: HTMLInputElement, value: string) => {
    el.value = value;
    await act(() => void el.dispatchEvent(new Event("input", { bubbles: true })));
  };

  test("the form shows sanitized: no script, its own form or buttons; names and label targets prefixed", async () => {
    await show([ask(FULL)]);
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelectorAll("form")).toHaveLength(1);
    expect(root.querySelector("form")!.getAttribute("action")).toBeNull();
    expect(button("Go")).toBeUndefined();
    // A field named like a form property keeps its name, prefixed so it can't shadow one.
    expect(input("input[type=number]").name).toBe("user-content-action");
    expect(root.querySelector("label[for]")!.getAttribute("for")).toBe(root.querySelector("select")!.id);
  });

  test("controls inside a button and button-like inputs go, as omp skips them; id references get the prefix too", async () => {
    await show([ask(`<button><input name="hidden_in_button"></button><input type="reset"><input type="submit" value="Ship">
      <p id="hint">Days</p><input name="d" aria-describedby="hint">`)]);
    expect(root.querySelector("input[name=user-content-hidden_in_button], input[type=reset], input[type=submit]")).toBeNull();
    expect(input("input[name=user-content-d]").getAttribute("aria-describedby")).toBe(root.querySelector("p")!.id);
  });

  test("a required box group needs one box or Other's text, not every box", async () => {
    const boxes = ["lint", "types", "tests"].map((v) => `<label><input type="checkbox" name="checks" value="${v}" required> ${v}</label>`).join("");
    await show([ask(`<fieldset><legend>Checks</legend>${boxes}</fieldset><input name="note">`)]);
    await click(button("Send answer"));
    expect(answers()).toEqual([]);
    await type(input("input[data-other=checks]"), "fmt");
    await click(input("input[value=types]"));
    await click(button("Send answer"));
    expect(answers()).toEqual([{ id: "a1", values: { checks: ["types"], note: "" }, other: { checks: "fmt" } }]);
  });

  test("a form that is one radio group sends on the first tap and then locks", async () => {
    await show([user("go"), ask(DB)]);
    await click(radio("sqlite"));
    expect(answers()).toEqual([{ id: "a1", values: { db: "sqlite" }, other: {} }]);
    expect(root.querySelector(".ask.sent")).not.toBeNull();
    expect(root.textContent).toContain("Sent, waiting for omp…");
    expect(root.querySelector<HTMLFieldSetElement>(".ask-form")!.disabled).toBe(true);
    expect(buzzes).toEqual([12]);
  });

  test("tapping the option the model preselected sends it too", async () => {
    await show([ask(DB.replace('value="pg"', 'value="pg" checked'))]);
    await click(radio("pg"));
    expect(answers()).toEqual([{ id: "a1", values: { db: "pg" }, other: {} }]);
  });

  test("an option value written with an HTML entity posts as the browser decodes it, and the server takes it", async () => {
    const entry = ask(`<label><input type="radio" name="drink" value="caf&eacute;"> Caf&eacute;</label><label><input type="radio" name="drink" value="tea"> Tea</label>`);
    await show([entry]);
    await click(radio("café"));
    const [body] = answers() as Record<string, unknown>[];
    expect(body).toEqual({ id: "a1", values: { drink: "café" }, other: {} });
    expect(answerSteps(entry, body)).toBeArray();
  });

  test("a radio group's Other text replaces its pick; emptied, the form's own pick is back", async () => {
    await show([ask(DB.replace('value="pg"', 'value="pg" checked'))]);
    const other = input("input[data-other=db]");
    expect(other.getAttribute("aria-label")).toBe("Which DB?: other");
    await type(other, "  MySQL ");
    expect(radio("pg").checked).toBe(false);
    await type(other, "");
    expect(radio("pg").checked).toBe(true);
    await type(other, "  MySQL ");
    await click(button("Send answer"));
    expect(answers()).toEqual([{ id: "a1", values: {}, other: { db: "MySQL" } }]);
  });

  test("Send carries every field: text, boxes (even none), the dropdown, and Other for boxes", async () => {
    await show([ask(FULL)]);
    await type(input("input[data-other=db]"), "zzz");
    // A picked radio drops its group's Other text.
    await click(radio("pg"));
    expect(input("input[data-other=db]").value).toBe("");
    // Several fields: a tap never sends by itself.
    expect(answers()).toEqual([]);
    await type(input("input[type=number]"), "7");
    await click(input("input[value=cache]"));
    await type(input("input[data-other=x]"), "metrics");
    await click(button("Send answer"));
    expect(answers()).toEqual([{ id: "a1", values: { db: "pg", action: "7", x: [], size: "m" }, other: { x: "metrics" } }]);
  });

  test("required fields hold the answer back until filled", async () => {
    await show([ask(FULL)]);
    await type(input("input[type=number]"), "");
    await click(button("Send answer"));
    expect(answers()).toEqual([]);
  });

  test("Sending… while in flight, once; a refusal shows and leaves the card answerable", async () => {
    const held = Promise.withResolvers<Response>();
    net.reply = () => held.promise;
    await show([ask(FULL)]);
    await click(button("Send answer"));
    await click(button("Sending…"));
    expect(answers()).toHaveLength(1);
    expect(root.querySelector<HTMLFieldSetElement>(".ask-form")!.disabled).toBe(true);
    await act(async () => {
      held.resolve(Response.json({ error: "ask expired" }, { status: 409 }));
      await settle();
    });
    expect(root.querySelector(".ask .err")!.textContent).toBe("ask expired");
    expect(root.querySelector(".ask.sent")).toBeNull();
    expect(button("Send answer")!.disabled).toBe(false);
    expect(buzzes).toEqual([]);
  });

  test("answered asks show omp's answer lines; one followed by talk shows its question went unanswered", async () => {
    await show([ask(DB, "Which DB?: SQLite"), { ...ask(FULL), id: "a2" }, user("never mind")]);
    expect(texts(".ask.done .ask-answer")).toEqual(["Which DB?: SQLite", "not answered"]);
    expect(texts(".ask.done .ask-q")).toEqual(["Which DB?"]);
    expect(root.querySelector("input")).toBeNull();
  });
});

describe("stretchtext replies", () => {
  const reply = (text: string): ChatEntry => ({ role: "assistant", text, block: "1792161451904.1", ts: TS });
  const TEXT = "A monad {{wraps values|wraps values in a context}}. Done.";
  const links = () => [...root.querySelectorAll("a[href^='#stretch/']")].map((a) => a.textContent);
  const prose = () => root.querySelector(".msg.assistant")!.textContent?.trim();

  test("a short form is a link that grows its long form in place; « closes it; the route stays", async () => {
    location.hash = "#s/5";
    await show([reply(TEXT)]);
    expect(prose()).toBe("A monad wraps values. Done.");
    expect(links()).toEqual(["wraps values"]);
    await click(root.querySelector("a[href^='#stretch/']"));
    await act(() => sleep(400));
    expect(prose()).toBe("A monad wraps values in a context «. Done.");
    expect(location.hash).toBe("#s/5");
    await click(root.querySelector("a[href='#stretch/close/0']"));
    expect(prose()).toBe("A monad wraps values. Done.");
  });

  test("Copy takes the whole reply as plain text, every stretch open, whatever is open on screen; a stretch tap doesn't show it", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    await show([reply("A monad {{wraps values|wraps values {{in a context|in a context, like `Maybe`}}}}. Done."), said("**Plain.**")]);
    const [stretchy, plain] = [...root.querySelectorAll(".reply")];
    await click(stretchy.querySelector("a[href^='#stretch/']"));
    expect(stretchy.classList.contains("acts-open")).toBe(false);
    await click(stretchy.querySelector(".msg"));
    expect(stretchy.classList.contains("acts-open")).toBe(true);
    await click(stretchy.querySelector(".reply-acts button"));
    await click(plain.querySelector(".reply-acts button"));
    expect(copied).toEqual(["A monad wraps values in a context, like `Maybe`. Done.", "**Plain.**"]);
    expect(stretchy.querySelector(".reply-acts button")!.textContent).toBe("Copied");
  });

  test("in a session, the shared state decides what is open and a tap goes to it", async () => {
    const set = mock((_block: string, _key: string, _open: boolean) => {});
    const draw = (open: Record<string, string[]>, off = false) =>
      act(() =>
        render(
          <StretchContext.Provider value={{ open, off, set }}>
            <Chat entries={[reply(TEXT)]} block="5" rewind />
          </StretchContext.Provider>,
          root,
        ),
      );
    await draw({});
    await click(root.querySelector("a[href^='#stretch/']"));
    expect(set.mock.calls).toEqual([["1792161451904.1", "wraps values", true]]);
    expect(prose()).toBe("A monad wraps values. Done.");
    // Opened in the Tern pane: it grows in here too.
    await draw({ "1792161451904.1": ["wraps values"] });
    await act(() => sleep(400));
    expect(prose()).toBe("A monad wraps values in a context «. Done.");
    // `/stretch off`: every long form, no links.
    await draw({}, true);
    expect(prose()).toBe("A monad wraps values in a context. Done.");
    expect(links()).toEqual([]);
  });

  test("✦ on a fully open stretch asks the pane; its press twinkles with the answer streaming in, then the answer stays", async () => {
    const BLOCK = "1792161451904.1";
    const press = mock((_block: string, _key: string) => {});
    const draw = (sync: Partial<StretchSync>) =>
      act(() =>
        render(
          <StretchContext.Provider value={{ open: { [BLOCK]: ["wraps values"] }, off: false, set: () => {}, press, ...sync }}>
            <Chat entries={[reply(TEXT)]} block="5" rewind />
          </StretchContext.Provider>,
          root,
        ),
      );
    await draw({});
    await click(root.querySelector("a[href='#stretch/deepen/0']"));
    expect(press.mock.calls).toEqual([[BLOCK, "wraps values"]]);
    // Running: no ✦ link, the seconds until words arrive, then the words where the answer will stand.
    await draw({ running: { [BLOCK]: [{ key: "wraps values", seconds: 3, partial: "" }] } });
    expect(root.querySelector("a[href^='#stretch/deepen/']")).toBeNull();
    expect(prose()).toMatch(/^A monad wraps values in a context . 3s «\. Done\.$/);
    await draw({ running: { [BLOCK]: [{ key: "wraps values", seconds: 4, partial: "Such as {{IO|IO actions" }] } });
    expect(prose()).toMatch(/^A monad wraps values in a context ✦ Such as IO . «\. Done\.$/);
    // The answer arrived: spliced in as an open ✦ stretch whose own stretch is a link (so neither has ✦ yet).
    const answers = { [BLOCK]: [{ key: "wraps values", text: "Such as {{IO|IO actions}}." }] };
    await draw({ open: { [BLOCK]: ["wraps values", "wraps values › ✦"] }, answers });
    // The answer ends where its parent does, so the two share one «.
    expect(prose()).toBe("A monad wraps values in a context ✦ Such as IO. «. Done.");
    expect(links()).toEqual(["IO", "«"]);
    // Without `press` (an omp that can't ask from here) there is no ✦.
    await draw({ press: undefined });
    expect(root.querySelector("a[href^='#stretch/deepen/']")).toBeNull();
  });

  test("braces in code and replies without stretches render as written", async () => {
    await show([said("Use `{{a|b}}` here.")]);
    expect(prose()).toBe("Use {{a|b}} here.");
    expect(links()).toEqual([]);
  });
});
