import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { HASH, PNG, T0, Transcript, call, image, text } from "../test/fixtures";
import { INLINE_IMAGE_CHARS, TranscriptImages, parseChat, readChatFile, recapStale, scanFacts, type ChatEntry } from "./transcript";

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

describe("assistant markdown image transport", () => {
  const chat = (md: string) => {
    const t = new Transcript();
    t.say(md, 0);
    return parseChat(t.lines(), "", 80);
  };
  const srcHash = (src: string) => /\/api\/blob\/([0-9a-f]{64})/.exec(src)![1];

  test("discovers inline and reference images without changing markdown, links or code", async () => {
    const cache = new TranscriptImages();
    const inline = `${dir}/inline.png`;
    const reference = `${dir}/reference image.png`;
    const code = `${dir}/code-only.png`;
    for (const path of [inline, reference, code]) writeFileSync(path, PNG);
    const md = [
      `![Corrected queued message](${inline})`,
      `![Reference][after]\n\n[after]: <${reference}> "Queue image"`,
      `[download](${code})`,
      `\`![literal](${code})\``,
      "```md", `![fenced](${code})`, "```",
      "![remote](https://example.test/image.png)",
      "![inline](data:image/png;base64,aGVsbG8=)",
    ].join("\n\n");
    const entry = only((await cache.attach(chat(md))).entries, "assistant")[0];
    expect(entry.text).toBe(md);
    expect(Object.keys(entry.imageSources!)).toEqual([inline, reference]);
    for (const src of Object.values(entry.imageSources!)) expect((await cache.get(srcHash(src)))?.bytes).toEqual(new Uint8Array(PNG));
  });

  test("only the displayed assistant path authorizes local files, never user text or abandoned branches", async () => {
    const cache = new TranscriptImages();
    const path = `${dir}/abandoned.png`;
    writeFileSync(path, PNG);
    const t = new Transcript();
    const prompt = t.user(`![user](${path})`, 0);
    t.say(`![abandoned](${path})`, 1);
    const leaf = t.assistant([text("No screenshot")], 2, { parent: prompt });
    const result = await cache.attach(parseChat(t.lines(), leaf, 80));
    expect(only(result.entries, "assistant")[0].imageSources).toBeUndefined();
    expect(await cache.get(new Bun.CryptoHasher("sha256").update(PNG).digest("hex"))).toBeUndefined();
  });

  test("rejects missing files, symlinks, directories, non-images, wrong extensions and oversized files", async () => {
    const valid = `${dir}/validation.png`;
    const invalid = `${dir}/html.png`;
    const mismatch = `${dir}/wrong.jpg`;
    const link = `${dir}/linked.png`;
    const folder = `${dir}/folder.png`;
    const large = `${dir}/large.png`;
    writeFileSync(valid, PNG);
    writeFileSync(invalid, "<html>not an image</html>");
    writeFileSync(mismatch, PNG);
    symlinkSync(valid, link);
    mkdirSync(folder);
    writeFileSync(large, "");
    truncateSync(large, 16 * 1024 * 1024 + 1);
    const paths = [`${dir}/missing.png`, invalid, mismatch, link, folder, large, `file://${valid}`, "//server/share.png", "relative.png"];
    const cache = new TranscriptImages();
    const md = paths.map((path) => `![invalid](${path})`).join("\n");
    const entry = only((await cache.attach(chat(md))).entries, "assistant")[0];
    expect(entry.text).toBe(md);
    expect(entry.imageSources).toBeUndefined();
  });

  test("unchanged polls reuse the same byte snapshot; changed files get new content hashes", async () => {
    const cache = new TranscriptImages();
    const path = `${dir}/cached.png`;
    writeFileSync(path, PNG);
    const md = `![cached](${path})`;
    const first = only((await cache.attach(chat(md))).entries, "assistant")[0].imageSources![path];
    const bytes = (await cache.get(srcHash(first)))!.bytes;
    const again = only((await cache.attach(chat(md))).entries, "assistant")[0].imageSources![path];
    expect(again).toBe(first);
    expect((await cache.get(srcHash(again)))!.bytes).toBe(bytes);
    const changed = Buffer.concat([PNG, Buffer.from("changed")]);
    writeFileSync(path, changed);
    const next = only((await cache.attach(chat(md))).entries, "assistant")[0].imageSources![path];
    expect(next).not.toBe(first);
    expect((await cache.get(srcHash(next)))?.bytes).toEqual(new Uint8Array(changed));
    rmSync(path);
    expect((await cache.get(srcHash(next)))?.bytes).toEqual(new Uint8Array(changed));
  });

  test("a single chat beyond the byte-entry capacity still resolves every image and rejects changed refill paths", async () => {
    const cache = new TranscriptImages();
    const paths: string[] = [];
    const images: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < 130; i++) {
      const path = `${dir}/eviction-${i}.png`;
      const bytes = Buffer.concat([PNG, Buffer.from(String(i))]);
      writeFileSync(path, bytes);
      paths.push(path);
      images.push(bytes);
    }
    const md = paths.map((path) => `![image](${path})`).join("\n");
    const sources = only((await cache.attach(chat(md))).entries, "assistant")[0].imageSources!;
    expect(Object.keys(sources).length).toBe(130);
    // Both paths are evicted from the 128-entry byte cache; their indexed hashes remain authorized.
    writeFileSync(paths[0], Buffer.concat([PNG, Buffer.from("replaced")]));
    expect(await cache.get(srcHash(sources[paths[0]]))).toBeUndefined();
    for (let i = 1; i < paths.length; i++) {
      expect((await cache.get(srcHash(sources[paths[i]])))?.bytes).toEqual(images[i]);
    }
    const again = only((await cache.attach(chat(md))).entries, "assistant")[0].imageSources!;
    expect(again[paths[1]]).toBe(sources[paths[1]]);
    expect(again[paths[0]]).not.toBe(sources[paths[0]]);
  });

  test("the byte-size limit refills authorized images and tries a surviving duplicate path", async () => {
    const cache = new TranscriptImages();
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = `${dir}/size-limit-${i}.png`;
      writeFileSync(path, Buffer.concat([PNG, Buffer.from(String(i))]));
      truncateSync(path, 14 * 1024 * 1024);
      paths.push(path);
    }
    const duplicate = `${dir}/size-duplicate.png`;
    writeFileSync(duplicate, Buffer.concat([PNG, Buffer.from("0")]));
    truncateSync(duplicate, 14 * 1024 * 1024);
    const md = [paths[0], duplicate, ...paths.slice(1)].map((path) => `![large](${path})`).join("\n");
    const sources = only((await cache.attach(chat(md))).entries, "assistant")[0].imageSources!;
    expect(sources[duplicate]).toBe(sources[paths[0]]);
    // Five 14 MiB images exceed 64 MiB, so the shared first image's bytes were evicted.
    rmSync(paths[0]);
    const restored = await cache.get(srcHash(sources[duplicate]));
    expect(restored?.bytes.byteLength).toBe(14 * 1024 * 1024);
    expect(restored?.bytes.subarray(0, PNG.byteLength)).toEqual(new Uint8Array(PNG));
    for (const path of paths.slice(1)) expect((await cache.get(srcHash(sources[path])))?.bytes.byteLength).toBe(14 * 1024 * 1024);
  });
});

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

  test("a subagent's yielded text is its reply; a yield without text stays a tool line", () => {
    const t = new Transcript();
    t.user("sleep", 0);
    t.assistant([call("b", "bash", { i: "Sleeping" })], 10, { stop: "toolUse" });
    t.result("b", "bash", 20);
    t.assistant([call("y", "yield", { data: { result: "I slept." } })], 30, { stop: "toolUse" });
    t.result("y", "yield", 31);
    t.assistant([call("y2", "yield", { data: { files: 2 } })], 40, { stop: "toolUse" });
    const entries = parseChat(t.lines(), "", 80).entries;
    expect(roles(entries)).toEqual(["user", "tools", "assistant", "tools"]);
    expect(only(entries, "assistant")[0]).toEqual({ role: "assistant", text: "I slept.", ts: T0 + 30 });
    expect(only(entries, "tools").map((g) => g.calls.map((c) => c.name))).toEqual([["bash"], ["yield"]]);
  });

  test("a reply part with stretchtext markup carries its block id: message timestamp and part index", () => {
    const t = new Transcript();
    t.user("explain", 0);
    t.assistant([text("Plain."), call("b", "bash", {}), text("A {{b|b long}}.")], 10, { stop: "toolUse" });
    const replies = only(parseChat(t.lines(), "", 80).entries, "assistant");
    expect(replies.map((r) => r.block)).toEqual([undefined, `${T0 + 10}.2`]);
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

  test("a known leaf outside the available rows never falls back to another branch", () => {
    const { t } = rewound();
    expect(parseChat(t.lines(), "nope", 80).entries).toEqual([]);
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

  test("a tail starting exactly on a line keeps that line, including UTF-8 text", async () => {
    const t = new Transcript();
    t.user("older", 0);
    t.say("friss válasz 🐈", 10);
    const last = t.lines().at(-1)! + "\n";
    const { entries } = await readChatFile(file(t.text()), "", 80, Buffer.byteLength(last));
    expect(only(entries, "assistant").map((e) => e.text)).toEqual(["friss válasz 🐈"]);
  });

  test("rewinding outside the tail does not show the abandoned branch", async () => {
    const t = new Transcript();
    const leaf = t.user("rewind target", 0);
    t.say("abandoned reply", 10);
    t.user("abandoned prompt", 20);
    const last = t.lines().at(-1)! + "\n";
    expect((await readChatFile(file(t.text()), leaf, 80, Buffer.byteLength(last) + 1)).entries).toEqual([]);
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
    expect(partial).toEqual(first); // incomplete bytes do not change the facts
    expect(partial.lastPrompt).toBe("one");
    expect(partial.offset).toBe(Bun.file(path).size - 20);

    appendFileSync(path, `${line.slice(20)}\n`);
    const done = await scanFacts(path, partial);
    expect(done.lastPrompt).toBe("two");
    expect(done.lastTurn).toBe(T0 + 2000);
    expect(done.offset).toBe(Bun.file(path).size);
  });

  test("concurrent scans do not mutate their shared cached snapshot", async () => {
    const t = new Transcript();
    t.user("one", 1000);
    const path = file(t.text());
    const before = await scanFacts(path, undefined);
    const offset = before.offset;
    t.user("two", 2000);
    appendFileSync(path, t.lines().at(-1)! + "\n");
    const results = await Promise.all([scanFacts(path, before), scanFacts(path, before)]);
    for (const result of results) expect(result).toMatchObject({ lastPrompt: "two", offset: Bun.file(path).size });
    expect(before).toMatchObject({ lastPrompt: "one", offset });
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

  test.each(["replace", "rewrite"] as const)("a same-size %s discards the previous file's facts", async (mode) => {
    const t = new Transcript();
    t.user("old", 1000);
    const path = file(t.text());
    const before = await scanFacts(path, undefined);
    const u = new Transcript();
    u.user("new", 1000);
    if (mode === "replace") renameSync(file(u.text()), path);
    else {
      writeFileSync(path, u.text());
      utimesSync(path, new Date(100000), new Date(100000));
    }
    expect(await scanFacts(path, before)).toMatchObject({ lastPrompt: "new", lastTurn: T0 + 1000 });
  });

  test("a removed file clears its cached facts and can reappear", async () => {
    const t = new Transcript();
    t.user("old", 1000);
    const path = file(t.text());
    const before = await scanFacts(path, undefined);
    rmSync(path);
    const missing = await scanFacts(path, before);
    expect(missing).toEqual({ offset: 0, lastPrompt: "", lastTurn: 0, lastActivity: 0 });
    writeFileSync(path, t.text());
    expect((await scanFacts(path, missing)).lastPrompt).toBe("old");
  });

  test("a tail starting exactly on a line keeps its prompt", async () => {
    const t = new Transcript();
    t.user("friss kérdés 🐈", 1000);
    const last = t.lines().at(-1)! + "\n";
    expect(await scanFacts(file(t.text()), undefined, Buffer.byteLength(last))).toMatchObject({
      lastPrompt: "friss kérdés 🐈", lastTurn: T0 + 1000,
    });
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
