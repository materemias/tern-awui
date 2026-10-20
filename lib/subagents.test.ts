import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T0, Transcript, call, text } from "../test/fixtures";
import {
  assistantSummary,
  countSubagents,
  listSubagents,
  scanSubagent,
  subagentDir,
  subagentFile,
  subagentNames,
  validSubagentName,
  type SubagentFacts,
} from "./subagents";

const root = mkdtempSync(`${tmpdir()}/tern-awui-subagents-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A subagent that ran `sleep 20`, said so, and yielded: 5 messages, the last at T0+23001. */
function finished(): Transcript {
  const t = new Transcript("sub-a", "/tmp/proj");
  t.user("Run sleep 20 and report", 1000);
  t.assistant([call("c1", "bash", { i: "Sleeping 20 s", command: "sleep 20" })], 2000, { stop: "toolUse" });
  t.result("c1", "bash", 22000);
  t.assistant([text("Slept for **20** seconds."), call("y1", "yield", { data: {} })], 23000, { stop: "toolUse" });
  t.result("y1", "yield", 23001);
  return t;
}

/** A subagent still sleeping: its prompt and the running call, the last at T0+5000. */
function working(): Transcript {
  const t = new Transcript("sub-b", "/tmp/proj");
  t.user("Run sleep 20", 4000);
  t.assistant([call("c1", "bash", { i: "Sleeping in B", command: "sleep 20" })], 5000, { stop: "toolUse" });
  return t;
}

/** A session's subagent folder as omp leaves it: transcripts, results, advisor transcripts, tool logs. */
function sessionFolder(name: string): string {
  const dir = `${root}/${name}`;
  mkdirSync(`${dir}/local`, { recursive: true });
  mkdirSync(`${dir}/Folder.jsonl`);
  writeFileSync(`${dir}/A.jsonl`, finished().text());
  writeFileSync(`${dir}/B.jsonl`, working().text());
  writeFileSync(`${dir}/A.md`, "{}");
  writeFileSync(`${dir}/__advisor.sol61-high.jsonl`, new Transcript("adv").text());
  writeFileSync(`${dir}/.hidden.jsonl`, new Transcript("h").text());
  writeFileSync(`${dir}/bad name.jsonl`, new Transcript("b").text());
  writeFileSync(`${dir}/12.bash.log`, "output");
  writeFileSync(`${root}/outside.jsonl`, new Transcript("outside").text());
  symlinkSync(`${root}/outside.jsonl`, `${dir}/Link.jsonl`);
  return dir;
}

describe("subagent names and files", () => {
  test.each(["ViewA", "HuProgressMail", "Fix.v2-a_b", "9Lives", "x".repeat(128)])("%s is a subagent name", (name) =>
    expect(validSubagentName(name)).toBe(true),
  );

  test.each(["", "..", "../x", "a/b", "a\\b", "__advisor.sol61-high", "_x", ".hidden", "-flag", "bad name", "x".repeat(129), "A.jsonl\0"])(
    "%j is not",
    (name) => expect(validSubagentName(name)).toBe(false),
  );

  test("the folder is the transcript's path without .jsonl; a file needs a valid name", () => {
    const transcript = "/s/proj/2026-10-11T13-00-00-000Z_abc.jsonl";
    expect(subagentDir(transcript)).toBe("/s/proj/2026-10-11T13-00-00-000Z_abc");
    expect(subagentFile(transcript, "ViewA")).toBe(join("/s/proj/2026-10-11T13-00-00-000Z_abc", "ViewA.jsonl"));
    expect(subagentFile(transcript, "../2026-10-11T13-00-00-000Z_abc")).toBeNull();
    expect(subagentFile(transcript, "__advisor.sol61-high")).toBeNull();
  });

  test("only regular .jsonl files with a subagent name count: no advisors, results, logs, folders or symlinks", () => {
    const dir = sessionFolder("names");
    expect(subagentNames(dir).sort()).toEqual(["A", "B"]);
    expect(subagentNames(`${root}/missing`)).toEqual([]);
  });

  test("the count adds running subagents without a transcript yet, once each", () => {
    const dir = sessionFolder("count");
    expect(countSubagents(dir, [])).toBe(2);
    const jobs = [
      { agent: "B", since: 1 },
      { agent: "Pending", since: 2 },
      { agent: "", since: 3 }, // a background shell job
      { agent: "../x", since: 4 },
    ];
    expect(countSubagents(dir, jobs)).toBe(3);
    expect(countSubagents(`${root}/missing`, jobs)).toBe(2);
  });
});

describe("assistantSummary", () => {
  const msg = (...content: unknown[]) => ({ role: "assistant", content });

  test("the last text, on one line, without markdown emphasis", () => {
    expect(assistantSummary(msg(text("first"), text("Done: **two** `files`\n\n  changed"), text("  ")))).toBe("Done: two files changed");
  });

  test("long text stops at 200 characters", () => {
    expect(assistantSummary(msg(text("y".repeat(500))))).toHaveLength(200);
  });

  test("without text, the last tool call's intent, else its name; a yield without text says nothing", () => {
    expect(assistantSummary(msg(call("a", "read", { path: "src/a.ts" }), call("b", "bash", { i: "Building", command: "bun run build" })))).toBe("Building");
    expect(assistantSummary(msg(call("a", "todo", { ops: [] }), call("y", "yield", { data: {} })))).toBe("todo");
    expect(assistantSummary(msg(call("y", "yield", { data: { count: 3 } })))).toBe("");
    expect(assistantSummary(msg())).toBe("");
  });

  test("a yielded text result is the answer, over any text beside it", () => {
    expect(assistantSummary(msg(text("Done."), call("y", "yield", { data: { result: "I slept for **45** seconds." } })))).toBe("I slept for 45 seconds.");
    expect(assistantSummary(msg(call("y", "yield", { data: "  plain result " })))).toBe("plain result");
  });
});

describe("scanSubagent", () => {
  test("start from the session row, activity from the newest message, the summary from the newest one that says something", async () => {
    const path = `${root}/scan.jsonl`;
    writeFileSync(path, finished().text());
    expect(await scanSubagent(path, undefined)).toMatchObject({
      started: T0,
      lastActivity: T0 + 23001,
      summary: "Slept for 20 seconds.",
      messages: 5,
    });
  });

  test("continues from the previous scan, waits for a line still being written, starts over on a shrunk file", async () => {
    const path = `${root}/incremental.jsonl`;
    const t = working();
    writeFileSync(path, t.text());
    const first = await scanSubagent(path, undefined);
    expect(first).toMatchObject({ messages: 2, summary: "Sleeping in B", lastActivity: T0 + 5000 });
    const offset = first.offset;

    t.result("c1", "bash", 25000);
    appendFileSync(path, t.lines().at(-1)!); // no newline yet
    const partial = await scanSubagent(path, first);
    expect(partial).toEqual(first); // incomplete bytes do not change the facts
    expect(partial).toMatchObject({ offset, messages: 2, lastActivity: T0 + 5000 });

    appendFileSync(path, "\n");
    // A tool result says nothing: the summary stays the call's intent, the activity moves on.
    expect(await scanSubagent(path, first)).toMatchObject({ messages: 3, summary: "Sleeping in B", lastActivity: T0 + 25000 });

    t.say("B is awake.", 26000);
    appendFileSync(path, t.lines().at(-1)! + "\n");
    expect(await scanSubagent(path, first)).toMatchObject({ messages: 4, summary: "B is awake.", started: T0 });

    const fresh = new Transcript("sub-b2");
    fresh.say("rewritten", 100);
    writeFileSync(path, fresh.text());
    expect(await scanSubagent(path, first)).toMatchObject({ messages: 1, summary: "rewritten", lastActivity: T0 + 100 });
  });

  test("concurrent scans count appended messages once and leave the cached snapshot untouched", async () => {
    const path = `${root}/concurrent.jsonl`;
    const t = new Transcript();
    t.user("go", 0);
    writeFileSync(path, t.text());
    const before = await scanSubagent(path, undefined);
    const offset = before.offset;
    t.say("done", 10);
    appendFileSync(path, t.lines().at(-1)! + "\n");
    const results = await Promise.all([scanSubagent(path, before), scanSubagent(path, before)]);
    for (const result of results) expect(result).toMatchObject({ messages: 2, summary: "done", offset: Bun.file(path).size });
    expect(before).toMatchObject({ messages: 1, summary: "", offset });
  });

  test.each(["replace", "rewrite"] as const)("a same-size %s discards the old summary and message count", async (mode) => {
    const path = `${root}/${mode}.jsonl`;
    const t = new Transcript();
    t.say("old reply", 1000);
    writeFileSync(path, t.text());
    const before = await scanSubagent(path, undefined);
    const u = new Transcript();
    u.say("new reply", 1000);
    if (mode === "replace") {
      writeFileSync(`${path}.new`, u.text());
      renameSync(`${path}.new`, path);
    } else {
      writeFileSync(path, u.text());
      utimesSync(path, new Date(100000), new Date(100000));
    }
    expect(await scanSubagent(path, before)).toMatchObject({ summary: "new reply", messages: 1 });
  });

  test("a removed transcript clears its cached summary and can reappear", async () => {
    const path = `${root}/removed.jsonl`;
    writeFileSync(path, finished().text());
    const before = await scanSubagent(path, undefined);
    rmSync(path);
    const missing = await scanSubagent(path, before);
    expect(missing).toEqual({ offset: 0, started: 0, lastActivity: 0, summary: "", messages: 0 });
    writeFileSync(path, finished().text());
    expect(await scanSubagent(path, missing)).toMatchObject({ summary: "Slept for 20 seconds.", messages: 5 });
  });

  test("a transcript without a session row dates its start from its newest message", async () => {
    const path = `${root}/headless.jsonl`;
    writeFileSync(path, finished().lines().slice(2).join("\n") + "\n");
    expect(await scanSubagent(path, undefined)).toMatchObject({ started: T0 + 23001, messages: 5 });
  });

  test("a transcript past the decoded tail still counts every message and keeps its start", async () => {
    const path = `${root}/big.jsonl`;
    const t = new Transcript("sub-big");
    for (let i = 0; i < 1200; i++) t.say(`${i} ${"x".repeat(5000)}`, i);
    t.say("the end", 5000);
    writeFileSync(path, t.text());
    expect(Bun.file(path).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(await scanSubagent(path, undefined)).toMatchObject({ started: T0, messages: 1201, summary: "the end", lastActivity: T0 + 5000 });
  });
});

describe("listSubagents", () => {
  test("running ones (by job agent name) first, then newest activity; a job without a transcript shows from the job", async () => {
    const dir = sessionFolder("list");
    const cache = new Map<string, SubagentFacts>();
    const jobs = [
      { agent: "B", since: T0 + 100 },
      { agent: "Pending", since: T0 + 9000 },
      { agent: "", since: T0 },
      { agent: "../escape", since: T0 },
    ];
    const list = await listSubagents(dir, jobs, cache);
    expect(list).toEqual([
      { name: "Pending", started: T0 + 9000, lastActivity: T0 + 9000, running: true, summary: "", messages: 0 },
      { name: "B", started: T0, lastActivity: T0 + 5000, running: true, summary: "Sleeping in B", messages: 2 },
      { name: "A", started: T0, lastActivity: T0 + 23001, running: false, summary: "Slept for 20 seconds.", messages: 5 },
    ]);
    expect([...cache.keys()].sort()).toEqual([join(dir, "A.jsonl"), join(dir, "B.jsonl")]);
    // Once its job ends, a subagent sorts among the finished ones by its activity.
    expect((await listSubagents(dir, [], cache)).map((s) => [s.name, s.running])).toEqual([
      ["A", false],
      ["B", false],
    ]);
  });

  test("no folder and no jobs: none", async () => {
    expect(await listSubagents(`${root}/missing`, [], new Map())).toEqual([]);
  });
});
