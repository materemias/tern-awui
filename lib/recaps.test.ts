import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { queryRecaps, querySessionRecaps, withRecaps } from "./recaps";
import type { ChatEntry } from "./transcript";

function db(rows: [string, string, number][]) {
  const d = new Database(":memory:");
  d.run("CREATE TABLE session_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, recap TEXT, created_at INTEGER NOT NULL)");
  for (const r of rows) d.run("INSERT INTO session_recaps (session_id, recap, created_at) VALUES (?, ?, ?)", r);
  return d;
}

describe("queryRecaps", () => {
  test("the newest recap per session wins; within a second the later row", () => {
    using d = db([
      ["a", "newer by time", 200],
      ["a", "oldest", 100],
      ["b", "first in second", 300],
      ["b", "second in second", 300],
      ["c", "not asked", 999],
    ]);
    const out = queryRecaps(d, ["a", "b", "missing"]);
    expect([...out]).toEqual([
      ["a", { text: "newer by time", createdAt: 200 }],
      ["b", { text: "second in second", createdAt: 300 }],
    ]);
  });

  test("collapses whitespace, caps the length, and skips empty recaps", () => {
    using d = db([
      ["a", "  kept\n\n  earlier ", 1],
      ["a", "   ", 2],
      ["b", `long ${"x".repeat(800)}`, 1],
    ]);
    const out = queryRecaps(d, ["a", "b"]);
    expect(out.get("a")).toEqual({ text: "kept earlier", createdAt: 1 });
    expect(out.get("b")!.text).toHaveLength(600);
  });

  test("no ids, no query", () => {
    using d = new Database(":memory:");
    expect(queryRecaps(d, []).size).toBe(0);
  });

  test("a database without the table throws, for the caller to drop", () => {
    using d = new Database(":memory:");
    expect(() => queryRecaps(d, ["a"])).toThrow();
  });
});

describe("querySessionRecaps", () => {
  test("every non-empty recap of the session, oldest first, line breaks kept", () => {
    using d = db([
      ["a", "second", 200],
      ["a", " first\nline ", 100],
      ["a", "  ", 150],
      ["b", "other", 120],
    ]);
    expect(querySessionRecaps(d, "a")).toEqual([{ text: "first\nline", createdAt: 100 }, { text: "second", createdAt: 200 }]);
  });
});

describe("withRecaps", () => {
  const user = (ts: number): ChatEntry => ({ role: "user", id: String(ts), text: "q", images: [], ts });
  const turn = (ts: number): ChatEntry => ({ role: "turn", ms: 1000, model: "m", ts });
  const roles = (entries: ChatEntry[]) => entries.map((e) => (e.role === "recap" ? `recap:${e.text}` : e.role));

  test("a recap follows the turn it was written after and comes before the next prompt", () => {
    const chat = [user(10_000), turn(20_000), user(400_000), turn(410_000)];
    expect(roles(withRecaps(chat, [{ text: "one", createdAt: 300 }, { text: "two", createdAt: 700 }]))).toEqual(["user", "turn", "recap:one", "user", "turn", "recap:two"]);
  });

  test("a recap from the turn's own second (whole seconds) still goes after it", () => {
    expect(roles(withRecaps([user(10_000), turn(20_400)], [{ text: "same second", createdAt: 20 }]))).toEqual(["user", "turn", "recap:same second"]);
  });

  test("recaps older than the shown chat are left out; no chat, no recaps", () => {
    expect(roles(withRecaps([user(10_000), turn(20_000)], [{ text: "before", createdAt: 5 }]))).toEqual(["user", "turn"]);
    expect(withRecaps([], [{ text: "alone", createdAt: 5 }])).toEqual([]);
  });
});
