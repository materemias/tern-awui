import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { queryRecaps } from "./recaps";

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
