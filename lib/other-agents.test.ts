import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessions, codexSessions } from "./other-agents";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tern-awui-agents-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const line = (row: unknown) => `${JSON.stringify(row)}\n`;

test("Claude Code: a title written before more than 64 KB of conversation is kept; a new prompt and a deleted transcript show on the next read", async () => {
  const dir = join(root, "claude");
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  const history = join(dir, "history.jsonl");
  writeFileSync(history, line({ display: "first", project: "/w", sessionId: "a", timestamp: 1000 }));
  const transcript = join(dir, "projects", "-w", "a.jsonl");
  writeFileSync(transcript, line({ type: "ai-title", aiTitle: "Long session" }) + line({ type: "assistant", text: "x".repeat(100_000) }));
  expect((await claudeSessions(dir)).map((s) => [s.title, s.prompts])).toEqual([["Long session", ["first"]]]);
  appendFileSync(history, line({ display: "second", project: "/w", sessionId: "a", timestamp: 2000 }));
  expect((await claudeSessions(dir))[0].prompts).toEqual(["first", "second"]);
  rmSync(transcript);
  expect(await claudeSessions(dir)).toEqual([]);
});

test("Codex: the folder is read from a session_meta row written with spaces after its colons", async () => {
  const dir = join(root, "codex");
  const id = "01a195fc-75c5-7d11-b95d-6e9ab2b85a13";
  mkdirSync(join(dir, "sessions", "2026", "01", "01"), { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), line({ session_id: id, ts: 5, text: "port it" }));
  writeFileSync(join(dir, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`), `{"type": "session_meta", "payload": {"id": "${id}", "cwd": "/w/app"}}\n`);
  expect((await codexSessions(dir)).map((s) => [s.id, s.cwd])).toEqual([[id, "/w/app"]]);
});
