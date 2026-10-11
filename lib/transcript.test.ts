import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { HASH, T0, Transcript, call, image, text } from "../test/fixtures";
import { INLINE_IMAGE_CHARS, parseChat, readChatFile, recapStale, scanFacts, type ChatEntry } from "./transcript";

const dir = mkdtempSync(`${tmpdir()}/tern-awui-transcript-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
function file(content: string): string {
  const path = `${dir}/${++files}.jsonl`;
  writeFileSync(path, content);
  return path;
}

const roles = (entries: ChatEntry[]) => entries.map((e) => e.role);
function only<R extends ChatEntry["role"]>(entries: ChatEntry[], role: R): Extract<ChatEntry, { role: R }>[] {
  return entries.filter((e): e is Extract<ChatEntry, { role: R }> => e.role === role);
}

describe("parseChat turns", () => {
  test("a prompt, a tool round and a final answer make one turn timed from the prompt", () => {
    const t = new Transcript();
    const prompt = t.user("fix the build", 1000);
    t.assistant([text("Looking."), call("c1", "bash", { i: "Running build", command: "bun run build" })], 2000, { stop: "toolUse" });
    t.result("c1", "bash", 3000);
    t.say("Fixed.", 9000);
    const { entries } = parseChat(t.lines(), "", 80);
    expect(roles(entries)).toEqual(["user", "assistant", "tools", "assistant", "turn"]);
    expect(entries[0]).toMatchObject({ role: "user", id: prompt, text: "fix the build", ts: T0 + 1000 });
    expect(only(entries, "turn")[0]).toMatchObject({ ms: 8000, model: "claude-test" });
  });

  test("an assistant message that stops for tools does not end the turn", () => {
    const t = new Transcript();
    t.user("go", 0);
    t.assistant([call("c1", "read", { path: "a.ts" })], 100, { stop: "toolUse" });
    const { entries } = parseChat(t.lines(), "", 80);
    expect(roles(entries)).toEqual(["user", "tools"]);
  });

  test("a turn without a prompt on the path is not timed", () => {
    const t = new Transcript();
    t.say("hello on my own", 100);
    expect(roles(parseChat(t.lines(), "", 80).entries)).toEqual(["assistant"]);
  });

  test("blank text parts, non-message rows and broken lines are skipped", () => {
    const t = new Transcript();
    t.user("q", 0);
    t.custom(10);
    t.assistant([text("   "), text("real")], 20);
    const lines = [...t.lines().slice(0, -1), "{not json", t.lines().at(-1)!];
    const { entries } = parseChat(lines, "", 80);
    expect(only(entries, "assistant").map((e) => e.text)).toEqual(["real"]);
  });

  test("limit keeps the newest entries", () => {
    const t = new Transcript();
    for (let i = 0; i < 5; i++) {
      t.user(`p${i}`, i * 10);
      t.say(`a${i}`, i * 10 + 5);
    }
    const { entries } = parseChat(t.lines(), "", 3);
    expect(entries.map((e) => ("text" in e ? e.text : e.role))).toEqual(["p4", "a4", "turn"]);
  });

  test("a row without a timestamp falls back to the message's own", () => {
    const t = new Transcript();
    t.user("x", 500);
    delete t.rows.at(-1)!.timestamp;
    expect(parseChat(t.lines(), "", 80).entries[0].ts).toBe(T0 + 500);
  });
});

describe("parseChat tool groups", () => {
  test("consecutive calls share a group; text between them starts a new one", () => {
    const t = new Transcript();
    t.user("go", 0);
    t.assistant([call("a", "read", { path: "x" }), call("b", "grep", { pattern: "y" })], 10, { stop: "toolUse" });
    t.result("a", "read", 11);
    t.result("b", "grep", 12);
    t.assistant([call("c", "find", { query: "z" })], 20, { stop: "toolUse" });
    t.result("c", "find", 21);
    t.assistant([text("between"), call("d", "bash", { command: "ls" })], 30, { stop: "toolUse" });
    const groups = only(parseChat(t.lines(), "", 80).entries, "tools");
    expect(groups.map((g) => g.calls.map((c) => c.name))).toEqual([["read", "grep", "find"], ["bash"]]);
  });

  test("intents follow the key priority; eval's title wins and its code is a last resort", () => {
    const t = new Transcript();
    t.user("go", 0);
    t.assistant(
      [
        call("1", "bash", { command: "ls -la", i: "Listing files" }),
        call("2", "eval", { title: "Load data", code: "import x\nprint(x)" }),
        call("3", "eval", { code: "\n  first = 1\nsecond = 2" }),
        call("4", "web", { url: "https://example.com", description: "docs" }),
        call("5", "odd", { count: 3 }),
        call("6", "bash", { command: "x".repeat(400) }),
        call("7", "bash", { i: 42, command: "fallback when i is not a string" }),
      ],
      10,
      { stop: "toolUse" },
    );
    const intents = only(parseChat(t.lines(), "", 80).entries, "tools")[0].calls.map((c) => c.intent);
    expect(intents).toEqual(["Listing files", "Load data", "first = 1", "https://example.com", "", "x".repeat(160), "fallback when i is not a string"]);
  });

  test("a failed result marks only its own call", () => {
    const t = new Transcript();
    t.user("go", 0);
    t.assistant([call("a", "bash", { command: "ok" }), call("b", "bash", { command: "boom" })], 10, { stop: "toolUse" });
    t.result("a", "bash", 11);
    t.result("b", "bash", 12, { isError: true, content: "exit 1" });
    const calls = only(parseChat(t.lines(), "", 80).entries, "tools")[0].calls;
    expect(calls.map((c) => c.error === true)).toEqual([false, true]);
  });

  test("a todo result sets the group's list from details.phases; the newest one wins", () => {
    const t = new Transcript();
    t.user("plan", 0);
    t.assistant([call("t1", "todo", { op: "init" })], 10, { stop: "toolUse" });
    t.result("t1", "todo", 11, {
      details: { op: "init", phases: [{ name: "Research", tasks: [{ content: "Study", status: "in_progress" }] }] },
    });
    t.assistant([call("t2", "todo", { op: "update" })], 20, { stop: "toolUse" });
    t.result("t2", "todo", 21, {
      details: {
        phases: [
          { name: "Research", tasks: [{ content: "Study", status: "completed" }] },
          { name: "Build", tasks: [{ content: "Server" }, { content: "Deploy", status: "blocked", blocker: "no creds" }] },
        ],
      },
    });
    const todo = only(parseChat(t.lines(), "", 80).entries, "tools")[0].todo;
    expect(todo).toEqual([
      { name: "Research", tasks: [{ content: "Study", status: "completed" }] },
      {
        name: "Build",
        tasks: [
          { content: "Server", status: "pending" },
          { content: "Deploy", status: "blocked", blocker: "no creds" },
        ],
      },
    ]);
  });

  test("a todo result without phases (or another tool's phases) leaves the list alone", () => {
    const t = new Transcript();
    t.user("plan", 0);
    t.assistant([call("t1", "todo", {}), call("x", "other", {})], 10, { stop: "toolUse" });
    t.result("t1", "todo", 11, { details: { op: "view" } });
    t.result("x", "other", 12, { details: { phases: [{ name: "Not a todo", tasks: [] }] } });
    expect(only(parseChat(t.lines(), "", 80).entries, "tools")[0].todo).toBeNull();
  });
});

describe("parseChat images", () => {
  test("blob refs become /api/blob URLs, small inline data a data: URL; others are dropped", () => {
    const t = new Transcript();
    t.user(
      [
        text("look"),
        image(`blob:sha256:${HASH}`),
        image("aGVsbG8=", "image/jpeg"),
        image("A".repeat(INLINE_IMAGE_CHARS + 1)),
        image("not base64!"),
        image("aGVsbG8=", "image/svg+xml"),
        image("aGVsbG8=", "constructor"),
        image("aGVsbG8=", "__proto__"),
        image("blob:sha256:short"),
      ],
      0,
    );
    const [user] = only(parseChat(t.lines(), "", 80).entries, "user");
    expect(user.images).toEqual([{ src: `/api/blob/${HASH}?type=image%2Fpng` }, { src: "data:image/jpeg;base64,aGVsbG8=" }]);
  });

  test("an image-only prompt is shown; an empty one is not, but still starts the turn", () => {
    const t = new Transcript();
    t.user([image(`blob:sha256:${HASH}`)], 0);
    t.say("nice picture", 10);
    t.user([text("  ")], 20);
    t.say("?", 50);
    const { entries } = parseChat(t.lines(), "", 80);
    expect(roles(entries)).toEqual(["user", "assistant", "turn", "assistant", "turn"]);
    expect(only(entries, "user")[0].text).toBe("");
    expect(only(entries, "turn")[1].ms).toBe(30);
  });

  test("images a tool returned attach to the call's group", () => {
    const t = new Transcript();
    t.user("screenshot", 0);
    t.assistant([call("s", "browser", { i: "Taking screenshot" })], 10, { stop: "toolUse" });
    t.result("s", "browser", 11, { content: [text("done"), image(`blob:sha256:${HASH}`, "image/webp")] });
    expect(only(parseChat(t.lines(), "", 80).entries, "tools")[0].images).toEqual([{ src: `/api/blob/${HASH}?type=image%2Fwebp` }]);
  });
});

describe("parseChat asks and advisor notes", () => {
  const ask = (id: string) =>
    call(id, "ask", {
      questions: [
        { question: "Which?", options: [{ label: "A", description: "first" }, "B"], recommended: 1 },
        { question: "Also?", options: [{ label: "x" }], multi: true },
      ],
    });

  test("an open ask carries its questions; plain-string options become labels", () => {
    const t = new Transcript();
    t.user("decide", 0);
    t.assistant([ask("q1")], 10, { stop: "toolUse" });
    const [entry] = only(parseChat(t.lines(), "", 80).entries, "ask");
    expect(entry).toMatchObject({ id: "q1", answer: null });
    expect(entry.questions).toEqual([
      { question: "Which?", multi: false, recommended: 1, options: [{ label: "A", description: "first" }, { label: "B", description: "" }] },
      { question: "Also?", multi: true, recommended: 0, options: [{ label: "x", description: "" }] },
    ]);
  });

  test("its result answers it; an empty result still counts as answered", () => {
    const t = new Transcript();
    t.user("decide", 0);
    t.assistant([ask("q1")], 10, { stop: "toolUse" });
    t.result("q1", "ask", 11, { content: "User picked: A" });
    t.assistant([ask("q2")], 20, { stop: "toolUse" });
    t.result("q2", "ask", 21, { content: [] });
    const asks = only(parseChat(t.lines(), "", 80).entries, "ask");
    expect(asks.map((a) => a.answer)).toEqual(["User picked: A", "answered"]);
  });

  test("an ask without a questions array is an ordinary tool call", () => {
    const t = new Transcript();
    t.user("decide", 0);
    t.assistant([call("q", "ask", { question: "loose" })], 10, { stop: "toolUse" });
    expect(roles(parseChat(t.lines(), "", 80).entries)).toEqual(["user", "tools"]);
  });

  test("advisor notes keep their advisor and severity (default `note`); empty notes drop", () => {
    const t = new Transcript();
    t.user("go", 0);
    t.advisor([{ note: "  Key: x\nFix: y  ", severity: "blocker", advisor: "luna" }, { note: "plain" }, { note: "   " }], 5);
    t.advisor([{ note: "" }], 6);
    const notes = only(parseChat(t.lines(), "", 80).entries, "advisor");
    expect(notes).toHaveLength(1);
    expect(notes[0].notes).toEqual([
      { advisor: "luna", severity: "blocker", note: "Key: x\nFix: y" },
      { advisor: "", severity: "note", note: "plain" },
    ]);
  });
});

describe("parseChat active path", () => {
  // p1 → a1 → p2 → a2, then a rewind to before p2 continues from a1: p3 → a3.
  function rewound() {
    const t = new Transcript();
    const p1 = t.user("first", 0);
    const a1 = t.say("one", 10);
    const p2 = t.user("abandoned", 20);
    const a2 = t.say("two", 30);
    const p3 = t.user("retry", 40, a1);
    const a3 = t.say("three", 50);
    return { t, p1, a1, p2, a2, p3, a3 };
  }
  const prompts = (entries: ChatEntry[]) => only(entries, "user").map((e) => e.text);

  test("without a known leaf the path ends at the file's last entry", () => {
    const { t } = rewound();
    expect(prompts(parseChat(t.lines(), "", 80).entries)).toEqual(["first", "retry"]);
  });

  test("the bridge's leaf wins, even when later entries exist on another branch", () => {
    const { t, a2 } = rewound();
    expect(prompts(parseChat(t.lines(), a2, 80).entries)).toEqual(["first", "abandoned"]);
  });

  test("a leaf just after a rewind (nothing appended yet) hides everything after it", () => {
    const { t, a1 } = rewound();
    const { entries } = parseChat(t.lines(), a1, 80);
    expect(prompts(entries)).toEqual(["first"]);
    expect(only(entries, "assistant").map((e) => e.text)).toEqual(["one"]);
  });

  test("`-` (rewound past the first prompt) shows nothing", () => {
    const { t } = rewound();
    expect(parseChat(t.lines(), "-", 80).entries).toEqual([]);
  });

  test("an unknown leaf falls back to the last line", () => {
    const { t } = rewound();
    expect(prompts(parseChat(t.lines(), "nope", 80).entries)).toEqual(["first", "retry"]);
  });

  test("a parent cycle does not hang the walk", () => {
    const t = new Transcript();
    const a = t.user("a", 0);
    const b = t.say("b", 10);
    t.rows.find((r) => r.id === a)!.parentId = b;
    expect(prompts(parseChat(t.lines(), "", 80).entries)).toEqual(["a"]);
  });

  test("the user entry's id is the row id the rewind endpoint takes", () => {
    const { t, p1, p3 } = rewound();
    expect(only(parseChat(t.lines(), "", 80).entries, "user").map((e) => e.id)).toEqual([p1, p3]);
  });
});

describe("readChatFile", () => {
  test("reads only the tail and drops the line it starts in", () => {
    const t = new Transcript();
    t.user("old prompt that falls outside the tail", 0);
    t.say("old answer", 10);
    t.user("new", 20);
    t.say("fresh", 30);
    const body = t.text();
    const lastTwo = t.lines().slice(-2).join("\n") + "\n";
    // Cut a few bytes into the third-from-last line.
    const path = file(body);
    return readChatFile(path, "", 80, lastTwo.length + 5).then(({ entries }) => {
      expect(only(entries, "user").map((e) => e.text)).toEqual(["new"]);
      expect(only(entries, "assistant").map((e) => e.text)).toEqual(["fresh"]);
    });
  });

  test("a whole file within the tail keeps its first line", async () => {
    const t = new Transcript();
    t.user("only", 0);
    const { entries } = await readChatFile(file(t.lines().slice(3).join("\n")), "", 80);
    expect(only(entries, "user").map((e) => e.text)).toEqual(["only"]);
  });
});

describe("scanFacts", () => {
  test("finds the newest prompt (whitespace collapsed, capped) and the newest activity", async () => {
    const t = new Transcript();
    t.user("first", 1000);
    t.say("a", 2000);
    t.user(`  second\n\n  prompt ${"y".repeat(400)}`, 3000);
    t.say("b", 4000);
    const facts = await scanFacts(file(t.text()), undefined);
    expect(facts.lastPrompt).toBe(`second prompt ${"y".repeat(400)}`.slice(0, 300));
    expect(facts.lastTurn).toBe(T0 + 3000);
    expect(facts.lastActivity).toBe(T0 + 4000);
  });

  test("an image-only prompt starts a turn but keeps the shown prompt", async () => {
    const t = new Transcript();
    t.user("describe this", 1000);
    t.user([image(`blob:sha256:${HASH}`)], 5000);
    const facts = await scanFacts(file(t.text()), undefined);
    expect(facts.lastPrompt).toBe("describe this");
    expect(facts.lastTurn).toBe(T0 + 5000);
  });

  test("custom rows (advisor, tool events) are not activity", async () => {
    const t = new Transcript();
    t.user("q", 1000);
    t.advisor([{ note: "late note" }], 9000);
    t.custom(9500);
    expect((await scanFacts(file(t.text()), undefined)).lastActivity).toBe(T0 + 1000);
  });

  test("continues from the previous scan, and a line still being written waits for the next", async () => {
    const t = new Transcript();
    t.user("one", 1000);
    const path = file(t.text());
    const first = await scanFacts(path, undefined);
    expect(first.offset).toBe(Bun.file(path).size);

    t.user("two", 2000);
    const line = t.lines().at(-1)!;
    appendFileSync(path, line.slice(0, 20));
    const partial = await scanFacts(path, first);
    expect(partial).toBe(first); // updated in place
    expect(partial.lastPrompt).toBe("one");
    expect(partial.offset).toBe(Bun.file(path).size - 20);

    appendFileSync(path, `${line.slice(20)}\n`);
    const done = await scanFacts(path, partial);
    expect(done.lastPrompt).toBe("two");
    expect(done.lastTurn).toBe(T0 + 2000);
    expect(done.offset).toBe(Bun.file(path).size);
  });

  test("a shrunk (rewritten) file is scanned from scratch", async () => {
    const t = new Transcript();
    t.user("long gone prompt", 1000);
    t.say("x".repeat(500), 2000);
    const path = file(t.text());
    const before = await scanFacts(path, undefined);

    const u = new Transcript();
    u.user("new", 50);
    writeFileSync(path, u.text());
    const after = await scanFacts(path, before);
    expect(after.lastPrompt).toBe("new");
    expect(after.lastActivity).toBe(T0 + 50);
    expect(after.offset).toBe(Bun.file(path).size);
  });

  test("a big file is scanned from its tail, skipping the line the tail starts in", async () => {
    const t = new Transcript();
    t.user("outside the tail", 1000);
    t.user("cut in half", 2000);
    t.user("inside", 3000);
    const lastLine = t.lines().at(-1)! + "\n";
    const facts = await scanFacts(file(t.text()), undefined, lastLine.length + 10);
    expect(facts.lastPrompt).toBe("inside");
    expect(facts.lastTurn).toBe(T0 + 3000);
  });
});

describe("recapStale", () => {
  const turn = T0 + 30_000;
  test("no recap is never stale", () => expect(recapStale(undefined, turn)).toBe(false));
  test("a recap from the turn's second (rounded down) is current", () => {
    expect(recapStale({ createdAt: Math.floor(turn / 1000) }, turn + 999)).toBe(false);
    expect(recapStale({ createdAt: Math.floor(turn / 1000) - 1 }, turn)).toBe(false);
  });
  test("a recap more than a second before the last turn is stale", () => {
    expect(recapStale({ createdAt: Math.floor(turn / 1000) - 2 }, turn)).toBe(true);
  });
  test("a session without turns keeps its recap current", () => expect(recapStale({ createdAt: 1 }, 0)).toBe(false));
});
